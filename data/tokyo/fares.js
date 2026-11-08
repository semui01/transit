/*
 * Tokyo Metro and Toei Subway adult fares (yen).
 *
 * Each operator charges by its own distance band: distance in km, rounded up to
 * the next whole km. When a journey changes between Tokyo Metro and Toei, the
 * two fares are added and 70 yen is taken off. So, unlike Singapore, the fare
 * depends on which route you take.
 *
 * bands: [upToKm, IC card fare, paper ticket fare]; upToKm null = longer.
 */
window.MRT_DATA = window.MRT_DATA || {};
window.MRT_DATA["tokyo/fares"] = {
  model: "operator-distance",
  currency: "JPY",
  minorUnits: 0,
  officialCalculator: "https://www.tokyometro.jp/en/ticket/regular/index.html",
  operators: {
    metro: {
      name: "Tokyo Metro",
      effective: "2023-03-18",
      bands: [[6, 178, 180], [11, 209, 210], [19, 252, 260], [27, 293, 300], [null, 324, 330]],
      source: "Tokyo Metro regular fares (includes the barrier-free charge from 18 Mar 2023; unchanged in the 14 Mar 2026 revision)"
    },
    toei: {
      name: "Toei Subway",
      bands: [[4, 178, 180], [9, 220, 220], [15, 272, 280], [21, 325, 330], [27, 377, 380], [null, 430, 430]],
      source: "Toei Subway regular fares (IC fares in 1-yen units)"
    }
  },
  transferDiscount: { operators: ["metro", "toei"], amount: 70 },
  minutesPer100: 2,   // when ranking routes, 100 yen saved counts like 2 minutes saved
  notes: "Special fares (Ayase-Kita-senju, Meguro-Shirokane-takanawa shared section) are not modelled."
};
