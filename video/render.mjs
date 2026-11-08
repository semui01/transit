// Render a film frame by frame in headless Chromium. Writes numbered PNG frames, cues.json and
// text.jsonl (every text span per frame, for tools/textcheck.py).
// usage: node render.mjs [--film film.html] [--frames frames] [--sub 4] [--workers 4] [--from 0] [--to N] [--fmt png|jpeg] [--cues-only]
//   --sub        motion-blur sub-frames per output frame (1 = none; 4 default; film.blur raises it in fast moves)
//   --workers    parallel browser pages (about one per CPU core)
//   --from/--to  render only a frame range (then SKIP_RENDER=1 ./build.sh re-encodes everything)
//   --cues-only  write cues.json and exit (to work on score.py before rendering)
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));

export async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  const root = execSync('npm root -g').toString().trim();
  return await import(pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href);
}
// Run a page call with a time limit so a hung page reports instead of stalling the build.
export function withTimeout(promise, ms, what) {
  let id;
  const timer = new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(id));   // cleared, so node exits as soon as the work is done
}
export async function launch() {
  const { chromium } = await loadPlaywright();
  const opts = { args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] };
  if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
  return chromium.launch(opts);
}
export async function openFilm(browser, film, errors = null) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', e => { console.error('PAGEERROR', e.message); process.exit(1); });
  p.on('crash', () => { console.error('The browser page crashed (out of memory?). Re-run; lower --workers if it repeats.'); process.exit(1); });
  if (errors) p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });   // attached before load, so precompute errors are seen
  await p.goto(pathToFileURL(film).href + '?render');
  await p.waitForFunction(() => window.FILM, null, { timeout: 15000 }).catch(() => { console.error('window.FILM never appeared: did film.start() run?'); process.exit(1); });
  await p.evaluate(() => window.FILM.ready);
  return p;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const film = path.resolve(arg('film', path.join(here, 'film.html')));
  const dir = path.resolve(arg('frames', path.join(here, 'frames')));
  const sub = +arg('sub', 4), workers = +arg('workers', 4), fmt = arg('fmt', 'png');
  fs.mkdirSync(dir, { recursive: true });
  const browser = await launch();
  const errors = [];
  const first = await openFilm(browser, film, errors);
  const { FPS, DUR, CUES } = await first.evaluate(() => ({ FPS: window.FILM.FPS, DUR: window.FILM.DUR, CUES: window.FILM.CUES }));
  if (errors.length) console.error('film console errors:\n  ' + [...new Set(errors)].join('\n  '));
  fs.writeFileSync(path.join(dir, 'cues.json'), JSON.stringify(CUES));
  if (process.argv.includes('--cues-only')) { console.log('cues →', path.join(dir, 'cues.json')); await browser.close(); process.exit(0); }
  const total = Math.round(FPS * DUR), from = +arg('from', 0), to = Math.min(total, +arg('to', total));
  const ext = fmt === 'png' ? 'png' : 'jpg', other = ext === 'png' ? 'jpg' : 'png';
  const frameFiles = fs.readdirSync(dir).filter(f => /^f\d{5}\.(png|jpg)$/.test(f));
  if (from === 0 && to === total) {
    // Full render: remove frames of the other format and any tail left by a longer earlier version.
    for (const f of frameFiles) if (f.endsWith(other) || +f.slice(1, 6) >= total) fs.unlinkSync(path.join(dir, f));
  } else if (frameFiles.some(f => f.endsWith(other))) {
    console.error(`${dir} holds .${other} frames; a partial --from/--to render in .${ext} would mix formats. Render the whole film, or use the same --fmt.`); process.exit(1);
  }
  const pages = [first];
  for (let i = 1; i < workers; i++) pages.push(await openFilm(browser, film));
  const textPath = path.join(dir, 'text.jsonl'), texts = {};
  if (from > 0 || to < total) { try { for (const l of fs.readFileSync(textPath, 'utf8').split('\n')) if (l) { const d = JSON.parse(l); texts[d.f] = d.spans; } } catch {} }
  let next = from, done = 0; const t0 = Date.now();
  await Promise.all(pages.map(async p => {
    while (next < to) {
      const i = next++;
      const { data, spans } = await withTimeout(p.evaluate(([i, sub, fmt]) => { window.FILM.renderFrame(i, sub); return { data: document.getElementById('c').toDataURL(fmt === 'png' ? 'image/png' : 'image/jpeg', .95), spans: window.FILM.text() }; }, [i, sub, fmt]), 120000, `frame ${i}`)
        .catch(e => { console.error(e.message); process.exit(1); });
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(5, '0')}.${fmt === 'png' ? 'png' : 'jpg'}`), Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
      texts[i] = spans;
      if (++done % 60 === 0) { const ms = (Date.now() - t0) / done; console.log(`${done}/${to - from} frames · ${ms.toFixed(0)} ms/frame · ~${Math.ceil(ms * (to - from - done) / 1000)} s left`); }
    }
  }));
  fs.writeFileSync(textPath, Object.keys(texts).map(Number).sort((a, b) => a - b).map(f => JSON.stringify({ f, spans: texts[f] })).join('\n') + '\n');
  console.log(`rendered ${done} frames (${FPS} fps, ${DUR} s) in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${dir}`);
  await browser.close();
  process.exit(0);
}
