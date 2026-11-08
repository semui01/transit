#!/usr/bin/env python3
"""
Build data/tokyo/network.js (Tokyo Metro + Toei Subway) for the Metro Planner.

Input: the Mini Tokyo 3D open data (https://github.com/nagix/mini-tokyo-3d, MIT):
  curl -LO https://raw.githubusercontent.com/nagix/mini-tokyo-3d/master/data/stations.json
  curl -LO https://raw.githubusercontent.com/nagix/mini-tokyo-3d/master/data/railways.json

Run:
  python3 tools/build_tokyo.py --stations stations.json --railways railways.json

The official route map PDF has no machine-readable text, so the map is drawn
geographically: station coordinates are projected with a mild fisheye around
Tokyo Station (the centre is spread out, the suburbs pulled in), and labels are
placed automatically to avoid overlaps.

Everything that is not in the open data (station codes, official line lengths,
transfer times, transfers between differently named stations) is in CONFIG.
"""
import argparse, datetime, json, math, re, sys

# ----------------------------------------------------------------- CONFIG ---
# line id: (Mini Tokyo 3D railway id, English name, Japanese name, colour, operator)
LINES = {
    "G": ("TokyoMetro.Ginza", "Ginza Line", "銀座線", "#FF9500", "metro"),
    "M": ("TokyoMetro.Marunouchi", "Marunouchi Line", "丸ノ内線", "#F62E36", "metro"),
    "Mb": ("TokyoMetro.MarunouchiBranch", "Marunouchi Line (Honancho branch)", "丸ノ内線（方南町支線）", "#F62E36", "metro"),
    "H": ("TokyoMetro.Hibiya", "Hibiya Line", "日比谷線", "#B5B5AC", "metro"),
    "T": ("TokyoMetro.Tozai", "Tozai Line", "東西線", "#009BBF", "metro"),
    "C": ("TokyoMetro.Chiyoda", "Chiyoda Line", "千代田線", "#00BB85", "metro"),
    "Y": ("TokyoMetro.Yurakucho", "Yurakucho Line", "有楽町線", "#C1A470", "metro"),
    "Z": ("TokyoMetro.Hanzomon", "Hanzomon Line", "半蔵門線", "#8F76D6", "metro"),
    "N": ("TokyoMetro.Namboku", "Namboku Line", "南北線", "#00AC9B", "metro"),
    "F": ("TokyoMetro.Fukutoshin", "Fukutoshin Line", "副都心線", "#9C5E31", "metro"),
    "A": ("Toei.Asakusa", "Asakusa Line", "都営浅草線", "#E85298", "toei"),
    "I": ("Toei.Mita", "Mita Line", "都営三田線", "#0079C2", "toei"),
    "S": ("Toei.Shinjuku", "Shinjuku Line", "都営新宿線", "#6CBB5A", "toei"),
    "E": ("Toei.Oedo", "Oedo Line", "都営大江戸線", "#B6007A", "toei"),
}
OPERATORS = {"metro": {"name": "Tokyo Metro", "ja": "東京メトロ"}, "toei": {"name": "Toei Subway", "ja": "都営地下鉄"}}

# Stations served by through trains beyond the subway (dropped).
TRIM = {"C": (2, 0), "H": (0, 1)}   # (drop from start, drop from end)

def codes_for(line, n):
    if line == "Mb":
        return ["Mb03", "Mb04", "Mb05", "M06"]          # Honancho ... Nakano-sakaue
    if line == "E":
        return ["E28"] + [f"E{i:02d}" for i in range(1, 39)]   # Tochomae, loop E01..E27, Tochomae, E29..E38
    return [f"{line}{i:02d}" for i in range(1, n + 1)]

def paths_for(line, codes):
    if line == "Mb":
        return [list(reversed(codes))]                    # M06 -> Mb03
    if line == "E":
        return [codes[:29], codes[28:]]                   # loop E28..E28, radial E28..E38
    return [codes]

# Official operating lengths (km) used to scale coordinate distances.
LENGTHS = [
    ("G", "G01", "G19", 14.2), ("M", "M01", "M25", 24.2), ("Mb", "M06", "Mb03", 3.2),
    ("H", "H01", "H22", 20.3), ("T", "T01", "T23", 30.8), ("C", "C01", "C19", 21.9), ("C", "C19", "C20", 2.1),
    ("Y", "Y01", "Y24", 28.3), ("Z", "Z01", "Z14", 16.8), ("N", "N01", "N19", 21.3), ("F", "F06", "F16", 11.9),
    ("A", "A01", "A20", 18.3), ("I", "I03", "I27", 24.2), ("S", "S01", "S21", 23.5),
    ("E", "E28", "E27", 27.8, 0), ("E", "E28", "E38", 12.9, 1),    # loop path 0, radial path 1
]
# Shared track: copy segment lengths from the owning line.
COPY = [("F", "F01", "F06", "Y", "Y01"), ("I", "I01", "I03", "N", "N01")]

# Transfers between differently named stations: (codes of station A, codes of station B, minutes, out of gates)
LINKS = [
    ("G05", "Y16", 7, False),   # Akasaka-mitsuke - Nagatacho
    ("G06", "M14", 6, False),   # Tameike-sanno - Kokkai-gijidomae
    ("H08", "Y18", 6, False),   # Hibiya - Yurakucho
    ("G09", "Y19", 7, True),    # Ginza - Ginza-itchome
    ("M22", "I12", 7, False),   # Korakuen - Kasuga
    ("G15", "E09", 6, False),   # Ueno-hirokoji - Ueno-okachimachi
    ("G15", "H17", 7, True),    # Ueno-hirokoji - Naka-okachimachi
    ("M19", "S07", 5, False),   # Awajicho - Ogawamachi
    ("M19", "C12", 6, True),    # Awajicho - Shin-ochanomizu
    ("S09", "A15", 5, False),   # Bakuro-yokoyama - Higashi-nihombashi
    ("E19", "G08", 8, False),   # Shiodome - Shimbashi
    ("G07", "H06", 8, True),    # Toranomon - Toranomon Hills
]

DEFAULT_TRANSFER = 5
# (code, code): minutes. Codes are matched within the same station complex.
TRANSFER_MIN = {
    ("G05", "M13"): 3, ("G02", "Z02"): 3, ("Z06", "S05"): 3, ("M06", "E30"): 5,
    ("N01", "I01"): 2, ("N02", "I02"): 2, ("N03", "I03"): 2,
    ("Y01", "F01"): 2, ("Y02", "F02"): 2, ("Y03", "F03"): 2, ("Y04", "F04"): 2, ("Y05", "F05"): 2, ("Y06", "F06"): 3,
    ("Y07", "F07"): 3, ("Y08", "F08"): 3, ("Y09", "F09"): 5,
    ("M18", "Z08"): 8, ("M18", "I09"): 7, ("M18", "C11"): 6, ("M18", "T09"): 6, ("Z08", "I09"): 6, ("Z08", "C11"): 7,
    ("Z08", "T09"): 6, ("T09", "C11"): 5, ("T09", "I09"): 6, ("C11", "I09"): 5,
    ("E06", "T06"): 8, ("E06", "Y13"): 8, ("E06", "N10"): 8, ("T06", "Y13"): 6, ("T06", "N10"): 6, ("Y13", "N10"): 4,
    ("E27", "M08"): 8, ("E27", "S01"): 5, ("S01", "M08"): 7,
    ("H04", "E23"): 7, ("G04", "Z03"): 4, ("G04", "E24"): 6, ("Z03", "E24"): 6,
    ("G01", "Z01"): 7, ("G01", "F16"): 9, ("Z01", "F16"): 5,
    ("M25", "Y09"): 6, ("M25", "F09"): 6,
    ("Y14", "N09"): 4, ("S04", "Y14"): 6, ("S04", "N09"): 6, ("M12", "N08"): 6,
    ("G11", "T10"): 4, ("A13", "G11"): 6, ("A13", "T10"): 6, ("G12", "Z09"): 6,
    ("T12", "E15"): 6, ("Z11", "E14"): 6, ("Y21", "E16"): 5, ("Z14", "A20"): 4,
    ("G19", "A18"): 6, ("A17", "E11"): 9, ("M21", "E08"): 8,
    ("H10", "A11"): 4, ("C03", "F15"): 5, ("Z07", "I10"): 4, ("Z07", "S06"): 4, ("I10", "S06"): 4,
    ("M09", "F13"): 5, ("F13", "S02"): 4, ("M09", "S02"): 6, ("M22", "N11"): 6,
}
OUT_OF_GATE = {("A17", "E11"), ("M21", "E08")}
LOOP_CHANGE_MIN = 3   # Marunouchi main line <-> Honancho branch at Nakano-sakaue

SAME_PLATFORM = "Same platforms: both lines share the track here."
NOTES = {
    ("G05", "M13"): "Cross-platform for some directions.",
    ("G02", "Z02"): "Cross-platform for some directions.",
    ("Z06", "S05"): "Cross-platform for some directions.",
    ("N01", "I01"): SAME_PLATFORM, ("N02", "I02"): SAME_PLATFORM, ("N03", "I03"): SAME_PLATFORM,
    ("Y01", "F01"): SAME_PLATFORM, ("Y02", "F02"): SAME_PLATFORM, ("Y03", "F03"): SAME_PLATFORM,
    ("Y04", "F04"): SAME_PLATFORM, ("Y05", "F05"): SAME_PLATFORM,
    ("M18", "Z08"): "Otemachi is a large station; expect a long underground walk.",
    ("M18", "I09"): "Otemachi is a large station; expect a long underground walk.",
    ("Z08", "C11"): "Otemachi is a large station; expect a long underground walk.",
    ("E06", "T06"): "The Oedo Line platforms are very deep.", ("E06", "Y13"): "The Oedo Line platforms are very deep.",
    ("E06", "N10"): "The Oedo Line platforms are very deep.",
    ("E27", "M08"): "Long walk through the Shinjuku underground passages.",
    ("G01", "F16"): "The Ginza Line is above ground and the Fukutoshin Line is deep underground.",
    ("A17", "E11"): "Separate stations: leave the ticket gates and walk along the street.",
    ("M21", "E08"): "Separate stations a short walk apart.",
    ("G05", "Y16"): "Long underground passage between Akasaka-mitsuke and Nagatacho.",
    ("E19", "G08"): "Long underground walk from Shiodome to Shimbashi.",
    ("G07", "H06"): "Walk between Toranomon and Toranomon Hills stations.",
}

# Mild fisheye around Tokyo Station: r' = R0 * (r / R0) ** POWER
CENTER = (139.7671, 35.6812)
R0, POWER = 10.0, 0.72
MAP_WIDTH = 1000.0

def clean_en(s):
    s = s.replace("Toranomon-hills", "Toranomon Hills").replace("Nakano-Shimbashi", "Nakano-shimbashi")
    m = re.match(r"^(.*?)<(.*)>$", s)
    if m:
        extra = m.group(2)
        extra = extra.title() if extra.isupper() else extra
        return m.group(1).strip(), f"{m.group(1).strip()} ({extra})"
    return s, s

def norm_ja(s):
    s = s.replace("ヶ", "ケ").replace("ヵ", "カ")   # 市ヶ谷 / 市ケ谷
    return re.sub(r"[〈<（(].*?[〉>）)]", "", s).strip()

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def hav(a, b):
    (lon1, lat1), (lon2, lat2) = a, b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    d = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(d))

def project(lon, lat):
    kx = 111.32 * math.cos(math.radians(CENTER[1]))
    dx, dy = (lon - CENTER[0]) * kx, (CENTER[1] - lat) * 110.57
    r = math.hypot(dx, dy)
    if r == 0: return 0.0, 0.0
    rp = R0 * (r / R0) ** POWER
    return dx / r * rp, dy / r * rp

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stations", required=True)
    ap.add_argument("--railways", required=True)
    ap.add_argument("--out", default="data/tokyo/network.js")
    args = ap.parse_args()
    mst = {s["id"]: s for s in json.load(open(args.stations))}
    mrw = {r["id"]: r for r in json.load(open(args.railways))}

    # ---- per-line codes and per-code station info
    code_info = {}          # code -> dict(en, full, ja, coord)
    line_paths = {}
    for lid, (rid, en, ja, color, op) in LINES.items():
        sids = mrw[rid]["stations"]
        a, b = TRIM.get(lid, (0, 0))
        sids = sids[a:len(sids) - b if b else None]
        codes = codes_for(lid, len(sids))
        assert len(codes) == len(sids), (lid, len(codes), len(sids))
        for c, sid in zip(codes, sids):
            s = mst[sid]
            short, full = clean_en(s["title"]["en"])
            info = dict(en=short, full=full, ja=s["title"]["ja"], coord=tuple(s["coord"]))
            if c in code_info:   # Oedo's Tochomae appears twice
                continue
            code_info[c] = info
        line_paths[lid] = paths_for(lid, codes)

    # ---- group codes into stations by Japanese name
    groups = {}
    for c, info in code_info.items():
        groups.setdefault(norm_ja(info["ja"]), []).append(c)
    stations = []
    code_station = {}
    for key, codes in groups.items():
        infos = [code_info[c] for c in codes]
        spread = max(hav(p["coord"], q["coord"]) for p in infos for q in infos)
        if spread > 0.7:
            print(f"WARNING {key}: codes {codes} are {spread:.2f} km apart", file=sys.stderr)
        metro_first = sorted(codes, key=lambda c: (LINES[re.match(r'[A-Za-z]+', c).group(0)][4] != "metro", c))
        pick = code_info[metro_first[0]]
        full = max((code_info[c]["full"] for c in codes), key=len)
        lon = sum(p["coord"][0] for p in infos) / len(infos)
        lat = sum(p["coord"][1] for p in infos) / len(infos)
        order = list(LINES)
        codes_sorted = sorted(codes, key=lambda c: (order.index(re.match(r"[A-Za-z]+", c).group(0)), c))
        st = dict(id=slug(pick["en"]), name=full, short=pick["en"], ja=norm_ja(pick["ja"]) if "〈" not in pick["ja"] else pick["ja"],
                  codes=codes_sorted, lat=round(lat, 5), lon=round(lon, 5))
        stations.append(st)
        for c in codes: code_station[c] = st
    ids = [s["id"] for s in stations]
    assert len(ids) == len(set(ids)), "duplicate station ids"

    # ---- complexes (transfers between differently named stations)
    parent = {s["id"]: s["id"] for s in stations}
    def find(x):
        while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for a, b, _, _ in LINKS:
        ra, rb = find(code_station[a]["id"]), find(code_station[b]["id"])
        if ra != rb: parent[rb] = ra
    members = {}
    for s in stations: members.setdefault(find(s["id"]), []).append(s)
    for root, ss in members.items():
        if len(ss) > 1:
            cid = "x-" + "-".join(sorted(s["id"] for s in ss))[:60]
            lines_seen = {}
            for s in ss:
                for c in s["codes"]:
                    for lid, paths in line_paths.items():
                        if any(c in p for p in paths):
                            assert lid not in lines_seen or lines_seen[lid] == s["id"], f"complex {cid} has two stations on {lid}"
                            lines_seen[lid] = s["id"]
                s["complex"] = cid

    # ---- distances
    seg = {}   # (line, path index, i) -> km
    for lid, paths in line_paths.items():
        for pi, p in enumerate(paths):
            for i in range(len(p) - 1):
                seg[(lid, pi, i)] = hav(code_info[p[i]]["coord"], code_info[p[i + 1]]["coord"])
    for item in LENGTHS:
        lid, a, b, km = item[:4]
        pi = item[4] if len(item) > 4 else 0
        p = line_paths[lid][pi]
        i, j = p.index(a), (len(p) - 1 if lid == "E" and pi == 0 else p.index(b))
        raw = sum(seg[(lid, pi, k)] for k in range(i, j))
        for k in range(i, j): seg[(lid, pi, k)] *= km / raw
    for lid, a, b, src, sa in COPY:
        p, q = line_paths[lid][0], line_paths[src][0]
        i, j, si = p.index(a), p.index(b), q.index(sa)
        for k in range(i, j): seg[(lid, 0, k)] = seg[(src, 0, si + (k - i))]

    out_lines = {}
    for lid, (rid, en, ja, color, op) in LINES.items():
        out_lines[lid] = dict(name=en, short=en.replace(" Line", "").replace(" (Honancho branch)", " branch"), ja=ja,
                              color=color, kind="MRT", operator=op,
                              paths=[dict(stops=p, km=[round(seg[(lid, pi, i)], 3) for i in range(len(p) - 1)])
                                     for pi, p in enumerate(line_paths[lid])])

    # ---- transfers
    def tmin(a, b):
        return TRANSFER_MIN.get((a, b)) or TRANSFER_MIN.get((b, a))
    def note(a, b):
        return NOTES.get((a, b)) or NOTES.get((b, a))
    transfers = []
    def add_transfer(a, b, m, oog):
        t = dict(a=a, b=b, min=m)
        if oog: t["tapOut"] = True
        n = note(a, b)
        if n: t["note"] = n
        transfers.append(t)
    for s in stations:
        cs = s["codes"]
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                a, b = cs[i], cs[j]
                add_transfer(a, b, tmin(a, b) or DEFAULT_TRANSFER, (a, b) in OUT_OF_GATE or (b, a) in OUT_OF_GATE)
    walk_links = []
    for a, b, m, oog in LINKS:
        sa, sb = code_station[a], code_station[b]
        walk_links.append([sa["id"], sb["id"]])
        for ca in sa["codes"]:
            for cb in sb["codes"]:
                add_transfer(ca, cb, tmin(ca, cb) or m, oog)

    # ---- projection
    for s in stations:
        s["_p"] = project(s["lon"], s["lat"])
    xs = [s["_p"][0] for s in stations]; ys = [s["_p"][1] for s in stations]
    k = MAP_WIDTH / (max(xs) - min(xs))
    pad = 60
    for s in stations:
        s["x"] = round((s["_p"][0] - min(xs)) * k + pad, 1)
        s["y"] = round((s["_p"][1] - min(ys)) * k + pad, 1)
    vbw, vbh = MAP_WIDTH + 2 * pad, round((max(ys) - min(ys)) * k + 2 * pad)

    # ---- labels: greedy placement avoiding other labels, stations and lines
    FS = 6.2
    pos = {s["id"]: (s["x"], s["y"]) for s in stations}
    segs = []
    for lid, paths in line_paths.items():
        for p in paths:
            for a, b in zip(p, p[1:]):
                segs.append((pos[code_station[a]["id"]], pos[code_station[b]["id"]]))
    samples = []
    for (x1, y1), (x2, y2) in segs:
        n = max(1, int(math.hypot(x2 - x1, y2 - y1) / 2.5))
        for t in range(n + 1):
            samples.append((x1 + (x2 - x1) * t / n, y1 + (y2 - y1) * t / n))
    grid = {}
    def gkey(x, y): return (int(x // 12), int(y // 12))
    for pt in samples: grid.setdefault(gkey(*pt), []).append(pt)
    placed = []
    def hits(box):
        x0, y0, x1, y1 = box
        n = 0
        for gx in range(int(x0 // 12), int(x1 // 12) + 1):
            for gy in range(int(y0 // 12), int(y1 // 12) + 1):
                for (px, py) in grid.get((gx, gy), ()):
                    if x0 <= px <= x1 and y0 <= py <= y1: n += 1
        return n
    def overlap(b, c):
        return max(0, min(b[2], c[2]) - max(b[0], c[0])) * max(0, min(b[3], c[3]) - max(b[1], c[1]))
    FSJ = 5.2   # Japanese line
    order = sorted(stations, key=lambda s: (-len(s["codes"]), -("complex" in s), s["y"]))
    for s in order:
        text, ja = s["short"], norm_ja(s["ja"])
        wen, wja = len(text) * FS * 0.5 + 1, len(ja) * FSJ + 0.5
        w, h = max(wen, wja), FS + FSJ * 1.15
        x, y = pos[s["id"]]
        off = 4.2
        # (anchor, anchor x, top of the two-line box)
        cands = [("start", x + off, y - h * 0.45), ("end", x - off, y - h * 0.45),
                 ("start", x + off * 0.7, y - off * 0.7 - h), ("end", x - off * 0.7, y - off * 0.7 - h),
                 ("start", x + off * 0.7, y + off * 0.7), ("end", x - off * 0.7, y + off * 0.7),
                 ("middle", x, y - off - h), ("middle", x, y + off)]
        best = None
        for rank, (anchor, ax, top) in enumerate(cands):
            x0 = ax if anchor == "start" else ax - w if anchor == "end" else ax - w / 2
            box = (x0, top, x0 + w, top + h)
            score = rank * 0.4 + hits(box) * 3
            score += sum(overlap(box, b) for b in placed) * 2.5
            score += sum(1 for o in stations if o is not s and box[0] - 2 < o["x"] < box[2] + 2 and box[1] - 2 < o["y"] < box[3] + 2) * 6
            if best is None or score < best[0]: best = (score, anchor, ax, top, box)
        _, anchor, ax, top, box = best
        placed.append(box)
        minor = 0 if (len(s["codes"]) > 1 or "complex" in s) else 1
        y_en = top + FS * 0.8
        # [text, anchor x, baseline y, width, font size, minor, language, anchor]
        s["label"] = [[text, round(ax, 1), round(y_en, 1), round(wen, 1), FS, minor, None, anchor],
                      [ja, round(ax, 1), round(y_en + FSJ * 1.15, 1), round(wja, 1), FSJ, minor, "ja", anchor]]

    out_st = []
    for s in sorted(stations, key=lambda s: s["name"]):
        e = {k: s[k] for k in ("id", "name", "ja", "codes", "lat", "lon", "x", "y", "label")}
        if s["short"] != s["name"]: e["short"] = s["short"]
        if "complex" in s: e["complex"] = s["complex"]
        out_st.append(e)

    data = dict(
        meta=dict(title="Tokyo Metro & Toei Subway", systemMap="Tokyo subway route map (Mar 2023)",
                  source="Mini Tokyo 3D open data (coordinates, names); official line lengths; codes per the route map",
                  generated=datetime.date.today().isoformat(), viewBox=[0, 0, round(vbw), vbh],
                  loopChangeMin=LOOP_CHANGE_MIN, operators=OPERATORS,
                  timing={"MRT": {"dwellMin": 0.7, "kmh": 46}}, walkLinks=walk_links),
        lines=out_lines, stations=out_st, transfers=transfers)
    with open(args.out, "w") as fh:
        fh.write("/* Generated by tools/build_tokyo.py - edit CONFIG there and re-run. */\n")
        fh.write("window.MRT_DATA = window.MRT_DATA || {};\nwindow.MRT_DATA[\"tokyo/network\"] = ")
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    tot = {lid: round(sum(L["paths"][i]["km"][j] for i in range(len(L["paths"])) for j in range(len(L["paths"][i]["km"]))), 1) for lid, L in out_lines.items()}
    print(f"wrote {args.out}: {len(out_st)} stations, {len(transfers)} transfers, {sum(1 for s in out_st if 'complex' in s)} linked stations; km {tot}", file=sys.stderr)

if __name__ == "__main__":
    main()
