"""geo-projection@1 — the materialized geographic view of the corpus.

Joins the canonical card records against the reviewed, committed
`config/geo/resolved-places.json` and writes `data/materialized/geo/`. Reads no
gazetteer and touches no network: a fresh clone can rebuild this with nothing
but the two source corpora and the committed resolution file.

The unit is the CARD. A card with ten matches lights one city once, with an
intensity that can encode its ten matches — it does not produce ten
city-to-city movements. Match-level detail is reachable from the card, not
modelled as separate geographic events.

Determinism: cards are sorted by (date, card id AS A STRING). csv ids like
'c:c1773' are NaN under a numeric sort, and a mixed numeric sort silently
reorders the whole csv half of the corpus.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import struct
import sys
from pathlib import Path

from .extract import extract_all
from .geo_normalize import CONFIG
from .geo_source import build_geo_source, parse_location_key
from .merge import merge_csv
from .normalize import bucket_of, day_to_iso

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "data" / "materialized" / "geo"
RESOLVED = CONFIG / "resolved-places.json"

GEO_SCHEMA_VERSION = "1.0.0"
GEO_PROJECTION_VERSION = "geo-projection@1"

# cards.bin record layout, u32 little-endian.
CARD_STRIDE_U32 = 8
CARD_FIELDS = [
    "day",  # days since 1900-01-01
    "promotionIdx",  # index into manifest.promotions
    "placeRef",  # 0 = not plotted; otherwise placeIdx + 1
    "eventNameIdx",  # index into eventNames
    "matchCount",
    "personCount",
    "titleCounts",  # titleMatchCount | titleChangeCount << 16
    "flags",  # bit0 unresolvedParticipant, bit1 csv-sourced
]
FLAG_UNRESOLVED_PARTICIPANT = 1
FLAG_CSV_SOURCE = 2

PEOPLE_SHARDS = 256  # matches normalize.bucket_of (fnv1a32 % 256)


def dumps(obj) -> str:
    """Deterministic JSON: sorted keys, no spaces, no NaN."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


class Writer:
    def __init__(self, root: Path):
        self.root = root
        self.checksums: dict[str, str] = {}

    def write(self, rel: str, data: str | bytes) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = data.encode("utf-8") if isinstance(data, str) else data
        path.write_bytes(blob)
        self.checksums[rel] = hashlib.sha256(blob).hexdigest()


def load_resolution() -> dict:
    if not RESOLVED.exists():
        raise FileNotFoundError(
            f"{RESOLVED} missing — run: pnpm geo:gazetteer:fetch && pnpm geo:resolve"
        )
    return json.loads(RESOLVED.read_text(encoding="utf-8"))


def build(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    print(f"geo:materialize — {GEO_PROJECTION_VERSION}")

    src, resolver, _belts, matches_sql = extract_all()
    merged = merge_csv(src, resolver)
    matches = [*matches_sql, *merged["matches_csv"]]
    geo = build_geo_source(src, merged, matches)
    res = load_resolution()
    keys, place_defs = res["keys"], res["places"]
    cards = geo["cards"]
    print(f"  {len(cards)} cards, {len(geo['surface'])} source locations, "
          f"{len(place_defs)} resolved places")

    # ---------------------------------------------------------------- places
    # Only places actually reached by a card are emitted; a reviewed place that
    # no card uses is resolution config, not projected data.
    used: dict[str, dict] = {}
    for c in cards:
        k = keys.get(c["location_key"])
        if k and k["place_id"]:
            used.setdefault(k["place_id"], place_defs[k["place_id"]])
    place_ids = sorted(used)
    place_idx = {pid: i for i, pid in enumerate(place_ids)}

    pl: dict[str, list] = {f: [] for f in (
        "id", "displayName", "city", "admin1", "country", "countryCode",
        "lat", "lon", "precision", "cards", "matches", "titleMatches",
        "titleChanges", "firstDay", "lastDay", "resolution", "confidence", "source",
    )}
    agg = {pid: {"cards": 0, "matches": 0, "tm": 0, "tc": 0, "first": 10**9, "last": -1}
           for pid in place_ids}
    # Worst (lowest-confidence) verdict across every source location that maps
    # into a place — a place is only as trustworthy as its weakest inbound key.
    verdict: dict[str, tuple[float, str, str]] = {}
    for key, k in keys.items():
        pid = k["place_id"]
        if pid in agg:
            cur = verdict.get(pid)
            cand = (k["confidence"], k["resolution"], k["rung"])
            if cur is None or cand[0] < cur[0]:
                verdict[pid] = cand

    # ---------------------------------------------------------------- cards
    promo_names = geo["promotion_names"]
    promo_ids = sorted({c["promotion_id"] for c in cards})
    promo_idx = {p: i for i, p in enumerate(promo_ids)}
    event_names = sorted({c["event_name"] for c in cards})
    event_idx = {n: i for i, n in enumerate(event_names)}

    buf = bytearray()
    card_ids: list[str] = []
    unplotted_cards = unplotted_matches = 0
    plotted_cards = plotted_matches = 0
    by_place: dict[int, list[int]] = {}
    by_promo: dict[int, list[int]] = {}
    by_event: dict[int, list[int]] = {}
    year_range: dict[str, list[int]] = {}
    density: dict[str, dict] = {}

    for i, c in enumerate(cards):
        k = keys.get(c["location_key"]) or {"place_id": None}
        pid = k["place_id"]
        pref = place_idx[pid] + 1 if pid in place_idx else 0
        if pref:
            a = agg[pid]
            a["cards"] += 1
            a["matches"] += c["match_count"]
            a["tm"] += c["title_match_count"]
            a["tc"] += c["title_change_count"]
            a["first"] = min(a["first"], c["day"])
            a["last"] = max(a["last"], c["day"])
            by_place.setdefault(pref - 1, []).append(i)
            plotted_cards += 1
            plotted_matches += c["match_count"]
        else:
            unplotted_cards += 1
            unplotted_matches += c["match_count"]
        flags = 0
        if c["unresolved_participant"]:
            flags |= FLAG_UNRESOLVED_PARTICIPANT
        if c["card_id"].startswith("c:c"):
            flags |= FLAG_CSV_SOURCE
        pi = promo_idx[c["promotion_id"]]
        buf += struct.pack(
            "<8I", c["day"], pi, pref, event_idx[c["event_name"]],
            min(c["match_count"], 0xFFFFFFFF), min(c["person_count"], 0xFFFFFFFF),
            (min(c["title_match_count"], 0xFFFF) | (min(c["title_change_count"], 0xFFFF) << 16)),
            flags,
        )
        card_ids.append(c["card_id"])
        by_promo.setdefault(pi, []).append(i)
        by_event.setdefault(event_idx[c["event_name"]], []).append(i)
        year = c["date"][:4]
        r = year_range.get(year)
        if r is None:
            year_range[year] = [i, i + 1]
        else:
            r[1] = i + 1
        d = density.setdefault(year, {"cards": 0, "matches": 0, "titleChanges": 0,
                                      "places": set(), "unplottedCards": 0})
        d["cards"] += 1
        d["matches"] += c["match_count"]
        d["titleChanges"] += c["title_change_count"]
        if pref:
            d["places"].add(pref - 1)
        else:
            d["unplottedCards"] += 1

    for pid in place_ids:
        p, a = used[pid], agg[pid]
        v = verdict.get(pid, (0.0, "unresolved", ""))
        pl["id"].append(pid)
        pl["displayName"].append(p["displayName"])
        pl["city"].append(p["city"])
        pl["admin1"].append(p["admin1"])
        pl["country"].append(p["country"])
        pl["countryCode"].append(p["countryCode"])
        pl["lat"].append(p["latitude"])
        pl["lon"].append(p["longitude"])
        pl["precision"].append(p["precision"])
        pl["cards"].append(a["cards"])
        pl["matches"].append(a["matches"])
        pl["titleMatches"].append(a["tm"])
        pl["titleChanges"].append(a["tc"])
        pl["firstDay"].append(a["first"] if a["last"] >= 0 else -1)
        pl["lastDay"].append(a["last"])
        pl["resolution"].append(v[1])
        pl["confidence"].append(v[0])
        pl["source"].append(p["source"])

    # ------------------------------------------------- person / title scopes
    card_pos = {c["card_id"]: i for i, c in enumerate(cards)}
    by_person: dict[str, set] = {}
    by_title: dict[str, set] = {}
    for rec in matches:
        ci = card_pos.get(f"c:{rec['card_id']}")
        if ci is None:
            continue
        for side in rec["sides"]:
            for cid in side["members"]:
                by_person.setdefault(cid, set()).add(ci)
        for t in rec["title_components"]:
            by_title.setdefault(f"t:{t}", set()).add(ci)

    w = Writer(OUT)
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)

    w.write("cards.bin", bytes(buf))
    w.write("cards-strings.json", dumps({
        "cardIds": card_ids,
        "promotionIds": promo_ids,
        "promotionNames": [promo_names.get(p, p) for p in promo_ids],
        "eventNames": event_names,
    }))
    w.write("places.json", dumps({"count": len(place_ids), **pl}))

    # source-location-map: which raw source strings feed each place, and what
    # the resolver decided about each. This is the provenance trail the
    # inspector shows, kept out of places.json so the hot path stays small.
    slm: dict[str, dict] = {}
    for key, k in sorted(keys.items()):
        s = geo["surface"].get(key)
        if s is None:
            continue
        parsed = parse_location_key(key)
        slm[key] = {
            "placeId": k["place_id"],
            "resolution": k["resolution"],
            "confidence": k["confidence"],
            "rung": k["rung"],
            "reviewed": k["reviewed"],
            "notes": k["notes"],
            "rawName": s["raw_name"],
            "family": s["family"],
            "cards": s["cards"],
            "matches": s["matches"],
            **({"venue": parsed.get("venue"), "city": parsed.get("city")}
               if parsed["family"] == "csv" else {"sourceLocationId": parsed["location_id"]}),
        }
    w.write("source-location-map.json", dumps(slm))

    w.write("scopes/promotions.json", dumps({promo_ids[i]: v for i, v in sorted(by_promo.items())}))
    w.write("scopes/places.json", dumps({place_ids[i]: v for i, v in sorted(by_place.items())}))
    w.write("scopes/events.json", dumps({event_names[i]: v for i, v in sorted(by_event.items())}))
    w.write("scopes/titles.json", dumps({t: sorted(v) for t, v in sorted(by_title.items())}))
    shards: dict[str, dict] = {}
    for pid, ids in by_person.items():
        shards.setdefault(bucket_of(pid), {})[pid] = sorted(ids)
    for bb in sorted(shards):
        w.write(f"scopes/people/{bb}.json", dumps(shards[bb]))

    w.write("by-year/index.json", dumps({y: r for y, r in sorted(year_range.items())}))
    w.write("density/by-year.json", dumps({
        y: {"cards": d["cards"], "matches": d["matches"], "titleChanges": d["titleChanges"],
            "places": len(d["places"]), "unplottedCards": d["unplottedCards"]}
        for y, d in sorted(density.items())
    }))

    # ------------------------------------------------------- quality reports
    prec_counts: dict[str, int] = {}
    for p in pl["precision"]:
        prec_counts[p] = prec_counts.get(p, 0) + 1
    res_rows: dict[str, dict] = {}
    for key, k in keys.items():
        s = geo["surface"].get(key)
        if s is None:
            continue
        b = res_rows.setdefault(k["resolution"], {"locations": 0, "cards": 0, "matches": 0})
        b["locations"] += 1
        b["cards"] += s["cards"]
        b["matches"] += s["matches"]
    totals = geo["totals"]
    quality = {
        "byResolution": res_rows,
        "precisionCounts": prec_counts,
        "rowCoverage": round(sum(1 for k in keys.values() if k["place_id"]) / max(1, len(keys)), 4),
        "cardCoverage": round(plotted_cards / max(1, totals["cards"]), 4),
        "matchCoverage": round(plotted_matches / max(1, totals["matches"]), 4),
        "plottedCards": plotted_cards,
        "unplottedCards": unplotted_cards,
        "plottedMatches": plotted_matches,
        "unplottedMatches": unplotted_matches,
        "totalCards": totals["cards"],
        "totalMatches": totals["matches"],
        "totalLocations": totals["locations"],
        "places": len(place_ids),
        "targets": {"rows": 0.95, "cards": 0.98, "matches": 0.98},
    }
    w.write("quality.json", dumps(quality))

    unresolved = sorted(
        (
            {
                "locationKey": key,
                "rawName": geo["surface"][key]["raw_name"],
                "family": geo["surface"][key]["family"],
                "resolution": k["resolution"],
                "cards": geo["surface"][key]["cards"],
                "matches": geo["surface"][key]["matches"],
                "firstDate": geo["surface"][key]["first_date"],
                "lastDate": geo["surface"][key]["last_date"],
                "notes": k["notes"],
            }
            for key, k in keys.items()
            if not k["place_id"] and key in geo["surface"]
        ),
        key=lambda r: (-r["cards"], r["locationKey"]),
    )
    w.write("unresolved.json", dumps(unresolved))

    days = [c["day"] for c in cards]
    manifest = {
        "schema_version": GEO_SCHEMA_VERSION,
        "projection_version": GEO_PROJECTION_VERSION,
        "resolution_version": res["version"],
        "gazetteer_version": res["gazetteer"],
        "coordinate_reference_system": "EPSG:4326 (WGS 84), decimal degrees",
        "epoch": "1900-01-01",
        "attribution": [
            "Place coordinates: GeoNames (https://www.geonames.org), CC BY 4.0",
        ],
        "counts": {
            "cards": len(cards),
            "matches": totals["matches"],
            "places": len(place_ids),
            "sourceLocations": totals["locations"],
            "promotions": len(promo_ids),
            "eventNames": len(event_names),
            "peopleWithCards": len(by_person),
            "titlesWithCards": len(by_title),
            "plottedCards": plotted_cards,
            "unplottedCards": unplotted_cards,
        },
        "date_range": [day_to_iso(min(days)), day_to_iso(max(days))],
        "day_range": [min(days), max(days)],
        "cards_bin": {"count": len(cards), "stride_u32": CARD_STRIDE_U32, "fields": CARD_FIELDS},
        "flags": {"unresolvedParticipant": FLAG_UNRESOLVED_PARTICIPANT,
                  "csvSource": FLAG_CSV_SOURCE},
        "people_shards": PEOPLE_SHARDS,
        "coverage": {k: quality[k] for k in ("rowCoverage", "cardCoverage", "matchCoverage")},
        "precision_counts": prec_counts,
        "checksums": dict(sorted(w.checksums.items())),
    }
    manifest_blob = dumps(manifest)
    (OUT / "manifest.json").write_bytes(manifest_blob.encode("utf-8"))

    print(f"  places {len(place_ids)}  plotted {plotted_cards}/{len(cards)} cards "
          f"({quality['cardCoverage'] * 100:.2f}%)  unplotted {unplotted_cards}")
    print(f"  scopes: {len(by_promo)} promotions, {len(by_place)} places, {len(by_event)} events, "
          f"{len(by_title)} titles, {len(by_person)} people in {len(shards)} shards")
    total_bytes = sum((OUT / r).stat().st_size for r in w.checksums)
    print(f"  wrote {len(w.checksums) + 1} files, {total_bytes / 1e6:.1f} MB -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(build())
