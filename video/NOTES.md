# Singapore MRT Planner · explainer film

A 25-second, 1920×1080, 60 fps motion-graphics explainer for <https://semui01.github.io/transit/>, with a
synthesised score and no voiceover. The finished film is `out/singapore-mrt-planner.mp4`, with its last
frame as `out/singapore-mrt-planner-poster.png`. Open `film.html` in a browser (served over http, e.g.
`npm start` at the repo root, then `/video/film.html`) to play and scrub it live.

## Rebuild

Needs Node 18+ with Playwright and its Chromium, ffmpeg (libx264, AAC) and Python 3 with numpy.

```bash
cd video
node data/prepare.mjs                                         # recompute data.js from ../data and ../js
./build.sh /tmp/mrt-frames out/singapore-mrt-planner.mp4      # render (~5 min), score, encode, check
DRAFT=1 ./build.sh /tmp/mrt-frames /tmp/draft.mp4             # fast pass with every check
node tools/stills.mjs --every 0.5 --sheet /tmp/sheet.jpg --out /tmp/stills   # contact sheet
```

`build.sh` documents its options in its header (FILM, SUB, WORKERS, CRF, VENUE, NO_AUDIO, FROM/TO, …).
Frames are about 2 MB each as PNG; keep them outside the repo (`video/.gitignore` ignores `frames/`).

## Source

- **Site and code:** `semui01/transit`, commit `87e90c7` (2026-11-08, "Show how long each interchange
  transfer takes"), read in full. The page itself was also fetched at <https://semui01.github.io/transit/>.
- **Look:** the site's light theme (`index.html` `:root` tokens), its three typefaces (Schibsted Grotesk,
  Public Sans, Barlow Semi Condensed; SIL OFL 1.1, from `google/fonts`, licences in `fonts/`), its mark
  (three bars in NSL red, EWL green, CCL orange) and the way `js/app.js` draws the map (line widths,
  interchange capsules, dashed not-yet-open segments, the 22% dim behind a route, transfer pills).
- **Numbers:** `data/prepare.mjs` runs the site's own engine (`../js/planner.js`) on its own data
  (`../data/network.js`, `../data/fares.js`) for the travel date **8 Nov 2026**, and writes `data.js`.
  Nothing on screen is typed in by hand. Re-running it at commit `87e90c7` reproduces the filmed
  `data.js` byte for byte; after the planner's data changes, it updates the film's numbers.
- **The map** is the planner's own drawing from station positions on the LTA system map (SM-26-01-EN),
  re-drawn in canvas. It is not LTA's official map artwork.

## Storyboard as built

| # | Time (s) | What moves | On-screen text | Sound |
|---|---|---|---|---|
| 1 | 0–3.0 | The network draws itself: each line shoots out from its first station, stations pop as it passes; the site's header fades in | Singapore MRT Planner · Plan any MRT / or LRT journey. | Gadd9 pad opening up; a rising mallet note per line |
| 2 | 3.0–6.45 | Pins drop on Jurong East (A) and Changi Airport (B); the network dims to 22%; a train dot runs the suggested route, the camera follows and pushes in; it walks across Tanah Merah and takes the airport branch | Where to change. · Jurong East · Changi Airport · 3 min · TANAH MERAH / Quick change | Em7; pin plinks, rising whoosh, glassy chime on the change |
| 3 | 6.45–9.5 | Pull back; the journey bar fills ride–change–ride while a counter climbs | How long it takes. · 53 min · 50 min on trains · 3 min transferring | Cmaj7; falling whoosh, ticks with the counter, mallet + bell when 53 lands |
| 4 | 9.5–12.9 | The fare lands; the map swaps to two slower routes while the fare stays put | What it costs. · ADULT CARD FARE · $2.49 · Every route costs the same. · line chips and 53 / 68 / 71 min | Am7; a coin-like ding, repeated quieter on each swap |
| 5 | 13.0–16.9 | Zoom into the city core; a transfer-time pill pops at every interchange in view, sweeping west to east | Every transfer, timed. · legend ≤3 / 4–5 / 6–7 / 8+ min · CITY HALL / Quick change · OUTRAM PARK / Very long | Em9; rising whoosh, a mallet per pill (pitch from its minutes) |
| 6 | 16.9–20.2 | Pan east; the planner's travel date rolls to 26 Dec 2026; the dashed TEL and DTL extensions fill in solid and the three stations light up | Openings switch on / by themselves. · TRAVELLING ON · 8 Nov → 26 Dec 2026 · Bedok South · Sungei Bedok · Xilin | Dsus4 → D; whip, clock ticks, bright triad on opening day |
| 7 | 20.2–25.0 | Pull back; the NSL, EWL and CCL lines retract and fly into the site's three-bar mark; end card (complete by ≈22.6 s, held 2.4 s) | Singapore MRT Planner · Where to change, how long, what it costs. · semui01.github.io/transit | riser, three snaps as the bars land, impact, resolve to G, bells on the title and link |

## Every on-screen fact and its source

| On screen | Value | Source |
|---|---|---|
| Example journey | Jurong East → Changi Airport | The site's default example (`js/app.js` `DEFAULT_EXAMPLE`) |
| Suggested route | EWL towards Pasir Ris to Tanah Merah, then the Changi Airport branch (CG); 22 stops | `planner.plan()` on 8 Nov 2026 |
| Transfer | Tanah Merah, 3 min, "Quick change" | `data/network.js` transfers; rating thresholds `planner.LEVELS` (≤3 quick, ≤5 short walk, ≤7 long walk, else very long) |
| Journey time | 53 min = 50 min on trains + 3 min transferring (legs 42.1 + 7.7 min) | `planner.plan()`; the site says times are estimates and exclude waiting for the first train |
| Fare | $2.49 adult card fare | `planner.fareFor()`: shortest distance 32.4 km. Cross-checked with LTA's fare table effective 27 Dec 2025, basic services, 32.3–33.2 km = $2.49 (<https://www.lta.gov.sg/content/dam/ltagov/img/map/bus/fare-table.pdf>). The planner flags this band as derived from the band pattern; LTA's table agrees with it |
| Same fare on every route | 53, 68 and 71 min routes, all $2.49 | Planner rule: train fares are charged on the shortest entry-to-exit distance. The 72-min option via Tampines needs a tap-out transfer and is left out so no footnote is needed |
| Slower routes | EWL › CCL › DTL › EWL (CG) 68 min; EWL › NEL › DTL › EWL (CG) 71 min | `planner.plan()` `moreOptions` |
| Transfer pills | The real minutes at the 15 interchanges in view (e.g. City Hall 3, Outram Park 5–8, Newton 9 tap-out) | `planner.stationTransfers()` per interchange, as the app's map pills show them |
| Outram Park "Very long" | Its longest transfer, EWL ↔ TEL, is 8 min | `data/network.js` (note: the TEL platforms are deep underground) |
| Openings | Bedok South (TE30), Sungei Bedok (TE31/DT37), Xilin (DT36) on 26 Dec 2026 | `data/network.js` `opens`; confirmed by LTA's release (<https://www.lta.gov.sg/content/ltagov/en/newsroom/2026/11/news-releases/tel5-dtl3e-passenger-service-26-dec-2026.html>) |
| "Openings switch on by themselves" | | Site text: "Stations with an announced opening date switch on by themselves on that date." |
| "Travelling on" | the app's date field label | `index.html` |

## Simplifications an expert might question

- The train dot moves at an eased constant pace; it does not model dwell times at intermediate stops.
- "Every route costs the same" is shown only for routes without a tap-out transfer.
- The 26 Dec 2026 fare rise (+13¢ for this trip, $2.62) also switches on by date in the planner; the
  film shows only the station openings, to keep the scene to one idea.
- Station names are shown only where the story needs them; the full map carries no labels.
- Map strokes thin slightly as the camera zooms in, so close-ups stay legible.

## Checks

Draft build (`DRAFT=1`, 1 sub-frame): 0 high, 0 medium findings after fixes; text 49 elements, 87 words
(3.48 words/s); audio −16.0 LUFS integrated, −2.6 dBTP, LRA 4.7 LU; 5% of energy below 60 Hz, 10% below
120 Hz; sync medians: pills +0.2 ms (15/15), pins +0.5 ms (2/2), lands −0.4 ms (3/3).

Final build (4 sub-frames, up to 12 in camera moves; H.264 CRF 15 + AAC 256 kb/s, 16.3 MB):
0 high, 0 medium findings. Picture mean luma median 0.92 (light theme, no grey washes); text 49
elements, 87 words, OK; audio −16.0 LUFS integrated, −2.6 dBTP, LRA 4.7 LU; 5% of energy below 60 Hz,
10% below 120 Hz; sync medians unchanged (pills +0.2 ms, pins +0.5 ms, lands −0.4 ms). The mix was
checked by measurement only; nobody has listened to it yet.

Files: `out/singapore-mrt-planner.mp4` and `out/singapore-mrt-planner-poster.png` (last frame). Each
build also writes contact sheets and a spectrogram beside them; those are ignored by git.
