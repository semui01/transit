"""Score for the Singapore MRT Planner film. One layer per kind of on-screen event; every time comes
from cues.json (exported by film.cues), so sound lands on the frame.

usage: python3 score.py frames/cues.json soundtrack.wav

Key: G major. The bed walks Gadd9 → Em7 → Cmaj7 → Am7 → Em9 → Dsus4 → D (V) and resolves to G on the
end card. Melodic events use G major pentatonic (G A B D E), which sits inside every chord of the bed.
A soft pulse on the film's 120 BPM grid (0.5 s) carries the explainer until the end card.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sound import Score, bell, boom, curve, hz, mallet, riser, tick, whip, whoosh  # noqa: E402

cues = json.load(open(sys.argv[1]))
dur = cues['dur']
phone = os.environ.get('VENUE') == 'phone' or cues.get('H', 1080) > cues.get('W', 1920)
sc = Score(dur, seed=11, profile='phone' if phone else 'speakers')

sc_t = cues['scenes'] + [dur]          # scene starts: open, route, time, fare, transfers, openings, end
on, lands = cues['on'], cues['lands']
end0 = lands[0]

# --- Bed: one chord per scene, crossfading at the cuts; brightness follows the story.
bright = curve([(0, 450), (1.6, 1100), (sc_t[1], 1400), (sc_t[2], 1300), (sc_t[3], 1200), (sc_t[4], 1700),
                (sc_t[5], 1900), (on - .05, 2300), (on + .3, 3000), (end0, 2600), (dur, 1400)])
beds = [(['G2', 'D3', 'A3', 'B3', 'D4'], sc_t[0] + .02, sc_t[1]),
        (['E2', 'B2', 'D3', 'G3', 'B3'], sc_t[1], sc_t[2]),
        (['C3', 'G3', 'B3', 'E4'], sc_t[2], sc_t[3]),
        (['A2', 'E3', 'G3', 'C4'], sc_t[3], sc_t[4]),
        (['E2', 'B2', 'D3', 'F#3', 'G3'], sc_t[4], sc_t[5]),
        (['D3', 'G3', 'A3', 'D4'], sc_t[5], on),                 # Dsus4 waits for opening day...
        (['D3', 'F#3', 'A3', 'D4'], on, end0)]                    # ...and settles on D (V) when it comes
for notes, a, b in beds:
    sc.chord(notes, a, b + .25, bright, gain=.05, att=.3, rel=.5)
sc.chord(['G2', 'D3', 'G3', 'B3', 'D4', 'G4'], end0, dur + .3, bright, gain=.06, att=.06, rel=.8)   # resolve to G

# --- Pulse: a soft tick on every beat, a muted low mallet on the chord root every other beat.
roots = ['G3', 'E3', 'C3', 'A3', 'E3', 'D3']
for k in range(int(end0 / .5) + 1):
    t = k * .5
    if t >= end0 - .25:
        break
    sc.add(tick(6500, .01, .0012), t, .022 if k % 2 else .032, .15 if k % 2 else -.15)
    if k % 2 == 0 and t > .9:
        si = max(i for i, s in enumerate(sc_t[:6]) if s <= t + 1e-6)
        sc.add(mallet(hz(roots[si]), .4, .09), t, .045, 0, rev=.15)

# --- Opening: each line that starts drawing gets a note, rising through the pentatonic.
penta = ['G4', 'A4', 'B4', 'D5', 'E5', 'G5', 'A5', 'B5', 'D6', 'E6']
for i, t in enumerate(cues['lineStarts']):
    pan = -.45 + .9 * i / max(1, len(cues['lineStarts']) - 1)
    sc.add(mallet(hz(penta[i]), .7, .2), t + .02, .085, pan, rev=.5)
    sc.add(tick(4800, .008, .0014), t + .02, .02, pan)

# --- Journey: pins drop, the train runs (rising whoosh with the push-in), the transfer chimes, arrival.
for t, nt, pan in zip(cues['pins'], ['D5', 'G5'], [-.3, .45]):
    sc.add(mallet(hz(nt), .6, .15), t, .13, pan, rev=.35)
    sc.add(tick(4200, .01, .0016), t, .06, pan)
sc.add(whoosh(cues['arr1'] - cues['dep'] + .2, 260, 1500, q=.5, peak=.75), cues['dep'], .16, .1, rev=.2)
sc.add(bell(hz('B5'), 2.6, .8, 2.0, 1.1), cues['xfer'], .14, .35, rev=.6)          # the change at Tanah Merah
sc.add(tick(3800, .012, .002), cues['xfer'], .06, .35)
sc.add(whoosh(cues['arr2'] - cues['dep2'] + .15, 400, 1100, q=.45, peak=.7), cues['dep2'], .08, .5, rev=.15)
sc.add(mallet(hz('G5'), .8, .2), cues['arr2'], .1, .6, rev=.5)                       # arrival at B

# --- Camera moves: falling whooshes on pull-outs, rising on the zoom, a whip on the lateral pan.
sc.add(whoosh(cues['pull'][1] - cues['pull'][0] + .2, 1700, 300, q=.5, peak=.35), cues['pull'][0] - .05, .2, -.1, rev=.2)
sc.add(whoosh(cues['zoom'][1] - cues['zoom'][0] + .2, 280, 2200, q=.5, peak=.75), cues['zoom'][0] - .05, .22, .1, rev=.25)
sc.add(whip(cues['pan'][1] - cues['pan'][0] + .15), cues['pan'][0] - .05, .22, rev=.15)
sc.add(whoosh(cues['back'][1] - cues['back'][0] + .2, 1600, 260, q=.5, peak=.35), cues['back'][0] - .05, .2, rev=.2)

# --- How long: ticks as the counter climbs (one per digit step), a mallet and bell when 53 lands.
ease = lambda x: 4 * x ** 3 if x < .5 else 1 - (-2 * x + 2) ** 3 / 2      # E.inOutCubic in engine.js
inv = lambda y: float(np.interp(y, [ease(x) for x in np.linspace(0, 1, 401)], np.linspace(0, 1, 401)))
b0, b1 = cues['bar0'], cues['bar1']
for v in range(3, 53, 3):
    t = b0 + (b1 - b0) * inv((v - .5) / 52.86)
    sc.add(tick(3600 + 40 * v, .009, .0014), t, .03, -.55)
sc.add(mallet(hz('G4'), .9, .22), b1, .12, -.5, rev=.4)
sc.add(bell(hz('D6'), 2.2, .7, 2.0, 1.0), b1 + .02, .08, -.5, rev=.6)

# --- What it costs: a coin-like ding for the fare, and the same ding, quieter, on each route swap:
#     the route changes, the fare does not.
coin = bell(hz('E6'), 2.0, .55, 3.5, 1.4)
sc.add(coin, cues['fare'] + .05, .13, -.45, rev=.5)
for t, nt in zip(cues['routeSwaps'], ['A4', 'B4']):
    sc.add(mallet(hz(nt), .6, .15), t, .09, .4, rev=.4)
    sc.add(coin, t + .3, .06, -.45, rev=.5)

# --- Every transfer, timed: a mallet per pill, pitch from its minutes (quick = low, very long = high),
#     pan from its order across the sweep; a tick on top for a clean onset.
pills, vals = cues['pills'], cues.get('pillVals') or [5] * len(cues['pills'])
lo, hi = min(vals), max(vals)
for i, (t, v) in enumerate(zip(pills, vals)):
    deg = round((v - lo) / ((hi - lo) or 1) * 6)
    pan = -.4 + .8 * i / max(1, len(pills) - 1)
    sc.add(mallet(hz(penta[deg]), .6, .15), t, .075, pan, rev=.45)
    sc.add(tick(4400, .008, .0015), t, .028, pan)
for t in cues['callouts']:
    sc.add(tick(3000, .03, .006), t, .07, .3, rev=.3)

# --- Openings: the date rolls (clock ticks), then the stations switch on with a bright triad.
for i, t in enumerate(cues['dateTicks']):
    sc.add(tick(2800 + 60 * i, .012, .002), t, .035, -.5)
for k, nt in enumerate(['D6', 'F#6', 'A6']):
    sc.add(bell(hz(nt), 2.8, .9, 2.0, 1.2), on + .03 * k, .1, .25 + .15 * k, rev=.7)
sc.add(mallet(hz('D4'), 1.0, .3), on, .12, .2, rev=.5)

# --- End card: a riser as the lines retract, three snaps as they land in the mark, an impact,
#     then bells on the title words and the link.
sc.add(riser(lands[0] - cues['gather'][0] + .05, 300, 22), cues['gather'][0] - .05, .22, rev=.3)
for t, nt, pan in zip(lands, ['G4', 'B4', 'D5'], [-.35, -.3, -.25]):
    sc.add(mallet(hz(nt), .8, .2), t, .12, pan, rev=.4)
    sc.add(tick(5200, .01, .0015), t, .07, pan)
sc.add(boom(2.2, 78, 44, .6, .3), lands[0], .32, rev=.4)
for k, nt in enumerate(['G5', 'B5', 'D6']):
    sc.add(bell(hz(nt), 2.6, .9, 2.0, 1.1), cues['title'] + .2 + k * .14, .075, -.3 + .2 * k, rev=.7)
sc.add(bell(hz('G6'), 2.4, .8, 3.5, 1.2), cues['url'] + .1, .06, .3, rev=.8)

sc.write(sys.argv[2])
