#!/usr/bin/env python3
"""
Build data/network.js for the MRT Journey Planner.

Inputs
  --pdf      LTA system map PDF (e.g. SM_EN_Ver210726_CCL6.pdf). Used for the
             schematic position of every station code badge and station label.
  --geojson  sg-rail.geojson from https://github.com/cheeaun/sgraildata
             (station lat/lon + simplified track geometry, used for distances).

Run
  python3 tools/build_network.py --pdf SM_EN_xxx.pdf --geojson sg-rail.geojson

Everything that is not derivable from those two files (line order, transfer
times, opening dates, stations missing from the GeoJSON) lives in the CONFIG
section below, so adding a new station is usually: add its code to LINES,
add a STATION_EXTRA entry if the GeoJSON doesn't know it yet, re-run.
"""
import argparse, json, math, re, sys, datetime

# ----------------------------------------------------------------- CONFIG ---
def rng(prefix, a, b, skip=()):
    return [f"{prefix}{i}" for i in range(a, b + 1) if i not in skip]

LINES = {
    "NS": dict(name="North-South Line", short="NSL", color="#D42E12", kind="MRT",
               paths=[rng("NS", 1, 28, skip=(6,))]),
    "EW": dict(name="East-West Line", short="EWL", color="#009645", kind="MRT",
               paths=[rng("EW", 1, 33)]),
    "CG": dict(name="East-West Line (Changi Airport branch)", short="EWL (CG)", color="#009645", kind="MRT",
               paths=[["CG", "CG1", "CG2"]]),
    "NE": dict(name="North East Line", short="NEL", color="#9900AA", kind="MRT",
               paths=[rng("NE", 1, 18, skip=(2,))]),
    "CC": dict(name="Circle Line", short="CCL", color="#FA9E0D", kind="MRT",
               paths=[rng("CC", 1, 34, skip=(18,)), ["CC34", "CC4"]]),
    "DT": dict(name="Downtown Line", short="DTL", color="#005EC4", kind="MRT",
               paths=[rng("DT", 1, 37)]),
    "TE": dict(name="Thomson-East Coast Line", short="TEL", color="#9D5B25", kind="MRT",
               paths=[rng("TE", 1, 31, skip=(10, 21))]),
    "BP": dict(name="Bukit Panjang LRT", short="BPLRT", color="#748477", kind="LRT",
               paths=[rng("BP", 1, 6), ["BP6"] + rng("BP", 7, 13) + ["BP6"]]),
    "SE": dict(name="Sengkang LRT (East Loop)", short="SKLRT", color="#748477", kind="LRT",
               paths=[["STC"] + rng("SE", 1, 5) + ["STC"]]),
    "SW": dict(name="Sengkang LRT (West Loop)", short="SKLRT", color="#748477", kind="LRT",
               paths=[["STC"] + rng("SW", 1, 8) + ["STC"]]),
    "PE": dict(name="Punggol LRT (East Loop)", short="PGLRT", color="#748477", kind="LRT",
               paths=[["PTC"] + rng("PE", 1, 7) + ["PTC"]]),
    "PW": dict(name="Punggol LRT (West Loop)", short="PGLRT", color="#748477", kind="LRT",
               paths=[["PTC"] + rng("PW", 1, 7) + ["PTC"]]),
}

# Which routing line(s) a station code belongs to.
def lines_of_code(code):
    if code == "STC": return ["SE", "SW"]
    if code == "PTC": return ["PE", "PW"]
    m = re.match(r"[A-Z]+", code).group(0)
    return [m]

# Stations not (yet) in the GeoJSON. lat/lon approximate.
STATION_EXTRA = {
    "Bedok South":  dict(codes=["TE30"], lat=1.3180, lon=103.9488),
    "Sungei Bedok": dict(codes=["TE31", "DT37"], lat=1.3216, lon=103.9555),
    "Xilin":        dict(codes=["DT36"], lat=1.3296, lon=103.9665),
}

# Codes not yet in passenger service, with the announced opening date.
# The app treats them as open automatically from that date.
OPENING = {
    "TE30": "2026-12-26", "TE31": "2026-12-26", "DT36": "2026-12-26", "DT37": "2026-12-26",
}

# Interchanges where you must tap out and tap in again ("Tap Out to Transfer").
TAP_OUT = [("NS21", "DT11"), ("EW2", "DT32"), ("BP6", "DT1")]

# Transfer time in minutes (walking + average wait for the next train).
DEFAULT_TRANSFER = 5
TRANSFER_MIN = {
    ("NS1", "EW24"): 3, ("NS25", "EW13"): 3, ("NS26", "EW14"): 3, ("EW4", "CG"): 3,
    ("NS24", "NE6"): 5, ("NS24", "CC1"): 6, ("NE6", "CC1"): 5,
    ("EW16", "NE3"): 5, ("EW16", "TE17"): 8, ("NE3", "TE17"): 7,
    ("NS27", "CC33"): 5, ("NS27", "TE20"): 7, ("CC33", "TE20"): 6,
    ("EW12", "DT14"): 7, ("NS21", "DT11"): 9, ("EW2", "DT32"): 9, ("BP6", "DT1"): 6,
    ("CC34", "DT16"): 3, ("CC4", "DT15"): 5, ("CC10", "DT26"): 4, ("CC19", "DT9"): 6,
    ("CC17", "TE9"): 5, ("DT10", "TE11"): 5, ("NS22", "TE14"): 7, ("NS9", "TE2"): 6,
    ("DT35", "CG1"): 4, ("EW8", "CC9"): 4, ("NE12", "CC13"): 4, ("NS17", "CC15"): 4,
    ("EW21", "CC22"): 4, ("NE1", "CC29"): 5, ("NE4", "DT19"): 5, ("NE7", "DT12"): 5,
    ("NS4", "BP1"): 4, ("NE16", "STC"): 4, ("NE17", "PTC"): 4, ("TE31", "DT37"): 5,
}
LOOP_CHANGE_MIN = 3   # SE<->SW at Sengkang, PE<->PW at Punggol

# Short notes shown with a transfer (station popup, route steps, interchange guide).
XPLAT = "Cross-platform for some directions; otherwise one level up or down."
TEL_DEEP = "Long walk: the Thomson-East Coast Line platforms are deep underground, away from the other lines."
TRANSFER_NOTES = {
    ("NS1", "EW24"): "Cross-platform for most directions.",
    ("NS25", "EW13"): XPLAT,
    ("NS26", "EW14"): XPLAT,
    ("EW4", "CG"): "Short change within the station to the Changi Airport branch.",
    ("CC34", "DT16"): "Cross-platform.",
    ("EW16", "TE17"): TEL_DEEP,
    ("NE3", "TE17"): TEL_DEEP,
    ("NS27", "TE20"): "Long walk to the Thomson-East Coast Line platforms.",
    ("CC33", "TE20"): "Long walk to the Thomson-East Coast Line platforms.",
    ("NS22", "TE14"): "Long underground walk between the two lines.",
    ("EW12", "DT14"): "Long underground walk between the two lines.",
    ("NS24", "CC1"): "Several escalators and a long walk between the lines.",
    ("NS21", "DT11"): "Tap out, walk to the other station and tap in again.",
    ("EW2", "DT32"): "Tap out, walk to the other station and tap in again.",
    ("BP6", "DT1"): "Tap out, walk to the other station and tap in again.",
}

# Distance anchors used to calibrate the track-length factor (km, published).
DIST_ANCHORS = [("EW4", "EW15", 14.0)]   # Tanah Merah - Tanjong Pagar, "14 km" (PTC fare example)

# --------------------------------------------------------------- helpers ---
def hav(a, b):
    lat1, lon1 = map(math.radians, a); lat2, lon2 = map(math.radians, b)
    d = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(d))

def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def project(poly, cum, pt):
    """Return (distance_from_line_km, arc_position_km) of pt projected onto poly ([(lat,lon)])."""
    best = (1e9, 0)
    lat0 = math.radians(pt[0]); kx = 111.32 * math.cos(lat0); ky = 110.57
    px, py = pt[1] * kx, pt[0] * ky
    for i in range(len(poly) - 1):
        ax, ay = poly[i][1] * kx, poly[i][0] * ky
        bx, by = poly[i + 1][1] * kx, poly[i + 1][0] * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0 if L2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
        qx, qy = ax + t * dx, ay + t * dy
        d = math.hypot(px - qx, py - qy)
        if d < best[0]:
            best = (d, cum[i] + t * (cum[i + 1] - cum[i]))
    return best

# ------------------------------------------------------------------ main ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--geojson", required=True)
    ap.add_argument("--out", default="data/network.js")
    ap.add_argument("--map-version", default=None, help="e.g. SM-26-01-EN")
    args = ap.parse_args()

    import pdfplumber
    page = pdfplumber.open(args.pdf).pages[0]
    W, H = page.width, page.height
    words = page.extract_words(extra_attrs=["fontname"])  # not "size": tiny per-glyph size jitter splits words
    for w in words:
        w["size"] = w["bottom"] - w["top"]
    PREF = {"NS", "EW", "CG", "NE", "CC", "DT", "TE", "BP", "SE", "SW", "PE", "PW", "STC", "PTC"}
    LEGEND_Y = H * 0.80   # everything below is legend
    badges = {}
    for i, w in enumerate(words):
        if w["top"] > LEGEND_Y or "Identity" not in w["fontname"]:
            continue
        t = w["text"]
        if t in PREF:
            num = next((v for v in words if abs(v["top"] - w["top"]) < 3 and 0 <= v["x0"] - w["x1"] < 12
                        and re.fullmatch(r"\d{1,2}", v["text"])), None)
            x1 = num["x1"] if num else w["x1"]
            code = t + (num["text"] if num else "")
            badges[code] = ((w["x0"] + x1) / 2, (w["top"] + w["bottom"]) / 2)
    # Orphan numbers whose prefix glyphs were not extracted (seen for DT21).
    for w in words:
        if w["top"] > LEGEND_Y or not re.fullmatch(r"\d{1,2}", w["text"]): continue
        for pref in ("DT",):
            code = pref + w["text"]
            if code not in badges and any(code in L["paths"][0] for L in LINES.values() if L["paths"][0][0].startswith(pref)):
                badges[code] = (w["x0"] - 16, (w["top"] + w["bottom"]) / 2)

    geo = json.load(open(args.geojson))
    feats = geo["features"]
    stations = {}
    for f in feats:
        p = f["properties"]
        if p.get("stop_type") != "station": continue
        lon, lat = f["geometry"]["coordinates"][:2]
        stations[p["name"]] = dict(name=p["name"], codes=p["station_codes"].split("-"), lat=lat, lon=lon,
                                   zh=p.get("name_zh-Hans"), ta=p.get("name_ta"))
    for n, e in STATION_EXTRA.items():
        if n not in stations:
            stations[n] = dict(name=n, codes=e["codes"], lat=e["lat"], lon=e["lon"])

    code2st = {}
    for s in stations.values():
        for c in s["codes"]:
            code2st[c] = s["name"]
    all_codes = {c for L in LINES.values() for p in L["paths"] for c in p}
    missing = sorted(c for c in all_codes if c not in code2st)
    nobadge = sorted(c for c in all_codes if c not in badges)
    if missing: print("WARNING codes without station:", missing, file=sys.stderr)
    if nobadge: print("WARNING codes without map position:", nobadge, file=sys.stderr)

    # ---- schematic positions (viewBox units)
    S = 0.2
    VBW, VBH = round(W * S), round(LEGEND_Y * S)
    for s in stations.values():
        pts = [badges[c] for c in s["codes"] if c in badges]
        s["badges"] = {c: [round(badges[c][0] * S, 1), round(badges[c][1] * S, 1)] for c in s["codes"] if c in badges}
        if pts:
            s["x"] = round(sum(p[0] for p in pts) / len(pts) * S, 1)
            s["y"] = round(sum(p[1] for p in pts) / len(pts) * S, 1)

    # ---- labels: find the station's name words nearest to its badges
    namewords = [w for w in words if w["top"] < LEGEND_Y and "Identity" in w["fontname"]
                 and w["text"] not in PREF and not re.fullmatch(r"\d{1,2}", w["text"]) and w["size"] > 24]
    used = set()
    def cand_label(s):
        toks = s["name"].replace("one-north", "one-north").split()
        cx, cy = s["x"] / S, s["y"] / S
        best = None
        firsts = [i for i, w in enumerate(namewords) if w["text"] == toks[0] and i not in used]
        for i in firsts:
            w0 = namewords[i]
            d0 = math.hypot((w0["x0"] + w0["x1"]) / 2 - cx, (w0["top"] + w0["bottom"]) / 2 - cy)
            if d0 > 700: continue
            chosen = [i]; cost = d0; ok = True
            prev = w0
            for t in toks[1:]:
                cands = [(math.hypot(w["x0"] - prev["x1"], w["top"] - prev["top"]) if abs(w["top"] - prev["top"]) < 5
                          else math.hypot(w["x0"] - prev["x0"], w["top"] - prev["bottom"]) + 5, j)
                         for j, w in enumerate(namewords) if w["text"] == t and j not in used and j not in chosen]
                cands = [c for c in cands if c[0] < 140]
                if not cands: ok = False; break
                c = min(cands); chosen.append(c[1]); cost += c[0]; prev = namewords[c[1]]
            if ok and (best is None or cost < best[0]):
                best = (cost, chosen)
        return best
    pending = [s for s in stations.values() if "x" in s]
    while pending:
        scored = [(cand_label(s), s) for s in pending]
        scored = [(b, s) for b, s in scored if b]
        if not scored: break
        b, s = min(scored, key=lambda t: t[0][0])
        used.update(b[1])
        ws = [namewords[j] for j in b[1]]
        rows = []
        for w in sorted(ws, key=lambda w: (round(w["top"]), w["x0"])):
            if rows and abs(rows[-1]["top"] - w["top"]) < 5:
                rows[-1]["text"] += " " + w["text"]; rows[-1]["x1"] = w["x1"]
            else:
                rows.append(dict(text=w["text"], x0=w["x0"], x1=w["x1"], top=w["top"], bottom=w["bottom"], size=w["size"]))
        # [text, x, baseline y, width, font size] in viewBox units
        s["label"] = [[r["text"], round(r["x0"] * S, 1), round((r["bottom"] - r["size"] * 0.21) * S, 1),
                       round((r["x1"] - r["x0"]) * S, 1), round(r["size"] * S, 1)] for r in rows]
        pending.remove(s)
    for s in pending:
        print("WARNING no label found for", s["name"], file=sys.stderr)

    # ---- distances along track geometry
    linegeom = {}
    name2line = {"North South Line": ["NS"], "East West Line": ["EW", "CG"], "North East Line": ["NE"],
                 "Circle Line": ["CC"], "Downtown Line": ["DT"], "Thomson-East Coast Line": ["TE"],
                 "Bukit Panjang LRT": ["BP"], "Sengkang LRT (East Loop)": ["SE"], "Sengkang LRT (West Loop)": ["SW"],
                 "Punggol LRT (East Loop)": ["PE"], "Punggol LRT (West Loop)": ["PW"]}
    for f in feats:
        g = f["geometry"]
        if g["type"] not in ("LineString", "MultiLineString"): continue
        parts = [g["coordinates"]] if g["type"] == "LineString" else g["coordinates"]
        polys = []
        for part in parts:
            poly = [(c[1], c[0]) for c in part]
            cum = [0.0]
            for i in range(1, len(poly)): cum.append(cum[-1] + hav(poly[i - 1], poly[i]))
            polys.append((poly, cum))
        for lid in name2line.get(f["properties"]["name"], []):
            linegeom.setdefault(lid, []).extend(polys)

    def seg_track(lid, a, b):
        A = (stations[code2st[a]]["lat"], stations[code2st[a]]["lon"])
        B = (stations[code2st[b]]["lat"], stations[code2st[b]]["lon"])
        h = hav(A, B)
        best = None
        for poly, cum in linegeom.get(lid, []):
            da, sa = project(poly, cum, A); db, sb = project(poly, cum, B)
            if da > 0.35 or db > 0.35: continue
            d = abs(sb - sa)
            closed = hav(poly[0], poly[-1]) < 0.05
            if closed: d = min(d, cum[-1] - d)
            if h * 0.97 <= d <= h * 1.8 and (best is None or d < best):
                best = d
        return best, h

    segs = []
    raw = {}
    for lid, L in LINES.items():
        for path in L["paths"]:
            for a, b in zip(path, path[1:]):
                if a not in code2st or b not in code2st: continue
                t, h = seg_track(lid, a, b)
                raw[(a, b)] = (t, h)
    ratios = [t / h for t, h in raw.values() if t and h > 0.4]
    fallback = sorted(ratios)[len(ratios) // 2] if ratios else 1.1
    def segkm(a, b):
        t, h = raw.get((a, b)) or raw.get((b, a))
        return t if t else h * fallback
    # calibrate against published distances along the EWL
    ew = LINES["EW"]["paths"][0]
    def along(a, b):
        i, j = sorted((ew.index(a), ew.index(b)))
        return sum(segkm(ew[k], ew[k + 1]) for k in range(i, j))
    facs = [km / along(a, b) for a, b, km in DIST_ANCHORS]
    CAL = sum(facs) / len(facs)
    print(f"geometry fallback ratio {fallback:.3f}; calibration factor {CAL:.3f} from {['%.3f' % f for f in facs]}", file=sys.stderr)

    out_lines = {}
    for lid, L in LINES.items():
        out_paths = []
        for path in L["paths"]:
            km = [round(segkm(a, b) * CAL, 2) for a, b in zip(path, path[1:])]
            out_paths.append(dict(stops=path, km=km))
        out_lines[lid] = dict(name=L["name"], short=L["short"], color=L["color"], kind=L["kind"], paths=out_paths)

    # ---- transfers
    def tkey(a, b):
        return TRANSFER_MIN.get((a, b)) or TRANSFER_MIN.get((b, a))
    transfers = []
    for s in stations.values():
        cs = s["codes"]
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                a, b = cs[i], cs[j]
                tm = tkey(a, b) or DEFAULT_TRANSFER
                tap = (a, b) in TAP_OUT or (b, a) in TAP_OUT
                t = dict(a=a, b=b, min=tm)
                if tap: t["tapOut"] = True
                note = TRANSFER_NOTES.get((a, b)) or TRANSFER_NOTES.get((b, a))
                if note: t["note"] = note
                transfers.append(t)
    # loop-to-loop changes at LRT hubs are expressed per line pair in the app (LOOP_CHANGE_MIN)

    out_st = []
    for s in sorted(stations.values(), key=lambda s: s["name"]):
        if not any(c in all_codes for c in s["codes"]): continue
        e = dict(id=slug(s["name"]), name=s["name"], codes=s["codes"], lat=round(s["lat"], 5), lon=round(s["lon"], 5))
        if s.get("zh"): e["zh"] = s["zh"]
        if "x" in s: e["x"], e["y"] = s["x"], s["y"]
        if s.get("badges") and len(s["badges"]) > 1:
            e["badges"] = s["badges"]   # per-line marker positions at interchanges
        if s.get("label"): e["label"] = s["label"]
        op = {c: OPENING[c] for c in s["codes"] if c in OPENING}
        if op: e["opens"] = op
        out_st.append(e)

    data = dict(
        meta=dict(
            title="Singapore MRT & LRT network",
            systemMap=args.map_version or "SM-26-01-EN",
            systemMapFile=args.pdf.split("/")[-1],
            source="LTA System Map (station layout) + sgraildata (coordinates, track geometry)",
            generated=datetime.date.today().isoformat(),
            viewBox=[0, 0, VBW, VBH],
            loopChangeMin=LOOP_CHANGE_MIN,
        ),
        lines=out_lines, stations=out_st, transfers=transfers)
    with open(args.out, "w") as fh:
        fh.write("/* Generated by tools/build_network.py - edit there or by hand (see README). */\n")
        fh.write("window.MRT_NETWORK = ")
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    print(f"wrote {args.out}: {len(out_st)} stations, {sum(len(p['stops']) - 1 for L in out_lines.values() for p in L['paths'])} segments", file=sys.stderr)

if __name__ == "__main__":
    main()
