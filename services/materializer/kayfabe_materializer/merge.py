"""crosswalk@1 — merge the csv corpus into the canonical corpus.

Policy (docs/DECISIONS.md D-007):
  * local_sql stays canonical for the six family promotions (ECW/NXT/WCW/
    WWE/WWWF/WWF). A family csv row must crosswalk to a sqlite match on
    (date, promotion, participant-name set); matched rows contribute
    ENRICHMENT only (venue/city/placement/ppv attach card-level to every
    match sharing the key; a Meltzer rating attaches only when the key is
    unambiguous). Unmatched family rows are EXCLUDED and ledgered — measured:
    919 of 1,150 are date-shifted twins of matches the sqlite already has,
    so admitting them would double-count encounters between headliners.
  * Non-family rows become csv-canonical matches (id 'c<n>'). Their people
    resolve by exact name against the sqlite identity space first (a name
    seen in both sources is the same canonical person), then against a
    deterministic csv-person registry ('p:c<slug>').
  * The csv has no title-change flag: csv matches contribute titleMatches
    counts and championship anchors but never reigns or gold pulses.

Deterministic and stdlib-only. Nothing here writes to any source.
"""

from __future__ import annotations

from .csv_source import load_csv_rows, norm_name
from .normalize import Resolver, classify_form, detect_placeholders, fnv1a32, parse_win_type


class CsvNameRegistry:
    """Resolves csv part names to canonical person ids.

    Order: sqlite individual name -> 'p:<id>'; sqlite side-derived name ->
    'p:d<slug>'; placeholder -> None; otherwise a csv-canonical person
    'p:c<slug>' (slug = fnv1a32 hex of the exact name; collisions rehash
    with a deterministic counter salt). Registration happens in sorted name
    order so ids are stable across runs.
    """

    def __init__(self, resolver: Resolver, names: set[str]):
        self.resolver = resolver
        self.placeholders = detect_placeholders(names)
        self.name_to_cid: dict[str, str] = {}
        self.csv_people: dict[str, str] = {}  # canonical id -> exact name
        taken: dict[str, str] = {}
        for name in sorted(names):
            if name in self.placeholders:
                continue
            pid = resolver.name_to_pid.get(name)
            if pid is not None:
                self.name_to_cid[name] = f"p:{pid}"
                continue
            dslug = resolver.derived_slug.get(name)
            if dslug is not None:
                self.name_to_cid[name] = f"p:d{dslug}"
                continue
            slug = "%08x" % fnv1a32(name)
            salt = 0
            while slug in taken and taken[slug] != name:
                salt += 1
                slug = "%08x" % fnv1a32(f"{name}\x00{salt}")
            taken[slug] = name
            cid = f"p:c{slug}"
            self.name_to_cid[name] = cid
            self.csv_people[cid] = name

    def resolve(self, name: str) -> str | None:
        return self.name_to_cid.get(name)


def _sqlite_crosswalk_keys(src: dict) -> dict[tuple, list[int]]:
    """(date, family promo id, frozenset of normalized part names) -> match ids."""
    wname = dict(src["wrestlers"])
    cards = src["cards"]
    keys: dict[tuple, list[int]] = {}
    for m in src["matches"]:
        card = cards[m["card_id"]]
        parts: set[str] = set()
        for row_id in (m["winner_row"], m["loser_row"]):
            for part in wname.get(row_id, "").split(" & "):
                p = norm_name(part)
                if p:
                    parts.add(p)
        key = (card["date"], card["promotion_id"], frozenset(parts))
        keys.setdefault(key, []).append(m["id"])
    for mids in keys.values():
        mids.sort()
    return keys


def merge_csv(src: dict, resolver: Resolver, staged: dict | None = None) -> dict:
    """Crosswalk + project the staged csv rows against the sqlite corpus."""
    staged = staged or load_csv_rows()
    rows = staged["rows"]
    xwalk = _sqlite_crosswalk_keys(src)

    ledger = {
        "family_rows": 0,
        "family_enriched": 0,
        "family_enriched_ambiguous_key": 0,
        "family_unmatched_excluded": 0,
        "family_unmatched_samples": [],
        "csv_canonical_rows": 0,
        "meltzer_attached": 0,
    }
    enrichment: dict[int, dict] = {}
    canonical_rows: list[dict] = []

    for row in rows:
        fam = row["family"]
        if fam is None:
            canonical_rows.append(row)
            ledger["csv_canonical_rows"] += 1
            continue
        ledger["family_rows"] += 1
        parts: set[str] = set()
        for units in (row["units_w"], row["units_l"]):
            for unit in units:
                parts.update(unit)
        mids = xwalk.get((row["date"], fam, frozenset(parts)))
        if not mids:
            ledger["family_unmatched_excluded"] += 1
            if len(ledger["family_unmatched_samples"]) < 20:
                ledger["family_unmatched_samples"].append(
                    {"d": row["date"], "promo": row["promo"], "event": row["event"]}
                )
            continue
        ledger["family_enriched"] += 1
        if len(mids) > 1:
            ledger["family_enriched_ambiguous_key"] += 1
        for mid in mids:
            e = enrichment.setdefault(mid, {})
            if row["venue"] and "venue" not in e:
                e["venue"] = row["venue"]
            if row["city"] and "city" not in e:
                e["city"] = row["city"]
            if row["ppv"]:
                e["ppv"] = 1
            if row["placement"] is not None and "placement" not in e:
                e["placement"] = row["placement"]
        if row["meltzer"] is not None and len(mids) == 1:
            enrichment[mids[0]]["mr"] = row["meltzer"]
            ledger["meltzer_attached"] += 1

    # ---- registries (deterministic, alphabetical) ----
    promo_names = sorted({r["promo"] for r in canonical_rows})
    promo_key = {name: f"c{i}" for i, name in enumerate(promo_names)}

    title_pairs = sorted(
        {(promo_key[r["promo"]], r["championship"]) for r in canonical_rows if r["championship"]}
    )
    title_key = {pair: f"c{i}" for i, pair in enumerate(title_pairs)}

    event_names = sorted({r["event"] for r in canonical_rows if r["event"]})
    event_key = {name: f"c{i}" for i, name in enumerate(event_names)}

    # cards: one per (date, promotion, event, venue, city)
    card_tuples = sorted(
        {(r["date"], promo_key[r["promo"]], r["event"], r["venue"], r["city"]) for r in canonical_rows}
    )
    card_key = {t: f"c{i}" for i, t in enumerate(card_tuples)}

    # Structured card location, kept apart from the human-readable "venue, city"
    # join in each match record: venue names contain commas ("2300 Arena (AKA
    # ECW Arena/Asylum Arena/...), Philadelphia"), so the joined string cannot
    # be split back into fields. The geo pipeline needs the fields, not the join.
    cards_csv = {
        cid: {"date": t[0], "promotion_id": t[1], "event": t[2], "venue": t[3], "city": t[4]}
        for t, cid in card_key.items()
    }

    # ---- identity ----
    all_names: set[str] = set()
    for r in canonical_rows:
        for units in (r["units_w"], r["units_l"]):
            for unit in units:
                all_names.update(unit)
    registry = CsvNameRegistry(resolver, all_names)

    # ---- canonical csv match records (same shape as extract.py output) ----
    canonical_rows.sort(
        key=lambda r: (r["date"], promo_key[r["promo"]], r["event"], r["placement"] or 10**6, r["idx"])
    )
    matches_csv: list[dict] = []
    for n, r in enumerate(canonical_rows):
        pk = promo_key[r["promo"]]
        kind, res, fin = parse_win_type(r["res"])

        def resolve_units(units_raw: list[list[str]]) -> tuple[list[list[str]], list[str], bool, int]:
            """Per-side resolution. Dedupe is per side only — a person listed on
            BOTH sides must reach derive_observations, which suppresses and
            ledgers dual-side corruption instead of silently swallowing it."""
            out: list[list[str]] = []
            names_out: list[str] = []
            unknown = False
            raw_count = 0
            seen: set[str] = set()
            for unit in units_raw:
                members: list[str] = []
                for name in unit:
                    raw_count += 1
                    cid = registry.resolve(name)
                    if cid is None:
                        unknown = True
                        continue
                    if cid in seen:
                        continue
                    seen.add(cid)
                    members.append(cid)
                if members:
                    out.append(members)
                    names_out.append(" & ".join(unit))
            return out, names_out, unknown, raw_count

        units_w, names_w, w_unknown, w_size = resolve_units(r["units_w"])
        units_l, names_l, l_unknown, l_size = resolve_units(r["units_l"])
        units_total = len(r["units_w"]) + len(r["units_l"])
        form = classify_form(r["stip"], (w_size, l_size), units_total)

        title_components: list[str] = []
        if r["championship"]:
            title_components = [title_key[(pk, r["championship"])]]

        loc = ", ".join(x for x in (r["venue"], r["city"]) if x)
        matches_csv.append(
            {
                "id": f"c{n}",
                "card_id": card_key[(r["date"], pk, r["event"], r["venue"], r["city"])],
                "date": r["date"],
                "day": r["day"],
                "promotion_id": pk,
                "event_name": r["event"],
                "event_id": event_key.get(r["event"]),
                "location": loc,
                "form": form,
                "stip": r["stip"],
                "kind": kind,
                "res": res,
                "fin": fin,
                "dur": r["dur"],
                "title_components": title_components,
                "title_change": 0,  # csv carries no title-change flag — never invented
                "apx": r["apx"],
                "_mr": r["meltzer"],
                "_ppv": r["ppv"],
                "_placement": r["placement"],
                "sides": [
                    {
                        "role": "winner" if kind == "decisive" else ("draw-a" if kind == "draw" else "unknown"),
                        "members": [m for u in units_w for m in u],
                        "units": units_w,
                        "unit_names": names_w,
                        "has_unknown": w_unknown,
                        "size_raw": w_size,
                        "row": None,
                    },
                    {
                        "role": "loser" if kind == "decisive" else ("draw-b" if kind == "draw" else "unknown"),
                        "members": [m for u in units_l for m in u],
                        "units": units_l,
                        "unit_names": names_l,
                        "has_unknown": l_unknown,
                        "size_raw": l_size,
                        "row": None,
                    },
                ],
            }
        )

    promo_matches: dict[str, int] = {}
    for m in matches_csv:
        promo_matches[m["promotion_id"]] = promo_matches.get(m["promotion_id"], 0) + 1

    return {
        "matches_csv": matches_csv,
        "cards_csv": cards_csv,  # 'c<n>' -> {date, promotion_id, event, venue, city}
        "enrichment": enrichment,
        "registry": registry,
        "promos": {promo_key[n]: n for n in promo_names},  # key -> display name
        "promo_matches": promo_matches,
        "titles": {title_key[p]: {"promo": p[0], "name": p[1]} for p in title_pairs},
        "events": {event_key[n]: n for n in event_names},
        "quality": {"staging": staged["quality"], "crosswalk": ledger},
    }
