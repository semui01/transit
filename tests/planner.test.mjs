// Run: node --test tests/planner.test.mjs   (or: npm test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.window = {};
require("../data/network.js");
require("../data/fares.js");
const MRTPlanner = require("../js/planner.js");
const N = window.MRT_NETWORK, F = window.MRT_FARES;
const at = (date) => MRTPlanner.create(N, F, { date });

test("every code on every line belongs to a station with map position and label", () => {
  const byCode = new Map();
  for (const s of N.stations) for (const c of s.codes) byCode.set(c, s);
  for (const [id, L] of Object.entries(N.lines)) {
    for (const p of L.paths) {
      assert.equal(p.km.length, p.stops.length - 1, `${id} km/stops length`);
      for (const c of p.stops) {
        const s = byCode.get(c);
        assert.ok(s, `${id}: no station for ${c}`);
        assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), `${s.name} has no map position`);
        assert.ok(s.label && s.label.length, `${s.name} has no label`);
      }
      for (const km of p.km) assert.ok(km > 0.2 && km < 6, `${id}: odd segment length ${km}`);
    }
  }
});

test("fares match published examples (27 Dec 2025 table)", () => {
  const p = at("2026-11-08");
  assert.equal(p.fareFor("tanah-merah", "tanjong-pagar").adultCents, 202); // PTC: $2.02, 14 km
  assert.equal(p.fareFor("tanah-merah", "jurong-east").adultCents, 242);   // PTC: $2.42, 26.2 km
  assert.equal(p.fareFor("tanah-merah", "bedok").adultCents, 128);         // ~2 km, $1.28
  assert.equal(p.fareFor("tanah-merah", "bedok").earlyCents, 78);
});

test("fare change of 26 Dec 2026 switches on by date", () => {
  const p = at("2026-12-26");
  assert.equal(p.fareFor("tanah-merah", "jurong-east").adultCents, 255); // PTC: $2.55
  assert.equal(p.fareFor("tanah-merah", "bedok").adultCents, 140);       // PTC: $1.40
  const before = at("2026-12-25").fareFor("tanah-merah", "bedok");
  assert.equal(before.adultCents, 128);
  assert.equal(before.next.adultCents, 140);
});

test("same fare whichever route: fare uses shortest distance", () => {
  const r = at("2026-11-08").plan("jurong-east", "changi-airport");
  assert.ok(r.fare.km < r.options[0].km + 0.01);
});

test("TEL5 / DTL3e stations open automatically on 26 Dec 2026", () => {
  assert.match(at("2026-12-25").plan("xilin", "bayshore").error, /not open yet/);
  const r = at("2026-12-26").plan("xilin", "bayshore");
  assert.ok(!r.error);
  assert.deepEqual(r.suggested.transfers.map((t) => t.station), ["sungei-bedok"]);
  // trains run through unopened stations: DTL Expo -> ... is unaffected before opening
  assert.ok(!at("2026-11-08").plan("expo", "bugis").error);
});

test("direct routes are suggested when they are fastest", () => {
  const p = at("2026-11-08");
  const r = p.plan("jurong-east", "city-hall");
  assert.equal(r.suggested.nTransfers, 0);
  assert.deepEqual(r.suggested.lines, ["EW"]);
  assert.ok(r.suggested.totalMin >= 20 && r.suggested.totalMin <= 30, `JE-City Hall ${r.suggested.totalMin} min`);
});

test("Circle Line Stage 6 closes the loop (Keppel to Bayfront is direct)", () => {
  const r = at("2026-11-08").plan("keppel", "bayfront");
  assert.deepEqual(r.suggested.lines, ["CC"]);
  assert.ok(r.suggested.legs[0].stops.includes("marina-bay"));
});

test("Changi Airport needs a change at Tanah Merah from the west", () => {
  const r = at("2026-11-08").plan("jurong-east", "changi-airport");
  assert.deepEqual(r.suggested.transfers.map((t) => t.station), ["tanah-merah"]);
});

test("tap-out transfers are flagged", () => {
  const r = at("2026-11-08").plan("bukit-panjang", "raffles-place");
  const all = r.options.concat(r.moreOptions);
  const viaNewton = all.find((o) => o.transfers.some((t) => t.station === "newton"));
  assert.ok(viaNewton && viaNewton.transfers.find((t) => t.station === "newton").tapOut);
});

test("LRT loops connect through their hub", () => {
  const r = at("2026-11-08").plan("senja", "teck-lee");
  assert.ok(!r.error);
  assert.equal(r.suggested.legs[0].line, "BP");
  assert.equal(r.suggested.legs.at(-1).line, "PW");
});

test("every open station is reachable from and to Dhoby Ghaut", () => {
  const p = at("2026-12-26");
  for (const s of N.stations) {
    if (s.id === "dhoby-ghaut") continue;
    const a = p.plan("dhoby-ghaut", s.id), b = p.plan(s.id, "dhoby-ghaut");
    assert.ok(!a.error && a.options.length, `to ${s.name}: ${a.error}`);
    assert.ok(!b.error && b.options.length, `from ${s.name}: ${b.error}`);
    for (const o of a.options) {
      const seen = new Set();
      for (const leg of o.legs) for (const st of leg.stops.slice(seen.size ? 1 : 0)) {
        assert.ok(!seen.has(st), `${s.name}: route visits ${st} twice`);
        seen.add(st);
      }
    }
  }
});
