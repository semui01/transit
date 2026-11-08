/*
 * MRT Journey Planner - routing and fare engine.
 * Works in the browser (window.MRTPlanner) and in Node (require) for tests.
 *
 *   const planner = MRTPlanner.create(MRT_NETWORK, MRT_FARES, { date: "2026-11-08" });
 *   const result  = planner.plan("jurong-east", "changi-airport");
 *
 * Model
 *  - Every line is a small graph of station codes; a ride between two codes on
 *    one line is the shortest path on that line (handles loops like the CCL).
 *  - A route is a sequence of lines. We enumerate every sequence of lines that
 *    joins origin to destination (up to min transfers + 2), and every choice of
 *    interchange station between consecutive lines, then keep the sensible ones.
 *  - Stations with an `opens` date are treated as open from that date on, so
 *    announced openings switch on by themselves.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MRTPlanner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Ride time per segment = dwell + distance / average running speed.
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
    const timing = Object.assign({}, TIMING, options.timing || {});
    const loopChangeMin = (network.meta && network.meta.loopChangeMin) || 3;

    // ---------------------------------------------------------- stations ---
    const stationById = new Map();
    const stationByCode = new Map();
    for (const s of network.stations) {
      stationById.set(s.id, s);
      for (const c of s.codes) stationByCode.set(c, s);
    }
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
      const add = (a, b, km) => {
        const min = t.dwellMin + (km / t.kmh) * 60;
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push({ to: b, km, min });
        adj.get(b).push({ to: a, km, min });
      };
      const termini = [];
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
        termini.push(open);
      }
      lines[id] = { id, name: L.name, short: L.short, color: L.color, kind: L.kind, adj, openPaths: termini };
    }

    // All-pairs shortest rides within each line (lines are small).
    for (const L of Object.values(lines)) {
      L.sp = new Map();
      for (const src of L.adj.keys()) L.sp.set(src, dijkstra(L.adj, src, "min"));
    }

    // station -> line -> code
    const stationLines = new Map();
    for (const L of Object.values(lines)) {
      for (const c of L.adj.keys()) {
        const s = stationByCode.get(c);
        if (!stationLines.has(s.id)) stationLines.set(s.id, {});
        stationLines.get(s.id)[L.id] = c;
      }
    }

    // transfers lookup
    const transferInfo = new Map();
    for (const t of network.transfers || []) {
      transferInfo.set(t.a + "|" + t.b, t);
      transferInfo.set(t.b + "|" + t.a, t);
    }
    function transferAt(stationId, fromLine, toLine) {
      const m = stationLines.get(stationId);
      const a = m[fromLine], b = m[toLine];
      if (a === b) return { min: loopChangeMin, tapOut: false, note: null, level: transferLevel(loopChangeMin), fromCode: a, toCode: b };
      const t = transferInfo.get(a + "|" + b);
      const min = t ? t.min : DEFAULT_TRANSFER_MIN;
      return { min, tapOut: !!(t && t.tapOut), note: (t && t.note) || null, level: transferLevel(min), fromCode: a, toCode: b };
    }

    // Every transfer possible at a station (open lines only), quickest first.
    function stationTransfers(stationId) {
      const m = stationLines.get(stationId);
      if (!m) return [];
      const ls = Object.keys(m);
      const seen = new Map();
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        const t = transferAt(stationId, ls[i], ls[j]);
        const key = t.fromCode === t.toCode ? t.fromCode + "|loop" : [t.fromCode, t.toCode].sort().join("|");
        if (!seen.has(key)) seen.set(key, { station: stationId, lines: [ls[i], ls[j]], ...t });
      }
      return [...seen.values()].sort((a, b) => a.min - b.min);
    }
    function interchangeGuide() {
      const rows = [];
      for (const sid of stationLines.keys()) rows.push(...stationTransfers(sid));
      return rows.sort((a, b) => a.min - b.min || stationById.get(a.station).name.localeCompare(stationById.get(b.station).name));
    }

    // interchange stations between each pair of lines
    const interchanges = new Map();
    const lineNeighbours = new Map(Object.keys(lines).map((id) => [id, new Set()]));
    for (const [sid, m] of stationLines) {
      const ls = Object.keys(m);
      for (const a of ls) for (const b of ls) {
        if (a === b) continue;
        const k = a + "|" + b;
        if (!interchanges.has(k)) interchanges.set(k, []);
        interchanges.get(k).push(sid);
        lineNeighbours.get(a).add(b);
      }
    }

    // ------------------------------------------------- fare distance graph ---
    const stationAdj = new Map();
    for (const L of Object.values(lines)) {
      for (const [a, es] of L.adj) {
        const sa = stationByCode.get(a).id;
        if (!stationAdj.has(sa)) stationAdj.set(sa, []);
        for (const e of es) stationAdj.get(sa).push({ to: stationByCode.get(e.to).id, km: e.km, min: e.min });
      }
    }
    const fareDistCache = new Map();
    function fareDistanceKm(fromId, toId) {
      if (!fareDistCache.has(fromId)) fareDistCache.set(fromId, dijkstra(stationAdj, fromId, "km"));
      const r = fareDistCache.get(fromId).get(toId);
      return r ? r.km : null;
    }

    // ----------------------------------------------------------- fares ---
    const schedules = buildSchedules(fares);
    function scheduleFor(d) {
      let best = null;
      for (const s of schedules) if (s.effective <= d && (!best || s.effective > best.effective)) best = s;
      return best || schedules[0];
    }
    function fareCents(km, d) {
      const s = scheduleFor(d || date);
      const k = Math.round(km * 10) / 10; // bands are in 0.1 km steps
      for (const [upTo, cents] of s.bands) if (upTo === null || k <= upTo) return cents;
      return s.bands[s.bands.length - 1][1];
    }
    function fareFor(fromId, toId, d) {
      const km = fareDistanceKm(fromId, toId);
      if (km == null) return null;
      const day = d || date;
      const s = scheduleFor(day);
      const cents = fareCents(km, day);
      const out = {
        km: +km.toFixed(1),
        adultCents: cents,
        earlyCents: Math.max(0, cents - (s.earlyDiscountCents || 0)),
        schedule: { id: s.id, label: s.label, effective: s.effective },
        estimate: !s.confirmedSet.has(bandOf(s, km)),
      };
      // Show the next announced fare change, if any.
      const next = schedules.filter((x) => x.effective > day).sort((a, b) => (a.effective < b.effective ? -1 : 1))[0];
      if (next) out.next = { label: next.label, effective: next.effective, adultCents: fareCents(km, next.effective) };
      return out;
    }

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

    function plan(fromId, toId, opts) {
      opts = opts || {};
      const from = stationById.get(fromId), to = stationById.get(toId);
      if (!from || !to) return { error: "Unknown station" };
      if (fromId === toId) return { error: "Start and destination are the same station" };
      const fromLines = stationLines.get(fromId), toLines = stationLines.get(toId);
      if (!fromLines) return { error: `${from.name} is not open yet` + opensNote(from) };
      if (!toLines) return { error: `${to.name} is not open yet` + opensNote(to) };

      const startLines = Object.keys(fromLines);
      const endLines = new Set(Object.keys(toLines));
      const minHops = minLineHops(startLines, endLines);
      if (!isFinite(minHops)) return { error: "No connection found" };
      const maxLines = Math.min(minHops + (opts.extraTransfers ?? MAX_EXTRA_TRANSFERS), 6);

      const found = [];
      let bestTime = Infinity;
      const limit = () => bestTime * 1.6 + 15;

      // Depth-first over line sequences, choosing interchange stations as we go.
      function extend(seq, boardStation, visited, cost, legs, xfers) {
        const line = seq[seq.length - 1];
        const boardCode = stationLines.get(boardStation)[line];
        if (cost > limit()) return;
        // Option 1: ride this line to the destination.
        if (endLines.has(line)) {
          const r = ride(line, boardCode, toLines[line]);
          if (r && noRevisit(r.codes, visited)) {
            const total = cost + r.min;
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
          for (const sid of interchanges.get(line + "|" + next)) {
            if (sid === boardStation || sid === toId || sid === fromId) continue;
            const r = ride(line, boardCode, stationLines.get(sid)[line]);
            if (!r || !noRevisit(r.codes, visited)) continue;
            const t = transferAt(sid, line, next);
            const v2 = new Set(visited);
            for (const c of r.codes) v2.add(stationByCode.get(c).id);
            extend(seq.concat([next]), sid, v2, cost + r.min + t.min,
              legs.concat([{ line, ...r }]), xfers.concat([{ station: sid, fromLine: line, toLine: next, ...t }]));
          }
        }
      }
      function noRevisit(codes, visited) {
        // first code is the boarding station (already visited); others must be new
        for (let i = 1; i < codes.length; i++) if (visited.has(stationByCode.get(codes[i]).id)) return false;
        return true;
      }

      for (const l of startLines) extend([l], fromId, new Set([fromId]), 0, [], []);
      if (!found.length) return { error: "No route found" };

      // Group by line sequence; keep the best interchange choice and remember near-equal alternatives.
      const groups = new Map();
      for (const f of found) {
        const key = f.legs.map((l) => l.line).join(">");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }
      let opts2 = [];
      for (const [key, fs] of groups) {
        fs.sort((a, b) => a.total - b.total);
        const best = fs[0];
        const alsoVia = [];
        const seen = new Set([best.transfers.map((t) => t.station).join(",")]);
        for (const f of fs.slice(1)) {
          const k = f.transfers.map((t) => t.station).join(",");
          if (f.total <= best.total + 3 && !seen.has(k)) { seen.add(k); alsoVia.push(f.transfers.map((t) => t.station)); }
        }
        opts2.push(decorate(key, best, alsoVia));
      }

      // Main options: not beaten by a route with fewer transfers, and either close to
      // the fastest or the quickest route for its number of transfers.
      // Everything else that is still reasonable goes to `moreOptions`.
      const fastest = Math.min(...opts2.map((o) => o.totalMinExact));
      const bestForTransfers = new Map();
      for (const o of opts2) {
        const b = bestForTransfers.get(o.nTransfers);
        if (!b || o.totalMinExact < b.totalMinExact) bestForTransfers.set(o.nTransfers, o);
      }
      const beatenByFewer = (o) => opts2.some((p) => p.nTransfers < o.nTransfers && p.totalMinExact <= o.totalMinExact + 1);
      const main = [], more = [];
      for (const o of opts2) {
        const near = o.totalMinExact <= fastest * 1.3 + 5;
        const tierBest = bestForTransfers.get(o.nTransfers) === o;
        if (!beatenByFewer(o) && (near || tierBest)) main.push(o);
        else if (o.totalMinExact <= fastest * 1.8 + 15) more.push(o);
      }
      const byScore = (a, b) => a.score - b.score || a.nTransfers - b.nTransfers;
      main.sort(byScore);
      more.sort((a, b) => a.totalMinExact - b.totalMinExact);
      const maxN = opts.maxOptions || MAX_OPTIONS;
      const options = main.slice(0, maxN);
      const moreOptions = main.slice(maxN).concat(more).slice(0, maxN);

      const fastestOpt = options.reduce((a, b) => (b.totalMinExact < a.totalMinExact ? b : a));
      const fewestOpt = options.reduce((a, b) => (b.nTransfers < a.nTransfers || (b.nTransfers === a.nTransfers && b.totalMinExact < a.totalMinExact) ? b : a));
      options.forEach((o, i) => {
        o.rank = i + 1;
        o.tags = [];
        if (i === 0) o.tags.push("suggested");
        if (o === fastestOpt) o.tags.push("fastest");
        if (o === fewestOpt) o.tags.push(o.nTransfers === 0 ? "direct" : "fewest-transfers");
      });
      moreOptions.forEach((o, i) => { o.rank = options.length + i + 1; o.tags = []; });

      return {
        from: from.id, to: to.id, date,
        fare: fareFor(from.id, to.id, opts.fareDate || date),
        options,
        moreOptions,
        suggested: options[0],
      };
    }

    function decorate(key, f, alsoVia) {
      const legs = f.legs.map((l) => {
        const L = lines[l.line];
        const stops = l.codes.map((c) => stationByCode.get(c).id);
        return {
          line: l.line, lineName: L.name, short: L.short, color: L.color, kind: L.kind,
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
      return {
        key, legs, transfers, alsoVia,
        lines: legs.map((l) => l.line),
        nTransfers: transfers.length, tapOuts,
        rideMin: Math.round(rideMin), transferMin: Math.round(transferMin),
        totalMinExact: rideMin + transferMin,
        totalMin: Math.round(rideMin + transferMin),
        km: +legs.reduce((a, l) => a + l.km, 0).toFixed(1),
        nStops: legs.reduce((a, l) => a + l.nStops, 0),
        score: rideMin + transferMin + transfers.length * SUGGEST_TRANSFER_PENALTY + tapOuts * SUGGEST_TAPOUT_PENALTY,
      };
    }

    // "Towards X" for lines with a single end-to-end path; null for loops.
    function towards(L, codes) {
      if (codes.length < 2) return null;
      for (const path of L.openPaths) {
        const i = path.indexOf(codes[0]), j = path.indexOf(codes[1]);
        if (i < 0 || j < 0 || Math.abs(i - j) !== 1) continue;
        if (path[0] === path[path.length - 1]) return null; // loop
        if (L.id === "CC") return null; // CCL runs as a loop since CCL6
        const end = j > i ? path[path.length - 1] : path[0];
        return stationByCode.get(end).id;
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
      lines,
      stations: network.stations,
      station: (id) => stationById.get(id),
      stationByCode: (c) => stationByCode.get(c),
      isStationOpen: (id) => stationLines.has(id),
      stationLines: (id) => stationLines.get(id) || {},
      codeOpen,
      codeOpensOn,
      plan,
      fareFor,
      fareCents,
      fareDistanceKm,
      scheduleFor,
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
