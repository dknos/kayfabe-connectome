"""atlas:validate — assert the ATLAS projection is internally consistent and
honest about what it could not resolve.

Called by atlas_project.build() before the manifest is written (which is why
every check reads the tree from disk and none of them reads the manifest), and
standalone by `pnpm atlas:validate` to re-check a committed tree, where it
additionally verifies every recorded checksum.

The browser loader refuses to render a projection whose own validation failed,
so nothing here is a warning: a check either states something that must be
true of the files or it does not belong in this module. Every check reconciles
a derived number against a different derived number written by a different
code path, so a single systematic error cannot agree with itself.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

from .atlas_project import OUT, decode_years
from .normalize import bucket_of, day_to_iso, iso_to_day
from .validate import verify_checksums

MAX_EXAMPLES = 5


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _year_of(day: int) -> int:
    return int(day_to_iso(day)[:4])


def _numbers(obj):
    """Every numeric leaf, so a NaN cannot hide inside a nested structure."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _numbers(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _numbers(v)


def _rows(columnar: dict) -> list[dict]:
    """Columnar file -> row dicts. Length disagreements are caught before this
    runs, so a short column here would be an IndexError, not a silent zip()."""
    keys = [k for k in columnar if k != "count"]
    return [{k: columnar[k][i] for k in keys} for i in range(columnar["count"])]


def run_checks(out: Path, counts: dict | None = None) -> tuple[bool, dict]:
    checks: dict[str, dict] = {}
    promos = _load(out / "promotions.json")
    titles = _load(out / "titles.json")

    # ---------------------------------------------------------- columnar shape
    p_arrays = ("id", "name", "firstDay", "lastDay", "cards", "matches", "people",
                "titles", "src", "bit", "yearFrom", "yearCounts")
    t_arrays = ("id", "name", "pr", "assoc", "assocShare", "firstDay", "lastDay",
                "titleMatches", "reigns", "changes", "holders", "artifact", "src",
                "lineage")
    p_len_ok = all(len(promos.get(a, [])) == promos["count"] for a in p_arrays)
    t_len_ok = all(len(titles.get(a, [])) == titles["count"] for a in t_arrays)
    p_keys_ok = set(promos) == {"count", *p_arrays}
    t_keys_ok = set(titles) == {"count", *t_arrays}
    p_unique = len(set(promos["id"])) == promos["count"]
    t_unique = len(set(titles["id"])) == titles["count"]
    p_sorted = promos["id"] == sorted(promos["id"])
    t_sorted = titles["id"] == sorted(titles["id"])
    checks["columnar_shape"] = {
        "passed": bool(p_len_ok and t_len_ok and p_keys_ok and t_keys_ok
                       and p_unique and t_unique and p_sorted and t_sorted),
        "promotions": promos["count"],
        "titles": titles["count"],
        "promotion_lengths_ok": bool(p_len_ok and p_keys_ok),
        "title_lengths_ok": bool(t_len_ok and t_keys_ok),
        "ids_unique": bool(p_unique and t_unique),
        "ids_sorted_as_strings": bool(p_sorted and t_sorted),
    }

    prows = _rows(promos)
    trows = _rows(titles)
    promo_ids = set(promos["id"])
    by_promo = {r["id"]: r for r in prows}

    # ------------------------------------------------------- title association
    assoc_bad: list[str] = []
    assoc_tally = {"registry": 0, "dominant": 0, "unresolved": 0}
    for r in trows:
        a, pr, share = r["assoc"], r["pr"], r["assocShare"]
        if a not in assoc_tally:
            assoc_bad.append(r["id"])
            continue
        assoc_tally[a] += 1
        if a == "unresolved":
            ok = pr == "" and share == 0.0 and r["titleMatches"] == 0
        elif a == "registry":
            ok = pr in promo_ids and share == 1.0
        else:
            ok = pr in promo_ids and 0.0 < share <= 1.0 and r["titleMatches"] > 0
        if not ok:
            assoc_bad.append(r["id"])
    placed = sum(1 for r in trows if r["pr"] != "")
    title_col_sum = sum(promos["titles"])
    per_promo_titles: dict[str, int] = {}
    for r in trows:
        if r["pr"]:
            per_promo_titles[r["pr"]] = per_promo_titles.get(r["pr"], 0) + 1
    lane_bad = [r["id"] for r in prows if r["titles"] != per_promo_titles.get(r["id"], 0)]
    checks["title_association"] = {
        "passed": bool(not assoc_bad and not lane_bad and title_col_sum == placed),
        **{f"assoc_{k}": v for k, v in assoc_tally.items()},
        "placed_titles": placed,
        "promotion_title_column_sum": title_col_sum,
        "invalid_rows": assoc_bad[:MAX_EXAMPLES],
        "promotions_with_wrong_title_count": lane_bad[:MAX_EXAMPLES],
    }

    # ------------------------------------------------------------- title lineage
    lin_bad: list[str] = []
    lin_tally = {"derived": 0, "no-changes": 0}
    for r in trows:
        lin = r["lineage"]
        if lin not in lin_tally:
            lin_bad.append(r["id"])
            continue
        lin_tally[lin] += 1
        # A source that cannot record a change must not have derived one, and
        # reigns==0 must never come with holders — a holder with no reign would
        # be a claim about a lineage this projection says it cannot see.
        ok = (lin == "derived") == (r["src"] == "local_sql")
        if lin == "no-changes":
            ok = ok and r["reigns"] == 0 and r["changes"] == 0
        if r["reigns"] == 0:
            ok = ok and r["holders"] == 0
        if r["reigns"] > 0:
            ok = ok and lin == "derived" and r["holders"] > 0
        if not ok:
            lin_bad.append(r["id"])
    checks["title_lineage"] = {
        "passed": not lin_bad,
        **{f"lineage_{k}": v for k, v in lin_tally.items()},
        "titles_with_reigns": sum(1 for r in trows if r["reigns"] > 0),
        "invalid_rows": lin_bad[:MAX_EXAMPLES],
    }

    # ------------------------------------------------------------------ buckets
    pdetail: dict[str, dict] = {}
    pbucket_bad: list[str] = []
    pbucket_files = sorted((out / "promotions").glob("*.json"))
    for path in pbucket_files:
        bucket = _load(path)
        for pid, detail in bucket.items():
            if bucket_of(pid) != path.stem or detail["id"] != pid:
                pbucket_bad.append(pid)
            pdetail[pid] = detail
    people: dict[str, dict] = {}
    people_bucket_bad: list[str] = []
    people_files = sorted((out / "people").glob("*.json"))
    for path in people_files:
        bucket = _load(path)
        for cid, entry in bucket.items():
            if bucket_of(cid) != path.stem:
                people_bucket_bad.append(cid)
            people[cid] = entry
    detail_cover = set(pdetail) == promo_ids
    checks["bucket_assignment"] = {
        "passed": bool(not pbucket_bad and not people_bucket_bad and detail_cover),
        "promotion_buckets": len(pbucket_files),
        "people_buckets": len(people_files),
        "promotion_details": len(pdetail),
        "people": len(people),
        "details_cover_promotions": bool(detail_cover),
        "misbucketed": (pbucket_bad + people_bucket_bad)[:MAX_EXAMPLES],
    }

    # ------------------------------------------------------------------- spans
    span_bad: list[str] = []

    def span_ok(label: str, first, last) -> None:
        if first < 0 or last < 0:
            if not (first == -1 and last == -1):
                span_bad.append(label)
            return
        if first > last:
            span_bad.append(label)

    for r in prows:
        span_ok(r["id"], r["firstDay"], r["lastDay"])
    for r in trows:
        span_ok(r["id"], r["firstDay"], r["lastDay"])
    for pid, d in pdetail.items():
        span_ok(pid, d["firstDay"], d["lastDay"])
        for m in d["members"]:
            span_ok(f"{pid}/{m['p']}", m["firstDay"], m["lastDay"])
        for t in d["titles"]:
            span_ok(f"{pid}/{t['t']}", t["firstDay"], t["lastDay"])
    for cid, e in people.items():
        span_ok(cid, e["firstDay"], e["lastDay"])
        for r in e["routes"]:
            span_ok(f"{cid}/{r['pr']}", r["firstDay"], r["lastDay"])
    checks["spans_monotonic"] = {
        "passed": not span_bad,
        "violations": len(span_bad),
        "examples": span_bad[:MAX_EXAMPLES],
    }

    # -------------------------------------------------------- id resolution
    unresolved: list[str] = []
    for r in trows:
        if r["pr"] and r["pr"] not in promo_ids:
            unresolved.append(r["id"])
    title_ids = set(titles["id"])
    for pid, d in pdetail.items():
        for t in d["titles"]:
            if t["t"] not in title_ids:
                unresolved.append(f"{pid}/{t['t']}")
        for m in d["members"]:
            if m["p"] not in people:
                unresolved.append(f"{pid}/{m['p']}")
    for cid, e in people.items():
        for r in e["routes"]:
            if r["pr"] not in promo_ids:
                unresolved.append(f"{cid}/{r['pr']}")
    checks["id_resolution"] = {
        "passed": not unresolved,
        "dangling": len(unresolved),
        "examples": unresolved[:MAX_EXAMPLES],
    }

    # ------------------------------------------- promotion / detail agreement
    mismatch: list[str] = []
    truncated = 0
    for pid, d in pdetail.items():
        r = by_promo.get(pid)
        if r is None:
            mismatch.append(pid)
            continue
        left_out = d.get("membersTruncated", 0)
        if left_out:
            truncated += 1
        same = (
            d["n"] == r["name"]
            and d["firstDay"] == r["firstDay"]
            and d["lastDay"] == r["lastDay"]
            and d["cards"] == r["cards"]
            and d["matches"] == r["matches"]
            and d["people"] == r["people"]
            and d["src"] == r["src"]
            and d["yearFrom"] == r["yearFrom"]
            and len(d["titles"]) == r["titles"]
            # The roster is the ledger: kept + left out is the distinct member
            # count, so a truncated board can still be read as a total.
            and d["people"] == len(d["members"]) + left_out
        )
        if not same:
            mismatch.append(pid)
    checks["promotion_people_reconcile"] = {
        "passed": not mismatch,
        "promotions": len(pdetail),
        "truncated_rosters": truncated,
        "examples": mismatch[:MAX_EXAMPLES],
    }

    # ------------------------------------------------------- member ordering
    order_bad: list[str] = []
    for pid, d in pdetail.items():
        keys = [(-m["matches"], m["p"]) for m in d["members"]]
        if keys != sorted(keys):
            order_bad.append(pid)
        if any(m["cards"] > m["matches"] for m in d["members"]):
            order_bad.append(pid)
    route_order_bad = [
        cid for cid, e in people.items()
        if [(r["firstDay"], r["pr"]) for r in e["routes"]]
        != sorted((r["firstDay"], r["pr"]) for r in e["routes"])
    ]
    checks["member_ordering"] = {
        "passed": bool(not order_bad and not route_order_bad),
        "unordered_rosters": len(order_bad),
        "unordered_routes": len(route_order_bad),
        "examples": (order_bad + route_order_bad)[:MAX_EXAMPLES],
    }

    # -------------------------------------------------------- champion flags
    # champ is the only field derived from a join (reign holders x members), so
    # it is the one field a wrong join key would leave silently absent
    # everywhere. A board with no derivable lineage cannot have a champion, and
    # a board's champions cannot outnumber the holders of its own titles.
    champ_bad: list[str] = []
    champ_total = 0
    for pid, d in pdetail.items():
        flagged = sum(1 for m in d["members"] if m.get("champ") == 1)
        champ_total += flagged
        board_reigns = sum(t["reigns"] for t in d["titles"])
        board_holders = sum(t["holders"] for t in d["titles"])
        if flagged and (board_reigns == 0 or flagged > board_holders):
            champ_bad.append(pid)
    checks["champ_flags"] = {
        "passed": not champ_bad,
        "boards_with_champions": sum(
            1 for d in pdetail.values() if any(m.get("champ") == 1 for m in d["members"])
        ),
        "flagged_members": champ_total,
        "examples": champ_bad[:MAX_EXAMPLES],
    }

    # --------------------------------------------------------- yearly series
    year_bad: list[str] = []

    def years_ok(label: str, year_from: int, series: list[int], total: int,
                 first: int, last: int) -> None:
        if sum(series) != total:
            year_bad.append(label)
            return
        if not series:
            if year_from != -1 or total != 0 or first != -1:
                year_bad.append(label)
            return
        if year_from != _year_of(first) or year_from + len(series) - 1 != _year_of(last):
            year_bad.append(label)
        elif series[0] == 0 or series[-1] == 0:
            # A leading or trailing zero means the span and the series disagree
            # about when the promotion was actually documented.
            year_bad.append(label)

    for r in prows:
        years_ok(r["id"], r["yearFrom"], r["yearCounts"], r["matches"],
                 r["firstDay"], r["lastDay"])
    for pid, d in pdetail.items():
        years_ok(f"{pid}#matches", d["yearFrom"], d["yearMatches"], d["matches"],
                 d["firstDay"], d["lastDay"])
        years_ok(f"{pid}#cards", d["yearFrom"], d["yearCards"], d["cards"],
                 d["firstDay"], d["lastDay"])
        if len(d["yearCards"]) != len(d["yearMatches"]):
            year_bad.append(f"{pid}#len")
        if d["yearMatches"] != by_promo[pid]["yearCounts"]:
            year_bad.append(f"{pid}#promotions.json")
        for t in d["titles"]:
            years_ok(f"{pid}/{t['t']}", t["yearFrom"], t["yearCounts"],
                     t["titleMatches"], t["firstDay"], t["lastDay"])
            if sum(decode_years(t["yearFrom"], t["yearCounts"]).values()) != t["titleMatches"]:
                year_bad.append(f"{pid}/{t['t']}#decode")
    checks["yearly_reconcile"] = {
        "passed": not year_bad,
        "series_checked": len(prows) + 2 * len(pdetail)
        + sum(len(d["titles"]) for d in pdetail.values()),
        "violations": len(year_bad),
        "examples": year_bad[:MAX_EXAMPLES],
    }

    # ------------------------------------------------------ person vs routes
    person_bad: list[str] = []
    route_total = 0
    for cid, e in people.items():
        rs = e["routes"]
        route_total += len(rs)
        if not rs:
            person_bad.append(cid)
            continue
        if (e["matches"] != sum(r["matches"] for r in rs)
                or e["firstDay"] != min(r["firstDay"] for r in rs)
                or e["lastDay"] != max(r["lastDay"] for r in rs)
                or len({r["pr"] for r in rs}) != len(rs)
                or any(r["cards"] > r["matches"] for r in rs)):
            person_bad.append(cid)
    # The same (person, promotion) pair is written twice — once as a route,
    # once as a member — by two different loops. They must agree.
    member_pairs = {(pid, m["p"]): (m["matches"], m["cards"], m["firstDay"], m["lastDay"])
                    for pid, d in pdetail.items() for m in d["members"]}
    pair_bad: list[str] = []
    for cid, e in people.items():
        for r in e["routes"]:
            got = member_pairs.get((r["pr"], cid))
            if got is None:
                continue  # truncated out of that roster; the ledger check covers it
            if got != (r["matches"], r["cards"], r["firstDay"], r["lastDay"]):
                pair_bad.append(f"{r['pr']}/{cid}")
    checks["person_routes_reconcile"] = {
        "passed": bool(not person_bad and not pair_bad),
        "people": len(people),
        "routes": route_total,
        "inconsistent_people": len(person_bad),
        "member_route_disagreements": len(pair_bad),
        "examples": (person_bad + pair_bad)[:MAX_EXAMPLES],
    }

    # ---------------------------------------------------------- finite values
    nonfinite = 0
    for blob in (promos, titles, pdetail, people):
        for v in _numbers(blob):
            if not math.isfinite(v):
                nonfinite += 1
    checks["finite_values"] = {"passed": nonfinite == 0, "nonfinite": nonfinite}

    # --------------------------------------------------------- manifest counts
    if counts is not None:
        expect = {
            "promotions": promos["count"],
            "titles": titles["count"],
            "people": len(people),
            "routes": route_total,
            "cards": sum(promos["cards"]),
            "matches": sum(promos["matches"]),
            "promotionBuckets": len(pbucket_files),
            "peopleBuckets": len(people_files),
            "titlesRegistry": assoc_tally["registry"],
            "titlesDominant": assoc_tally["dominant"],
            "titlesUnresolved": assoc_tally["unresolved"],
            "titlesLineageDerived": lin_tally["derived"],
            "titlesWithReigns": sum(1 for r in trows if r["reigns"] > 0),
            "reigns": sum(titles["reigns"]),
            "promotionsWithTruncatedRoster": truncated,
        }
        wrong = sorted(k for k, v in expect.items() if counts.get(k) != v)
        checks["manifest_counts"] = {
            "passed": not wrong,
            "compared": len(expect),
            "mismatched": {k: [counts.get(k), expect[k]] for k in wrong[:MAX_EXAMPLES]},
        }

    # ------------------------------------------------------ determinism canary
    canary_obj = {
        "promotions_head": [[r["id"], r["matches"], r["people"], r["titles"]]
                            for r in prows[:100]],
        "titles_head": [[r["id"], r["pr"], r["assoc"], r["assocShare"], r["lineage"]]
                        for r in trows[:100]],
        "people_head": [[cid, people[cid]["matches"], len(people[cid]["routes"])]
                        for cid in sorted(people)[:100]],
    }
    canary = hashlib.sha256(
        json.dumps(canary_obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    checks["determinism_canary"] = {"passed": True, "sha256": canary}

    passed = all(c.get("passed", False) for c in checks.values())
    return passed, checks


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    out = Path(argv[0]) if argv else OUT

    manifest_path = out / "manifest.json"
    if not manifest_path.exists():
        print(f"atlas:validate FAILED — no manifest at {manifest_path}. "
              "Run: pnpm atlas:materialize")
        return 1
    manifest = _load(manifest_path)

    passed, checks = run_checks(out, manifest.get("counts"))
    cs_ok, cs = verify_checksums(out, manifest)
    checks["checksums"] = cs

    dr = manifest["date_range"]
    dr_ok = all(day_to_iso(iso_to_day(d)) == d for d in dr)
    day_ok = [iso_to_day(d) for d in dr] == manifest["day_range"]
    checks["manifest_consistency"] = {
        "passed": bool(dr_ok and day_ok and manifest["validation"]["passed"]),
        "date_range_roundtrip": bool(dr_ok),
        "day_range_matches": bool(day_ok),
        "recorded_validation_passed": bool(manifest["validation"]["passed"]),
    }

    ok = passed and cs_ok and checks["manifest_consistency"]["passed"]
    for name in sorted(checks):
        c = checks[name]
        print(f"[{'PASS' if c.get('passed') else 'FAIL'}] {name}: "
              + ", ".join(f"{k}={v}" for k, v in c.items() if k != "passed"))
    print("atlas:validate", "PASSED" if ok else "FAILED", f"— {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
