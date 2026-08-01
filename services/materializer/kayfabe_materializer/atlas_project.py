"""atlas-projection@1 — the semantic projection the ATLAS lens reads.

Writes data/materialized/atlas/ and nothing else. It is a SEPARATE entry point
from materialize.py: the atlas tree is not in that module's _MANAGED tuple, so
`pnpm data:materialize` neither builds nor deletes it, and this module never
touches graph/, timeline/, entities/, evidence/, search/ or geo/.

The projection makes no new claim about the corpus. Every number here is a
count of documented records or a span between documented records. The two
places where the source is genuinely ambiguous carry the ambiguity as data:

  * Which promotion a championship belongs to. The csv corpus names one
    outright; the sqlite corpus does not, so a sqlite belt is placed by the
    promotion that holds most of its documented title matches, with the share
    published so a widely-defended belt reads as one. materialize.py falls back
    to `sorted(FAMILY_PROMO_BITS)[0]` (ECW) for a belt with no counts at all —
    that fallback is not copied. A belt with no supporting record gets
    assoc="unresolved" and no promotion, because inventing ECW for it would be
    the only fabricated fact in the file.
  * Whether a lineage exists at all. The csv source carries no title-change
    flag, so csv belts derive zero reigns. That is a limitation of the source,
    not evidence that a belt never changed hands, and `lineage` says which of
    the two it is. A consumer that reads reigns==0 as "never changed hands"
    would be wrong for 4259 of the 4389 belts.

Membership is DOCUMENTED APPEARANCE on a card. It is not employment, not a
roster and not a contract; nothing in the corpus records any of those.

Determinism: ids are sorted AS STRINGS everywhere. The merged id space mixes
'1' with 'c361', and a numeric sort either throws or silently reorders the
whole csv half. No timestamp is written anywhere, including the manifest —
two runs over the same source produce byte-identical files.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

from .extract import extract_all
from .materialize import FAMILY_PROMO_BITS, PROMO_NAMED_BITS
from .merge import merge_csv
from .normalize import bucket_of, day_to_iso
from .project import derive_reigns

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "data" / "materialized" / "atlas"
SIBLING_MANIFEST = ROOT / "data" / "materialized" / "manifest.json"

ATLAS_SCHEMA_VERSION = "1.0.0"
ATLAS_PROJECTION_VERSION = "atlas-projection@1"

BUCKETS = 256  # matches normalize.bucket_of (fnv1a32 % 256)

# A promotion's focus board caps its roster so one 2500-member shard cannot
# stall the lens. The overflow is published as a number, never dropped
# silently: a capped roster that reads as complete is a false claim.
MEMBER_CAP = 4000

# Which sources can record a title change at all. Keyed by the same `src`
# strings entities/championships.json uses, so the two files agree.
SOURCE_LINEAGE = {"local_sql": "derived", "csv_initial_matches": "no-changes"}

# Files the lens reads from the connectome tree instead of from here. Copying
# them would double the bytes and create a second version that can drift.
REUSES = {
    "person teams": "entities/people/{bb}.json .teams",
    "person top partners/opponents": "entities/people/{bb}.json .top",
    "person yearly activity": "entities/people/{bb}.json .years",
    "title reign lineage": "entities/championships.json .reigns",
    "bucketing": "atlas/people/{bb}.json shares bb with entities/people/{bb}.json",
}


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


# --------------------------------------------------------------- pure rules
# Everything below is a plain function over plain dicts so the rules can be
# tested without the sqlite or csv corpora present.


def encode_years(counts: dict[str, int]) -> tuple[int, list[int]]:
    """Run-length a {year: count} map from its first year.

    Returns (yearFrom, [count for yearFrom, yearFrom+1, ...]) with explicit
    zeros for silent years, so the consumer indexes by offset and never has to
    parse a key. (-1, []) when there is nothing to encode — -1 rather than 0
    because a missing series must not read as "the year 0".
    """
    if not counts:
        return -1, []
    years = sorted(int(y) for y in counts)
    lo, hi = years[0], years[-1]
    return lo, [counts.get(str(y), 0) for y in range(lo, hi + 1)]


def decode_years(year_from: int, counts: list[int]) -> dict[str, int]:
    """Inverse of encode_years, dropping the padding zeros it inserted."""
    return {str(year_from + i): c for i, c in enumerate(counts) if c}


def associate_title(registry_promo: str | None, promo_counts: dict[str, int]) -> tuple[str, str, float]:
    """Place one championship under one promotion, or under none.

    registry_promo: the promotion the source registry names outright (csv), or
    None when the source has no such column (sqlite).
    promo_counts: {promotion id: documented title matches} for this belt.

    Returns (promotion id or "", assoc, assocShare). The ties are broken by
    promotion id ASC AS A STRING; the count alone is not a total order and an
    unstable tie-break would move belts between runs.
    """
    if registry_promo:
        return registry_promo, "registry", 1.0
    if promo_counts:
        total = sum(promo_counts.values())
        pr, n = sorted(promo_counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        return pr, "dominant", round(n / total, 4)
    return "", "unresolved", 0.0


def lineage_of(src: str) -> str:
    """Whether the SOURCE could record a title change, not whether it did.

    A sqlite belt with zero derived reigns is still "derived": the source
    carries a title_change flag and simply never set it for that belt. A csv
    belt has no such flag at all, so its zero says nothing about its history.
    """
    return SOURCE_LINEAGE[src]


def order_members(members: list[dict]) -> list[dict]:
    """(-matches, p): the label budget follows corpus weight, ties by id."""
    return sorted(members, key=lambda m: (-m["matches"], m["p"]))


def cap_members(members: list[dict], cap: int = MEMBER_CAP) -> tuple[list[dict], int]:
    """Truncate an ordered roster, returning what was left out as a number."""
    if len(members) <= cap:
        return members, 0
    return members[:cap], len(members) - cap


def promo_bits_of(promotions: dict[str, str], csv_promo_matches: dict[str, int]) -> dict[str, int]:
    """Recompute manifest.promo_bits (family fixed, then top csv by matches).

    Recomputed rather than read from data/materialized/manifest.json so the
    atlas tree can be built from the two source corpora alone; build() then
    cross-checks the result against that manifest when it happens to exist.
    The csv tie-break is by DISPLAY NAME, matching materialize.py exactly — by
    id instead and the bits drift silently out of step with promoMask.
    """
    bits = dict(FAMILY_PROMO_BITS)
    ranked = sorted(csv_promo_matches.items(), key=lambda kv: (-kv[1], promotions[kv[0]]))
    for i, (pk, _n) in enumerate(ranked[:PROMO_NAMED_BITS]):
        bits[pk] = 6 + i
    return bits


# -------------------------------------------------------------------- build


def build(argv: list[str] | None = None) -> int:
    # Imported here, not at module scope: atlas_validate imports OUT and
    # decode_years from this module, and the validator is the dependent half.
    from .atlas_validate import run_checks

    argv = argv if argv is not None else sys.argv[1:]
    print(f"atlas:materialize — {ATLAS_PROJECTION_VERSION}")

    src, resolver, belt_map, matches_sql = extract_all()
    merged = merge_csv(src, resolver)
    matches = [*matches_sql, *merged["matches_csv"]]

    promotions = {str(i): n for i, n in src["promotions"].items()}
    promotions.update(merged["promos"])
    sql_promo_ids = {str(i) for i in src["promotions"]}
    csv_titles = merged["titles"]  # 'c<n>' -> {"promo","name"}
    registry = merged["registry"]

    title_names: dict[str, str] = {str(i): src["belts"][i] for i, e in belt_map.items()
                                   if e["kind"] in ("title", "artifact")}
    sql_title_ids = set(title_names)
    title_names.update({t: v["name"] for t, v in csv_titles.items()})
    all_title_ids = sorted(title_names)

    # Person names come from the same three registries the node table uses;
    # a member with no name would be a resolver bug, so it raises rather than
    # shipping a blank label.
    person_names: dict[str, str] = {
        f"p:{i}": n
        for i, n in resolver.rows.items()
        if " & " not in n and n not in resolver.placeholders
    }
    for cid, name, _rows in resolver.derived_people():
        person_names[cid] = name
    person_names.update(registry.csv_people)

    print(f"  {len(matches)} matches, {len(promotions)} promotions, "
          f"{len(all_title_ids)} titles")

    # ------------------------------------------------------------ match pass
    promo: dict[str, dict] = {}
    title: dict[str, dict] = {t: {"m": 0, "first": -1, "last": -1, "pc": {}, "years": {},
                                  "changes": []} for t in all_title_ids}
    person: dict[str, dict] = {}
    route: dict[tuple[str, str], dict] = {}

    for rec in matches:
        pk = rec["promotion_id"]
        day = rec["day"]
        year = rec["date"][:4]
        card = f"c:{rec['card_id']}"

        p = promo.get(pk)
        if p is None:
            p = promo[pk] = {"m": 0, "first": day, "last": day, "cards": set(),
                             "people": set(), "year_m": {}, "year_c": {}}
        p["m"] += 1
        p["first"] = min(p["first"], day)
        p["last"] = max(p["last"], day)
        p["year_m"][year] = p["year_m"].get(year, 0) + 1
        if card not in p["cards"]:
            p["cards"].add(card)
            p["year_c"][year] = p["year_c"].get(year, 0) + 1

        # dict.fromkeys: a belt split into components must not be counted twice
        # for one match when two components resolve to the same id.
        for tid in dict.fromkeys(rec["title_components"]):
            t = title[tid]
            t["m"] += 1
            t["first"] = day if t["first"] < 0 else min(t["first"], day)
            t["last"] = max(t["last"], day)
            t["pc"][pk] = t["pc"].get(pk, 0) + 1
            t["years"][year] = t["years"].get(year, 0) + 1
            if rec["title_change"] == 1:
                t["changes"].append(
                    (rec["date"], str(rec["card_id"]), str(rec["id"]),
                     list(rec["sides"][0]["members"]))
                )

        # One appearance per person per match, however many units they occupy.
        seen: set[str] = set()
        for side in rec["sides"]:
            seen.update(side["members"])
        for cid in seen:
            p["people"].add(cid)
            st = person.get(cid)
            if st is None:
                st = person[cid] = {"m": 0, "first": day, "last": day}
            st["m"] += 1
            st["first"] = min(st["first"], day)
            st["last"] = max(st["last"], day)
            r = route.get((cid, pk))
            if r is None:
                r = route[(cid, pk)] = {"m": 0, "first": day, "last": day, "cards": set()}
            r["m"] += 1
            r["first"] = min(r["first"], day)
            r["last"] = max(r["last"], day)
            r["cards"].add(card)

    missing_names = sorted(cid for cid in person if cid not in person_names)
    if missing_names:
        raise AssertionError(f"{len(missing_names)} members have no name, e.g. {missing_names[:5]}")

    # ------------------------------------------------------- title placement
    title_pr: dict[str, str] = {}
    title_assoc: dict[str, str] = {}
    title_share: dict[str, float] = {}
    title_reigns: dict[str, list[dict]] = {}
    assoc_counts = {"registry": 0, "dominant": 0, "unresolved": 0}
    for tid in all_title_ids:
        reg = csv_titles[tid]["promo"] if tid in csv_titles else None
        pr, assoc, share = associate_title(reg, title[tid]["pc"])
        title_pr[tid], title_assoc[tid], title_share[tid] = pr, assoc, share
        assoc_counts[assoc] += 1
        # reign-derive@1 unchanged: intervals between successive change events,
        # never a vacancy and never an interpolated date.
        title_reigns[tid] = derive_reigns(title[tid]["changes"])

    # Anchors against the real corpus. If the lineage rule ever stops matching
    # the source split it is wrong, and a wrong lineage flag is exactly the
    # claim this projection exists to avoid making.
    lineage = {tid: lineage_of("local_sql" if tid in sql_title_ids else "csv_initial_matches")
               for tid in all_title_ids}
    derived_lineage = sum(1 for v in lineage.values() if v == "derived")
    with_reigns = {tid for tid in all_title_ids if title_reigns[tid]}
    if derived_lineage != len(sql_title_ids):
        raise AssertionError(f"lineage rule: {derived_lineage} derived vs {len(sql_title_ids)} sqlite titles")
    if not with_reigns <= sql_title_ids:
        raise AssertionError("a title outside the sqlite corpus derived a reign")

    holders: dict[str, set[str]] = {}
    champ_pairs: set[tuple[str, str]] = set()
    total_reigns = 0
    for tid in all_title_ids:
        hs = holders.setdefault(tid, set())
        for r in title_reigns[tid]:
            total_reigns += 1
            hs.update(r["holders"])
        pr = title_pr[tid]
        if pr:
            for h in hs:
                champ_pairs.add((pr, h))

    titles_by_promo: dict[str, list[str]] = {}
    for tid in all_title_ids:
        if title_pr[tid]:
            titles_by_promo.setdefault(title_pr[tid], []).append(tid)

    # --------------------------------------------------------------- writing
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True, exist_ok=True)
    w = Writer(OUT)

    promo_bits = promo_bits_of(promotions, merged["promo_matches"])
    promo_ids = sorted(promotions)  # AS STRINGS: '1' and 'c361' share one space

    cols: dict[str, list] = {k: [] for k in (
        "id", "name", "firstDay", "lastDay", "cards", "matches", "people", "titles",
        "src", "bit", "yearFrom", "yearCounts")}
    for pk in promo_ids:
        a = promo.get(pk)
        yf, yc = encode_years(a["year_m"] if a else {})
        cols["id"].append(f"pr:{pk}")
        cols["name"].append(promotions[pk])
        cols["firstDay"].append(a["first"] if a else -1)
        cols["lastDay"].append(a["last"] if a else -1)
        cols["cards"].append(len(a["cards"]) if a else 0)
        cols["matches"].append(a["m"] if a else 0)
        cols["people"].append(len(a["people"]) if a else 0)
        cols["titles"].append(len(titles_by_promo.get(pk, [])))
        cols["src"].append("local_sql" if pk in sql_promo_ids else "csv_initial_matches")
        cols["bit"].append(promo_bits.get(pk, -1))
        cols["yearFrom"].append(yf)
        cols["yearCounts"].append(yc)
    w.write("promotions.json", dumps({"count": len(promo_ids), **cols}))

    tcols: dict[str, list] = {k: [] for k in (
        "id", "name", "pr", "assoc", "assocShare", "firstDay", "lastDay", "titleMatches",
        "reigns", "changes", "holders", "artifact", "src", "lineage")}
    for tid in all_title_ids:
        t = title[tid]
        is_sql = tid in sql_title_ids
        tcols["id"].append(f"t:{tid}")
        tcols["name"].append(title_names[tid])
        tcols["pr"].append(f"pr:{title_pr[tid]}" if title_pr[tid] else "")
        tcols["assoc"].append(title_assoc[tid])
        tcols["assocShare"].append(title_share[tid])
        tcols["firstDay"].append(t["first"])
        tcols["lastDay"].append(t["last"])
        tcols["titleMatches"].append(t["m"])
        tcols["reigns"].append(len(title_reigns[tid]))
        tcols["changes"].append(len(t["changes"]))
        tcols["holders"].append(len(holders[tid]))
        tcols["artifact"].append(1 if is_sql and belt_map[int(tid)]["kind"] == "artifact" else 0)
        tcols["src"].append("local_sql" if is_sql else "csv_initial_matches")
        tcols["lineage"].append(lineage[tid])
    w.write("titles.json", dumps({"count": len(all_title_ids), **tcols}))

    # promotions/{bb}.json — focus boards. Only non-empty buckets are written,
    # so the loader must glob rather than assume 256 files.
    routes_by_person: dict[str, list[tuple[str, dict]]] = {}
    for (cid, pk), r in route.items():
        routes_by_person.setdefault(cid, []).append((pk, r))

    members_by_promo: dict[str, list[dict]] = {}
    for (cid, pk), r in route.items():
        m: dict = {
            "p": cid,
            "n": person_names[cid],
            "firstDay": r["first"],
            "lastDay": r["last"],
            "matches": r["m"],
            "cards": len(r["cards"]),
        }
        if (pk, cid) in champ_pairs:
            m["champ"] = 1
        members_by_promo.setdefault(pk, []).append(m)

    pbuckets: dict[str, dict[str, dict]] = {}
    truncated_promos = 0
    largest_roster = 0
    for pk in promo_ids:
        a = promo.get(pk)
        yf_m, ym = encode_years(a["year_m"] if a else {})
        _yf_c, yc = encode_years(a["year_c"] if a else {})
        tlist = []
        for tid in sorted(titles_by_promo.get(pk, [])):
            t = title[tid]
            tyf, tyc = encode_years(t["years"])
            tlist.append({
                "t": f"t:{tid}",
                "n": title_names[tid],
                "firstDay": t["first"],
                "lastDay": t["last"],
                "titleMatches": t["m"],
                "reigns": len(title_reigns[tid]),
                "changes": len(t["changes"]),
                "holders": len(holders[tid]),
                "artifact": 1 if tid in sql_title_ids and belt_map[int(tid)]["kind"] == "artifact" else 0,
                "assoc": title_assoc[tid],
                "assocShare": title_share[tid],
                "lineage": lineage[tid],
                "yearFrom": tyf,
                "yearCounts": tyc,
            })
        tlist.sort(key=lambda e: (-e["titleMatches"], e["t"]))
        roster = order_members(members_by_promo.get(pk, []))
        largest_roster = max(largest_roster, len(roster))
        kept, left_out = cap_members(roster)
        detail: dict = {
            "id": f"pr:{pk}",
            "n": promotions[pk],
            "firstDay": a["first"] if a else -1,
            "lastDay": a["last"] if a else -1,
            "cards": len(a["cards"]) if a else 0,
            "matches": a["m"] if a else 0,
            "people": len(a["people"]) if a else 0,
            "src": "local_sql" if pk in sql_promo_ids else "csv_initial_matches",
            "yearFrom": yf_m,
            "yearCards": yc,
            "yearMatches": ym,
            "titles": tlist,
            "members": kept,
        }
        if left_out:
            detail["membersTruncated"] = left_out
            truncated_promos += 1
        pid = f"pr:{pk}"
        pbuckets.setdefault(bucket_of(pid), {})[pid] = detail
    for bb in sorted(pbuckets):
        w.write(f"promotions/{bb}.json", dumps(pbuckets[bb]))

    # people/{bb}.json — routes only. Teams, top links, yearly activity and
    # reigns already exist in entities/; duplicating them here would ship a
    # second copy that can disagree with the first.
    people_buckets: dict[str, dict[str, dict]] = {}
    route_total = 0
    for cid in sorted(person):
        st = person[cid]
        rs = [
            {"pr": f"pr:{pk}", "firstDay": r["first"], "lastDay": r["last"],
             "matches": r["m"], "cards": len(r["cards"])}
            for pk, r in routes_by_person.get(cid, [])
        ]
        rs.sort(key=lambda e: (e["firstDay"], e["pr"]))
        route_total += len(rs)
        people_buckets.setdefault(bucket_of(cid), {})[cid] = {
            "n": person_names[cid],
            "firstDay": st["first"],
            "lastDay": st["last"],
            "matches": st["m"],
            "routes": rs,
        }
    for bb in sorted(people_buckets):
        w.write(f"people/{bb}.json", dumps(people_buckets[bb]))

    # ------------------------------------------------------------ validation
    days = [r["day"] for r in matches]
    counts = {
        "promotions": len(promo_ids),
        "titles": len(all_title_ids),
        "people": len(person),
        "routes": route_total,
        "matches": len(matches),
        "cards": sum(len(a["cards"]) for a in promo.values()),
        "promotionBuckets": len(pbuckets),
        "peopleBuckets": len(people_buckets),
        "titlesRegistry": assoc_counts["registry"],
        "titlesDominant": assoc_counts["dominant"],
        "titlesUnresolved": assoc_counts["unresolved"],
        "titlesLineageDerived": derived_lineage,
        "titlesWithReigns": len(with_reigns),
        "reigns": total_reigns,
        "promotionsWithTruncatedRoster": truncated_promos,
    }
    passed, checks = run_checks(OUT, counts)

    bits_check = {"passed": True, "compared": False}
    if SIBLING_MANIFEST.exists():
        sibling = json.loads(SIBLING_MANIFEST.read_text(encoding="utf-8"))
        same = sibling.get("promo_bits") == promo_bits
        bits_check = {"passed": bool(same), "compared": True}
    checks["promo_bits_match_connectome"] = bits_check
    passed = passed and bits_check["passed"]

    manifest = {
        "schema_version": ATLAS_SCHEMA_VERSION,
        "projection_version": ATLAS_PROJECTION_VERSION,
        "epoch": "1900-01-01",
        "algorithms": {
            "title_association": "atlas-title-assoc@1",
            "title_lineage": "atlas-lineage@1",
            "reign_derive": "reign-derive@1",
            "year_encoding": "run-length-from-year@1",
            "member_order": "matches-desc-then-id@1",
            "member_cap": str(MEMBER_CAP),
            "bucketing": "fnv1a32-mod-256@1",
        },
        "counts": counts,
        "date_range": [day_to_iso(min(days)), day_to_iso(max(days))],
        "day_range": [min(days), max(days)],
        "buckets": BUCKETS,
        "reuses": REUSES,
        "checksums": dict(sorted(w.checksums.items())),
        "validation": {"passed": bool(passed), "checks": checks},
    }
    (OUT / "manifest.json").write_bytes(dumps(manifest).encode("utf-8"))

    print(f"  titles: registry={assoc_counts['registry']} dominant={assoc_counts['dominant']} "
          f"unresolved={assoc_counts['unresolved']}  lineage derived={derived_lineage} "
          f"no-changes={len(all_title_ids) - derived_lineage}  reigns={total_reigns} "
          f"in {len(with_reigns)} titles")
    print(f"  people {len(person)} in {len(people_buckets)} buckets, {route_total} routes; "
          f"promotions {len(promo_ids)} in {len(pbuckets)} buckets, "
          f"largest roster {largest_roster}, truncated {truncated_promos}")
    for rel in ("promotions.json", "titles.json"):
        print(f"  {rel}: {(OUT / rel).stat().st_size} bytes")
    def _bucket_size(prefix: str) -> tuple[str, int]:
        rels = [r for r in w.checksums if r.startswith(prefix)]
        if not rels:
            return "", 0
        big = max(rels, key=lambda r: (OUT / r).stat().st_size)
        return big, (OUT / big).stat().st_size
    for prefix in ("promotions/", "people/"):
        rel, size = _bucket_size(prefix)
        print(f"  largest {prefix}bucket: {rel} {size} bytes")
    total_bytes = sum((OUT / r).stat().st_size for r in w.checksums)
    print(f"  wrote {len(w.checksums) + 1} files, {total_bytes / 1e6:.1f} MB -> {OUT}")
    for name in sorted(checks):
        c = checks[name]
        print(f"  [{'PASS' if c.get('passed') else 'FAIL'}] {name}")
    print("atlas:materialize", "OK" if passed else "FAILED VALIDATION")
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(build())
