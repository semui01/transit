// Reduce the planner's own data to what the film draws, using the planner's own engine.
// Inputs are this repo's own files: ../../data/network.js (stations, lines, distances, transfers),
// ../../data/fares.js (fare schedules) and ../../js/planner.js (routing + fares). The film was made
// from commit 87e90c7 (2026-11-08); re-running this after the data changes updates the film's numbers.
// usage: node data/prepare.mjs   → writes data.js (window.DATA) and data/facts.json (numbers quoted in NOTES.md)
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, '..', '..');
const SRC = { 'network.js': 'data/network.js', 'fares.js': 'data/fares.js', 'planner.js': 'js/planner.js' };
const src = f => fs.readFileSync(path.join(root, SRC[f]), 'utf8');

// network.js is one JSON object assigned to window.MRT_NETWORK: parse it rather than run it.
const ns = src('network.js');
const N = JSON.parse(ns.slice(ns.indexOf('{'), ns.lastIndexOf('}') + 1));
// fares.js (object literal with comments) and planner.js (pure functions) were read in full before use.
const box = { window: {}, self: {} };
vm.runInNewContext(src('fares.js'), box);
vm.runInNewContext(src('planner.js'), box);
const F = box.window.MRT_FARES, P = box.self.MRTPlanner;

const TODAY = '2026-11-08', OPEN_DAY = '2026-12-26';
const pl = P.create(N, F, { date: TODAY });
const plOpen = P.create(N, F, { date: OPEN_DAY });

// --- geometry exactly as the app draws it (app.js pos(): interchange badge position, else station x/y)
const posOf = code => { const s = pl.stationByCode(code); return (s.badges && s.badges[code]) || [s.x, s.y]; };
const lines = {};
for (const [id, L] of Object.entries(N.lines)) {
  lines[id] = {
    name: L.name, short: L.short, color: L.color, kind: L.kind,
    paths: L.paths.map(p => ({
      codes: p.stops,
      pts: p.stops.map(posOf),
      soon: p.stops.map(c => !pl.codeOpen(c)),
    })),
  };
}
const stations = N.stations.map(s => ({
  id: s.id, name: s.name, codes: s.codes, x: s.x, y: s.y,
  badges: s.badges || null,
  open: pl.isStationOpen(s.id),
  opens: s.opens ? Object.values(s.opens).sort()[0] : null,
  kind: (N.lines[(s.codes[0].match(/^[A-Z]+/) || [''])[0]] || { kind: 'LRT' }).kind,
}));

// --- the app's default example journey (app.js DEFAULT_EXAMPLE)
const FROM = 'jurong-east', TO = 'changi-airport';
const res = pl.plan(FROM, TO);
const opt = o => ({
  lines: o.lines, totalMin: o.totalMin, rideMin: o.rideMin, transferMin: o.transferMin, nTransfers: o.nTransfers,
  nStops: o.nStops, km: o.km, tags: o.tags,
  legs: o.legs.map(l => ({ line: l.line, short: l.short, color: l.color, codes: l.codes, from: l.from, to: l.to, nStops: l.nStops, min: +l.min.toFixed(2), km: l.km, towards: l.towards })),
  transfers: o.transfers.map(t => ({ station: t.station, name: pl.station(t.station).name, fromLine: t.fromLine, toLine: t.toLine, min: t.min, level: t.level.id, tapOut: t.tapOut, fromCode: t.fromCode, toCode: t.toCode, note: t.note })),
});
const journey = {
  from: FROM, to: TO, fromName: pl.station(FROM).name, toName: pl.station(TO).name,
  fare: res.fare, options: res.options.map(opt), more: res.moreOptions.map(opt),
};

// --- transfer time at every interchange, as the map's pills show it (app.js drawTransferPills)
const pills = [];
for (const s of N.stations) {
  const ts = pl.stationTransfers(s.id);
  if (!ts.length) continue;
  const lo = ts[0].min, hi = ts[ts.length - 1].min;
  pills.push({ id: s.id, name: s.name, x: s.x, y: s.y, lo, hi, text: lo === hi ? `${lo} min` : `${lo}–${hi} min`,
    level: pl.transferLevel(hi).id, tapOut: ts.some(t => t.tapOut),
    pairs: ts.map(t => ({ a: t.fromCode, b: t.toCode, min: t.min, level: t.level.id, tapOut: t.tapOut, note: t.note })) });
}
const guide = pl.interchangeGuide().map(t => ({ station: t.station, name: pl.station(t.station).name, a: t.fromCode, b: t.toCode, min: t.min, level: t.level.id, tapOut: t.tapOut }));

// --- openings: stations that switch on by date, and how the network changes that day
const opening = stations.filter(s => s.opens).map(s => ({ id: s.id, name: s.name, opens: s.opens, codes: s.codes }));
const fareOpenDay = plOpen.fareFor(FROM, TO);

// --- counts quoted on screen
const count = {
  stations: N.stations.length,
  openToday: N.stations.filter(s => pl.isStationOpen(s.id)).length,
  mrtLines: new Set(Object.values(N.lines).filter(L => L.kind === 'MRT').map(L => L.short.replace(/ \(.*\)$/, ''))).size,
  lrtSystems: new Set(Object.values(N.lines).filter(L => L.kind === 'LRT').map(L => L.short)).size,
  interchanges: pills.length,
  levels: Object.fromEntries(P.LEVELS.map(L => [L.id, pills.filter(p => p.level === L.id).length])),
};

const DATA = { meta: { ...N.meta, today: TODAY, openDay: OPEN_DAY, repoCommit: '87e90c7' }, viewBox: N.meta.viewBox, lines, stations, journey, pills, guide, opening, fareOpenDay, count,
  levels: P.LEVELS.map(L => ({ id: L.id, max: L.max === Infinity ? null : L.max, label: L.label })), timing: P.TIMING };
fs.writeFileSync(path.join(here, '..', 'data.js'), '/* generated by data/prepare.mjs from semui01/transit data; do not edit */\nwindow.DATA = ' + JSON.stringify(DATA) + ';\n');

// A readable summary for NOTES.md and for checking every on-screen number.
const facts = { count, journey: { ...journey, options: journey.options, more: journey.more.map(o => ({ lines: o.lines, totalMin: o.totalMin, nTransfers: o.nTransfers })) }, fareOpenDay, opening,
  guideQuick: guide.filter(g => g.level === 'quick'), guideVeryLong: guide.filter(g => g.level === 'verylong') };
fs.writeFileSync(path.join(here, 'facts.json'), JSON.stringify(facts, null, 2));
console.log(JSON.stringify(count));
console.log('journey', journey.fromName, '→', journey.toName, 'fare', JSON.stringify(res.fare));
for (const o of journey.options) console.log(' option', o.tags.join('/'), o.lines.join('>'), o.totalMin + ' min', `(ride ${o.rideMin} + transfer ${o.transferMin})`, o.transfers.map(t => `${t.name} ${t.min}min ${t.level}`).join(', '), o.nStops + ' stops', o.km + ' km');
for (const o of journey.more) console.log(' more  ', o.lines.join('>'), o.totalMin + ' min', o.transfers.map(t => `${t.name} ${t.min}`).join(', '));
console.log('fare on', OPEN_DAY, JSON.stringify(fareOpenDay));
console.log('opening', JSON.stringify(opening));
console.log('guide quick', guide.filter(g => g.level === 'quick').map(g => `${g.name} ${g.a}-${g.b} ${g.min}`).join('; '));
console.log('guide verylong', guide.filter(g => g.level === 'verylong').map(g => `${g.name} ${g.a}-${g.b} ${g.min}${g.tapOut ? ' tap' : ''}`).join('; '));
