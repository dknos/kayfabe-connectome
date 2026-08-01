"""Extraction: stream Cards + Matches into canonical match records.

Reads the source corpus (read-only) once, joins in memory, and yields
canonical match records with explicit sides per docs/CANONICAL-MODEL.md.
Deterministic ordering: (card date, card id, match id).
"""

from __future__ import annotations

from .normalize import (
    NO_TITLE_BELT_ID,
    Resolver,
    classify_form,
    iso_to_day,
    parse_duration,
    parse_win_type,
    split_belts,
)
from .source_db import connect_readonly, guard_sql


def load_source(con=None) -> dict:
    """Load every needed table into plain dicts (single read pass)."""
    own = con is None
    if own:
        con = connect_readonly()
    cur = con.cursor()

    def rows(sql):
        return cur.execute(guard_sql(sql)).fetchall()

    src = {
        "promotions": {int(r[0]): str(r[1]) for r in rows("SELECT id, name FROM Promotions")},
        "events": {int(r[0]): str(r[1]) for r in rows("SELECT id, name FROM Events")},
        "locations": {int(r[0]): str(r[1]) for r in rows("SELECT id, name FROM Locations")},
        "belts": {int(r[0]): str(r[1]) for r in rows("SELECT id, name FROM Belts")},
        "match_types": {int(r[0]): str(r[1]) for r in rows("SELECT id, name FROM Match_Types")},
        "wrestlers": [(int(r[0]), str(r[1])) for r in rows("SELECT id, name FROM Wrestlers")],
        "cards": {
            int(r[0]): {
                "date": str(r[1]),
                "promotion_id": int(r[2]),
                "event_id": int(r[3]),
                "location_id": int(r[4]),
            }
            for r in rows(
                "SELECT id, event_date, promotion_id, event_id, location_id FROM Cards"
            )
        },
        "matches": [
            {
                "id": int(r[0]),
                "card_id": int(r[1]),
                "winner_row": int(r[2]),
                "loser_row": int(r[3]),
                "win_type": str(r[4]),
                "match_type_id": int(r[5]),
                "duration": str(r[6]),
                "title_id": int(r[7]),
                "title_change": int(r[8]),
            }
            for r in rows(
                "SELECT id, card_id, CAST(winner_id AS INT), CAST(loser_id AS INT), "
                "win_type, CAST(match_type_id AS INT), duration, "
                "CAST(title_id AS INT), title_change FROM Matches"
            )
        ],
    }
    if own:
        con.close()
    return src


ROLE_BY_KIND = {
    "decisive": ("winner", "loser"),
    "draw": ("draw-a", "draw-b"),
    "unknown": ("unknown", "unknown"),
}


def build_canonical_matches(src: dict, resolver: Resolver, belt_map: dict[int, dict]) -> list[dict]:
    """All matches as canonical records, sorted by (date, card id, match id)."""
    cards = src["cards"]
    match_types = src["match_types"]
    events = src["events"]
    locations = src["locations"]

    out: list[dict] = []
    for m in src["matches"]:
        card = cards[m["card_id"]]
        stip = match_types.get(m["match_type_id"], "")
        kind, res, fin = parse_win_type(m["win_type"])

        w_members, w_unknown, w_size = resolver.resolve(m["winner_row"])
        l_members, l_unknown, l_size = resolver.resolve(m["loser_row"])
        form = classify_form(stip, (w_size, l_size))

        # Title ids are strings in the merged namespace ('123' sqlite belt,
        # 'c<n>' csv title); promotion ids likewise ('4140' / 'c<n>').
        title_components: list[str] = []
        if m["title_id"] != NO_TITLE_BELT_ID:
            entry = belt_map.get(m["title_id"])
            if entry is not None:
                title_components = [str(c) for c in entry["components"]]
        role_w, role_l = ROLE_BY_KIND[kind]

        out.append(
            {
                "id": m["id"],
                "card_id": m["card_id"],
                "date": card["date"],
                "day": iso_to_day(card["date"]),
                "promotion_id": str(card["promotion_id"]),
                "event_name": events.get(card["event_id"], ""),
                "location": locations.get(card["location_id"], ""),
                "form": form,
                "stip": stip,
                "kind": kind,
                "res": res,
                "fin": fin,
                "dur": parse_duration(m["duration"]),
                "title_components": title_components,
                "title_change": m["title_change"],
                "apx": 0,
                "sides": [
                    {
                        "role": role_w,
                        "members": list(w_members),
                        "units": [list(w_members)] if w_members else [],
                        "has_unknown": w_unknown,
                        "size_raw": w_size,
                        "row": m["winner_row"],
                    },
                    {
                        "role": role_l,
                        "members": list(l_members),
                        "units": [list(l_members)] if l_members else [],
                        "has_unknown": l_unknown,
                        "size_raw": l_size,
                        "row": m["loser_row"],
                    },
                ],
            }
        )
    out.sort(key=lambda r: (r["date"], r["card_id"], r["id"]))
    return out


def extract_all() -> tuple[dict, Resolver, dict, list[dict]]:
    """Convenience: load source, build resolver + belt map + canonical matches."""
    src = load_source()
    resolver = Resolver(src["wrestlers"])
    belt_map = split_belts(src["belts"])
    matches = build_canonical_matches(src, resolver, belt_map)
    return src, resolver, belt_map, matches
