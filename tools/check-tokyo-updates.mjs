#!/usr/bin/env node
/*
 * Check Tokyo Metro's station index for changes that need a data update.
 *
 *   node tools/check-tokyo-updates.mjs                    # fetch the live page
 *   node tools/check-tokyo-updates.mjs --html page.html   # check a saved copy
 *   node tools/check-tokyo-updates.mjs --out report.md
 *
 * It looks for station numbers (G09, Mb03 ...) and station names on the page and
 * compares them with data/tokyo/network.js. Toei lines are not on this page.
 *
 * Exit codes: 0 = no change, 2 = changes found, 1 = could not check.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE = "https://www.tokyometro.jp/station/index.html";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const METRO = ["G", "M", "Mb", "H", "T", "C", "Y", "Z", "N", "F"];
const CODE_RE = /(?<![A-Za-z])(Mb|G|M|H|T|C|Y|Z|N|F)[\s-]?(\d{2})(?!\d)/g;

const args = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith("--")) args[process.argv[i].slice(2)] = process.argv[i + 1];
const today = new Date().toISOString().slice(0, 10);

function loadNetwork() {
  const src = readFileSync(join(ROOT, "data/tokyo/network.js"), "utf8");
  return JSON.parse(src.slice(src.indexOf("{", src.indexOf('["tokyo/network"]')), src.lastIndexOf("}") + 1));
}

async function main() {
  const net = loadNetwork();
  const metroStations = net.stations.filter((s) => s.codes.some((c) => METRO.includes(c.match(/^[A-Za-z]+/)[0])));
  const known = new Set(metroStations.flatMap((s) => s.codes));
  let html;
  try {
    html = args.html ? readFileSync(args.html, "utf8")
      : await (async () => {
        const r = await fetch(PAGE, { headers: { "user-agent": "Mozilla/5.0 (compatible; metro-planner-update-check/1.0)" } });
        if (!r.ok) throw new Error(`${PAGE} answered ${r.status}`);
        return r.text();
      })();
  } catch (e) { console.error(`Could not fetch the Tokyo Metro page: ${e.message}`); process.exit(1); }

  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<(?!img)[^>]+>/g, " ") + " " +
    [...html.matchAll(/alt\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).join(" ");
  const found = new Set([...text.matchAll(CODE_RE)].map((m) => m[1] + m[2]));
  const findings = [], notes = [];
  const added = [...found].filter((c) => !known.has(c)).sort();
  if (added.length) findings.push(`Station numbers on Tokyo Metro's page that the planner doesn't know: **${added.join(", ")}**`);

  const names = metroStations.map((s) => s.ja.replace(/〈.*〉/, ""));
  const present = names.filter((n) => text.includes(n));
  if (present.length < names.length * 0.6) {
    notes.push(`Only ${present.length} of ${names.length} station names were found on the page, so its layout may have changed; names were not compared.`);
  } else {
    const missing = metroStations.filter((s) => !text.includes(s.ja.replace(/〈.*〉/, ""))).map((s) => `${s.name} (${s.ja})`);
    if (missing.length) findings.push(`Stations in the planner whose names are not on the page (renamed or closed?): ${missing.join(", ")}`);
  }
  if (!found.size) notes.push("No station numbers found in the page text; only names were compared.");

  const report = [
    `# Tokyo Metro station check (${today})`, "",
    `Planner data: ${net.stations.length} stations, generated ${net.meta.generated}. Checked: ${args.html || PAGE}.`, "",
    findings.length ? "## Changes found" : "## No changes found",
    ...findings.map((f) => `- ${f}`),
    ...(notes.length ? ["", "## Notes", ...notes.map((n) => `- ${n}`)] : []),
    "", findings.length ? "See README > Updating Tokyo for how to refresh `data/tokyo/network.js`." : "",
  ].join("\n");
  console.log(report);
  if (args.out) writeFileSync(args.out, report + "\n");
  process.exit(findings.length ? 2 : 0);
}
main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
