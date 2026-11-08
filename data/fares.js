/*
 * Adult card fares for MRT/LRT (SGD cents), by distance band.
 *
 * Train fares are charged on the SHORTEST distance between the entry and exit
 * station, whichever route you actually take, so every route option between
 * the same two stations costs the same.
 *
 * Bands: [upToKm, cents]. The last band (upToKm: null) is "over 40.2 km".
 * `confirmed` lists the bands checked against published figures; the others
 * follow the official band pattern and should be checked against the PTC/LTA
 * fare table when it is next published (see README "Updating fares").
 *
 * A schedule can either list its own `bands`, or derive them from an earlier
 * schedule with `adjust` (cents added per distance range).
 * The app picks the schedule whose `effective` date is the latest one on or
 * before the travel date, so an announced fare change switches on by itself.
 */
window.MRT_FARES = {
  currency: "SGD",
  officialCalculator: "https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/fares_and_payment.html",
  schedules: [
    {
      id: "2025-12",
      effective: "2025-12-27",
      label: "Fares from 27 Dec 2025",
      earlyDiscountCents: 50, // tap in before 7:45am on weekdays (excl. public holidays)
      bands: [
        [3.2, 128], [4.2, 138], [5.2, 149], [6.2, 159], [7.2, 168], [8.2, 175], [9.2, 182],
        [10.2, 186], [11.2, 190], [12.2, 194], [13.2, 198], [14.2, 202], [15.2, 206],
        [16.2, 210], [17.2, 214], [18.2, 218], [19.2, 222], [20.2, 226], [21.2, 229],
        [22.2, 232], [23.2, 235], [24.2, 238], [25.2, 240], [26.2, 242], [27.2, 243],
        [28.2, 244], [29.2, 245], [30.2, 246], [31.2, 247], [32.2, 248], [33.2, 249],
        [34.2, 250], [35.2, 251], [36.2, 252], [37.2, 253], [38.2, 254], [39.2, 255],
        [40.2, 256], [null, 257]
      ],
      confirmed: [3.2, 4.2, 5.2, 10.2, 11.2, 14.2, 26.2, 40.2, null],
      source: "PTC Fare Review Exercise 2025 (adult card fares, basic train services)"
    },
    {
      id: "2026-12",
      effective: "2026-12-26",
      label: "Fares from 26 Dec 2026",
      earlyDiscountCents: 50,
      derivedFrom: "2025-12",
      adjust: [ { upToKm: 3.2, cents: 12 }, { upToKm: null, cents: 13 } ],
      source: "PTC Fare Review Exercise 2026: +12c up to 3.2 km, +13c above 3.2 km (adult card)"
    }
  ]
};
