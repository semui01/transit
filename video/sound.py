"""Small numpy synth for cue-driven film scores. No dependencies beyond numpy.

    from sound import *
    sc = Score(dur=9.0, seed=7)
    sc.add(bell(hz('E6')), t=0.1, gain=.15, pan=.3, rev=.6)     # place any mono/stereo signal
    sc.write('soundtrack.wav')                                     # reverb, master, fades, 16-bit WAV

Instruments return mono numpy arrays at SR. Gains in the 0.02–0.5 range; the master normalises.
"""
import wave

import numpy as np

SR = 48000
RNG = np.random.default_rng(0)


def tt(d):
    return np.arange(int(d * SR)) / SR


def hz(note):
    """'A4' → 440.0; accepts sharps ('F#3') and 'Bb'."""
    names = {'C': -9, 'C#': -8, 'Db': -8, 'D': -7, 'D#': -6, 'Eb': -6, 'E': -5, 'F': -4, 'F#': -3, 'Gb': -3, 'G': -2, 'G#': -1, 'Ab': -1, 'A': 0, 'A#': 1, 'Bb': 1, 'B': 2}
    return 440 * 2 ** ((names[note[:-1]] + 12 * (int(note[-1]) - 4)) / 12)


def noise(d):
    return RNG.standard_normal(int(d * SR))


def fft_filter(x, gain_fn):
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(np.fft.rfft(x) * gain_fn(np.maximum(f, 1e-3)), len(x))


def lowpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (fc / f) ** (2 * order)))


def stft_filter(x, gain_tf, n=2048, hop=512):
    """Time-varying filter: gain_tf(t_seconds, freqs_array) → gain per frequency bin."""
    win = np.hanning(n)
    pad = np.concatenate([np.zeros(n), x, np.zeros(n)])
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    f = np.maximum(np.fft.rfftfreq(n, 1 / SR), 1)
    for s in range(0, len(pad) - n + 1, hop):
        y = np.fft.irfft(np.fft.rfft(pad[s:s + n] * win) * gain_tf((s + n / 2 - n) / SR, f), n)
        out[s:s + n] += y * win
        norm[s:s + n] += win ** 2
    return (out / np.maximum(norm, 1e-6))[n:n + len(x)]


def env_ar(d, a, r):
    t = tt(d)
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / r)


def sweep(f0, f1, d, curve='exp'):
    t = tt(d)
    f = f0 * (f1 / f0) ** (t / d) if curve == 'exp' else f0 + (f1 - f0) * t / d
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def bell(f, d=2.0, tau=.6, ratio=3.5, idx=1.6):
    """FM bell/chime. ratio 2.0 = glassy, 3.5 = metallic. Good for reveals, titles, discoveries."""
    t = tt(d)
    mod = idx * np.exp(-t / (tau * .45)) * np.sin(2 * np.pi * f * ratio * t)
    return np.sin(2 * np.pi * f * t + mod) * np.exp(-t / tau) * np.minimum(1, t / .003)


def mallet(f, d=.5, tau=.14):
    """Soft marimba-like hit. Good for data points popping in, one note per item."""
    t = tt(d)
    s = np.sin(2 * np.pi * f * t) + .4 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / .05) + .2 * np.sin(2 * np.pi * 3.98 * f * t) * np.exp(-t / .018)
    return s * np.exp(-t / tau) * np.minimum(1, t / .0015)


def tick(f=5200, d=.012, tau=.0018):
    """Tiny high click: UI blips, light pulses, counters."""
    return np.sin(2 * np.pi * f * tt(d)) * np.exp(-tt(d) / tau)


def pop():
    """Sharp biphasic crack with a short body, like a spike on an electrophysiology audio monitor."""
    d = .09
    t = tt(d)
    s = np.zeros(len(t))
    n1, n2 = int(.0011 * SR), int(.0019 * SR)
    s[:n1] = np.sin(np.pi * np.arange(n1) / n1)
    s[n1:n1 + n2] = -.55 * np.sin(np.pi * np.arange(n2) / n2)
    crack = highpass(noise(d), 2500) * np.exp(-t / .0035)
    return s + .45 * np.sin(2 * np.pi * 170 * t) * np.exp(-t / .022) + .35 * crack / np.abs(crack).max()


def whoosh(d, f0, f1, q=.45, peak=.55):
    """Band of noise sweeping f0→f1 Hz. Rising for push-ins and zooms, falling for pull-outs."""
    y = stft_filter(noise(d), lambda tc, f: np.exp(-(np.log(f / (f0 * (f1 / f0) ** np.clip(tc / d, 0, 1))) / q) ** 2))
    x = tt(d) / d
    e = np.where(x < peak, (x / peak) ** 2, ((1 - x) / (1 - peak)) ** 1.5)
    return y * e / (np.abs(y).max() + 1e-9)


def whip(d=.5):
    """Stereo whoosh for a whip pan: sweeps right→left as content leaves to the left."""
    w = whoosh(d, 400, 2600, q=.55, peak=.5)
    return np.vstack([w * np.linspace(.3, 1, len(w)), w * np.linspace(1, .3, len(w))])


def riser(d=.9, f0=250, ratio=30):
    """Noise riser that builds into a hit at its end."""
    y = stft_filter(noise(d), lambda tc, f: np.exp(-(np.log(f / (f0 * ratio ** np.clip(tc / d, 0, 1))) / .7) ** 2))
    return y / np.abs(y).max() * np.linspace(0, 1, len(y)) ** 3


def boom(d=1.6, f0=80, f1=42, tau=.5, click=.35):
    """Impact: a pitch-dropping low thump plus a 1–4 kHz click layer, so it still lands on laptop and
    phone speakers that cannot reproduce the low part. Scene changes, reveals, the final card."""
    t = tt(d)
    f = f1 + (f0 - f1) * np.exp(-t / .18)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / tau) * np.minimum(1, t / .004)
    hit = lowpass(noise(d), 1800) * np.exp(-t / .05)
    ck = fft_filter(noise(d), lambda fr: np.exp(-(np.log(fr / 2200) / .5) ** 2)) * np.exp(-t / .012)
    return s + .35 * hit / (np.abs(hit).max() + 1e-9) + click * ck / (np.abs(ck).max() + 1e-9)


def curve(points):
    """Piecewise-linear automation: curve([(0, 400), (5, 1600)])(t_array)."""
    xs, ys = zip(*points)
    return lambda t: np.interp(t, xs, ys)


def pad_note(f, t0, t1, bright, att=.35, rel=.6, gain=1.0):
    """Additive, slightly detuned saw-like voice. `bright(t)` is a cutoff in Hz over film time,
    so the pad can open up, dim (e.g. while something is silenced) and swell at the end."""
    d = t1 - t0 + rel
    t = tt(d)
    fc = bright(t + t0)
    out = np.zeros(len(t))
    for det in (-.0025, .0, .0031):
        ph = RNG.random() * 6.28
        for n in range(1, 13):
            out += (1 / n) / np.sqrt(1 + (n * f / fc) ** 4) * np.sin(2 * np.pi * n * f * (1 + det) * t + ph * n)
    e = np.minimum(1, t / att) * np.clip((d - t) / rel, 0, 1) ** 1.5 * (1 + .08 * np.sin(2 * np.pi * .7 * t + RNG.random() * 6))
    return out * e * gain / 3


class Score:
    """profile: 'speakers' (laptops, TVs, projection: master high-pass 40 Hz) or 'phone'
    (Reels/Shorts/TikTok: high-pass 110 Hz and a gentle presence lift, since phone speakers play
    nothing below ~150 Hz; pair it with LUFS=-14 in build.sh)."""

    def __init__(self, dur, seed=1, profile='speakers'):
        global RNG
        RNG = np.random.default_rng(seed)
        self.profile = profile
        self.dur, self.n = dur, int(SR * dur)
        self.dry = np.zeros((2, self.n))
        self.wet = np.zeros((2, self.n))

    def add(self, sig, t, gain=1.0, pan=0.0, rev=0.0):
        """Place a mono (equal-power panned, pan in -1..1) or stereo signal at time t; rev = reverb send."""
        i = int(round(t * SR))
        if sig.ndim == 1:
            sig = np.vstack([sig * np.cos((pan + 1) * np.pi / 4), sig * np.sin((pan + 1) * np.pi / 4)])
        s0, i = max(0, -i), max(0, i)
        k = min(sig.shape[1] - s0, self.n - i)
        if k <= 0:
            return
        self.dry[:, i:i + k] += sig[:, s0:s0 + k] * gain
        if rev:
            self.wet[:, i:i + k] += sig[:, s0:s0 + k] * gain * rev

    def chord(self, notes, t0, t1, bright, gain=.06, att=.35, rel=.5, spread=.35, rev=.25):
        for nt in notes:
            f = hz(nt)
            self.add(pad_note(f, t0, t1, bright, att, rel, .35 if f < 100 else 1), t0, gain, RNG.uniform(-spread, spread), rev)   # low roots mostly eat headroom

    def mixdown(self, rev_mix=.55, drive=1.1, tail=.45):
        t = tt(2.6)
        ir = np.vstack([RNG.standard_normal(len(t)), RNG.standard_normal(len(t))]) * np.exp(-t / .6)
        ir = np.vstack([lowpass(ir[0], 5500, 1), lowpass(ir[1], 5500, 1)])
        ir[:, :int(.018 * SR)] = 0
        ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
        L = 1 << int(np.ceil(np.log2(self.n + ir.shape[1])))
        rev = np.vstack([np.fft.irfft(np.fft.rfft(self.wet[c], L) * np.fft.rfft(ir[c], L), L)[:self.n] for c in range(2)])
        mix = self.dry + rev_mix * rev
        hpf = 110 if self.profile == 'phone' else 40
        mix = np.vstack([highpass(mix[c], hpf, 2) for c in range(2)])
        if self.profile == 'phone':
            mix = np.vstack([mix[c] + .35 * fft_filter(mix[c], lambda fr: np.exp(-(np.log(fr / 3000) / .6) ** 2)) for c in range(2)])
        mix /= np.abs(mix).max() + 1e-9
        mix = np.tanh(mix * drive) / np.tanh(drive)       # gentle soft clip; ffmpeg loudnorm sets final level
        fade = np.ones(self.n)
        fade[:int(.01 * SR)] = np.linspace(0, 1, int(.01 * SR))
        fade[-int(tail * SR):] = np.linspace(1, 0, int(tail * SR)) ** 1.5
        return mix * fade * .89

    def write(self, path, **kw):
        pcm = (np.clip(self.mixdown(**kw).T, -1, 1) * 32767).astype('<i2')
        with wave.open(path, 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        print(f'wrote {path} ({self.dur:.2f} s)')
