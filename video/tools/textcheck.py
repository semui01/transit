"""Check on-screen text from frames/text.jsonl (written by render.mjs): reading time, overlaps,
end-card hold, word load, size and safe zones.

usage: python3 tools/textcheck.py frames/text.jsonl frames/cues.json [--venue screen|phone|projector]
Prints findings; exits 1 if any are 'high'. Thresholds and their reasons:
  reading time   a text must be fully sharp and at (nearly) its own peak opacity for at least
                 0.4 s + words / 4.5 s (display text is read at roughly 4-5 words per second;
                 changing numbers are exempt; deliberately dim text is judged against its own peak)
  overlap        two texts both above 15% opacity whose boxes overlap by more than 15% of the smaller
  hand-off       a heading-sized text (≥ 20 px) appearing while another heading is still fading out
                 (the incoming text should start after the outgoing exit ends)
  end card       everything on the last frame must be complete at least 1.5 s before the end
  word load      words (tokens with letters) summed over every distinct text element / duration: ≤ ~3.5 per second
  never readable a text that is on screen but never sharp (cut off while decoding or blurring in)
  size           smallest text: 15 px on a 1080p screen, 22 px for projection, 30 px per 1080 px of
                 width for phones (so 53 px in a 16:9 film watched in a phone feed)
  safe zones     vertical films: no text in the top 11.5% or bottom 20% (app UI on Reels/Shorts/TikTok)
"""
import json
import sys
from collections import defaultdict

text_path, cues_path = sys.argv[1], sys.argv[2]
venue = sys.argv[sys.argv.index('--venue') + 1] if '--venue' in sys.argv else None
cues = json.load(open(cues_path))
fps, dur, W, H = cues['fps'], cues['dur'], cues.get('W', 1920), cues.get('H', 1080)
if venue is None:
    venue = 'phone' if H > W else 'screen'
if venue not in ('screen', 'projector', 'phone'):
    sys.exit(f'--venue must be screen, projector or phone (got {venue!r})')
frames = {}
for line in open(text_path):
    if line.strip():
        d = json.loads(line)
        frames[d['f']] = d['spans']
n = max(frames) + 1 if frames else 0
findings = []


def add(sev, msg):
    findings.append((sev, msg))


# readable runs per text
vis = defaultdict(lambda: [0.0] * n)
first_seen, size = {}, {}
for f, spans in frames.items():
    for s in spans:
        key = (s['s'], s['k'])
        vis[key][f] = max(vis[key][f], s['a'])
        first_seen.setdefault(key, f)
        size[key] = min(size.get(key, 1e9), s['px'])

for (txt, kind), a in sorted(vis.items(), key=lambda kv: first_seen[kv[0]]):
    if kind == 'number':
        continue
    if max(a) < .3:
        seen = sum(1 for f, spans in frames.items() if any((s['s'], s['k']) == (txt, kind) and s.get('v', s['a']) > .15 for s in spans))
        if seen >= fps * .15:
            add('high', f'never readable: on screen for {seen / fps:.2f} s from {first_seen[(txt, kind)] / fps:.2f} s but never sharp: "{txt[:70]}"')
        continue
    full = .9 * max(a)
    best = run = 0
    for v in a:
        run = run + 1 if v >= full else 0
        best = max(best, run)
    held = best / fps
    words = max(1, sum(1 for w in txt.split() if any(ch.isalnum() for ch in w)))
    need = .4 + words / 4.5
    reaches_end = a[-1] >= full
    if held + 1e-6 < need and not (reaches_end and held >= need * .6):
        sev = 'high' if held < need * .5 else 'medium'
        add(sev, f'reading time {held:.2f} s < {need:.2f} s needed ({words} words) at {first_seen[(txt, kind)] / fps:.2f} s: "{txt[:70]}"')

# overlaps (per pair, first frame and duration)
pairs = defaultdict(list)
for f, spans in frames.items():
    live = [s for s in spans if s.get('v', s['a']) > .15]   # visible, even if not yet readable (scrambling, blurring in)
    for i in range(len(live)):
        for j in range(i + 1, len(live)):
            a, b = live[i]['b'], live[j]['b']
            ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
            iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
            smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])) or 1
            if ix * iy > .15 * smaller and live[i]['s'] != live[j]['s']:
                name = lambda s: '<changing number>' if s['k'] == 'number' else s['s']
                pairs[tuple(sorted([name(live[i]), name(live[j])]))].append(f)
for (s1, s2), fs in pairs.items():
    fs = sorted(set(fs))
    sev = 'high' if len(fs) > fps * .25 else 'medium'
    add(sev, f'overlap for {len(fs) / fps:.2f} s from {min(fs) / fps:.2f} s: "{s1[:40]}" × "{s2[:40]}"')

# hand-off: a heading appears while another heading is still on its way out
life = {}
for key, a in vis.items():
    if key[1] != 'text' or size.get(key, 0) < 20 or not any(ch.isalpha() for ch in key[0]):
        continue
    on = [f for f, spans in frames.items() for s in spans if (s['s'], s['k']) == key and s.get('v', s['a']) > .05]
    if on:
        life[key] = (min(on), max(on))
for kb, (b0, b1) in life.items():
    for ka, (a0, a1) in life.items():
        # a real overlap of ≥ 0.12 s (a scene cut under an opaque end card ends its text within a frame or two)
        if ka != kb and a0 < b0 - .5 * fps and b0 + .12 * fps <= a1 < b0 + .6 * fps and a1 < n - 1:
            add('medium', f'hand-off at {b0 / fps:.2f} s: "{kb[0][:40]}" appears while "{ka[0][:40]}" is still fading out (until {a1 / fps:.2f} s)')

# end card hold
if n:
    last = [s for s in frames.get(n - 1, []) if s['k'] == 'text' and s['a'] >= .9 * max(vis[(s['s'], s['k'])])]
    if last:
        done = 0
        for s in last:
            a = vis[(s['s'], s['k'])]
            f = n - 1
            while f > 0 and a[f - 1] >= .9 * max(a):
                f -= 1
            done = max(done, f)
        hold = (n - done) / fps
        if hold < 1.5:
            add('high' if hold < .9 else 'medium', f'end card complete only {hold:.2f} s before the end (finish reveals by {dur - 1.5:.2f} s)')

# word load
words = sum(sum(1 for w in t.split() if any(ch.isalpha() for ch in w)) for (t, k) in vis if k == 'text')
if dur and words / dur > 3.5:
    add('medium', f'{words} distinct words in {dur:.1f} s = {words / dur:.1f} words/s (aim for ≤ 3.5; cut secondary labels)')

# size and safe zones
min_px = {'screen': 15, 'projector': 22, 'phone': 30}[venue] * (max(W, H) / 1920 if venue != 'phone' else W / 1080)
small = sorted({(t, round(size[(t, k)])) for (t, k) in vis if size[(t, k)] < min_px - .5}, key=lambda x: x[1])
for t, px in small[:8]:
    add('medium', f'text {px} px is below the {min_px:.0f} px minimum for {venue}: "{t[:50]}"')
if len(small) > 8:
    add('medium', f'... and {len(small) - 8} more text elements below {min_px:.0f} px')
if H > W:
    top, bottom = H * .115, H * (1 - .2)
    bad = set()
    for spans in frames.values():
        for s in spans:
            if s['a'] > .5 and (s['b'][1] < top or s['b'][3] > bottom):
                bad.add(s['s'])
    for t in sorted(bad)[:8]:
        add('medium', f'text inside the app-UI zone (top {top:.0f} px / bottom {H - bottom:.0f} px): "{t[:50]}"')
    if len(bad) > 8:
        add('medium', f'... and {len(bad) - 8} more text elements inside the app-UI zones')

order = {'high': 0, 'medium': 1}
for sev, msg in sorted(findings, key=lambda x: order[x[0]]):
    print(f'text    [{sev}] {msg}')
print(f'text    {len([k for k in vis if k[1] == "text"])} text elements, {words} words, venue={venue}: ' + ('OK' if not findings else f'{len(findings)} finding(s)'))
sys.exit(1 if any(s == 'high' for s, _ in findings) else 0)
