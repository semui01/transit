// Tokyo planner tests. Run all tests: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
require("../data/tokyo/network.js");
require("../data/tokyo/fares.js");
const MRTPlanner = require("../js/planner.js");
const N = window.MRT_DATA["tokyo/network"], F = window.MRT_DATA["tokyo/fares"];
const P = MRTPlanner.create(N, F, { date: "2026-11-08" });
const all = (r) => r.options.concat(r.moreOptions);

test("every code belongs to a station with a map position and label", () => {
  const byCode = new Map();
  for (const s of N.stations) for (const c of s.codes) byCode.set(c, s);
  for (const [id, L] of Object.entries(N.lines)) {
    for (const p of L.paths) {
      assert.equal(p.km.length, p.stops.length - 1);
      for (const c of p.stops) {
        const s = byCode.get(c);
        assert.ok(s, `${id}: no station for ${c}`);
        assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && s.label.length, `${s.name}: no position or label`);
      }
    }
  }
  assert.ok(N.stations.length >= 210, `only ${N.stations.length} stations`);
});

test("line lengths match the official figures", () => {
  const official = { G: 14.2, M: 24.2, Mb: 3.2, H: 20.3, T: 30.8, C: 24.0, Y: 28.3, Z: 16.8, N: 21.3, A: 18.3, S: 23.5, E: 40.7 };
  for (const [id, km] of Object.entries(official)) {
    const sum = N.lines[id].paths.reduce((a, p) => a + p.km.reduce((x, y) => x + y, 0), 0);
    assert.ok(Math.abs(sum - km) < 0.15, `${id}: ${sum.toFixed(2)} km vs ${km}`);
  }
});

test("Tokyo Metro only: short trip is the 1-6 km fare", () => {
  const r = P.plan("ginza", "kyobashi");
  assert.equal(r.suggested.fare.ic, 178);
  assert.equal(r.suggested.fare.ticket, 180);
  assert.equal(r.suggested.fare.discount, 0);
});

test("Tokyo Metro + Toei: both fares added, 70 yen off", () => {
  const r = P.plan("roppongi", "otemachi");
  const mixed = all(r).find((o) => new Set(o.legs.map((l) => l.operator)).size === 2 && o.fare.segments.length === 2);
  assert.ok(mixed, "expected a route using both operators");
  const sum = mixed.fare.segments.reduce((a, s) => a + s.ic, 0);
  assert.equal(mixed.fare.discount, 70);
  assert.equal(mixed.fare.ic, sum - 70);
  // and a Tokyo Metro-only route is cheaper here
  assert.ok(all(r).some((o) => o.fare.ic < mixed.fare.ic));
});

test("Toei only: long Oedo + Asakusa trip uses the Toei top band", () => {
  const r = P.plan("hikarigaoka", "nishi-magome");
  assert.equal(r.suggested.fare.ic, 430);
  assert.deepEqual([...new Set(r.suggested.legs.map((l) => l.operator))], ["toei"]);
});

test("walkway between linked stations: Ginza to Toyosu via Ginza-itchome", () => {
  const r = P.plan("ginza", "toyosu");
  assert.deepEqual(r.suggested.lines, ["Y"]);
  assert.equal(r.suggested.startWalk.to, "ginza-itchome");
  assert.equal(r.suggested.fare.ic, 178);
});

test("transfers between differently named stations are listed both ways", () => {
  const r = P.plan("honancho", "oshiage");
  const viaLink = all(r).find((o) => o.transfers.some((t) => t.station === "akasaka-mitsuke" && t.toStation === "nagatacho"));
  assert.ok(viaLink, "expected a route changing from Akasaka-mitsuke to Nagatacho");
  assert.ok(P.stationTransfers("nagatacho").some((t) => t.toStation === "akasaka-mitsuke"));
});

test("connected stations are not planned as a train trip", () => {
  assert.match(P.plan("akasaka-mitsuke", "nagatacho").error, /connected stations/);
});

test("quick and slow interchanges are rated", () => {
  const am = P.stationTransfers("akasaka-mitsuke").find((t) => [t.fromCode, t.toCode].sort().join() === "G05,M13");
  assert.equal(am.level.id, "quick");
  const ku = P.stationTransfers("kuramae")[0];
  assert.equal(ku.level.id, "verylong");
  assert.ok(ku.tapOut);
});

test("every station is reachable from Otemachi, without revisiting stations, quickly", () => {
  let worst = 0;
  for (const s of N.stations) {
    if (s.id === "otemachi") continue;
    const t0 = Date.now();
    const r = P.plan("otemachi", s.id);
    worst = Math.max(worst, Date.now() - t0);
    assert.ok(!r.error && r.options.length, `${s.name}: ${r.error}`);
    for (const o of r.options) {
      const seen = new Set();
      o.legs.forEach((leg, i) => leg.stops.slice(i ? 1 : 0).forEach((st) => {
        const cx = P.complexOf(st);
        assert.ok(!seen.has(cx) || (i && st === leg.stops[0]), `${s.name}: visits ${st} twice`);
        seen.add(cx);
      }));
      assert.ok(o.fare && o.fare.ic >= 178, `${s.name}: no fare`);
    }
  }
  assert.ok(worst < 1500, `slowest plan took ${worst} ms`);
});

test("every station has a Japanese name and a Japanese map label", () => {
  for (const s of N.stations) {
    assert.ok(/[぀-ヿ一-鿿]/.test(s.ja), `${s.name}: no Japanese name`);
    const ja = s.label.find((r) => r[6] === "ja");
    assert.ok(ja && ja[0].length, `${s.name}: no Japanese label`);
  }
  assert.equal(N.lines.E.ja, "都営大江戸線");
});
