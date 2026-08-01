"""geo-source@1 — the card-level geographic surface of the merged corpus.

One record per canonical CARD (not per match): the card is the unit a show
happens at, so it is the unit that lights a city. Each record carries the
*structured* source location, never the human-readable "Venue, City" join —
venue names contain commas, so that join cannot be split back into fields.

Two source families, two different location shapes:

  local_sql   Cards.location_id -> Locations.name, formatted "City, Region".
              687 rows, 14,398 cards. Region is an admin-1 name in the local
              language ("Florida", "Ontario", "Hokkaido", "Bayern", "England").

  csv         (Venue, City) columns. 39,740 cards, 5,226 distinct pairs. City
              is BARE — no region, no country. "Ontario", "Florence",
              "Charleston" and "London" are unresolvable from the city alone,
              so the venue string carries the discriminating signal.

The location KEY is what resolution is keyed on and what a canonical place is
looked up by. It is stable across runs and independent of coordinates.

Deterministic, stdlib-only, read-only with respect to every source.
"""

from __future__ import annotations

import json
from pathlib import Path

from .extract import extract_all
from .merge import merge_csv
from .normalize import iso_to_day

STAGING = Path(__file__).resolve().parents[3] / "data" / "staging"
CACHE = STAGING / "geo-source-cards.json"
GEO_SOURCE_VERSION = "geo-source@1"


def sql_location_key(location_id: int) -> str:
    """Key for a sqlite Locations row. Stable: source ids never renumber."""
    return f"sql:{location_id}"


def csv_location_key(venue: str, city: str) -> str:
    """Key for a csv (venue, city) pair. Unit separator is \\x1f so a venue
    containing any printable punctuation can never forge a key boundary."""
    return f"csv:{venue}\x1f{city}"


def parse_location_key(key: str) -> dict:
    """Inverse of the two builders above. Returns the structured raw fields."""
    if key.startswith("sql:"):
        return {"family": "sql", "location_id": int(key[4:])}
    if key.startswith("csv:"):
        venue, _, city = key[4:].partition("\x1f")
        return {"family": "csv", "venue": venue, "city": city}
    raise ValueError(f"not a location key: {key!r}")


def build_geo_source(src=None, merged=None, matches=None) -> dict:
    """Card records + the distinct location surface, both card- and
    match-weighted. Pass pre-built stages to reuse an in-flight materialize;
    omit them and this loads the sources itself."""
    if src is None or matches is None:
        src, resolver, _belt_map, matches_sql = extract_all()
        if merged is None:
            merged = merge_csv(src, resolver)
        matches = [*matches_sql, *merged["matches_csv"]]
    assert merged is not None

    locations = src["locations"]
    sql_cards = src["cards"]
    csv_cards = merged["cards_csv"]
    events = src["events"]

    # ---- per-card aggregates over every match in the merged corpus ----
    agg: dict[str, dict] = {}
    for rec in matches:
        raw_card = rec["card_id"]
        card_id = f"c:{raw_card}"
        a = agg.get(card_id)
        if a is None:
            a = {
                "matches": 0,
                "people": set(),
                "title_matches": 0,
                "title_changes": 0,
                "unresolved_participant": False,
            }
            agg[card_id] = a
        a["matches"] += 1
        if rec["title_components"]:
            a["title_matches"] += 1
            # A title change only counts against a real title component; the
            # sentinel-belt rows are excluded upstream in the same way.
            if rec["title_change"] == 1:
                a["title_changes"] += 1
        for side in rec["sides"]:
            a["people"].update(side["members"])
            if side["has_unknown"]:
                a["unresolved_participant"] = True

    # ---- card records ----
    cards: list[dict] = []
    for cid, card in sql_cards.items():
        card_id = f"c:{cid}"
        a = agg.get(card_id)
        if a is None:
            continue  # card with no surviving match — not a geographic event
        loc_id = card["location_id"]
        cards.append(
            {
                "card_id": card_id,
                "date": card["date"],
                "day": iso_to_day(card["date"]),
                "promotion_id": f"pr:{card['promotion_id']}",
                "event_id": f"en:{card['event_id']}",
                "event_name": events.get(card["event_id"], ""),
                "location_key": sql_location_key(loc_id),
                "raw_name": locations.get(loc_id, ""),
                "raw_venue": "",
                "raw_city": "",
                "match_count": a["matches"],
                "person_count": len(a["people"]),
                "title_match_count": a["title_matches"],
                "title_change_count": a["title_changes"],
                "unresolved_participant": a["unresolved_participant"],
            }
        )
    for cid, card in csv_cards.items():
        card_id = f"c:{cid}"
        a = agg.get(card_id)
        if a is None:
            continue
        venue, city = card["venue"], card["city"]
        cards.append(
            {
                "card_id": card_id,
                "date": card["date"],
                "day": iso_to_day(card["date"]),
                "promotion_id": f"pr:{card['promotion_id']}",
                "event_id": "",
                "event_name": card["event"],
                "location_key": csv_location_key(venue, city),
                "raw_name": ", ".join(x for x in (venue, city) if x),
                "raw_venue": venue,
                "raw_city": city,
                "match_count": a["matches"],
                "person_count": len(a["people"]),
                "title_match_count": a["title_matches"],
                "title_change_count": a["title_changes"],
                "unresolved_participant": a["unresolved_participant"],
            }
        )
    # Canonical order: date, then card id AS A STRING. csv ids like 'c:c1773'
    # are NaN under a numeric sort, and a mixed numeric sort silently reorders
    # the whole csv half of the corpus.
    cards.sort(key=lambda r: (r["date"], r["card_id"]))

    # ---- the distinct location surface ----
    surface: dict[str, dict] = {}
    for c in cards:
        key = c["location_key"]
        s = surface.get(key)
        if s is None:
            s = {
                "location_key": key,
                "raw_name": c["raw_name"],
                "raw_venue": c["raw_venue"],
                "raw_city": c["raw_city"],
                "family": "csv" if key.startswith("csv:") else "sql",
                "cards": 0,
                "matches": 0,
                "first_date": c["date"],
                "last_date": c["date"],
                "promotions": {},
            }
            surface[key] = s
        s["cards"] += 1
        s["matches"] += c["match_count"]
        if c["date"] < s["first_date"]:
            s["first_date"] = c["date"]
        if c["date"] > s["last_date"]:
            s["last_date"] = c["date"]
        s["promotions"][c["promotion_id"]] = s["promotions"].get(c["promotion_id"], 0) + 1

    promo_names = {f"pr:{k}": v for k, v in src["promotions"].items()}
    promo_names.update({f"pr:{k}": v for k, v in merged["promos"].items()})

    return {
        "version": GEO_SOURCE_VERSION,
        "cards": cards,
        "surface": surface,
        "promotion_names": promo_names,
        "totals": {
            "cards": len(cards),
            "matches": sum(c["match_count"] for c in cards),
            "locations": len(surface),
            "locations_sql": sum(1 for k in surface if k.startswith("sql:")),
            "locations_csv": sum(1 for k in surface if k.startswith("csv:")),
        },
    }


def load_geo_source(use_cache: bool = True) -> dict:
    """Cached build. The cache is derived data under data/staging (gitignored);
    delete it or pass use_cache=False to force a rebuild from the sources."""
    if use_cache and CACHE.exists():
        try:
            data = json.loads(CACHE.read_text(encoding="utf-8"))
            if data.get("version") == GEO_SOURCE_VERSION:
                data["surface"] = dict(data["surface"])
                return data
        except (json.JSONDecodeError, KeyError):
            pass  # corrupt cache: rebuild rather than fail
    data = build_geo_source()
    STAGING.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(
        json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    return data
