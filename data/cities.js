/*
 * Cities shown on the home page. To add a city:
 *   1. create data/<id>/network.js and data/<id>/fares.js (see README)
 *   2. add an entry here
 * The city's data files are loaded only when someone opens that city.
 */
window.MRT_CITY_LIST = [
  {
    id: "singapore",
    name: "Singapore",
    local: "新加坡 · Singapura · சிங்கப்பூர்",
    title: "Singapore MRT",
    system: "MRT & LRT",
    versionLabel: "Map SM-26-01-EN",
    summary: "6 MRT lines and 3 LRT systems, 187 stations. Includes Circle Line Stage 6; Bedok South, Sungei Bedok and Xilin switch on 26 Dec 2026.",
    colors: ["#D42E12", "#009645", "#FA9E0D", "#005EC4", "#9900AA", "#9D5B25"],
    locale: "en-SG",
    example: ["jurong-east", "changi-airport"],
    localNameLabel: "Chinese",
    tapOutLabel: "Tap out to transfer",
    tapOutNote: "Tap in again within 15 minutes and it still counts as one journey.",
    fareLabel: "Adult card fare",
    about: [
      "Network: LTA system map SM-26-01-EN (SM_EN_Ver210726_CCL6.pdf). Station positions come from that map; coordinates and track lengths from the open sgraildata project.",
      "Stations with an announced opening date switch on by themselves on that date, and so do announced fare changes. A weekly check compares the data with the <a href=\"https://www.lta.gov.sg/content/ltagov/en/getting_around/public_transport/rail_network.html\" target=\"_blank\" rel=\"noopener\">LTA rail network page</a> and flags new stations or a new map."
    ]
  },
  {
    id: "tokyo",
    name: "Tokyo",
    local: "東京",
    title: "Tokyo Subway",
    system: "Tokyo Metro & Toei Subway",
    versionLabel: "Station numbers as of Mar 2023",
    summary: "9 Tokyo Metro lines and 4 Toei Subway lines, 216 stations. Fares are worked out for each route, including the ¥70 discount for changing between Tokyo Metro and Toei.",
    colors: ["#FF9500", "#F62E36", "#B5B5AC", "#009BBF", "#00BB85", "#8F76D6", "#B6007A", "#0079C2"],
    locale: "en-JP",
    example: ["shinjuku", "asakusa"],
    localNameLabel: "Japanese",
    tapOutLabel: "Transfer outside the gates",
    tapOutNote: "Leave through the ticket gates and enter again within the time limit (30 minutes at most stations); your IC card fare still counts as one journey.",
    fareLabel: "IC card fare",
    about: [
      "Network: Tokyo Metro and Toei Subway lines with station numbers as on the subway route map (March 2023). The official map has no machine-readable text, so this map is drawn from real station coordinates (Mini Tokyo 3D open data), with the centre spread out for readability. Distances are scaled to each line's official length.",
      "Through services onto other railways, JR lines and private railways are not included. A weekly check compares the station list with <a href=\"https://www.tokyometro.jp/station/index.html\" target=\"_blank\" rel=\"noopener\">Tokyo Metro's station index</a> and flags stations the planner doesn't know."
    ]
  }
];
