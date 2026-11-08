/*
 * Metro Planner - routing and fare engine, shared by every city.
 * Works in the browser (window.MRTPlanner) and in Node (require) for tests.
 *
 *   const planner = MRTPlanner.create(network, fares, { date: "2026-11-08" });
 *   const result  = planner.plan("jurong-east", "changi-airport");
 *
 * Model
 *  - Every line is a small graph of station codes; a ride between two codes on
 *    one line is the shortest path on that line (handles loops).
 *  - Stations can belong to a "complex": differently named stations joined by a
 *    walkway (Tokyo's Akasaka-mitsuke and Nagatacho). Transfers happen within a
 *    station or a complex.
 *  - A route is a sequence of lines. We enumerate every sequence of lines that
 *    joins origin to destination (up to min transfers + 2) and every choice of
 *    interchange between consecutive lines, pruned with a lower bound on the time
 *    still needed, then keep the sensible ones.
 *  - Fares: "shortest-distance" (one fare by the shortest distance, Singapore) or
 *    "operator-distance" (each operator charges its own distance band, with a
 *    discount for changing operator; the fare depends on the route, Tokyo).
 *  - Stations with an `opens` date are treated as open from that date on.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MRTPlanner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Ride time per segment = dwell + distance / average running speed (cities can override).
  const TIMING = {
    MRT: { dwellMin: 0.75, kmh: 62 },
    LRT: { dwellMin: 0.5, kmh: 34 },
  };
  const DEFAULT_TRANSFER_MIN = 5;
  const SUGGEST_TRANSFER_PENALTY = 3; // extra "annoyance" minutes per transfer when ranking
  const SUGGEST_TAPOUT_PENALTY = 2;
  const MAX_EXTRA_TRANSFERS = 2;
  const MAX_OPTIONS = 8;

  // How convenient a transfer is, by transfer time (walking + average wait).
  const LEVELS = [
    { id: "quick", max: 3, label: "Quick change" },
    { id: "moderate", max: 5, label: "Short walk" },
    { id: "long", max: 7, label: "Long walk" },
    { id: "verylong", max: Infinity, label: "Very long" },
  ];
  const transferLevel = (min) => LEVELS.find((l) => min <= l.max);

  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function create(network, fares, options) {
    options = options || {};
    const date = options.date || todayISO();
    const meta = network.meta || {};
    const timing = Object.assign({}, TIMING, meta.timing || {}, options.timing || {});
    const loopChangeMin = meta.loopChangeMin || 3;

    // ---------------------------------------------------------- stations ---
    const stationById = new Map();
    const stationByCode = new Map();
    for (const s of network.stations) {
      stationById.set(s.id, s);
      for (const c of s.codes) stationByCode.set(c, s);
    }
    const cxOf = (stationId) => { const s = stationById.get(stationId); return (s && s.complex) || stationId; };
    const stOf = (code) => stationByCode.get(code).id;
    const codeOpensOn = (c) => {
      const s = stationByCode.get(c);
      return (s && s.opens && s.opens[c]) || null;
    };
    const codeOpen = (c) => {
      const o = codeOpensOn(c);
      return !o || o <= date;
    };

    // ------------------------------------------------------------- lines ---
    const lines = {};
    for (const [id, L] of Object.entries(network.lines)) {
      const t = timing[L.kind] || timing.MRT;
      const adj = new Map();
      let edges = 0;
      const add = (a, b, km) => {
        const min = t.dwellMin + (km / t.kmh) * 60;
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push({ to: b, km, min });
        adj.get(b).push({ to: a, km, min });
        edges++;
      };
      const openPaths = [];
      for (const p of L.paths) {
        // Skip stops that are not open yet: trains run through them.
        let last = null, acc = 0;
        const open = [];
        p.stops.forEach((c, i) => {
          if (i > 0) acc += p.km[i - 1];
          if (!stationByCode.has(c) || !codeOpen(c)) return;
          if (last !== null) add(last, c, +acc.toFixed(3));
          last = c; acc = 0; open.push(c);
        });
        openPaths.push(open);
      }
      lines[id] = {
        id, name: L.name, short: L.short, color: L.color, kind: L.kind, operator: L.operator || null,
        adj, openPaths, hasCycle: edges >= adj.size && adj.size > 0,
      };
    }

    // All-pairs shortest rides within each line (lines are small).
    for (const L of Object.values(lines)) {
      L.sp = new Map();
      for (const src of L.adj.keys()) L.sp.set(src, dijkstra(L.adj, src, "min"));
    }

    // station -> line -> code, and complex -> line -> code
    const realLines = new Map();
    const cxLines = new Map();
    for (const L of Object.values(lines)) {
      for (const c of L.adj.keys()) {
        const sid = stOf(c), cx = cxOf(sid);
        if (!realLines.has(sid)) realLines.set(sid, {});
        realLines.get(sid)[L.id] = c;
        if (!cxLines.has(cx)) cxLines.set(cx, {});
        cxLines.get(cx)[L.id] = c;
      }
    }

    // transfers lookup
    const transferInfo = new Map();
    for (const t of network.transfers || []) {
      transferInfo.set(t.a + "|" + t.b, t);
      transferInfo.set(t.b + "|" + t.a, t);
    }
    function transferAt(cx, fromLine, toLine) {
      const m = cxLines.get(cx) || cxLines.get(cxOf(cx));
      const a = m[fromLine], b = m[toLine];
      const station = stOf(a), toStation = stOf(b);
      if (a === b) return { min: loopChangeMin, tapOut: false, note: null, level: transferLevel(loopChangeMin), fromCode: a, toCode: b, station, toStation };
      const t = transferInfo.get(a + "|" + b);
      const min = t ? t.min : DEFAULT_TRANSFER_MIN;
      return { min, tapOut: !!(t && t.tapOut), note: (t && t.note) || null, level: transferLevel(min), fromCode: a, toCode: b, station, toStation };
    }

    // Every transfer possible at a station (open lines only), quickest first.
    // Walking time from a station to a code of a linked station (transfer time minus the wait).
    function walkMin(stationId, code) {
      let best = Infinity;
      for (const c of stationById.get(stationId).codes) {
        const t = transferInfo.get(c + "|" + code);
        if (t) best = Math.min(best, t.min);
      }
      return isFinite(best) ? Math.max(2, best - 2) : DEFAULT_TRANSFER_MIN;
    }

    function stationTransfers(stationId) {
      const cx = cxOf(stationId);
      const m = cxLines.get(cx);
      if (!m || !realLines.has(stationId)) return [];
      const ls = Object.keys(m);
      const seen = new Map();
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        let t = transferAt(cx, ls[i], ls[j]);
        if (t.station !== stationId && t.toStation !== stationId) continue;
        if (t.station !== stationId) t = transferAt(cx, ls[j], ls[i]); // list this station's code first
        const key = t.fromCode === t.toCode ? t.fromCode + "|same|" + [ls[i], ls[j]].sort().join() : [t.fromCode, t.toCode].sort().join("|");
        if (!seen.has(key)) seen.set(key, { lines: t.fromCode === t.toCode ? [ls[i], ls[j]] : [ls[i], ls[j]], ...t });
      }
      return [...seen.values()].sort((a, b) => a.min - b.min);
    }
    function interchangeGuide() {
      const rows = [], seen = new Set();
      for (const sid of realLines.keys()) for (const t of stationTransfers(sid)) {
        const key = t.fromCode === t.toCode ? t.fromCode + t.lines.join() : [t.fromCode, t.toCode].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(t);
      }
      return rows.sort((a, b) => a.min - b.min || stationById.get(a.station).name.localeCompare(stationById.get(b.station).name));
    }

    // interchange complexes between each pair of lines
    const interchanges = new Map();
    const lineNeighbours = new Map(Object.keys(lines).map((id) => [id, new Set()]));
    for (const [cx, m] of cxLines) {
      const ls = Object.keys(m);
      for (const a of ls) for (const b of ls) {
        if (a === b) continue;
        const k = a + "|" + b;
        if (!interchanges.has(k)) interchanges.set(k, []);
        interchanges.get(k).push(cx);
        lineNeighbours.get(a).add(b);
      }
    }

    // ---------------------------------------------- station-level graphs ---
    // by riding time (lower bounds for pruning) and by km (fares); members of
    // a complex are joined by zero-cost edges.
    const stationAdj = new Map();
    const opAdj = new Map(); // operator -> station adjacency (km)
    const addEdge = (map, a, b, e) => { if (!map.has(a)) map.set(a, []); map.get(a).push({ to: b, ...e }); };
    for (const L of Object.values(lines)) {
      for (const [a, es] of L.adj) for (const e of es) {
        addEdge(stationAdj, stOf(a), stOf(e.to), { km: e.km, min: e.min });
        if (L.operator) {
          if (!opAdj.has(L.operator)) opAdj.set(L.operator, new Map());
          addEdge(opAdj.get(L.operator), stOf(a), stOf(e.to), { km: e.km, min: e.min });
        }
      }
    }
    const complexes = new Map();
    for (const s of network.stations) if (s.complex) { if (!complexes.has(s.complex)) complexes.set(s.complex, []); complexes.get(s.complex).push(s.id); }
    for (const ids of complexes.values()) for (const a of ids) for (const b of ids) if (a !== b) {
      addEdge(stationAdj, a, b, { km: 0, min: 0 });
      for (const g of opAdj.values()) addEdge(g, a, b, { km: 0, min: 0 });
    }
    const distCache = new Map();
    function graphDist(graph, key, from, to, weight) {
      const ck = key + "|" + from + "|" + weight;
      if (!distCache.has(ck)) distCache.set(ck, dijkstra(graph, from, weight));
      const r = distCache.get(ck).get(to);
      return r ? r[weight] : null;
    }
    const fareDistanceKm = (fromId, toId) => graphDist(stationAdj, "all", fromId, toId, "km");

    // ----------------------------------------------------------- fares ---
    const fareModel = (fares && fares.model) || "shortest-distance";
    const schedules = fareModel === "shortest-distance" ? buildSchedules(fares) : [];
    function scheduleFor(d) {
      let best = null;
      for (const s of schedules) if (s.effective <= d && (!best || s.effective > best.effective)) best = s;
      return best || schedules[0] || null;
    }
    function fareCents(km, d) {
      const s = scheduleFor(d || date);
      const k = Math.round(km * 10) / 10; // bands are in 0.1 km steps
      for (const [upTo, cents] of s.bands) if (upTo === null || k <= upTo) return cents;
      return s.bands[s.bands.length - 1][1];
    }
    function fareFor(fromId, toId, d) {
      if (fareModel !== "shortest-distance") return null;
      const km = fareDistanceKm(fromId, toId);
      if (km == null) return null;
      const day = d || date;
      const s = scheduleFor(day);
      const cents = fareCents(km, day);
      const out = {
        kind: "distance",
        km: +km.toFixed(1),
        adultCents: cents,
        earlyCents: Math.max(0, cents - (s.earlyDiscountCents || 0)),
        schedule: { id: s.id, label: s.label, effective: s.effective },
        estimate: !s.confirmedSet.has(bandOf(s, km)),
      };
      const next = schedules.filter((x) => x.effective > day).sort((a, b) => (a.effective < b.effective ? -1 : 1))[0];
      if (next) out.next = { label: next.label, effective: next.effective, adultCents: fareCents(km, next.effective) };
      return out;
    }
    // Operator fares for one route: each run of legs on one operator is charged by
    // that operator's shortest distance between where you board and leave it.
    function routeFare(legs) {
      if (fareModel !== "operator-distance") return null;
      const segs = [];
      for (const leg of legs) {
        const op = lines[leg.line].operator;
        const last = segs[segs.length - 1];
        if (last && last.operator === op) { last.to = leg.to; last.rideKm += leg.km; }
        else segs.push({ operator: op, from: leg.from, to: leg.to, rideKm: leg.km });
      }
      let ic = 0, ticket = 0;
      const out = segs.map((s) => {
        const conf = fares.operators[s.operator];
        let km = graphDist(opAdj.get(s.operator), s.operator, s.from, s.to, "km");
        if (km == null) km = s.rideKm;
        const fareKm = Math.max(1, Math.ceil(km - 1e-9));
        const band = conf.bands.find(([upTo]) => upTo === null || fareKm <= upTo) || conf.bands[conf.bands.length - 1];
        ic += band[1]; ticket += band[2];
        return { operator: s.operator, name: conf.name, from: s.from, to: s.to, km: +km.toFixed(1), fareKm, ic: band[1], ticket: band[2] };
      });
      const td = fares.transferDiscount;
      let changes = 0;
      for (let i = 1; i < segs.length; i++) if (td && td.operators.includes(segs[i - 1].operator) && td.operators.includes(segs[i].operator)) changes++;
      const discount = changes ? td.amount : 0;
      return { kind: "operator", ic: ic - discount, ticket: ticket - discount, discount, segments: out, estimate: changes > 1 };
    }

    // Where fares depend on the route, a cheaper route gets a small bonus when ranking.
    const fareMinutes = (fare) => (fare && fares.minutesPer100 ? (fare.ic / 100) * fares.minutesPer100 : 0);

    // ---------------------------------------------------------- routing ---
    function ride(lineId, fromCode, toCode) {
      const r = lines[lineId].sp.get(fromCode);
      const hit = r && r.get(toCode);
      if (!hit) return null;
      const codes = [toCode];
      let cur = toCode;
      while (cur !== fromCode) { cur = r.get(cur).prev; codes.unshift(cur); }
      return { codes, min: hit.min, km: hit.km };
    }

    function minLineHops(startLines, endLines) {
      const dist = new Map();
      const q = [];
      for (const l of startLines) { dist.set(l, 1); q.push(l); }
      while (q.length) {
        const l = q.shift();
        if (endLines.has(l)) return dist.get(l);
        for (const n of lineNeighbours.get(l)) if (!dist.has(n)) { dist.set(n, dist.get(l) + 1); q.push(n); }
      }
      return Infinity;
    }

    // Fastest possible time (platform graph with transfers), used to bound the search.
    // Lines you can start or finish on at a station: its own, plus a linked station's after a walk.
    function entries(stationId) {
      const out = {};
      const m = cxLines.get(cxOf(stationId)) || {};
      for (const [l, code] of Object.entries(m)) {
        const own = stOf(code) === stationId;
        out[l] = { code, walk: own ? 0 : walkMin(stationId, code), station: stOf(code) };
      }
      return out;
    }
    let platformAdj = null;
    const node = (c, l) => c + "@" + l;
    function fastestTime(fromId, toId) {
      if (!platformAdj) {
        platformAdj = new Map();
        for (const L of Object.values(lines)) for (const [a, es] of L.adj) for (const e of es) addEdge(platformAdj, node(a, L.id), node(e.to, L.id), { min: e.min, km: 0 });
        for (const [cx, m] of cxLines) {
          const ls = Object.keys(m);
          for (const a of ls) for (const b of ls) if (a !== b) addEdge(platformAdj, node(m[a], a), node(m[b], b), { min: transferAt(cx, a, b).min, km: 0 });
        }
      }
      const adj = new Map(platformAdj);
      const src = "__src";
      adj.set(src, Object.entries(entries(fromId)).map(([l, e]) => ({ to: node(e.code, l), min: e.walk, km: 0 })));
      const d = dijkstra(adj, src, "min");
      let best = Infinity;
      for (const [l, e] of Object.entries(entries(toId))) { const r = d.get(node(e.code, l)); if (r) best = Math.min(best, r.min + e.walk); }
      return best;
    }

    function plan(fromId, toId, opts) {
      opts = opts || {};
      const from = stationById.get(fromId), to = stationById.get(toId);
      if (!from || !to) return { error: "Unknown station" };
      if (fromId === toId) return { error: "Start and destination are the same station" };
      const fromCx = cxOf(fromId), toCx = cxOf(toId);
      if (fromCx === toCx) return { error: `${from.name} and ${to.name} are connected stations: walk between them inside the station.` };
      if (!realLines.get(fromId)) return { error: `${from.name} is not open yet` + opensNote(from) };
      if (!realLines.get(toId)) return { error: `${to.name} is not open yet` + opensNote(to) };
      const startE = entries(fromId), endE = entries(toId);
      const fromLines = {}, toLines = {};
      for (const [l, e] of Object.entries(startE)) fromLines[l] = e.code;
      for (const [l, e] of Object.entries(endE)) toLines[l] = e.code;

      const startLines = Object.keys(fromLines);
      const endLines = new Set(Object.keys(toLines));
      const minHops = minLineHops(startLines, endLines);
      if (!isFinite(minHops)) return { error: "No connection found" };
      const maxLines = Math.min(minHops + (opts.extraTransfers ?? MAX_EXTRA_TRANSFERS), 6);

      // lower bound on riding time still needed from each station
      const h = dijkstra(stationAdj, toId, "min");
      const hOf = (sid) => { const r = h.get(sid); return r ? r.min : Infinity; };
      let bestTime = fastestTime(fromId, toId);
      if (!isFinite(bestTime)) return { error: "No route found" };
      const limit = () => bestTime * 1.6 + 15;

      const found = [];
      function extend(seq, boardCx, boardCode, visited, cost, legs, xfers) {
        const line = seq[seq.length - 1];
        if (cost + hOf(stOf(boardCode)) > limit()) return;
        // Option 1: ride this line to the destination.
        if (endLines.has(line)) {
          const r = ride(line, boardCode, toLines[line]);
          if (r && noRevisit(r.codes, visited)) {
            const total = cost + r.min + endE[line].walk;
            if (total <= limit()) {
              found.push({ legs: legs.concat([{ line, ...r }]), transfers: xfers.slice(), total });
              if (total < bestTime) bestTime = total;
            }
          }
        }
        // Option 2: ride to an interchange and change line.
        if (seq.length >= maxLines) return;
        for (const next of lineNeighbours.get(line)) {
          if (seq.includes(next)) continue;
          for (const cx of interchanges.get(line + "|" + next)) {
            if (cx === boardCx || cx === toCx || cx === fromCx || visited.has(cx)) continue;
            const exitCode = cxLines.get(cx)[line];
            const r = ride(line, boardCode, exitCode);
            if (!r || !noRevisit(r.codes, visited)) continue;
            const t = transferAt(cx, line, next);
            const c2 = cost + r.min + t.min;
            if (c2 + hOf(t.toStation) > limit()) continue;
            const v2 = new Set(visited);
            for (const c of r.codes) v2.add(cxOf(stOf(c)));
            extend(seq.concat([next]), cx, t.toCode, v2, c2,
              legs.concat([{ line, ...r }]), xfers.concat([{ fromLine: line, toLine: next, ...t }]));
          }
        }
      }
      function noRevisit(codes, visited) {
        // first code is the boarding station (already visited); others must be new
        for (let i = 1; i < codes.length; i++) if (visited.has(cxOf(stOf(codes[i])))) return false;
        return true;
      }

      for (const l of startLines) extend([l], fromCx, fromLines[l], new Set([fromCx]), startE[l].walk, [], []);
      if (!found.length) return { error: "No route found" };

      // Group by line sequence; keep the best interchange choice and remember near-equal alternatives.
      const groups = new Map();
      for (const f of found) {
        const key = f.legs.map((l) => l.line).join(">");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }
      let all = [];
      for (const [key, fs] of groups) {
        fs.sort((a, b) => a.total - b.total);
        const best = fs[0];
        const alsoVia = [];
        const seen = new Set([best.transfers.map((t) => t.station).join(",")]);
        for (const f of fs.slice(1)) {
          const k = f.transfers.map((t) => t.station).join(",");
          if (f.total <= best.total + 3 && !seen.has(k)) { seen.add(k); alsoVia.push(f.transfers.map((t) => t.station)); }
        }
        const o = decorate(key, best, alsoVia);
        const first = o.legs[0], last = o.legs[o.legs.length - 1];
        if (first.from !== from.id) o.startWalk = { from: from.id, to: first.from, min: startE[first.line].walk };
        if (last.to !== to.id) o.endWalk = { from: last.to, to: to.id, min: endE[last.line].walk };
        const walk = (o.startWalk ? o.startWalk.min : 0) + (o.endWalk ? o.endWalk.min : 0);
        if (walk) { o.walkMin = walk; o.totalMinExact += walk; o.totalMin = Math.round(o.totalMinExact); o.score += walk; }
        all.push(o);
      }

      // Main options: not beaten by a route with fewer transfers, and either close to
      // the fastest or the quickest route for its number of transfers.
      const fastest = Math.min(...all.map((o) => o.totalMinExact));
      const bestForTransfers = new Map();
      for (const o of all) {
        const b = bestForTransfers.get(o.nTransfers);
        if (!b || o.totalMinExact < b.totalMinExact) bestForTransfers.set(o.nTransfers, o);
      }
      const beatenByFewer = (o) => all.some((p) => p.nTransfers < o.nTransfers && p.totalMinExact <= o.totalMinExact + 1);
      const main = [], more = [];
      for (const o of all) {
        const near = o.totalMinExact <= fastest * 1.3 + 5;
        const tierBest = bestForTransfers.get(o.nTransfers) === o;
        if (!beatenByFewer(o) && (near || tierBest)) main.push(o);
        else if (o.totalMinExact <= fastest * 1.8 + 15) more.push(o);
      }
      const fareOf = (o) => (o.fare ? o.fare.ic : 0);
      main.sort((a, b) => a.score - b.score || a.nTransfers - b.nTransfers || fareOf(a) - fareOf(b));
      more.sort((a, b) => a.totalMinExact - b.totalMinExact);
      const maxN = opts.maxOptions || MAX_OPTIONS;
      const options = main.slice(0, maxN);
      const moreOptions = main.slice(maxN).concat(more).slice(0, maxN);

      const fastestOpt = options.reduce((a, b) => (b.totalMinExact < a.totalMinExact ? b : a));
      const fewestOpt = options.reduce((a, b) => (b.nTransfers < a.nTransfers || (b.nTransfers === a.nTransfers && b.totalMinExact < a.totalMinExact) ? b : a));
      const cheapestOpt = fareModel === "operator-distance" ? options.reduce((a, b) => (fareOf(b) < fareOf(a) ? b : a)) : null;
      options.forEach((o, i) => {
        o.rank = i + 1;
        o.tags = [];
        if (i === 0) o.tags.push("suggested");
        if (o === fastestOpt) o.tags.push("fastest");
        if (o === fewestOpt) o.tags.push(o.nTransfers === 0 ? "direct" : "fewest-transfers");
        if (cheapestOpt && o === cheapestOpt && options.some((p) => fareOf(p) > fareOf(o))) o.tags.push("cheapest");
      });
      moreOptions.forEach((o, i) => { o.rank = options.length + i + 1; o.tags = []; });

      return {
        from: from.id, to: to.id, date, fareModel,
        fare: fareModel === "operator-distance" ? options[0].fare : fareFor(from.id, to.id, opts.fareDate || date),
        options,
        moreOptions,
        suggested: options[0],
      };
    }

    function decorate(key, f, alsoVia) {
      const legs = f.legs.map((l) => {
        const L = lines[l.line];
        const stops = l.codes.map((c) => stOf(c));
        return {
          line: l.line, lineName: L.name, short: L.short, color: L.color, kind: L.kind, operator: L.operator,
          from: stops[0], to: stops[stops.length - 1], fromCode: l.codes[0], toCode: l.codes[l.codes.length - 1],
          codes: l.codes, stops, nStops: stops.length - 1,
          km: +l.km.toFixed(2), min: l.min,
          towards: towards(L, l.codes),
          nextStop: stops[1],
        };
      });
      const transfers = f.transfers.map((t) => ({ ...t }));
      const rideMin = legs.reduce((a, l) => a + l.min, 0);
      const transferMin = transfers.reduce((a, t) => a + t.min, 0);
      const tapOuts = transfers.filter((t) => t.tapOut).length;
      const fare = routeFare(legs);
      return {
        key, legs, transfers, alsoVia,
        lines: legs.map((l) => l.line),
        nTransfers: transfers.length, tapOuts,
        rideMin: Math.round(rideMin), transferMin: Math.round(transferMin),
        totalMinExact: rideMin + transferMin,
        totalMin: Math.round(rideMin + transferMin),
        km: +legs.reduce((a, l) => a + l.km, 0).toFixed(1),
        nStops: legs.reduce((a, l) => a + l.nStops, 0),
        score: rideMin + transferMin + transfers.length * SUGGEST_TRANSFER_PENALTY + tapOuts * SUGGEST_TAPOUT_PENALTY + fareMinutes(fare),
        fare,
      };
    }

    // "Towards X" for lines that run end to end; null for lines with a loop.
    function towards(L, codes) {
      if (codes.length < 2 || L.hasCycle) return null;
      for (const path of L.openPaths) {
        const i = path.indexOf(codes[0]), j = path.indexOf(codes[1]);
        if (i < 0 || j < 0 || Math.abs(i - j) !== 1) continue;
        const end = j > i ? path[path.length - 1] : path[0];
        return stOf(end);
      }
      return null;
    }

    function opensNote(s) {
      const d = s.opens && Object.values(s.opens).sort()[0];
      return d ? ` (opens ${d})` : "";
    }

    // ------------------------------------------------------- public API ---
    return {
      date,
      fareModel,
      lines,
      stations: network.stations,
      station: (id) => stationById.get(id),
      stationByCode: (c) => stationByCode.get(c),
      complexOf: cxOf,
      isStationOpen: (id) => realLines.has(id),
      stationLines: (id) => realLines.get(id) || {},
      codeOpen,
      codeOpensOn,
      plan,
      fareFor,
      fareCents,
      fareDistanceKm,
      scheduleFor,
      routeFare,
      transferAt,
      stationTransfers,
      interchangeGuide,
      transferLevel,
      LEVELS,
    };
  }

  // ------------------------------------------------------------- helpers ---
  function dijkstra(adj, src, weight) {
    // tiny binary-heap Dijkstra; returns Map(node -> {min, km, prev})
    const out = new Map([[src, { min: 0, km: 0, prev: null }]]);
    const heap = [[0, src]];
    const done = new Set();
    while (heap.length) {
      const [d, u] = pop(heap);
      if (done.has(u)) continue;
      done.add(u);
      const cur = out.get(u);
      for (const e of adj.get(u) || []) {
        const nd = d + e[weight];
        const ex = out.get(e.to);
        if (!ex || nd < ex[weight] - 1e-9) {
          out.set(e.to, { min: cur.min + e.min, km: cur.km + e.km, prev: u });
          push(heap, [nd, e.to]);
        }
      }
    }
    return out;
  }
  function push(h, x) {
    h.push(x);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; }
  }
  function pop(h) {
    const top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l][0] < h[m][0]) m = l;
        if (r < h.length && h[r][0] < h[m][0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]]; i = m;
      }
    }
    return top;
  }

  function buildSchedules(fares) {
    const list = (fares && fares.schedules) || [];
    const byId = new Map();
    const out = [];
    for (const s of list) {
      let bands = s.bands;
      if (!bands && s.derivedFrom) {
        const base = byId.get(s.derivedFrom);
        bands = base.bands.map(([upTo, c]) => {
          const adj = s.adjust.find((a) => a.upToKm === null || (upTo !== null && upTo <= a.upToKm));
          return [upTo, c + (adj ? adj.cents : 0)];
        });
      }
      const confirmed = s.confirmed || (s.derivedFrom ? (byId.get(s.derivedFrom).confirmed || []) : []);
      const full = { ...s, bands, confirmed, confirmedSet: new Set(confirmed) };
      byId.set(s.id, full);
      out.push(full);
    }
    return out;
  }
  function bandOf(s, km) {
    const k = Math.round(km * 10) / 10;
    for (const [upTo] of s.bands) if (upTo === null || k <= upTo) return upTo;
    return null;
  }

  return { create, todayISO, TIMING, LEVELS };
});
