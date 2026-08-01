"""Unit tests for the ATLAS projection.

Offline and corpus-free: every rule that decides what the projection claims is
a pure function over plain dicts, and the validator is exercised against a tiny
tree written into tmp_path. A test run must never need the sqlite or csv
corpora, because the rules are what regress, not the data.
"""

from __future__ import annotations

import json

import pytest

from kayfabe_materializer.atlas_project import (
    MEMBER_CAP,
    associate_title,
    cap_members,
    decode_years,
    dumps,
    encode_years,
    lineage_of,
    order_members,
)
from kayfabe_materializer.atlas_validate import run_checks
from kayfabe_materializer.normalize import bucket_of, iso_to_day


# ------------------------------------------------------------- association


def test_registry_title_keeps_the_promotion_the_source_names():
    assert associate_title("c361", {}) == ("c361", "registry", 1.0)


def test_registry_wins_even_when_the_matches_point_elsewhere():
    # The csv row names the promotion outright; a belt defended in someone
    # else's building does not change whose belt it is.
    assert associate_title("c361", {"1": 40, "c361": 2})[0] == "c361"


def test_dominant_title_publishes_how_strong_the_majority_is():
    pr, assoc, share = associate_title(None, {"4140": 30, "1": 10})
    assert (pr, assoc) == ("4140", "dominant")
    assert share == 0.75


def test_dominant_share_is_rounded_to_four_places():
    # 2 of 3 documented title matches, not a clean decimal.
    assert associate_title(None, {"1": 1, "2": 2}) == ("2", "dominant", 0.6667)


def test_dominant_ties_break_by_promotion_id_as_a_string():
    # '11561' sorts before '2715' as a string. Numeric order here would be a
    # different, and unstable, answer for the mixed 'c<n>' half of the space.
    assert associate_title(None, {"2715": 5, "11561": 5})[0] == "11561"
    assert associate_title(None, {"c9": 3, "1": 3})[0] == "1"


def test_a_title_with_no_record_is_unresolved_and_not_guessed_into_ecw():
    pr, assoc, share = associate_title(None, {})
    assert (pr, assoc, share) == ("", "unresolved", 0.0)
    # materialize.py falls back to sorted(FAMILY_PROMO_BITS)[0] == '1' (ECW).
    # Copying that would invent the only fabricated fact in the file.
    assert pr != "1"


def test_an_empty_registry_string_is_not_a_promotion():
    # A blank registry cell must fall through to the records, never be
    # published as a promotion whose id is "".
    assert associate_title("", {"1": 2}) == ("1", "dominant", 1.0)
    assert associate_title("", {}) == ("", "unresolved", 0.0)


# ----------------------------------------------------------------- lineage


def test_lineage_follows_the_source_not_the_reign_count():
    assert lineage_of("local_sql") == "derived"
    assert lineage_of("csv_initial_matches") == "no-changes"


def test_lineage_rejects_a_source_it_has_not_been_taught():
    # A new source must state whether it can record a change; defaulting would
    # silently label unknown history as derived.
    with pytest.raises(KeyError):
        lineage_of("some_new_corpus")


# ------------------------------------------------------------ year encoding


def test_year_encoding_round_trips():
    counts = {"1998": 3, "1999": 1, "2001": 7}
    year_from, series = encode_years(counts)
    assert (year_from, series) == (1998, [3, 1, 0, 7])
    assert decode_years(year_from, series) == counts


def test_year_encoding_pads_the_silent_years_between_records():
    year_from, series = encode_years({"1990": 1, "1994": 2})
    assert series == [1, 0, 0, 0, 2]
    assert year_from + len(series) - 1 == 1994


def test_an_empty_series_encodes_as_minus_one_not_year_zero():
    assert encode_years({}) == (-1, [])
    assert decode_years(-1, []) == {}


def test_a_single_year_encodes_to_one_slot():
    assert encode_years({"2015": 12}) == (2015, [12])


# ------------------------------------------------------------------ buckets


def test_bucket_is_two_hex_digits_of_the_prefixed_canonical_id():
    for cid in ("p:86", "p:c1204", "pr:4140", "t:c45"):
        bb = bucket_of(cid)
        assert len(bb) == 2 and int(bb, 16) < 256


def test_atlas_people_share_a_bucket_with_the_entities_they_reuse():
    # The lens opens atlas/people/{bb}.json and entities/people/{bb}.json for
    # the same person; bucketing on the bare id would split them.
    assert bucket_of("p:86") == bucket_of("p:86")
    assert bucket_of("86") != bucket_of("p:86")


# ------------------------------------------------------ member order + cap


def _member(pid: str, matches: int) -> dict:
    return {"p": pid, "n": pid, "firstDay": 0, "lastDay": 1, "matches": matches, "cards": 1}


def test_members_order_by_weight_then_by_id():
    got = order_members([_member("p:9", 2), _member("p:1", 5), _member("p:2", 2)])
    assert [m["p"] for m in got] == ["p:1", "p:2", "p:9"]


def test_member_order_is_stable_for_ids_that_are_not_numbers():
    got = order_members([_member("p:c10", 3), _member("p:c2", 3), _member("p:d1", 3)])
    assert [m["p"] for m in got] == ["p:c10", "p:c2", "p:d1"]


def test_capping_a_roster_reports_exactly_what_it_left_out():
    roster = [_member(f"p:{i}", 100 - i) for i in range(10)]
    kept, left_out = cap_members(roster, 4)
    assert len(kept) == 4 and left_out == 6
    assert len(kept) + left_out == len(roster)


def test_a_roster_under_the_cap_is_not_marked_truncated():
    roster = [_member("p:1", 1)]
    assert cap_members(roster, MEMBER_CAP) == (roster, 0)


# ------------------------------------------------------------- determinism


def test_dumps_is_independent_of_key_insertion_order():
    a = {"b": 1, "a": {"y": [1, 2], "x": 3}}
    b = {"a": {"x": 3, "y": [1, 2]}, "b": 1}
    assert dumps(a) == dumps(b)


def test_dumps_refuses_a_nan():
    with pytest.raises(ValueError):
        dumps({"x": float("nan")})


def test_dumps_is_compact_and_keeps_unicode_readable():
    assert dumps({"n": "Arena México", "m": 1}) == '{"m":1,"n":"Arena México"}'


# --------------------------------------------------------------- validator
# A hand-built two-promotion tree, small enough to reason about and complete
# enough that every cross-file check has something to reconcile.

D0 = iso_to_day("2000-05-01")
D1 = iso_to_day("2001-06-01")
D2 = iso_to_day("2002-03-01")


def _tree() -> dict[str, dict]:
    promotions = {
        "count": 2,
        "id": ["pr:1", "pr:c9"],
        "name": ["Alpha", "Cee"],
        "firstDay": [D0, D2],
        "lastDay": [D1, D2],
        "cards": [3, 1],
        "matches": [4, 2],
        "people": [2, 1],
        "titles": [1, 1],
        "src": ["local_sql", "csv_initial_matches"],
        "bit": [0, -1],
        "yearFrom": [2000, 2002],
        "yearCounts": [[3, 1], [2]],
    }
    titles = {
        "count": 3,
        "id": ["t:5", "t:9", "t:c7"],
        "name": ["Alpha Title", "Orphan Belt", "Cee Title"],
        "pr": ["pr:1", "", "pr:c9"],
        "assoc": ["dominant", "unresolved", "registry"],
        "assocShare": [0.75, 0.0, 1.0],
        "firstDay": [D0, -1, D2],
        "lastDay": [D1, -1, D2],
        "titleMatches": [4, 0, 2],
        "reigns": [1, 0, 0],
        "changes": [1, 0, 0],
        "holders": [1, 0, 0],
        "artifact": [0, 0, 0],
        "src": ["local_sql", "local_sql", "csv_initial_matches"],
        "lineage": ["derived", "derived", "no-changes"],
    }
    details = {
        "pr:1": {
            "id": "pr:1", "n": "Alpha", "firstDay": D0, "lastDay": D1,
            "cards": 3, "matches": 4, "people": 2, "src": "local_sql",
            "yearFrom": 2000, "yearCards": [2, 1], "yearMatches": [3, 1],
            "titles": [{
                "t": "t:5", "n": "Alpha Title", "firstDay": D0, "lastDay": D1,
                "titleMatches": 4, "reigns": 1, "changes": 1, "holders": 1,
                "artifact": 0, "assoc": "dominant", "assocShare": 0.75,
                "lineage": "derived", "yearFrom": 2000, "yearCounts": [3, 1],
            }],
            "members": [
                {"p": "p:1", "n": "Ann", "firstDay": D0, "lastDay": D1,
                 "matches": 3, "cards": 2, "champ": 1},
                {"p": "p:2", "n": "Bob", "firstDay": D0, "lastDay": D0,
                 "matches": 1, "cards": 1},
            ],
        },
        "pr:c9": {
            "id": "pr:c9", "n": "Cee", "firstDay": D2, "lastDay": D2,
            "cards": 1, "matches": 2, "people": 1, "src": "csv_initial_matches",
            "yearFrom": 2002, "yearCards": [1], "yearMatches": [2],
            "titles": [{
                "t": "t:c7", "n": "Cee Title", "firstDay": D2, "lastDay": D2,
                "titleMatches": 2, "reigns": 0, "changes": 0, "holders": 0,
                "artifact": 0, "assoc": "registry", "assocShare": 1.0,
                "lineage": "no-changes", "yearFrom": 2002, "yearCounts": [2],
            }],
            "members": [
                {"p": "p:2", "n": "Bob", "firstDay": D2, "lastDay": D2,
                 "matches": 2, "cards": 1},
            ],
        },
    }
    people = {
        "p:1": {"n": "Ann", "firstDay": D0, "lastDay": D1, "matches": 3,
                "routes": [{"pr": "pr:1", "firstDay": D0, "lastDay": D1,
                            "matches": 3, "cards": 2}]},
        "p:2": {"n": "Bob", "firstDay": D0, "lastDay": D2, "matches": 3,
                "routes": [
                    {"pr": "pr:1", "firstDay": D0, "lastDay": D0,
                     "matches": 1, "cards": 1},
                    {"pr": "pr:c9", "firstDay": D2, "lastDay": D2,
                     "matches": 2, "cards": 1},
                ]},
    }
    return {"promotions": promotions, "titles": titles, "details": details,
            "people": people}


def _write(root, tree: dict) -> None:
    (root / "promotions.json").write_text(dumps(tree["promotions"]), encoding="utf-8")
    (root / "titles.json").write_text(dumps(tree["titles"]), encoding="utf-8")
    for sub, entries in (("promotions", tree["details"]), ("people", tree["people"])):
        d = root / sub
        d.mkdir(exist_ok=True)
        shards: dict[str, dict] = {}
        for key, value in entries.items():
            shards.setdefault(bucket_of(key), {})[key] = value
        for bb, shard in shards.items():
            (d / f"{bb}.json").write_text(dumps(shard), encoding="utf-8")


@pytest.fixture()
def tree_dir(tmp_path):
    def _build(mutate=None):
        tree = _tree()
        if mutate is not None:
            mutate(tree)
        root = tmp_path / f"atlas{len(list(tmp_path.iterdir()))}"
        root.mkdir()
        _write(root, tree)
        return root
    return _build


def _failed(root, counts=None) -> set[str]:
    passed, checks = run_checks(root, counts)
    bad = {name for name, c in checks.items() if not c.get("passed")}
    assert passed == (not bad)
    return bad


def test_a_consistent_tree_passes_every_check(tree_dir):
    root = tree_dir()
    passed, checks = run_checks(root)
    assert passed, {k: v for k, v in checks.items() if not v.get("passed")}
    assert checks["title_association"]["assoc_unresolved"] == 1
    assert checks["title_lineage"]["lineage_no-changes"] == 1


def test_manifest_counts_are_checked_against_the_arrays(tree_dir):
    root = tree_dir()
    counts = {
        "promotions": 2, "titles": 3, "people": 2, "routes": 3, "cards": 4,
        "matches": 6, "promotionBuckets": 2, "peopleBuckets": 2,
        "titlesRegistry": 1, "titlesDominant": 1, "titlesUnresolved": 1,
        "titlesLineageDerived": 2, "titlesWithReigns": 1, "reigns": 1,
        "promotionsWithTruncatedRoster": 0,
    }
    assert not _failed(root, counts)
    counts["people"] = 3
    assert _failed(root, counts) == {"manifest_counts"}


def test_a_backwards_span_fails(tree_dir):
    def mutate(tree):
        tree["details"]["pr:1"]["members"][0]["lastDay"] = D0 - 1
    assert "spans_monotonic" in _failed(tree_dir(mutate))


def test_a_half_missing_span_fails(tree_dir):
    # firstDay -1 with a real lastDay is a half-claim; missing stays missing.
    def mutate(tree):
        tree["titles"]["firstDay"][1] = -1
        tree["titles"]["lastDay"][1] = D2
    assert "spans_monotonic" in _failed(tree_dir(mutate))


def test_an_unresolved_title_may_not_carry_a_promotion(tree_dir):
    def mutate(tree):
        tree["titles"]["pr"][1] = "pr:1"
    assert "title_association" in _failed(tree_dir(mutate))


def test_the_promotion_title_count_must_match_the_lane(tree_dir):
    def mutate(tree):
        tree["promotions"]["titles"][0] = 2
    assert "title_association" in _failed(tree_dir(mutate))


def test_a_csv_title_may_not_claim_a_derived_lineage(tree_dir):
    def mutate(tree):
        tree["titles"]["lineage"][2] = "derived"
    assert "title_lineage" in _failed(tree_dir(mutate))


def test_a_holder_without_a_reign_fails(tree_dir):
    def mutate(tree):
        tree["titles"]["holders"][1] = 1
    assert "title_lineage" in _failed(tree_dir(mutate))


def test_a_truncated_roster_must_declare_what_it_dropped(tree_dir):
    def mutate(tree):
        tree["details"]["pr:1"]["members"].pop()
    assert "promotion_people_reconcile" in _failed(tree_dir(mutate))


def test_declaring_the_truncation_restores_the_ledger(tree_dir):
    def mutate(tree):
        d = tree["details"]["pr:1"]
        d["members"].pop()
        d["membersTruncated"] = 1
    assert not _failed(tree_dir(mutate))


def test_an_out_of_order_roster_fails(tree_dir):
    def mutate(tree):
        tree["details"]["pr:1"]["members"].reverse()
    assert "member_ordering" in _failed(tree_dir(mutate))


def test_a_year_series_that_does_not_sum_to_its_total_fails(tree_dir):
    def mutate(tree):
        tree["promotions"]["yearCounts"][0] = [3, 2]
    assert "yearly_reconcile" in _failed(tree_dir(mutate))


def test_a_year_series_that_starts_before_the_span_fails(tree_dir):
    def mutate(tree):
        d = tree["details"]["pr:1"]
        d["yearFrom"] = 1999
        d["yearCards"] = [0, 2, 1]
        d["yearMatches"] = [0, 3, 1]
        tree["promotions"]["yearFrom"][0] = 1999
        tree["promotions"]["yearCounts"][0] = [0, 3, 1]
    assert "yearly_reconcile" in _failed(tree_dir(mutate))


def test_a_champion_on_a_board_with_no_derivable_lineage_fails(tree_dir):
    # pr:c9's only title is csv-sourced, so no reign can be derived there and
    # no member of that board can be flagged as a champion.
    def mutate(tree):
        tree["details"]["pr:c9"]["members"][0]["champ"] = 1
    assert "champ_flags" in _failed(tree_dir(mutate))


def test_more_champions_than_holders_fails(tree_dir):
    def mutate(tree):
        tree["details"]["pr:1"]["members"][1]["champ"] = 1
    assert "champ_flags" in _failed(tree_dir(mutate))


def test_a_member_who_is_in_no_people_bucket_fails(tree_dir):
    def mutate(tree):
        tree["details"]["pr:1"]["members"][0]["p"] = "p:404"
    assert "id_resolution" in _failed(tree_dir(mutate))


def test_a_route_into_a_promotion_that_does_not_exist_fails(tree_dir):
    def mutate(tree):
        tree["people"]["p:1"]["routes"][0]["pr"] = "pr:nope"
    assert "id_resolution" in _failed(tree_dir(mutate))


def test_a_route_and_its_member_row_must_agree(tree_dir):
    def mutate(tree):
        tree["people"]["p:1"]["routes"][0]["matches"] = 99
        tree["people"]["p:1"]["matches"] = 99
    assert "person_routes_reconcile" in _failed(tree_dir(mutate))


def test_a_misbucketed_person_fails(tree_dir, tmp_path):
    root = tree_dir()
    d = root / "people"
    shard = next(iter(d.glob("*.json")))
    payload = json.loads(shard.read_text(encoding="utf-8"))
    wrong = "00" if shard.stem != "00" else "01"
    (d / f"{wrong}.json").write_text(dumps(payload), encoding="utf-8")
    shard.unlink()
    assert "bucket_assignment" in _failed(root)


def test_a_missing_promotion_detail_fails(tree_dir):
    root = tree_dir()
    next(iter((root / "promotions").glob("*.json"))).unlink()
    assert "bucket_assignment" in _failed(root)
