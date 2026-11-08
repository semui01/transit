/* Metro Planner - UI for every city. Depends on data/cities.js and js/planner.js; city data loads on demand. */
(function () {
  "use strict";
  const CITIES = window.MRT_CITY_LIST || [];
  const cityById = new Map(CITIES.map((c) => [c.id, c]));
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const HUB_LINE = { STC: "SE", PTC: "PE" }; // Singapore LRT hub codes that are not a line id

  const today = MRTPlanner.todayISO();
  const state = { city: null, from: null, to: null, date: today, sel: 0, res: null, example: false, moreOpen: false, showXfer: true };
  try { if (localStorage.getItem("mrt-show-transfers") === "0") state.showXfer = false; } catch (_) { /* storage unavailable */ }

  // current city
  let city = null, N = null, F = null, planner = null, stationById = new Map(), moneyFmt = null;

  // ------------------------------------------------------------ helpers ---
  const codeLine = (code) => { const p = (code.match(/^[A-Za-z]+/) || [""])[0]; return N.lines[HUB_LINE[p] || p]; };
  function textOn(hex) {
    // white text unless contrast with white is below 3:1
    const v = hex.replace("#", "").match(/../g).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    const L = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    return 1.05 / (L + 0.05) >= 3 ? "" : " dark-text";
  }
  function codeBadge(code) {
    const L = codeLine(code);
    const c = L ? L.color : "#748477";
    const soon = !planner.codeOpen(code);
    return `<span class="code${soon ? " soon" : ""}${textOn(c)}" style="--c:${c}" title="${esc(L ? L.name : code)}${soon ? " (opening soon)" : ""}">${esc(code)}</span>`;
  }
  const badges = (s) => `<span class="codes">${s.codes.map(codeBadge).join("")}</span>`;
  function lineChip(lineId) {
    const L = N.lines[lineId];
    return `<span class="chip${textOn(L.color)}" style="--c:${L.color}" title="${esc(L.name)}">${esc(L.short)}</span>`;
  }
  const money = (amount) => moneyFmt.format(amount / Math.pow(10, F.minorUnits ?? 2));
  const localName = (s) => s.ja || s.zh || "";
  const lvlChip = (t, text) => `<span class="lvl lvl-${t.level.id}${t.tapOut ? " tap" : ""}">${text || `${t.min} min`}</span>`;
  function pairHtml(t) {
    if (t.fromCode === t.toCode) {
      const names = t.lines.map((l) => { const m = N.lines[l].name.match(/\((.*)\)/); return m ? m[1] : N.lines[l].name; });
      return `<span class="codes">${codeBadge(t.fromCode)}</span> <span class="pairtxt">${esc(names.join(" ↔ "))}</span>`;
    }
    return `<span class="codes">${codeBadge(t.fromCode)}<span class="arr" aria-hidden="true">↔</span>${codeBadge(t.toCode)}</span>` +
      (t.toStation !== t.station ? ` <span class="pairtxt">${esc(nm(t.toStation))}</span>` : "");
  }
  function fmtDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  const firstOpening = (s) => (s.opens ? Object.values(s.opens).sort()[0] : null);
  const nm = (id) => stationById.get(id).name;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  function listJoin(a) {
    if (a.length < 2) return a.join("");
    return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  }
  const squash = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

  // ------------------------------------------------------------- search ---
  function search(q) {
    q = q.trim().toLowerCase();
    const qs = squash(q);
    const out = [];
    for (const s of N.stations) {
      if (!q) { out.push([0, s]); continue; }
      const n = s.name.toLowerCase(), ns = squash(s.name);
      let score = -1;
      if (n === q || (qs && ns === qs)) score = 100;
      else if (n.startsWith(q) || (qs && ns.startsWith(qs))) score = 80;
      else if (n.split(/[\s()-]+/).some((w) => w.startsWith(q))) score = 60;
      else if (n.includes(q) || (qs.length > 2 && ns.includes(qs))) score = 40;
      const codes = s.codes.map((c) => c.toLowerCase());
      if (codes.includes(qs)) score = Math.max(score, 95);
      else if (qs.length >= 2 && codes.some((c) => c.startsWith(qs))) score = Math.max(score, 50);
      const ln = localName(s);
      if (ln && ln.includes(q.trim())) score = Math.max(score, ln === q.trim() ? 98 : 70);
      if (score >= 0) out.push([score, s]);
    }
    out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
    return out.slice(0, q ? 12 : 400).map((x) => x[1]);
  }

  function setupCombo(which) {
    const input = $(`#${which}-input`), list = $(`#${which}-list`);
    let items = [], active = -1;
    const restore = () => { input.value = state[which] && stationById.has(state[which]) ? nm(state[which]) : ""; };
    function render() {
      list.innerHTML = items.map((s, i) => {
        const soon = !planner.isStationOpen(s.id);
        const ln = localName(s);
        return `<li id="${which}-opt-${i}" role="option" aria-selected="${i === active}" data-id="${s.id}">` +
          `<span class="nm">${esc(s.name)}${ln ? ` <span class="ln" lang="${city.id === "tokyo" ? "ja" : "zh"}">${esc(ln)}</span>` : ""}` +
          `${soon ? ` <span class="soon">opens ${fmtDate(firstOpening(s))}</span>` : ""}</span>${badges(s)}</li>`;
      }).join("");
      if (active >= 0) {
        input.setAttribute("aria-activedescendant", `${which}-opt-${active}`);
        const li = list.children[active];
        if (li) li.scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }
    function open(q) {
      if (!N) return;
      items = search(q);
      active = q.trim() && items.length ? 0 : -1;
      render();
      list.hidden = !items.length;
      input.setAttribute("aria-expanded", String(!list.hidden));
    }
    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    function choose(s) { close(); setStation(which, s.id); input.blur(); }
    input.addEventListener("input", () => open(input.value));
    input.addEventListener("focus", () => { input.select(); open(""); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) open(input.value); else { active = Math.min(items.length - 1, active + 1); render(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === "Enter") { e.preventDefault(); if (!list.hidden && items[Math.max(0, active)]) choose(items[Math.max(0, active)]); }
      else if (e.key === "Escape") { close(); restore(); }
    });
    input.addEventListener("blur", () => setTimeout(() => { close(); restore(); }, 120));
    list.addEventListener("mousedown", (e) => e.preventDefault());
    list.addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) choose(stationById.get(li.dataset.id)); });
    return { restore };
  }
  const combos = { from: setupCombo("from"), to: setupCombo("to") };

  function setStation(which, id, opts) {
    state[which] = id;
    state.example = false;
    combos[which].restore();
    hidePopup();
    replan(opts);
  }

  $("#search").addEventListener("submit", (e) => e.preventDefault());
  $("#swap").addEventListener("click", () => {
    [state.from, state.to] = [state.to, state.from];
    combos.from.restore(); combos.to.restore();
    replan({ fit: false });
  });

  // --------------------------------------------------------------- date ---
  const dateInput = $("#travel-date");
  dateInput.value = state.date;
  dateInput.addEventListener("change", () => { if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) setDate(dateInput.value); });
  $("#today-btn").addEventListener("click", () => setDate(today));
  function setDate(d) {
    state.date = d;
    dateInput.value = d;
    $("#today-btn").hidden = d === today;
    planner = MRTPlanner.create(N, F, { date: d });
    drawMap();
    renderNotices();
    renderGuide();
    replan({ fit: false });
  }

  function renderNotices() {
    const upcoming = new Map();
    for (const s of N.stations) for (const [, d] of Object.entries(s.opens || {})) {
      if (d > state.date) { if (!upcoming.has(d)) upcoming.set(d, new Set()); upcoming.get(d).add(s.name); }
    }
    let h = "";
    for (const [d, names] of [...upcoming].sort()) {
      h += `<div class="notice"><div><b>Opening ${fmtDate(d)}:</b> ${esc(listJoin([...names].sort()))}. ` +
        `<button type="button" data-date="${d}">Plan for that date</button></div></div>`;
    }
    const opened = N.stations.filter((s) => s.opens && Object.values(s.opens).some((d) => d <= state.date && d > today));
    if (opened.length) {
      h += `<div class="notice"><div>Planning for <b>${fmtDate(state.date)}</b>, including ${esc(listJoin(opened.map((s) => s.name)))}, which open before then.</div></div>`;
    }
    $("#notices").innerHTML = h;
    $(".when").hidden = !N.stations.some((s) => s.opens) && !(F.schedules && F.schedules.length > 1);
  }
  $("#notices").addEventListener("click", (e) => { const b = e.target.closest("[data-date]"); if (b) setDate(b.dataset.date); });

  // ----------------------------------------------------------------- map ---
  const svg = $("#map"), popup = $("#popup");
  const layers = {};
  let bounds = null;
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  function pos(code) {
    const s = planner.stationByCode(code);
    return (s.badges && s.badges[code]) || [s.x, s.y];
  }
  function labelRows(s) {
    // [text, x, y, anchor, size, minor]; keep the side of the station the map puts the label on
    return (s.label || []).map(([t, x, y, w, fs, minor]) => {
      let anchor = "start", ax = x;
      if (x + w <= s.x + 3) { anchor = "end"; ax = x + w; }
      else if (x < s.x - 3) { anchor = "middle"; ax = x + w / 2; }
      return [t, ax, y, anchor, fs, minor];
    });
  }
  function drawLabel(s, parent, extraClass, keep, nudge) {
    for (let [t, x, y, anchor, fs, minor] of labelRows(s)) {
      if (nudge) { // move clear of a start/end pin
        if (anchor === "start") x += nudge; else if (anchor === "end") x -= nudge; else y += y < s.y ? -nudge : nudge;
      }
      const tx = el("text", { x, y, "font-size": (fs * 0.95).toFixed(2), "text-anchor": anchor, class: "lbl" + (extraClass || "") + (minor && !keep ? " minor" : ""), "data-st": s.id }, parent);
      tx.textContent = t;
    }
  }

  function drawMap() {
    svg.innerHTML = "";
    const base = el("g", { class: "base" }, svg);
    const gw = el("g", {}, base), gl = el("g", {}, base), gs = el("g", {}, base);
    layers.xfer = el("g", { class: "xferlayer" }, svg);
    const gt = el("g", { class: "base" }, svg);
    layers.route = el("g", {}, svg);
    layers.pins = el("g", {}, svg);

    // walkways between linked stations
    for (const [a, b] of (N.meta && N.meta.walkLinks) || []) {
      const sa = stationById.get(a), sb = stationById.get(b);
      el("line", { x1: sa.x, y1: sa.y, x2: sb.x, y2: sb.y, class: "walk" }, gw);
    }

    const ids = Object.keys(N.lines);
    const order = ids.filter((id) => N.lines[id].kind === "LRT").concat(ids.filter((id) => N.lines[id].kind !== "LRT"));
    const lineW = (N.meta && N.meta.lineWidth) || 3.6;
    for (const id of order) {
      const L = N.lines[id];
      for (const p of L.paths) {
        let run = [], runSoon = null;
        const flush = () => {
          if (run.length > 1) el("polyline", { class: "ln" + (runSoon ? " soon" : ""), points: run.map((q) => q.join(",")).join(" "), stroke: L.color, "stroke-width": L.kind === "LRT" ? 2.4 : lineW }, gl);
        };
        for (let i = 0; i < p.stops.length - 1; i++) {
          const a = p.stops[i], b = p.stops[i + 1];
          const soon = !planner.codeOpen(a) || !planner.codeOpen(b);
          if (runSoon !== null && soon !== runSoon) { flush(); run = [run[run.length - 1]]; }
          if (!run.length) run.push(pos(a));
          run.push(pos(b));
          runSoon = soon;
        }
        flush();
      }
    }

    for (const s of N.stations) {
      if (s.x == null) continue;
      const g = el("g", { "data-st": s.id }, gs);
      const open = planner.isStationOpen(s.id);
      const pts = s.badges ? Object.values(s.badges) : null;
      if (pts && pts.length > 1) {
        const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((q) => q.join(",")).join(" ");
        el("polyline", { points: sorted, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": 8, style: "stroke:var(--ink)" }, g);
        el("polyline", { points: sorted, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": 5.4, style: "stroke:var(--station-fill)" }, g);
      } else if (s.codes.length > 1) {
        el("circle", { cx: s.x, cy: s.y, r: 3.3, "stroke-width": 1.4, style: "fill:var(--station-fill);stroke:var(--ink)" }, g);
      } else {
        const L = codeLine(s.codes[0]);
        el("circle", { cx: s.x, cy: s.y, r: L.kind === "LRT" ? 1.9 : 2.3, class: "stn", stroke: open ? L.color : "currentColor", "stroke-width": 1.4, "stroke-dasharray": open ? "" : "1.4 1", style: open ? "" : "color:var(--muted)" }, g);
      }
      el("circle", { cx: s.x, cy: s.y, r: 6, class: "hit" }, g);
      drawLabel(s, gt, open ? "" : " soon");
    }

    drawTransferPills();
    drawLegend();
    drawRoute(currentOption());
    drawPins();
  }

  // Minutes-to-transfer pill, centred on an interchange.
  function pill(parent, s, text, levelId, tapOut) {
    const fs = 6.6, w = text.length * fs * 0.49 + 5, h = fs + 3.2;
    const g = el("g", { class: `xp xp-${levelId}${tapOut ? " tap" : ""}`, "data-st": s.id }, parent);
    el("rect", { x: s.x - w / 2, y: s.y - h / 2, width: w, height: h, rx: h / 2, "stroke-width": 0.9 }, g);
    const t = el("text", { x: s.x, y: s.y + fs * 0.36, "text-anchor": "middle", "font-size": fs }, g);
    t.textContent = text;
    return g;
  }
  function drawTransferPills() {
    layers.xfer.innerHTML = "";
    svg.classList.toggle("show-xfer", state.showXfer);
    if (!state.showXfer) return;
    for (const s of N.stations) {
      const ts = planner.stationTransfers(s.id);
      if (!ts.length || s.x == null) continue;
      const lo = ts[0].min, hi = ts[ts.length - 1].min;
      pill(layers.xfer, s, lo === hi ? `${lo} min` : `${lo}–${hi} min`, planner.transferLevel(hi).id, ts.some((t) => t.tapOut));
    }
  }

  function computeBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of N.stations) {
      if (s.x == null) continue;
      x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
      for (const [, x, y, anchor, fs] of labelRows(s)) {
        const w = 40; // rough label width allowance
        const lx = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
        x0 = Math.min(x0, lx); x1 = Math.max(x1, lx + w); y0 = Math.min(y0, y - fs); y1 = Math.max(y1, y + 2);
      }
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function drawLegend() {
    const items = [], seen = new Set();
    for (const L of Object.values(N.lines)) {
      const label = L.kind === "LRT" ? "LRT" : L.name.replace(/ \(.*\)$/, "").replace(/ Line$/, "");
      if (!seen.has(label)) { seen.add(label); items.push([L.color, label]); }
    }
    items.sort((a, b) => (a[1] === "LRT") - (b[1] === "LRT"));
    const hasTap = (N.transfers || []).some((t) => t.tapOut);
    $("#legend").innerHTML = items.map(([c, label]) => `<span><i style="--c:${c}"></i>${esc(label)}</span>`).join("") +
      (N.stations.some((s) => !planner.isStationOpen(s.id)) ? `<span><i class="dash"></i>Opening soon</span>` : "") +
      ((N.meta && N.meta.walkLinks && N.meta.walkLinks.length) ? `<span><i class="dot"></i>Walkway</span>` : "") +
      (state.showXfer ? `<div class="lg-x"><span class="lg-t">Transfer time</span>${MRTPlanner.LEVELS.map((l, i, a) =>
        `<span class="lvl lvl-${l.id}">${i === 0 ? `≤${l.max}` : l.max === Infinity ? `${a[i - 1].max + 1}+` : `${a[i - 1].max + 1}–${l.max}`}</span>`).join("")}<span class="lg-t">min</span>` +
        (hasTap ? `<span class="lvl tap lvl-verylong">${esc(city.id === "tokyo" ? "outside gates" : "tap out")}</span>` : "") + `</div>` : "");
  }

  function currentOption() {
    const r = state.res;
    if (!r || !r.options) return null;
    return r.options.concat(r.moreOptions)[state.sel] || r.options[0];
  }

  function drawRoute(o) {
    layers.route.innerHTML = "";
    svg.classList.toggle("has-route", !!o);
    if (!o) { for (const p of layers.xfer.children) p.style.visibility = ""; return; }
    const g = layers.route;
    const onRoute = new Set();
    const walkLine = (a, b) => {
      const sa = stationById.get(a), sb = stationById.get(b);
      el("line", { x1: sa.x, y1: sa.y, x2: sb.x, y2: sb.y, class: "walk on-route" }, g);
    };
    if (o.startWalk) { walkLine(o.startWalk.from, o.startWalk.to); onRoute.add(o.startWalk.from); }
    if (o.endWalk) { walkLine(o.endWalk.from, o.endWalk.to); onRoute.add(o.endWalk.to); }
    for (const t of o.transfers) if (t.station !== t.toStation) walkLine(t.station, t.toStation);
    for (const leg of o.legs) {
      const pts = leg.codes.map(pos).map((q) => q.join(",")).join(" ");
      el("polyline", { points: pts, fill: "none", "stroke-width": 9, "stroke-linecap": "round", "stroke-linejoin": "round", style: "stroke:var(--map-bg)" }, g);
      el("polyline", { points: pts, fill: "none", stroke: leg.color, "stroke-width": 5.6, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
      leg.stops.forEach((id) => onRoute.add(id));
    }
    for (const leg of o.legs) {
      leg.codes.slice(1, -1).forEach((c) => {
        const [x, y] = pos(c);
        el("circle", { cx: x, cy: y, r: 1.8, fill: "#fff", stroke: leg.color, "stroke-width": 1.2, "data-st": planner.stationByCode(c).id }, g);
      });
    }
    for (const id of onRoute) drawLabel(stationById.get(id), g, "", true, id === state.from || id === state.to ? 3.5 : 0);
    // pills under the route line would be half covered; the route's own transfers get their own pill
    for (const p of layers.xfer.children) p.style.visibility = onRoute.has(p.dataset.st) ? "hidden" : "";
    for (const t of o.transfers) {
      const s = stationById.get(t.station);
      if (state.showXfer) pill(g, s, `${t.min} min`, t.level.id, t.tapOut).classList.add("on-route");
      else el("circle", { cx: s.x, cy: s.y, r: 5, "stroke-width": 2.2, style: "fill:var(--station-fill);stroke:var(--ink)", "data-st": s.id }, g);
    }
  }

  function drawPins() {
    const g = layers.pins;
    g.innerHTML = "";
    const pin = (id, letter, cls) => {
      if (!id || !stationById.has(id)) return;
      const s = stationById.get(id);
      const pg = el("g", { "data-st": id }, g);
      el("circle", { cx: s.x, cy: s.y, r: 6.4, "stroke-width": 1.6, style: cls === "a" ? "fill:var(--ink);stroke:var(--map-bg)" : "fill:var(--signal);stroke:var(--signal-ink)" }, pg);
      const t = el("text", { x: s.x, y: s.y + 2.7, "text-anchor": "middle", "font-size": 7.5, "font-weight": 700, style: `font-family:var(--font-display);fill:${cls === "a" ? "var(--map-bg)" : "var(--signal-ink)"};pointer-events:none` }, pg);
      t.textContent = letter;
    };
    pin(state.from, "A", "a");
    pin(state.to, "B", "b");
  }

  // ---------------------------------------------------------- view/zoom ---
  const MIN_W = 70;
  function size() { return { cw: svg.clientWidth || 800, ch: svg.clientHeight || 600 }; }
  function applyView() {
    svg.setAttribute("viewBox", `${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}`);
    // hide minor labels while zoomed far out (only maps that mark labels as minor)
    if (bounds) svg.classList.toggle("lod-far", view.w > bounds.w * 0.62);
    positionPopup();
  }
  // Fit box b (map units) into the part of the map not covered by the hint, tools and legend.
  function fitBox(b, pad, minW) {
    const { cw, ch } = size();
    const legend = $("#legend");
    const legendH = legend && legend.offsetParent ? legend.offsetHeight + 20 : 0;
    const top = $(".map-top");
    const ins = { t: (top ? top.offsetHeight : 40) + 20, r: 58, b: Math.max(16, legendH), l: 16 };
    const aw = Math.max(80, cw - ins.l - ins.r), ah = Math.max(80, ch - ins.t - ins.b);
    const bw = Math.max(b.w + 2 * pad, minW || 0), bh = b.h + 2 * pad;
    const k = Math.max(bw / aw, bh / ah); // map units per pixel
    return {
      x: b.x + b.w / 2 - (ins.l + aw / 2) * k,
      y: b.y + b.h / 2 - (ins.t + ah / 2) * k,
      w: cw * k, h: ch * k,
    };
  }
  let anim = null;
  function goTo(target, animate) {
    if (anim) cancelAnimationFrame(anim);
    if (!animate || reducedMotion) { Object.assign(view, target); applyView(); return; }
    const from = { ...view }, t0 = performance.now(), dur = 380;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      for (const key of ["x", "y", "w", "h"]) view[key] = from[key] + (target[key] - from[key]) * e;
      applyView();
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }
  function fitAll(animate) { goTo(fitBox(bounds, 4), animate); }
  function fitRoute(o, animate) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = ([x, y]) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    for (const leg of o.legs) for (const c of leg.codes) add(pos(c));
    for (const w of [o.startWalk, o.endWalk]) if (w) { const a = stationById.get(w.from), b = stationById.get(w.to); add([a.x, a.y]); add([b.x, b.y]); }
    goTo(fitBox({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, 36, 360), animate);
  }
  function zoomAt(px, py, f) {
    const { cw, ch } = size();
    const ux = view.x + (px / cw) * view.w, uy = view.y + (py / ch) * view.h;
    const w = Math.min(Math.max(view.w * f, MIN_W), bounds.w * 2);
    const h = w * (ch / cw);
    view.x = ux - (px / cw) * w; view.y = uy - (py / ch) * h; view.w = w; view.h = h;
    applyView();
  }
  $("#zoom-in").addEventListener("click", () => { const { cw, ch } = size(); zoomAt(cw / 2, ch / 2, 1 / 1.5); });
  $("#zoom-out").addEventListener("click", () => { const { cw, ch } = size(); zoomAt(cw / 2, ch / 2, 1.5); });
  $("#zoom-fit").addEventListener("click", () => fitAll(true));

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.0018)));
  }, { passive: false });

  const pointers = new Map();
  let gesture = null;
  function startGesture(target) {
    const pts = [...pointers.values()];
    const r = svg.getBoundingClientRect();
    gesture = { target, moved: gesture ? gesture.moved : 0, view0: { ...view }, rect: r, p0: pts.map((p) => ({ ...p })) };
  }
  svg.addEventListener("pointerdown", (e) => {
    if (e.button && e.button !== 0) return;
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const target = pointers.size === 1 ? (e.target.closest && e.target.closest("[data-st]")) : null;
    if (pointers.size === 1) gesture = null;
    startGesture(target);
    if (pointers.size > 1) gesture.moved = 99;
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.values()];
    const { cw, ch } = size();
    if (pts.length === 1 && gesture.p0.length === 1) {
      const dx = pts[0].x - gesture.p0[0].x, dy = pts[0].y - gesture.p0[0].y;
      gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
      if (gesture.moved > 5) {
        svg.classList.add("dragging");
        const k = gesture.view0.w / cw;
        view.x = gesture.view0.x - dx * k; view.y = gesture.view0.y - dy * k;
        applyView();
      }
    } else if (pts.length >= 2 && gesture.p0.length >= 2) {
      const d0 = Math.hypot(gesture.p0[0].x - gesture.p0[1].x, gesture.p0[0].y - gesture.p0[1].y) || 1;
      const d1 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const m0 = { x: (gesture.p0[0].x + gesture.p0[1].x) / 2 - gesture.rect.left, y: (gesture.p0[0].y + gesture.p0[1].y) / 2 - gesture.rect.top };
      const m1 = { x: (pts[0].x + pts[1].x) / 2 - gesture.rect.left, y: (pts[0].y + pts[1].y) / 2 - gesture.rect.top };
      const v0 = gesture.view0;
      const w = Math.min(Math.max(v0.w * (d0 / d1), MIN_W), bounds.w * 2), h = w * (ch / cw);
      const ux = v0.x + (m0.x / cw) * v0.w, uy = v0.y + (m0.y / ch) * v0.h;
      view.x = ux - (m1.x / cw) * w; view.y = uy - (m1.y / ch) * h; view.w = w; view.h = h;
      applyView();
    }
  });
  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      svg.classList.remove("dragging");
      if (gesture && gesture.moved <= 5 && e.type === "pointerup") {
        if (gesture.target) { showPopup(gesture.target.dataset.st); $("#map-hint").hidden = true; }
        else hidePopup();
      }
      gesture = null;
    } else startGesture(null);
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  new ResizeObserver(() => {
    const { cw, ch } = size();
    const cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    view.h = view.w * (ch / cw);
    view.x = cx - view.w / 2; view.y = cy - view.h / 2;
    applyView();
  }).observe(svg);

  // -------------------------------------------------------------- popup ---
  let popupStation = null;
  function showPopup(id) {
    const s = stationById.get(id);
    popupStation = id;
    const open = planner.isStationOpen(id);
    const d = firstOpening(s);
    const ln = localName(s);
    popup.innerHTML = `<button type="button" class="x" data-act="close" aria-label="Close">&times;</button>` +
      `<h3>${esc(s.name)}${ln ? `<span class="zh" lang="${city.id === "tokyo" ? "ja" : "zh"}">${esc(ln)}</span>` : ""}</h3>${badges(s)}` +
      transfersListHtml(planner.stationTransfers(id)) +
      (open
        ? `<div class="acts"><button type="button" class="a" data-act="from">Start here</button><button type="button" class="b" data-act="to">Go here</button></div>`
        : `<p class="soonnote">Opens on ${fmtDate(d)}.</p><div class="acts"><button type="button" class="a" data-act="date" data-date="${d}">Plan for ${fmtDate(d)}</button></div>`);
    popup.hidden = false;
    positionPopup();
    const first = popup.querySelector(".acts button");
    if (first) first.focus({ preventScroll: true });
  }
  function transfersListHtml(ts) {
    if (!ts.length) return "";
    return `<ul class="xlist" aria-label="Transfers at this station">` + ts.map((t) =>
      `<li><div class="xrow">${pairHtml(t)}${lvlChip(t, `${t.min} min · ${t.level.label}`)}</div>` +
      (t.note ? `<div class="xnote">${esc(t.note)}</div>` : "") + `</li>`).join("") + `</ul>`;
  }
  function hidePopup() { popup.hidden = true; popupStation = null; }
  function positionPopup() {
    if (popup.hidden || !popupStation) return;
    const s = stationById.get(popupStation);
    const { cw, ch } = size();
    const px = ((s.x - view.x) / view.w) * cw, py = ((s.y - view.y) / view.h) * ch;
    const pw = popup.offsetWidth || 220, ph = popup.offsetHeight || 110;
    popup.style.visibility = px < 0 || px > cw || py < 0 || py > ch ? "hidden" : "visible";
    const below = py < ph + 24;
    popup.style.left = Math.min(Math.max(px, pw / 2 + 8), cw - pw / 2 - 8) + "px";
    popup.style.top = (below ? py + 14 : py) + "px";
    popup.style.transform = below ? "translate(-50%, 0)" : "";
    popup.classList.toggle("below", below);
  }
  popup.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = popupStation;
    if (b.dataset.act === "close") hidePopup();
    else if (b.dataset.act === "from") setStation("from", id);
    else if (b.dataset.act === "to") setStation("to", id);
    else if (b.dataset.act === "date") { hidePopup(); setDate(b.dataset.date); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !popup.hidden) hidePopup(); });

  // ----------------------------------------------------------- planning ---
  function replan(opts) {
    opts = opts || {};
    if (!state.from || !state.to) {
      state.res = null;
      renderResults(); drawRoute(null); drawPins(); updateHash();
      return;
    }
    state.res = planner.plan(state.from, state.to);
    state.sel = 0;
    state.moreOpen = false;
    renderResults();
    const o = currentOption();
    drawRoute(o);
    drawPins();
    if (o && opts.fit !== false) fitRoute(o, opts.animate !== false);
    updateHash();
  }

  function towardsText(leg) {
    if (leg.towards) return ` towards <b>${esc(nm(leg.towards))}</b>`;
    return leg.nStops ? ` (next stop: ${esc(nm(leg.nextStop))})` : "";
  }
  const tapOutHtml = () => `<div class="sub"><span class="tapout">${esc(city.tapOutLabel || "Tap out to transfer")}</span> ${esc(city.tapOutNote || "")}</div>`;

  function stepsHtml(o) {
    let h = `<ol class="steps">`;
    if (o.startWalk) {
      h += `<li class="stop start"><span class="pinmark pin-a">A</span><span class="name">${esc(nm(o.startWalk.from))}</span>${badges(stationById.get(o.startWalk.from))}` +
        `<div class="sub">Walk to <b>${esc(nm(o.startWalk.to))}</b> station · about ${o.startWalk.min} min</div></li><li class="walk"></li>`;
    }
    o.legs.forEach((leg, i) => {
      const s = stationById.get(leg.from);
      if (i === 0) {
        h += `<li class="stop ${o.startWalk ? "xfer" : "start"}">${o.startWalk ? "" : `<span class="pinmark pin-a">A</span>`}<span class="name">${esc(s.name)}</span>${codeBadge(leg.fromCode)}` +
          `<div class="sub">Board the <b>${esc(leg.lineName)}</b>${towardsText(leg)}</div></li>`;
      } else {
        const t = o.transfers[i - 1];
        const walk = t.station !== t.toStation;
        h += `<li class="stop xfer"><span class="name">${esc(nm(t.station))}</span><span class="codes">${codeBadge(t.fromCode)}${t.fromCode !== t.toCode ? codeBadge(t.toCode) : ""}</span>` +
          `<div class="sub">${walk ? `Walk to <b>${esc(nm(t.toStation))}</b> and transfer` : "Transfer"} to the <b>${esc(leg.lineName)}</b>${towardsText(leg)}</div>` +
          `<div class="sub">${lvlChip(t, `about ${t.min} min · ${t.level.label}`)}${t.note && !t.tapOut ? ` ${esc(t.note)}` : ""}</div>` +
          (t.tapOut ? tapOutHtml() : "") + `</li>`;
      }
      const mid = leg.stops.slice(1, -1);
      h += `<li class="ride" style="--c:${leg.color}">${plural(leg.nStops, "stop")} · ${Math.max(1, Math.round(leg.min))} min` +
        (mid.length ? `<details><summary>Stations passed</summary><ol>${mid.map((id) => `<li>${esc(nm(id))}</li>`).join("")}</ol></details>` : "") + `</li>`;
      if (i === o.legs.length - 1) {
        if (o.endWalk) {
          h += `<li class="stop xfer"><span class="name">${esc(nm(leg.to))}</span>${codeBadge(leg.toCode)}<div class="sub">Get off and walk to <b>${esc(nm(o.endWalk.to))}</b> · about ${o.endWalk.min} min</div></li><li class="walk"></li>` +
            `<li class="stop end"><span class="pinmark pin-b">B</span><span class="name">${esc(nm(o.endWalk.to))}</span><div class="sub">Arrive</div></li>`;
        } else {
          h += `<li class="stop end"><span class="pinmark pin-b">B</span><span class="name">${esc(nm(leg.to))}</span>${codeBadge(leg.toCode)}<div class="sub">Arrive</div></li>`;
        }
      }
    });
    h += `</ol>`;
    const extra = [];
    if (o.alsoVia.length) {
      const alts = o.alsoVia.map((v) => v.map(nm).join(" and ")).slice(0, 2);
      extra.push(`Takes about the same time if you transfer at ${esc(alts.join(", or at "))} instead.`);
    }
    const parts = [`${o.rideMin} min on trains`];
    if (o.nTransfers) parts.push(`${o.transferMin} min transferring`);
    if (o.walkMin) parts.push(`${Math.round(o.walkMin)} min walking`);
    extra.push(listJoin(parts) + ".");
    extra.push("Add a few minutes to wait for your first train.");
    if (o.fare && o.fare.kind === "operator") extra.push(`Fare for this route: ${money(o.fare.ic)} by IC card.`);
    return h + `<p class="breakdown">${extra.join(" ")}</p>`;
  }

  const TAG = { suggested: "Suggested", fastest: "Fastest", direct: "No transfers", "fewest-transfers": "Fewest transfers", cheapest: "Cheapest" };
  function optHtml(o, idx) {
    const sel = idx === state.sel;
    const seq = o.legs.map((l) => lineChip(l.line)).join('<span class="arr" aria-hidden="true">›</span>');
    const meta = [];
    if (o.fare && o.fare.kind === "operator") meta.push(`<b class="ofare">${money(o.fare.ic)}</b>`);
    meta.push(o.nTransfers ? `${plural(o.nTransfers, "transfer")} at ${esc(listJoin(o.transfers.map((t) => nm(t.station))))}` : "No transfers");
    meta.push(plural(o.nStops, "stop"));
    if (o.tapOuts) meta.push(esc((city.tapOutLabel || "tap out").toLowerCase()));
    return `<article class="opt${sel ? " sel" : ""}" data-idx="${idx}">` +
      `<button type="button" class="opt-head" aria-expanded="${sel}" data-idx="${idx}">` +
      (o.tags.length ? `<span class="tags">${o.tags.map((t) => `<span class="tag ${t}">${TAG[t]}</span>`).join("")}</span>` : "") +
      `<span class="seq">${seq}</span><span class="time">${o.totalMin}<small>min</small></span>` +
      `<span class="meta">${meta.join(" · ")}</span></button>` +
      (sel ? `<div class="opt-body">${stepsHtml(o)}</div>` : "") + `</article>`;
  }

  function fareHtml(f) {
    if (!f) return "";
    if (f.kind === "operator") {
      const rows = f.segments.map((s) => `<dt>${esc(s.name)} · ${s.km} km</dt><dd>${money(s.ic)}</dd>`).join("") +
        (f.discount ? `<dt>Discount for changing operator</dt><dd>−${money(f.discount)}</dd>` : "") +
        `<dt>Paper ticket</dt><dd>${money(f.ticket)}</dd>`;
      return `<div class="fare"><div class="big"><small>${esc(city.fareLabel || "Fare")}</small>${money(f.ic)}</div><dl>${rows}</dl>` +
        `<p>Fares here depend on the route. Tokyo Metro and Toei each charge by distance, and changing between the two takes ${money(70)} off. ` +
        `This is the fare for the selected route.${f.estimate ? " It changes operator more than once, so check the fare at the station." : ""} ` +
        `Distances are worked out from the map, so a trip close to a fare boundary may cost one band more or less; <a href="${esc(F.officialCalculator)}" target="_blank" rel="noopener">official fares</a>.</p></div>`;
    }
    return `<div class="fare"><div class="big"><small>${esc(city.fareLabel || "Fare")}</small>${money(f.adultCents)}</div>` +
      `<dl><dt>Tap in before 7:45am on weekdays</dt><dd>${money(f.earlyCents)}</dd>` +
      (f.next ? `<dt>From ${fmtDate(f.next.effective)}</dt><dd>${money(f.next.adultCents)}</dd>` : "") +
      `<dt>Fare distance</dt><dd>${f.km} km</dd></dl>` +
      `<p>Every route costs the same, because train fares are charged on the shortest distance between your two stations.` +
      (f.estimate ? ` This fare band is worked out from the published fare pattern; <a href="${esc(F.officialCalculator)}" target="_blank" rel="noopener">check the official fare</a> if you need it to the cent.` : "") +
      `</p></div>`;
  }

  function renderResults() {
    const R = $("#results"), res = state.res;
    if (!state.from || !state.to) {
      R.innerHTML = `<div class="error"><b>Choose where you're going</b><p>Type a station name or code above, or select stations on the map.</p></div>`;
      return;
    }
    if (res.error) {
      const s = [state.from, state.to].map((id) => stationById.get(id)).find((x) => !planner.isStationOpen(x.id));
      const d = s && firstOpening(s);
      R.innerHTML = `<div class="error"><b>${esc(res.error.replace(/ \(opens [\d-]+\)/, ""))}</b>` +
        (d ? `<p>${esc(s.name)} opens on ${fmtDate(d)}. <button type="button" class="linkish" data-date="${d}">Plan for ${fmtDate(d)}</button></p>` : "") + `</div>`;
      return;
    }
    let h = "";
    if (state.example) h += `<p class="example">Example journey. Choose your own stations above or on the map.</p>`;
    h += fareHtml(res.fareModel === "operator-distance" ? (currentOption() || res.options[0]).fare : res.fare);
    h += `<h2>${res.options.length > 1 ? `${res.options.length} route options` : "Your route"}</h2>`;
    res.options.forEach((o, i) => { h += optHtml(o, i); });
    if (res.moreOptions.length) {
      h += `<details class="more"${state.moreOpen ? " open" : ""}><summary>${plural(res.moreOptions.length, "more route")}, slower or with more transfers</summary><div>` +
        res.moreOptions.map((o, j) => optHtml(o, res.options.length + j)).join("") + `</div></details>`;
    }
    R.innerHTML = h;
  }

  $("#results").addEventListener("click", (e) => {
    const head = e.target.closest(".opt-head");
    if (head) {
      const idx = +head.dataset.idx;
      state.sel = idx;
      const more = $("#results .more");
      if (more) state.moreOpen = more.open;
      renderResults();
      const o = currentOption();
      drawRoute(o);
      fitRoute(o, true);
      const card = $(`#results .opt[data-idx="${idx}"] .opt-head`);
      if (card) card.focus({ preventScroll: true });
      return;
    }
    const d = e.target.closest("[data-date]");
    if (d) setDate(d.dataset.date);
  });
  $("#results").addEventListener("toggle", (e) => { if (e.target.classList && e.target.classList.contains("more")) state.moreOpen = e.target.open; }, true);

  // ---------------------------------------------------- interchange guide ---
  const LEVEL_HEAD = { quick: "3 min or less", moderate: "4 to 5 min", long: "6 to 7 min", verylong: "8 min or more" };
  function renderGuide() {
    const rows = planner.interchangeGuide();
    let h = `<p class="gintro">Transfer times include walking between platforms and the average wait for the next train. ` +
      `The planner counts them when it compares routes, so a route with one long transfer can lose to a route with two quick ones.</p>`;
    for (const L of MRTPlanner.LEVELS) {
      const rs = rows.filter((t) => t.level.id === L.id);
      if (!rs.length) continue;
      h += `<div class="ggroup"><h3><span class="lvl lvl-${L.id}">${esc(L.label)}</span> ${LEVEL_HEAD[L.id]}</h3><ul>` +
        rs.map((t) => `<li><button type="button" class="grow" data-st="${t.station}"><span class="gname">${esc(nm(t.station))}${t.toStation !== t.station ? ` ↔ ${esc(nm(t.toStation))}` : ""}</span>` +
          `<span class="codes">${codeBadge(t.fromCode)}${t.fromCode !== t.toCode ? `<span class="arr" aria-hidden="true">↔</span>${codeBadge(t.toCode)}` : ""}</span><span class="gmin">${t.min} min</span></button>` +
          (t.note ? `<p class="xnote">${esc(t.note)}</p>` : "") + `</li>`).join("") + `</ul></div>`;
    }
    $("#guide-body").innerHTML = h;
  }
  $("#guide-body").addEventListener("click", (e) => {
    const b = e.target.closest(".grow");
    if (b) focusStation(b.dataset.st);
  });
  function focusStation(id) {
    const s = stationById.get(id);
    const { cw, ch } = size();
    const w = Math.min(view.w, 420), h = w * (ch / cw);
    goTo({ x: s.x - w / 2, y: s.y - h / 2, w, h }, true);
    showPopup(id);
    const r = $("#mapwrap").getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) $("#mapwrap").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  }

  // transfer pill toggle
  const xferBtn = $("#xfer-toggle");
  function syncXferBtn() { xferBtn.setAttribute("aria-pressed", String(state.showXfer)); }
  xferBtn.addEventListener("click", () => {
    state.showXfer = !state.showXfer;
    try { localStorage.setItem("mrt-show-transfers", state.showXfer ? "1" : "0"); } catch (_) { /* ignore */ }
    syncXferBtn();
    drawTransferPills();
    drawLegend();
    drawRoute(currentOption());
    drawPins();
  });
  syncXferBtn();

  // ----------------------------------------------------------- cities ---
  const loaded = new Map();
  function loadScript(src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { loaded.delete(src); reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(s);
      }));
    }
    return loaded.get(src);
  }
  async function loadCityData(id) {
    const D = (window.MRT_DATA = window.MRT_DATA || {});
    if (!D[id + "/network"]) await loadScript(`data/${id}/network.js`);
    if (!D[id + "/fares"]) await loadScript(`data/${id}/fares.js`);
    return { network: D[id + "/network"], fares: D[id + "/fares"] };
  }

  async function openCity(id) {
    if (state.city === id) return false;
    const c = cityById.get(id);
    $("#planner").setAttribute("aria-busy", "true");
    const { network, fares } = await loadCityData(id);
    city = c; N = network; F = fares;
    state.city = id;
    stationById = new Map(N.stations.map((s) => [s.id, s]));
    moneyFmt = new Intl.NumberFormat(c.locale || "en", { style: "currency", currency: F.currency, minimumFractionDigits: F.minorUnits ?? 2, maximumFractionDigits: F.minorUnits ?? 2 });
    planner = MRTPlanner.create(N, F, { date: state.date });
    state.from = state.to = null; state.res = null;
    hidePopup();
    renderCityChrome();
    drawMap();
    bounds = computeBounds();
    renderNotices();
    renderGuide();
    $("#planner").removeAttribute("aria-busy");
    return true;
  }

  function renderCityChrome() {
    $("#city-title").textContent = city.title;
    $("#city-mark").innerHTML = city.colors.slice(0, 3).map((c) => `<i style="background:${c}"></i>`).join("");
    const meta = N.meta || {};
    $("#ver").textContent = city.versionLabel || (meta.systemMap ? `Map ${meta.systemMap}` : "");
    const sched = planner.scheduleFor(today);
    const fareLine = sched ? `Fares: ${sched.label}.` : `Fares: ${Object.values(F.operators || {}).map((o) => o.name).join(" and ")} regular fares.`;
    $("#about-city").innerHTML = (city.about || []).map((p) => `<p>${p}</p>`).join("") + `<p>${esc(fareLine)} Data generated ${esc(meta.generated || "")}.</p>`;
    document.title = `${city.title} · Interchange`;
    $("#map").setAttribute("aria-label", `${city.title} network map. Select a station to start or end your journey there.`);
    $("#from-input").placeholder = city.id === "tokyo" ? "Station name or code, e.g. Shinjuku, G09, 渋谷" : "Station name or code, e.g. NS24";
  }

  // --------------------------------------------------------------- home ---
  function renderHome() {
    $("#city-cards").innerHTML = CITIES.map((c) =>
      `<a class="city" href="#${c.id}" data-city="${c.id}">` +
      `<span class="stripes" aria-hidden="true">${c.colors.map((col) => `<i style="background:${col}"></i>`).join("")}</span>` +
      `<span class="cname">${esc(c.name)}</span><span class="clocal">${esc(c.local)}</span>` +
      `<span class="csys">${esc(c.system)}</span><span class="csum">${esc(c.summary)}</span>` +
      `<span class="cgo">Plan a journey <span aria-hidden="true">→</span></span></a>`).join("") +
      `<div class="city soon-card"><span class="cname">More cities</span><span class="csum">Each city is one data folder, so new ones slot in here.</span></div>`;
  }

  // ------------------------------------------------------------ routing ---
  function updateHash() {
    if (!state.city) return;
    const h = state.from && state.to && !state.example ? `#${state.city}--${state.from}--${state.to}` : `#${state.city}`;
    try { history.replaceState(null, "", h); } catch (_) { /* ignore */ }
  }
  function parseHash() {
    const parts = (location.hash || "").slice(1).split("--").filter(Boolean);
    if (!parts.length) return { city: null };
    if (cityById.has(parts[0])) return { city: parts[0], from: parts[1], to: parts[2] };
    if (parts.length === 2) return { city: "singapore", from: parts[0], to: parts[1] }; // links from before Tokyo was added
    return { city: null };
  }
  function showHome() {
    $("#home").hidden = false;
    $("#planner").hidden = true;
    document.title = "Interchange";
    window.scrollTo(0, 0);
  }
  async function route() {
    const r = parseHash();
    if (!r.city) { showHome(); return; }
    $("#home").hidden = true;
    $("#planner").hidden = false;
    let switched;
    try { switched = await openCity(r.city); }
    catch (err) {
      $("#results").innerHTML = `<div class="error"><b>${esc(err.message)}</b><p>Check your connection and reload the page.</p></div>`;
      return;
    }
    const valid = r.from && r.to && stationById.has(r.from) && stationById.has(r.to);
    if (valid) { state.from = r.from; state.to = r.to; state.example = false; }
    else if (switched || !state.from) { [state.from, state.to] = city.example; state.example = true; }
    combos.from.restore(); combos.to.restore();
    requestAnimationFrame(() => {
      if (switched) fitAll(false);
      replan({ animate: !switched });
    });
  }
  window.addEventListener("hashchange", route);

  // ---------------------------------------------------------------- boot ---
  $("#today-btn").hidden = true;
  renderHome();
  route();
})();
