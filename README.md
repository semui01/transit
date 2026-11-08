# Singapore MRT Planner

A static web app for planning MRT and LRT journeys in Singapore. Pick a start and a destination by typing a station name or code (`Dhoby Ghaut`, `NS24`, `多美歌`) or by selecting stations on the map. The app tells you:

- **where to transfer**, including which line and direction to board at each step
- **how long it takes**, split into time on trains and time transferring
- **how much it costs**, as the adult card fare (plus the early-morning fare and any announced fare change)
- **every sensible route option**, with one **suggested** route. Slower routes, or routes with more transfers, are tucked under "more routes".
- **how easy each transfer is**: the map shows the transfer time at every interchange, colour-coded from quick (cross-platform at City Hall, Raffles Place, Jurong East, Bayfront) to very long (Outram Park to the TEL, or tap-out transfers). Select a station for a breakdown by line pair. The **interchange guide** in the side panel lists them all, quickest first.

It has no build step and no dependencies. Open `index.html` in a browser, or serve the folder with any static host (GitHub Pages works: Settings → Pages → deploy from `main`, root folder).

## What's in the data

| | |
|---|---|
| Network | LTA system map **SM-26-01-EN** (`SM_EN_Ver210726_CCL6.pdf`): 187 stations on 6 MRT lines and 3 LRT systems, including **Circle Line Stage 6** (Keppel, Cantonment, Prince Edward Road; opened 12 Jul 2026) |
| Opening soon | **TEL Stage 5 and the DTL3 extension** (Bedok South, Sungei Bedok, Xilin) are loaded with their opening date, **26 Dec 2026**. They switch on by themselves on that date. Until then they are shown dashed on the map. |
| Fares | Adult card fares from **27 Dec 2025**, and the **26 Dec 2026** change (+12¢ up to 3.2 km, +13¢ above), which also switches on by date |
| Distances | Track lengths measured along the line geometry from [sgraildata](https://github.com/cheeaun/sgraildata), calibrated against PTC's published Tanah Merah–Tanjong Pagar (14 km) example |

The "Travelling on" date in the app lets you plan for a future day, for example after new stations open.

### How the numbers are worked out

- **Fare.** Singapore train fares are charged on the shortest distance between the entry and exit station, whatever route you take, so every option for a journey has the same fare. The planner computes that shortest distance and looks up the distance band in `data/fares.js`. The bands that are checked against published figures are listed in `confirmed`. The app marks other bands as worked out from the band pattern and links to LTA's fare page.
- **Journey time.** Each segment takes a dwell time plus distance at an average running speed (MRT: 0.75 min + 62 km/h; LRT: 0.5 min + 34 km/h). Transfers take a per-interchange time for walking plus the average wait, from 3 min (cross-platform) to 9 min (tap-out transfers). These are estimates, close to typical timetable times, for example Jurong East to City Hall in 24 min.
- **Route options.** The planner tries every sequence of lines up to two more transfers than the minimum, and every interchange station between consecutive lines. It drops routes that pass the same station twice. A route is shown if no route with fewer transfers beats it, and if it is close to the fastest or the quickest for its number of transfers. The **suggested** route minimises time plus 3 min per transfer (plus 2 min for a tap-out transfer).
- **Tap-out transfers** (Newton NSL–DTL, Tampines EWL–DTL, Bukit Panjang BPLRT–DTL) are labelled in the steps.
- **Transfer ratings.** Quick change: 3 min or less. Short walk: 4–5 min. Long walk: 6–7 min. Very long: 8 min or more. Times and notes per interchange live in `TRANSFER_MIN` and `TRANSFER_NOTES` in `tools/build_network.py`.

## Project layout

```
index.html                 page and styles
js/planner.js              routing and fare engine (browser + Node)
js/app.js                  UI: search, SVG map, route cards
data/network.js            stations, lines, distances, transfers (generated)
data/fares.js              fare schedules (edit by hand)
tools/build_network.py     builds data/network.js from the LTA system map PDF + sgraildata
tools/check-lta-updates.mjs  checks the LTA rail network page for changes
tests/planner.test.mjs     node --test tests/planner.test.mjs
.github/workflows/         weekly LTA check + tests on every push
```

## Keeping it up to date

### Automatic

1. **Announced openings switch on by themselves.** Any station code with an `opens` date in `data/network.js` is treated as open from that date. The same goes for fare schedules with an `effective` date in `data/fares.js`.
2. **Weekly LTA check.** `.github/workflows/check-lta-updates.yml` runs every Monday (and on demand from the Actions tab). It runs `tools/check-lta-updates.mjs`, which:
   - fetches the [LTA rail network page](https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network.html)
   - finds the system map PDF it links to and compares the file name and the `SM-yy-nn-EN` version with the planner's data
   - downloads the PDF and compares every station code on it with the planner's stations (this picks up new lines such as the Jurong Region Line or Cross Island Line as soon as they appear on the map)
   - opens a GitHub issue (or comments on the open one) with the differences

   Run it yourself with `node tools/check-lta-updates.mjs`. It exits with 0 when nothing changed, 2 when something did, and 1 when it couldn't check. LTA's site sometimes blocks automated requests. In that case the workflow fails and you can run the check locally, or check a downloaded map with `--pdf path/to/map.pdf`.

### Updating the network (when the check reports a change)

1. Download the new system map PDF from the LTA page, and the latest `sg-rail.geojson`:
   ```bash
   curl -LO https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1/sg-rail.geojson
   ```
2. Edit the `CONFIG` section at the top of `tools/build_network.py`:
   - add new codes to the line in `LINES`, in order. For a new line, add an entry with its name, colour and `kind`.
   - add the station to `STATION_EXTRA` (with approximate lat/lon) if `sg-rail.geojson` doesn't have it yet
   - add an `OPENING` date for stations that aren't open yet, and transfer times for new interchanges in `TRANSFER_MIN`
3. Rebuild and test:
   ```bash
   pip install pdfplumber
   ```
   ```bash
   python3 tools/build_network.py --pdf SM_EN_xxx.pdf --geojson sg-rail.geojson --map-version SM-yy-nn-EN
   ```
   ```bash
   node --test tests/planner.test.mjs
   ```
   The builder reads each station's position and label from the PDF. It prints a warning for any code it can't place.

### Updating fares

Add a schedule to `data/fares.js` with its `effective` date. Either list the full `bands`, or derive them from the previous schedule with `adjust` (cents added per distance range), as the 26 Dec 2026 entry does. Put bands you've checked against the official table in `confirmed`.

## Notes

- The map is drawn by the app from station positions on the LTA system map. It is not the official map artwork.
- Times are estimates and don't include waiting for the first train. Check LTA, SBS Transit or SMRT for service disruptions and planned closures.
- Only adult card fares are included. Student, senior, PWD and Workfare concession fares are lower.
