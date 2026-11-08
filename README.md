# Interchange: metro journey planner

A static web app for planning metro journeys. The home page lists the cities; pick one, then type a station name or code (`Dhoby Ghaut`, `NS24`, `渋谷`, `G09`) or select stations on the map. For every journey it shows:

- **where to transfer**, including which line and direction to board at each step, and walks between connected stations
- **how long it takes**, split into time on trains, transferring and walking
- **how much it costs**: the adult fare, worked out the way that city charges
- **every sensible route option**, with one **suggested** route. Slower routes, or routes with more transfers, are tucked under "more routes".
- **how easy each transfer is**: the map shows the transfer time at every interchange, colour-coded from quick (cross-platform) to very long. Select a station for a breakdown by line pair. The **interchange guide** in the side panel lists them all, quickest first.

Cities so far:

| City | Network | Fares |
|---|---|---|
| **Singapore** | 6 MRT lines and 3 LRT systems, 187 stations, from LTA system map SM-26-01-EN (Circle Line Stage 6 included). Bedok South, Sungei Bedok and Xilin switch on by themselves on 26 Dec 2026. | One fare by the shortest distance, whatever the route. 27 Dec 2025 table, and the 26 Dec 2026 change, picked by travel date. |
| **Tokyo** | 9 Tokyo Metro lines and 4 Toei Subway lines, 216 stations, numbered as on the March 2023 subway route map. | Each operator charges its own distance band; changing between Tokyo Metro and Toei takes ¥70 off. So the fare depends on the route, and every option shows its own. |

There is no build step and there are no dependencies. Open `index.html` in a browser, or serve the folder with any static host (GitHub Pages works: Settings → Pages → deploy from `main`, root folder). Links include the city and the journey, e.g. `#tokyo--shinjuku--asakusa`. Old Singapore links like `#jurong-east--changi-airport` still work.

## Project layout

```
index.html                    page, styles, home view and planner view
js/planner.js                 routing and fare engine (browser + Node), shared by all cities
js/app.js                     UI: city picker, search, SVG map, route cards
data/cities.js                the list of cities on the home page
data/<city>/network.js        stations, lines, distances, transfers (generated)
data/<city>/fares.js          fares (edited by hand)
tools/build_network.py        builds Singapore from the LTA system map PDF + sgraildata
tools/build_tokyo.py          builds Tokyo from the Mini Tokyo 3D open data
tools/check-lta-updates.mjs   checks LTA's rail network page and system map
tools/check-tokyo-updates.mjs checks Tokyo Metro's station index
tests/                        npm test
.github/workflows/            weekly update check (both cities) + tests on every push
```

## How the numbers are worked out

- **Journey time.** Each segment takes a dwell time plus distance at an average running speed (Singapore MRT: 0.75 min + 62 km/h, LRT: 0.5 min + 34 km/h; Tokyo: 0.7 min + 46 km/h). Transfers take a per-interchange time for walking plus the average wait. These are estimates close to timetable times, for example Jurong East to City Hall in 24 min, or Shibuya to Ueno on the Ginza Line in 26 min.
- **Route options.** The planner tries every sequence of lines up to two more transfers than the minimum, and every interchange between consecutive lines. A lower bound on the time still needed keeps this fast (under 50 ms for Tokyo). It drops routes that pass the same station twice. A route is shown if no route with fewer transfers beats it, and it is close to the fastest or the quickest for its number of transfers. The **suggested** route minimises time plus 3 min per transfer (plus 2 min for a tap-out or outside-the-gates transfer). In Tokyo, 100 yen saved counts like 2 minutes.
- **Singapore fares** are charged on the shortest distance between the entry and exit station, so every option has the same fare. Bands checked against published figures are listed in `confirmed` in `data/singapore/fares.js`.
- **Tokyo fares.** Each run of legs on one operator is charged by that operator's shortest distance between where you board and leave it, rounded up to whole km: Tokyo Metro ¥178–324 by IC card, Toei ¥178–430. When a route changes between the two, ¥70 comes off. Special fares (Ayase–Kita-senju, the shared Meguro–Shirokane-takanawa section) aren't modelled. Distances come from coordinates scaled to each line's official length, so a trip right at a band boundary may come out one band off.
- **Connected stations** (Tokyo's Akasaka-mitsuke and Nagatacho, Ginza and Ginza-itchome, and others) are joined by walkways. Routes can transfer between them, and a journey can start or end with a short walk to the connected station when that's quicker.
- **Transfer ratings.** Quick change: 3 min or less. Short walk: 4–5 min. Long walk: 6–7 min. Very long: 8 min or more. They are set per interchange in each city's builder (`TRANSFER_MIN`, `NOTES`).

## Keeping it up to date

### Automatic

1. **Announced openings switch on by themselves.** A station code with an `opens` date is treated as open from that date. A fare schedule with an `effective` date works the same way.
2. **Weekly check.** `.github/workflows/check-updates.yml` runs every Monday (and on demand from the Actions tab). For each city it compares the data with the operator's site and opens a GitHub issue (or comments on the open one) when something differs:
   - Singapore: `tools/check-lta-updates.mjs` reads the [LTA rail network page](https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network.html), finds the system map PDF, and compares its file name, version and every station code
   - Tokyo: `tools/check-tokyo-updates.mjs` reads [Tokyo Metro's station index](https://www.tokyometro.jp/station/index.html) and compares station numbers and names

   Run them yourself with `npm run check-updates`. Each exits with 0 when nothing changed, 2 when something did, and 1 when it couldn't reach the site. Operators' sites sometimes block automated requests. If that happens the workflow fails visibly, and you can run the check locally or point it at a saved copy (`--pdf map.pdf`, `--html page.html`).

### Updating Singapore

1. Download the new system map PDF from the LTA page, and the latest coordinates:
   ```bash
   curl -LO https://raw.githubusercontent.com/cheeaun/sgraildata/master/data/v1/sg-rail.geojson
   ```
2. Edit `CONFIG` in `tools/build_network.py`. Add new codes to `LINES`; add `STATION_EXTRA` coordinates if the GeoJSON lacks a station; add `OPENING` dates, `TRANSFER_MIN` and `TRANSFER_NOTES` for new interchanges.
3. Rebuild and test:
   ```bash
   python3 tools/build_network.py --pdf SM_EN_xxx.pdf --geojson sg-rail.geojson --map-version SM-yy-nn-EN
   ```
   ```bash
   npm test
   ```

### Updating Tokyo

1. Download the open data:
   ```bash
   curl -LO https://raw.githubusercontent.com/nagix/mini-tokyo-3d/master/data/stations.json
   ```
   ```bash
   curl -LO https://raw.githubusercontent.com/nagix/mini-tokyo-3d/master/data/railways.json
   ```
2. Edit `CONFIG` in `tools/build_tokyo.py`: line list and codes, official line lengths (`LENGTHS`), connected stations (`LINKS`), transfer times and notes.
3. Rebuild and test:
   ```bash
   python3 tools/build_tokyo.py --stations stations.json --railways railways.json
   ```
   ```bash
   npm test
   ```

### Updating fares

Edit `data/<city>/fares.js`. Singapore: add a schedule with its `effective` date, either with full `bands` or derived from the previous schedule with `adjust`. Tokyo: change the `bands` of `metro` or `toei` (`[upToKm, IC fare, ticket fare]`) or the `transferDiscount`.

## Adding a city

1. Create `data/<id>/network.js`. It sets `window.MRT_DATA["<id>/network"]` to `{ meta, lines, stations, transfers }`, in the same shape the two builders produce:
   - `lines[id]`: `{ name, short, color, kind: "MRT"|"LRT", operator?, paths: [{ stops: [codes], km: [segment km] }] }`
   - `stations[]`: `{ id, name, codes, x, y, label: [[text, x, y, width, fontSize, minor?]], complex?, opens? }`
   - `transfers[]`: `{ a, b, min, tapOut?, note? }` for each pair of codes you can change between
   - `meta`: `viewBox`, and optionally `timing`, `walkLinks`, `loopChangeMin`
2. Create `data/<id>/fares.js` with `model: "shortest-distance"` (Singapore style) or `model: "operator-distance"` (Tokyo style), plus `currency` and `minorUnits`.
3. Add the city to `data/cities.js`, and a test file under `tests/`.

## Notes

- Both maps are drawn by the app. Singapore uses station positions from the LTA system map. Tokyo is drawn from real coordinates, because its official map has no machine-readable text. Neither is the official map artwork.
- Times are estimates and don't include waiting for the first train. Check the operators for disruptions and planned closures.
- Only adult fares are included.
