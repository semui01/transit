#!/usr/bin/env node
/*
 * Check LTA's rail network page for changes that need a data update.
 *
 *   node tools/check-lta-updates.mjs                 # fetch LTA page + system map PDF
 *   node tools/check-lta-updates.mjs --pdf map.pdf   # check a local system map PDF
 *   node tools/check-lta-updates.mjs --html page.html
 *   node tools/check-lta-updates.mjs --out report.md --json report.json
 *
 * What it compares with data/singapore/network.js
 *   - the system map PDF linked from the page (file name and "SM-yy-nn-EN" version)
 *   - every station code on the page and in the PDF (needs `pdftotext` from poppler-utils)
 *   - opening dates in the data that have now passed
 *
 * Exit codes: 0 = no change, 2 = changes found (report written), 1 = could not check.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LTA_PAGE = "https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network.html";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (compatible; mrt-planner-update-check/1.0)";
const CODE_RE = /\b(NS|EW|CG|NE|CC|CE|DT|TE|JS|JE|JW|CR|CP|BP|SE|SW|PE|PW)\s?(\d{1,2}[A-Z]?)\b|\b(STC|PTC|CG)\b/g;

const args = parseArgs(process.argv.slice(2));
const today = new Date().toISOString().slice(0, 10);

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  return o;
}

function loadNetwork() {
  const src = readFileSync(join(ROOT, "data/singapore/network.js"), "utf8");
  const json = src.slice(src.indexOf("{", src.indexOf('["singapore/network"]')), src.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

function codesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(CODE_RE)) out.add(m[3] || m[1] + m[2]);
  return out;
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,*/*" }, redirect: "follow" });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.text();
}
async function fetchToFile(url, file) {
  const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

function pdfText(file) {
  try {
    return execFileSync("pdftotext", ["-q", file, "-"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function findMapPdf(html, base) {
  const links = [...html.matchAll(/href\s*=\s*["']([^"']+\.pdf)(?:\?[^"']*)?["']/gi)].map((m) => new URL(m[1], base).href);
  const scored = links.map((u) => {
    const f = decodeURIComponent(basename(new URL(u).pathname));
    let s = 0;
    if (/^SM[_-]/i.test(f)) s += 5;
    if (/system.?map/i.test(u)) s += 4;
    if (/_EN|english/i.test(f)) s += 2;
    if (/map/i.test(u)) s += 1;
    return { u, f, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored[0] || null;
}

async function main() {
  const net = loadNetwork();
  const known = new Set(net.stations.flatMap((s) => s.codes));
  const findings = [];
  const notes = [];
  let pageHtml = null, pdfFile = args.pdf || null, pdfName = args.pdf ? basename(args.pdf) : null;

  // 1. the LTA page
  if (args.html) pageHtml = readFileSync(args.html, "utf8");
  else if (!args.pdf) {
    try { pageHtml = await fetchText(LTA_PAGE); }
    catch (e) { console.error(`Could not fetch the LTA page: ${e.message}`); process.exit(1); }
  }
  if (pageHtml) {
    const pageText = pageHtml.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
    const pageCodes = codesIn(pageText);
    const newOnPage = [...pageCodes].filter((c) => !known.has(c)).sort();
    if (newOnPage.length) findings.push(`Station codes on the LTA page that the planner doesn't know: **${newOnPage.join(", ")}**`);
    const pdf = findMapPdf(pageHtml, LTA_PAGE);
    if (!pdf) notes.push("No system map PDF link found on the page (the page layout may have changed).");
    else {
      pdfName = pdf.f;
      if (pdf.f !== net.meta.systemMapFile) findings.push(`The LTA page links a different system map: **${pdf.f}** (planner uses ${net.meta.systemMapFile}). Download: ${pdf.u}`);
      if (!pdfFile) {
        pdfFile = join(mkdtempSync(join(tmpdir(), "lta-")), pdf.f);
        try { await fetchToFile(pdf.u, pdfFile); }
        catch (e) { notes.push(`Could not download the system map: ${e.message}`); pdfFile = null; }
      }
    }
  }

  // 2. the system map PDF
  if (pdfFile && existsSync(pdfFile)) {
    const text = pdfText(pdfFile);
    if (text == null) notes.push("`pdftotext` is not installed, so the map's station codes were not compared (apt-get install poppler-utils).");
    else {
      const ver = (text.match(/SM-\d{2}-\d{2}-[A-Z]{2}/) || [null])[0];
      if (ver && ver !== net.meta.systemMap) findings.push(`System map version is **${ver}** (planner uses ${net.meta.systemMap}).`);
      const mapCodes = codesIn(text.replace(/Legend[\s\S]*$/m, ""));
      const added = [...mapCodes].filter((c) => !known.has(c)).sort(byCode);
      const gone = [...known].filter((c) => !mapCodes.has(c)).sort(byCode);
      if (added.length) findings.push(`New station codes on the system map: **${added.join(", ")}**`);
      if (gone.length) findings.push(`Codes in the planner but not on the system map (closed or renumbered?): ${gone.join(", ")}`);
    }
  }

  // 3. opening dates that have passed
  const opened = net.stations.filter((s) => s.opens && Object.values(s.opens).every((d) => d <= today));
  if (opened.length) notes.push(`Opened per the data and now treated as open automatically: ${opened.map((s) => s.name).join(", ")}. You can remove their \`opens\` dates at the next rebuild.`);

  const report = [
    `# LTA rail network check (${today})`,
    "",
    `Planner data: ${net.meta.systemMap} (${net.meta.systemMapFile}), generated ${net.meta.generated}.`,
    `Checked: ${args.html ? args.html : args.pdf ? "local PDF" : LTA_PAGE}${pdfName ? ` and ${pdfName}` : ""}.`,
    "",
    findings.length ? "## Changes found" : "## No changes found",
    ...findings.map((f) => `- ${f}`),
    ...(notes.length ? ["", "## Notes", ...notes.map((n) => `- ${n}`)] : []),
    "",
    findings.length ? "See README > Updating the network for how to refresh `data/singapore/network.js`." : "",
  ].join("\n");

  console.log(report);
  if (args.out) writeFileSync(args.out, report + "\n");
  if (args.json) writeFileSync(args.json, JSON.stringify({ date: today, findings, notes }, null, 2));
  process.exit(findings.length ? 2 : 0);
}

function byCode(a, b) {
  const pa = a.match(/^([A-Z]+)(\d*)/), pb = b.match(/^([A-Z]+)(\d*)/);
  return pa[1].localeCompare(pb[1]) || (+pa[2] || 0) - (+pb[2] || 0);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
