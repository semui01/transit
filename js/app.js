/* Singapore MRT Planner - UI. Depends on data/network.js, data/fares.js, js/planner.js */
(function () {
  "use strict";
  const N = window.MRT_NETWORK, F = window.MRT_FARES;
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const HUB_LINE = { STC: "SE", PTC: "PE" }; // LRT hub codes that are not a line id
  const DARK_TEXT = new Set(["#FA9E0D"]); // white on CCL orange is too faint
  const DEFAULT_EXAMPLE = ["jurong-east", "changi-airport"];

  const today = MRTPlanner.todayISO();
  const state = { from: null, to: null, date: today, sel: 0, res: null, example: false, moreOpen: false, showXfer: true };
  try { if (localStorage.getItem("mrt-show-transfers") === "0") state.showXfer = false; } catch (_) { /* storage unavailable */ }
  let planner = MRTPlanner.create(N, F, { date: state.date });
  const stationById = new Map(N.stations.map((s) => [s.id, s]));

  // ------------------------------------------------------------ helpers ---
  const codeLine = (code) => { const p = (code.match(/^[A-Z]+/) || [""])[0]; return N.lines[HUB_LINE[p] || p]; };
  function codeBadge(code) {
    const L = codeLine(code);
    const c = L ? L.color : "#748477";
    const soon = !planner.codeOpen(code);
    return `<span class="code${soon ? " soon" : ""}${DARK_TEXT.has(c) ? " dark-text" : ""}" style="--c:${c}" title="${esc(L ? L.name : code)}${soon ? " (opening soon)" : ""}">${esc(code)}</span>`;
  }
  const badges = (s) => `<span class="codes">${s.codes.map(codeBadge).join("")}</span>`;
  function lineChip(lineId) {
    const L = N.lines[lineId];
    return `<span class="chip${DARK_TEXT.has(L.color) ? " dark-text" : ""}" style="--c:${L.color}" title="${esc(L.name)}">${esc(L.short)}</span>`;
  }
  const money = (c) => "$" + (c / 100).toFixed(2);
  const lvlChip = (t, text) => `<span class="lvl lvl-${t.level.id}${t.tapOut ? " tap" : ""}">${text || `${t.min} min`}</span>`;
  function pairHtml(t) {
    if (t.fromCode === t.toCode) {
      const names = t.lines.map((l) => N.lines[l].name.match(/\((.*)\)/)).map((m) => (m ? m[1].replace(/ Loop$/, "") : ""));
      return `<span class="codes">${codeBadge(t.fromCode)}</span> <span class="pairtxt">${esc(names.join(" ↔ "))} loop</span>`;
    }
    return `<span class="codes">${codeBadge(t.fromCode)}<span class="arr" aria-hidden="true">↔</span>${codeBadge(t.toCode)}</span>`;
  }
  function fmtDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
  }
  const firstOpening = (s) => (s.opens ? Object.values(s.opens).sort()[0] : null);
  const nm = (id) => stationById.get(id).name;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  function listJoin(a) {
    if (a.length < 2) return a.join("");
    return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
  }

  // ------------------------------------------------------------- search ---
  function search(q) {
    q = q.trim().toLowerCase();
    const qc = q.replace(/\s+/g, "");
    const out = [];
    for (const s of N.stations) {
      if (!q) { out.push([0, s]); continue; }
      const n = s.name.toLowerCase();
      let score = -1;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 80;
      else if (n.split(/[\s-]+/).some((w) => w.startsWith(q))) score = 60;
      else if (n.includes(q)) score = 40;
      const codes = s.codes.map((c) => c.toLowerCase());
      if (codes.includes(qc)) score = Math.max(score, 95);
      else if (qc.length >= 2 && codes.some((c) => c.startsWith(qc))) score = Math.max(score, 50);
      if (s.zh && s.zh.includes(q)) score = Math.max(score, 70);
      if (score >= 0) out.push([score, s]);
    }
    out.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
    return out.slice(0, q ? 12 : 400).map((x) => x[1]);
  }

  function setupCombo(which) {
    const input = $(`#${which}-input`), list = $(`#${which}-list`);
    let items = [], active = -1;
    const restore = () => { input.value = state[which] ? nm(state[which]) : ""; };
    function render() {
      list.innerHTML = items.map((s, i) => {
        const soon = !planner.isStationOpen(s.id);
        return `<li id="${which}-opt-${i}" role="option" aria-selected="${i === active}" data-id="${s.id}">` +
          `<span class="nm">${esc(s.name)}${soon ? ` <span class="soon">opens ${fmtDate(firstOpening(s))}</span>` : ""}</span>${badges(s)}</li>`;
      }).join("");
      if (active >= 0) {
        input.setAttribute("aria-activedescendant", `${which}-opt-${active}`);
        const li = list.children[active];
        if (li) li.scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    }
    function open(q) {
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
    for (const s of N.stations) for (const [c, d] of Object.entries(s.opens || {})) {
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
    // [text, x, y, anchor, size]; keep the side of the station the map puts the label on
    return (s.label || []).map(([t, x, y, w, fs]) => {
      let anchor = "start", ax = x;
      if (x + w <= s.x + 3) { anchor = "end"; ax = x + w; }
      else if (x < s.x - 3) { anchor = "middle"; ax = x + w / 2; }
      return [t, ax, y, anchor, fs];
    });
  }
  function drawLabel(s, parent, extraClass) {
    for (const [t, x, y, anchor, fs] of labelRows(s)) {
      const tx = el("text", { x, y, "font-size": (fs * 0.95).toFixed(2), "text-anchor": anchor, class: "lbl" + (extraClass || ""), "data-st": s.id }, parent);
      tx.textContent = t;
    }
  }

  function drawMap() {
    svg.innerHTML = "";
    const base = el("g", { class: "base" }, svg);
    const gl = el("g", {}, base), gs = el("g", {}, base), gt = el("g", {}, base);
    layers.xfer = el("g", { class: "xferlayer" }, svg);
    layers.route = el("g", {}, svg);
    layers.pins = el("g", {}, svg);

    const ids = Object.keys(N.lines);
    const order = ids.filter((id) => N.lines[id].kind === "LRT").concat(ids.filter((id) => N.lines[id].kind !== "LRT"));
    for (const id of order) {
      const L = N.lines[id];
      for (const p of L.paths) {
        let run = [], runSoon = null;
        const flush = () => {
          if (run.length > 1) el("polyline", { class: "ln" + (runSoon ? " soon" : ""), points: run.map((q) => q.join(",")).join(" "), stroke: L.color, "stroke-width": L.kind === "LRT" ? 2.4 : 3.6 }, gl);
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
      } else {
        const L = codeLine(s.codes[0]);
        el("circle", { cx: s.x, cy: s.y, r: L.kind === "LRT" ? 1.9 : 2.5, class: "stn", stroke: open ? L.color : "currentColor", "stroke-width": 1.5, "stroke-dasharray": open ? "" : "1.4 1", style: open ? "" : "color:var(--muted)" }, g);
      }
      el("circle", { cx: s.x, cy: s.y, r: 7, class: "hit" }, g);
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
    $("#legend").innerHTML = items.map(([c, label]) => `<span><i style="--c:${c}"></i>${esc(label)}</span>`).join("") +
      (N.stations.some((s) => !planner.isStationOpen(s.id)) ? `<span><i class="dash"></i>Opening soon</span>` : "") +
      (state.showXfer ? `<div class="lg-x"><span class="lg-t">Transfer time</span>${MRTPlanner.LEVELS.map((l, i, a) =>
        `<span class="lvl lvl-${l.id}">${i === 0 ? `≤${l.max}` : l.max === Infinity ? `${a[i - 1].max + 1}+` : `${a[i - 1].max + 1}–${l.max}`}</span>`).join("")}<span class="lg-t">min</span><span class="lvl tap lvl-verylong">tap out</span></div>` : "");
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
    for (const id of onRoute) drawLabel(stationById.get(id), g, "");
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
      if (!id) return;
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
    for (const leg of o.legs) for (const c of leg.codes) {
      const [x, y] = pos(c);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
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
    popup.innerHTML = `<button type="button" class="x" data-act="close" aria-label="Close">&times;</button>` +
      `<h3>${esc(s.name)}${s.zh ? `<span class="zh">${esc(s.zh)}</span>` : ""}</h3>${badges(s)}` +
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

  function lineName(leg) { return leg.lineName; }
  function towardsText(leg) {
    if (leg.towards) return ` towards <b>${esc(nm(leg.towards))}</b>`;
    return leg.nStops ? ` (next stop: ${esc(nm(leg.nextStop))})` : "";
  }

  function stepsHtml(o) {
    let h = `<ol class="steps">`;
    o.legs.forEach((leg, i) => {
      const s = stationById.get(leg.from);
      if (i === 0) {
        h += `<li class="stop start"><span class="pinmark pin-a">A</span><span class="name">${esc(s.name)}</span>${codeBadge(leg.fromCode)}` +
          `<div class="sub">Board the <b>${esc(lineName(leg))}</b>${towardsText(leg)}</div></li>`;
      } else {
        const t = o.transfers[i - 1];
        h += `<li class="stop xfer"><span class="name">${esc(s.name)}</span><span class="codes">${codeBadge(t.fromCode)}${t.fromCode !== t.toCode ? codeBadge(t.toCode) : ""}</span>` +
          `<div class="sub">Transfer to the <b>${esc(lineName(leg))}</b>${towardsText(leg)}</div>` +
          `<div class="sub">${lvlChip(t, `about ${t.min} min · ${t.level.label}`)}${t.note && !t.tapOut ? ` ${esc(t.note)}` : ""}</div>` +
          (t.tapOut ? `<div class="sub"><span class="tapout">Tap out to transfer</span> Tap in again within 15 minutes and it still counts as one journey.</div>` : "") +
          `</li>`;
      }
      const mid = leg.stops.slice(1, -1);
      h += `<li class="ride" style="--c:${leg.color}">${plural(leg.nStops, "stop")} · ${Math.max(1, Math.round(leg.min))} min` +
        (mid.length ? `<details><summary>Stations passed</summary><ol>${mid.map((id) => `<li>${esc(nm(id))}</li>`).join("")}</ol></details>` : "") + `</li>`;
      if (i === o.legs.length - 1) {
        const e = stationById.get(leg.to);
        h += `<li class="stop end"><span class="pinmark pin-b">B</span><span class="name">${esc(e.name)}</span>${codeBadge(leg.toCode)}<div class="sub">Arrive</div></li>`;
      }
    });
    h += `</ol>`;
    const extra = [];
    if (o.alsoVia.length) {
      const alts = o.alsoVia.map((v) => v.map(nm).join(" and ")).slice(0, 2);
      extra.push(`Takes about the same time if you transfer at ${esc(alts.join(", or at "))} instead.`);
    }
    extra.push(o.nTransfers ? `${o.rideMin} min on trains and ${o.transferMin} min transferring.` : `${o.rideMin} min on the train.`);
    extra.push("Add a few minutes to wait for your first train.");
    return h + `<p class="breakdown">${extra.join(" ")}</p>`;
  }

  const TAG = { suggested: "Suggested", fastest: "Fastest", direct: "No transfers", "fewest-transfers": "Fewest transfers" };
  function optHtml(o, idx) {
    const sel = idx === state.sel;
    const seq = o.legs.map((l) => lineChip(l.line)).join('<span class="arr" aria-hidden="true">›</span>');
    const meta = [o.nTransfers ? `${plural(o.nTransfers, "transfer")} at ${esc(listJoin(o.transfers.map((t) => nm(t.station))))}` : "No transfers", plural(o.nStops, "stop")];
    if (o.tapOuts) meta.push("tap out to transfer");
    return `<article class="opt${sel ? " sel" : ""}" data-idx="${idx}">` +
      `<button type="button" class="opt-head" aria-expanded="${sel}" data-idx="${idx}">` +
      (o.tags.length ? `<span class="tags">${o.tags.map((t) => `<span class="tag ${t}">${TAG[t]}</span>`).join("")}</span>` : "") +
      `<span class="seq">${seq}</span><span class="time">${o.totalMin}<small>min</small></span>` +
      `<span class="meta">${meta.join(" · ")}</span></button>` +
      (sel ? `<div class="opt-body">${stepsHtml(o)}</div>` : "") + `</article>`;
  }

  function fareHtml(f) {
    if (!f) return "";
    return `<div class="fare"><div class="big"><small>Adult card fare</small>${money(f.adultCents)}</div>` +
      `<dl><dt>Tap in before 7:45am on weekdays</dt><dd>${money(f.earlyCents)}</dd>` +
      (f.next ? `<dt>From ${fmtDate(f.next.effective)}</dt><dd>${money(f.next.adultCents)}</dd>` : "") +
      `<dt>Fare distance</dt><dd>${f.km} km</dd></dl>` +
      `<p>Every route costs the same, because train fares are charged on the shortest distance between your two stations.` +
      (f.estimate ? ` This fare band is worked out from the published fare pattern; <a href="${esc(F.officialCalculator)}" target="_blank" rel="noopener">check LTA's fare page</a> if you need it to the cent.` : "") +
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
    h += fareHtml(res.fare);
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
        rs.map((t) => `<li><button type="button" class="grow" data-st="${t.station}"><span class="gname">${esc(nm(t.station))}</span>${pairHtml(t)}<span class="gmin">${t.min} min</span></button>` +
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

  // --------------------------------------------------------------- hash ---
  function updateHash() {
    const h = state.from && state.to && !state.example ? `#${state.from}--${state.to}` : "";
    try { history.replaceState(null, "", h || location.pathname + location.search); } catch (_) { /* ignore */ }
  }
  function readHash() {
    const m = (location.hash || "").slice(1).split("--");
    if (m.length === 2 && stationById.has(m[0]) && stationById.has(m[1])) return m;
    return null;
  }
  window.addEventListener("hashchange", () => {
    const h = readHash();
    if (h) { state.from = h[0]; state.to = h[1]; state.example = false; combos.from.restore(); combos.to.restore(); replan(); }
  });

  // ---------------------------------------------------------------- boot ---
  const meta = N.meta || {};
  $("#ver").textContent = `Map ${meta.systemMap || ""}`;
  const sched = planner.scheduleFor(today);
  $("#data-line").innerHTML = `Network: LTA system map ${esc(meta.systemMap || "")} (${esc(meta.systemMapFile || "")}), which includes Circle Line Stage 6. ` +
    `Station positions and track lengths come from that map and the open sgraildata project. Fares: ${esc(sched.label)}. Data generated ${esc(meta.generated || "")}.`;

  const h = readHash();
  if (h) { state.from = h[0]; state.to = h[1]; }
  else { [state.from, state.to] = DEFAULT_EXAMPLE; state.example = true; }
  combos.from.restore(); combos.to.restore();
  $("#today-btn").hidden = true;

  syncXferBtn();
  drawMap();
  bounds = computeBounds();
  renderNotices();
  renderGuide();
  requestAnimationFrame(() => {
    fitAll(false);
    replan({ animate: false });
  });
})();
