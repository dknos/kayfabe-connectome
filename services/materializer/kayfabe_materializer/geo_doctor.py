"""geo:doctor — audit every source location before a single coordinate exists.

Answers the question the resolver design depends on: how many distinct
location strings must resolve to reach the card-weighted coverage target?
Row coverage is the misleading number — one unresolved 'Korakuen Hall, Tokyo'
costs 2,402 cards, fifty one-off towns cost fifty.

Writes data/staging/geo-doctor.json (the full per-location audit) and prints
the coverage curve. Reads sources; writes nothing outside data/staging.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .geo_normalize import clean, fold, is_venue_placeholder, parse_city_region, parse_venue
from .geo_source import STAGING, load_geo_source

REPORT = STAGING / "geo-doctor.json"

# Coverage marks reported on the cumulative curve.
MARKS = (0.50, 0.75, 0.90, 0.95, 0.98, 0.99, 1.00)


def audit_rows(geo: dict) -> list[dict]:
    """One audit row per distinct source location, ranked by card weight."""
    rows: list[dict] = []
    for key, s in geo["surface"].items():
        family = s["family"]
        if family == "sql":
            city, region = parse_city_region(s["raw_name"])
            venue, venue_aliases = "", []
        else:
            city = clean(s["raw_city"])
            region = ""
            venue, venue_aliases = parse_venue(s["raw_venue"])
        promos = sorted(s["promotions"].items(), key=lambda kv: (-kv[1], kv[0]))
        rows.append(
            {
                "location_key": key,
                "family": family,
                "raw_name": s["raw_name"],
                "raw_venue": s["raw_venue"],
                "raw_city": s["raw_city"],
                "parsed_city": city,
                "parsed_region": region,
                "parsed_venue": venue,
                "venue_aliases": venue_aliases,
                "venue_placeholder": bool(venue) and is_venue_placeholder(venue),
                "city_fold": fold(city),
                "venue_fold": fold(venue),
                "cards": s["cards"],
                "matches": s["matches"],
                "first_date": s["first_date"],
                "last_date": s["last_date"],
                "promotions": [
                    {"id": p, "name": geo["promotion_names"].get(p, p), "cards": n}
                    for p, n in promos[:8]
                ],
                # Filled by geo_resolve; present here so the two reports share
                # one row shape and a reader can diff them.
                "resolution": "unresolved",
                "confidence": 0.0,
                "place_id": None,
                "review_required": True,
            }
        )
    rows.sort(key=lambda r: (-r["cards"], -r["matches"], r["location_key"]))
    return rows


def coverage_curve(rows: list[dict], total_cards: int, total_matches: int) -> dict:
    """Cumulative card- and match-weighted coverage over the ranked rows."""
    marks: list[dict] = []
    cum_c = cum_m = 0
    mi = 0
    for i, r in enumerate(rows, 1):
        cum_c += r["cards"]
        cum_m += r["matches"]
        while mi < len(MARKS) and total_cards and cum_c / total_cards >= MARKS[mi]:
            marks.append(
                {
                    "card_fraction": MARKS[mi],
                    "distinct_locations": i,
                    "location_fraction": round(i / max(1, len(rows)), 4),
                    "cards": cum_c,
                    "matches": cum_m,
                    "match_fraction": round(cum_m / max(1, total_matches), 4),
                }
            )
            mi += 1
    tiers = []
    for n in (100, 50, 20, 10, 5, 2, 1):
        sel = [r for r in rows if r["cards"] >= n]
        tiers.append(
            {
                "min_cards": n,
                "locations": len(sel),
                "cards": sum(r["cards"] for r in sel),
                "card_fraction": round(sum(r["cards"] for r in sel) / max(1, total_cards), 4),
            }
        )
    return {"marks": marks, "tiers": tiers}


def run(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    fresh = "--fresh" in argv
    geo = load_geo_source(use_cache=not fresh)
    rows = audit_rows(geo)
    totals = geo["totals"]
    curve = coverage_curve(rows, totals["cards"], totals["matches"])

    families = {"sql": {"locations": 0, "cards": 0}, "csv": {"locations": 0, "cards": 0}}
    for r in rows:
        f = families[r["family"]]
        f["locations"] += 1
        f["cards"] += r["cards"]

    report = {
        "version": "geo-doctor@1",
        "totals": totals,
        "families": families,
        "coverage_curve": curve,
        "locations": rows,
    }
    STAGING.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=1), encoding="utf-8"
    )

    print(f"geo:doctor — {totals['locations']} distinct source locations")
    print(
        f"  cards {totals['cards']}  matches {totals['matches']}  "
        f"(sql {families['sql']['locations']} locations / {families['sql']['cards']} cards, "
        f"csv {families['csv']['locations']} locations / {families['csv']['cards']} cards)"
    )
    print("\n  card-weighted cumulative coverage")
    for m in curve["marks"]:
        print(
            f"    {m['card_fraction'] * 100:5.1f}% of cards <- top {m['distinct_locations']:>5} "
            f"locations ({m['location_fraction'] * 100:4.1f}% of them)"
        )
    print("\n  weight tiers")
    for t in curve["tiers"]:
        print(
            f"    >={t['min_cards']:>3} cards: {t['locations']:>5} locations "
            f"covering {t['cards']:>6} cards ({t['card_fraction'] * 100:.1f}%)"
        )
    print(f"\n  wrote {REPORT.relative_to(Path.cwd()) if REPORT.is_relative_to(Path.cwd()) else REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
