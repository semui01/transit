"""Verify a finished film: format, picture (grey washes), transitions, sound (loudness, low end, sync),
and on-screen text (via textcheck.py). Writes review images next to the film.

usage: python3 tools/check.py film.mp4 frames/cues.json [--sync KEY,KEY] [--venue screen|projector|phone]
  --sync   cues whose times should each carry a sound transient (lists or single times). Default:
           film.cues.sync if the film sets it, else every list of ≥3 plain numbers except
           transitions/blur/whips (so set `sync` explicitly when cues carry lists of values)
  --venue  sets text-size and low-end thresholds (default: phone for vertical films, else screen)
Outputs: <film>-sheet.jpg (16 frames), <film>-transitions.jpg (3 frames inside every cues.transitions
window and around cues.flash), <film>-spec.png (spectrogram). Exits 1 if anything is marked high.
"""
import json
import os
import subprocess
import sys

import numpy as np

mp4, cues_path = sys.argv[1], sys.argv[2]
cues = json.load(open(cues_path))
opt = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
fps, dur = cues.get('fps', 60), cues['dur']
base = mp4.rsplit('.', 1)[0]
problems = []


def run(*a, **kw):
    return subprocess.run(a, capture_output=True, **kw)


def flag(sev, msg):
    problems.append((sev, msg))
    print(f'        [{sev}] {msg}')


# ---------------------------------------------------------------- format
probe = json.loads(run('ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', mp4, text=True).stdout)
v = next(s for s in probe['streams'] if s['codec_type'] == 'video')
W, H = int(v['width']), int(v['height'])
has_audio = any(s['codec_type'] == 'audio' for s in probe['streams'])
venue = opt('--venue') or ('phone' if H > W else 'screen')
if venue not in ('screen', 'projector', 'phone'):
    sys.exit(f'--venue must be screen, projector or phone (got {venue!r})')
mdur = float(probe['format']['duration'])
print(f"video   {W}x{H} @ {v['r_frame_rate']} fps, {mdur:.3f} s (film: {dur} s), venue={venue}")
if abs(mdur - dur) > 1.5 / fps:
    flag('high', f'duration {mdur:.3f} s differs from the film ({dur} s)')

# ---------------------------------------------------------------- picture: grey veils
sw = 96
sh = max(2, round(sw * H / W / 2) * 2)
raw = run('ffmpeg', '-loglevel', 'error', '-i', mp4, '-vf', f'scale={sw}:{sh}:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-').stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, sh, sw, 3).astype(float) / 255
luma = (fr @ [.2126, .7152, .0722])
mx, mn = fr.max(-1), fr.min(-1)
sat = np.where(mx > .02, (mx - mn) / np.maximum(mx, 1e-6), 0).mean((1, 2))
mean_l = luma.mean((1, 2))
cy, cx = max(1, sh // 6), max(1, sw // 6)
corners = np.stack([luma[:, :cy, :cx], luma[:, :cy, -cx:], luma[:, -cy:, :cx], luma[:, -cy:, -cx:]], 1).mean((2, 3)).min(1)
base_l, base_c = np.median(mean_l), np.median(corners)
# Grey veil: the frame's corners lift well above their usual level while colour drains and the frame is
# not at white. Calibrated on three films whose flashes reviewers measured as visibly grey.
veil = (corners > max(.08, 3 * base_c)) & (sat < .3) & (mean_l < .85)
print(f'picture mean luma median {base_l:.2f}, max {mean_l.max():.2f}')
if venue == 'phone' and base_l < .08:
    flag('medium', f'the picture is very dark for a phone (median luma {base_l:.2f}): lift the background, enlarge the subject, keep the first frame bright')
if mean_l[0] < .03:
    print('        note: the first frame is near-black; platforms often use it as the thumbnail (Film.create({fadeIn: 0}) starts on the picture)')
if veil.any():
    idx = np.flatnonzero(veil)
    groups = np.split(idx, np.flatnonzero(np.diff(idx) > 1) + 1)
    for g in groups:
        sev = 'high' if len(g) >= 6 else 'medium'
        flag(sev, f'grey wash {g[0] / fps:.2f}–{(g[-1] + 1) / fps:.2f} s ({len(g)} frames): the whole frame lifts to mid-grey with little colour '
                  f'(peak luma {mean_l[g].max():.2f}, corners {corners[g].max():.2f}). Keep flashes local (M.flash bloom) or make a true white-out.')

# ---------------------------------------------------------------- review sheets
nfr = len(mean_l)


def sheet(frames, path, cols):
    frames = sorted({min(nfr - 1, max(0, int(f))) for f in frames})
    if not frames:
        return
    sel = '+'.join(f'eq(n\\,{f})' for f in frames)
    tw = 480 if W >= H else 300
    rows = (len(frames) + cols - 1) // cols
    args = ['ffmpeg', '-loglevel', 'error', '-y', '-i', mp4, '-vf', f"select='{sel}',scale={tw}:-2,tile={cols}x{rows}", '-frames:v', '1']
    r = run(*args, '-fps_mode', 'passthrough', path, text=True)
    if r.returncode:   # ffmpeg before 5.1 has no -fps_mode
        r = run(*args, '-vsync', 'passthrough', path, text=True)
    if r.returncode or not os.path.exists(path):
        flag('medium', f'could not write {path}: {r.stderr.strip()[:200]}')
    else:
        print(f'sheet   {path}  ({len(frames)} frames)')


cols = 4 if W >= H else 6
sheet([(k + .5) * nfr / 16 for k in range(16)], base + '-sheet.jpg', cols)
wins = [w for w in cues.get('transitions', []) if isinstance(w, list) and len(w) == 2]
if isinstance(cues.get('flash'), (int, float)):
    wins.append([cues['flash'] - .12, cues['flash'] + .2])
tfr = [fps * (a + (b - a) * q) for a, b in wins for q in (.2, .5, .8)]
if tfr:
    sheet(tfr, base + '-transitions.jpg', cols)
else:
    print('sheet   no cues.transitions: add [[t0, t1], ...] to film.cues to get a transitions sheet')

# ---------------------------------------------------------------- sound
if has_audio:
    ln = run('ffmpeg', '-hide_banner', '-i', mp4, '-af', 'loudnorm=print_format=summary', '-f', 'null', '-', text=True).stderr
    vals = {k: line.split(':')[1].strip() for line in ln.splitlines() for k in ('Input Integrated', 'Input True Peak', 'Input LRA') if k in line}
    print('audio   ' + ', '.join(f'{k.replace("Input ", "")} {v}' for k, v in vals.items()))
    try:
        lra = float(vals.get('Input LRA', '9').split()[0])
        if lra < 2.5:
            flag('medium', f'loudness range {lra} LU: the mix is squashed; lower the bed or raise events instead of adding drive')
    except ValueError:
        pass
    pcm = run('ffmpeg', '-loglevel', 'error', '-i', mp4, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-').stdout
    x = np.frombuffer(pcm, '<i2').astype(float) / 32768
    X = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / 48000)
    below60, below120 = X[f < 60].sum() / X.sum(), X[f < 120].sum() / X.sum()
    print(f'audio   energy below 60 Hz {below60:.0%}, below 120 Hz {below120:.0%}')
    if venue == 'phone' and below120 > .35:
        flag('medium', f'{below120:.0%} of the energy is below 120 Hz, which phone speakers cannot play: use Score(profile="phone") and impacts with a click layer')
    elif venue != 'phone' and below60 > .25:
        flag('medium', f'{below60:.0%} of the energy is below 60 Hz, which laptop and room speakers barely reproduce: voice pads higher, keep booms above 40 Hz')
    run('ffmpeg', '-loglevel', 'error', '-y', '-i', mp4, '-lavfi', 'aformat=channel_layouts=mono,showspectrumpic=s=1600x500:legend=1:scale=log:fscale=log:stop=12000', base + '-spec.png')
    print(f'audio   spectrogram {base}-spec.png (an overview: low bins smear on a log axis; trust the measured numbers above)')
    # sync: onset of high-frequency energy near each cue, window bounded by the neighbouring cues
    hp = np.fft.irfft(np.fft.rfft(x) * (f > 1500), len(x))
    env = np.convolve(np.abs(hp), np.ones(48) / 48, 'same')
    d = np.diff(env)
    # Which cues to check: --sync, else film.cues.sync (names of lists or single times), else every list of
    # 3+ plain numbers (two-number lists are usually [start, end] windows, not sound onsets).
    if opt('--sync'):
        keys = opt('--sync').split(',')
    elif 'sync' in cues:
        keys = cues['sync'] if isinstance(cues['sync'], list) else [cues['sync']]
    else:
        keys = [k for k, val in cues.items() if k not in ('transitions', 'blur', 'whips', 'sync') and isinstance(val, list) and len(val) >= 3 and all(isinstance(e, (int, float)) for e in val)]
    keys = [k.strip() for k in keys]
    for key in keys:
        if key not in cues:
            print(f'sync    "{key}" is not in cues.json (typo?)')
            continue
        val = cues.get(key, [])
        ts = sorted(e for e in (val if isinstance(val, list) else [val]) if isinstance(e, (int, float)))
        offs = []
        for i, t in enumerate(ts):
            lo = min(.03, (t - ts[i - 1]) / 2 if i else .03)
            hi = min(.06, (ts[i + 1] - t) / 2 if i + 1 < len(ts) else .06)
            a, b = int((t - lo) * 48000), int((t + hi) * 48000)
            if a > 0 and b < len(d) and b > a and env[a:b].max() > 2.5 * np.percentile(env[a:b], 20) + 1e-5:   # local contrast: an onset stands out from its own surroundings
                offs.append((a + int(np.argmax(d[a:b]))) / 48000 - t)
        if offs:
            ms = np.array(offs) * 1000
            iqr = np.subtract(*np.percentile(ms, [75, 25]))
            print(f'sync    "{key}": median {np.median(ms):+.1f} ms over {len(ms)}/{len(ts)} cues (spread {ms.min():+.0f}…{ms.max():+.0f} ms)'
                  + ('' if iqr < 15 else '  [scattered: soft or low-pitched attacks read late; not an error on its own]'))
            # Sound is placed from the same cue times, so only a consistent offset over several cues means
            # a real error (wrong fps, a time shift); scattered readings on soft attacks are measurement noise.
            if len(ms) >= 3 and abs(np.median(ms)) > 40 and iqr < 30:
                flag('high', f'sound for "{key}" is consistently {np.median(ms):+.0f} ms off its cues')
        elif ts:
            print(f'sync    "{key}": no high-frequency onset found near these cues (tonal or quiet sounds; nothing to measure)')
else:
    print('audio   none')

# ---------------------------------------------------------------- text
text = os.path.join(os.path.dirname(cues_path), 'text.jsonl')
if os.path.exists(text):
    r = run(sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'textcheck.py'), text, cues_path, '--venue', venue, text=True)
    out = r.stdout.strip()
    print(out)
    if r.returncode and '[high]' not in out:
        flag('high', 'textcheck.py failed, so on-screen text was not checked: ' + (r.stderr.strip().splitlines() or ['?'])[-1][:200])
    for line in out.splitlines():
        if '[high]' in line:
            problems.append(('high', line))
        elif '[medium]' in line:
            problems.append(('medium', line))
else:
    print('text    no text.jsonl next to cues.json (render with render.mjs to get the text check)')

high = [p for p in problems if p[0] == 'high']
print('OK' if not problems else f'{len(high)} high, {len(problems) - len(high)} medium finding(s): fix the high ones, look at the medium ones')
sys.exit(1 if high else 0)
