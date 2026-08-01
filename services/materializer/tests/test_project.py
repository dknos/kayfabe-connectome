"""Projection rules: partner suppression, battle royal, aggregation, reigns."""

from kayfabe_materializer.project import (
    PairAggregator,
    derive_observations,
    derive_reigns,
)


def rels(obs, rel):
    return sorted((a, b) for r, a, b in obs if r == rel)


# --------------------------------------------- multi-way partner suppression


def test_multiway_loser_group_yields_nothing_within():
    # three-way dance, collapsed loser row 'A & B': winner p:9 over p:1 & p:2
    obs, sup = derive_observations("multi_way", "decisive", ["p:9"], ["p:1", "p:2"])
    assert rels(obs, "same") == []  # no fabricated tag team
    assert rels(obs, "opposed") == [("p:1", "p:9"), ("p:2", "p:9")]
    assert ("p:1", "p:2") not in rels(obs, "opposed")  # no within-loser opposed
    assert sup["multiway_loser_pairs_suppressed"] == 1


def test_multiway_winner_team_yields_partner_obs():
    # 'three-way dance tag': winning TEAM is genuine; losers stay collapsed
    obs, _ = derive_observations(
        "multi_way", "decisive", ["p:1", "p:2"], ["p:3", "p:4", "p:5", "p:6"]
    )
    assert rels(obs, "same") == [("p:1", "p:2")]
    assert len(rels(obs, "opposed")) == 8  # 2 winners x 4 losers
    # nothing within the loser group
    for a, b in (("p:3", "p:4"), ("p:5", "p:6"), ("p:3", "p:6")):
        assert (a, b) not in rels(obs, "same")
        assert (a, b) not in rels(obs, "opposed")


def test_multiway_draw_no_partner_obs_anywhere():
    obs, sup = derive_observations("multi_way", "draw", ["p:1", "p:2"], ["p:3", "p:4"])
    assert rels(obs, "same") == []
    assert sup["multiway_draw_pairs_suppressed"] == 2
    assert len(rels(obs, "opposed")) == 4  # cross-side opposition is still factual


# ----------------------------------------------------------- genuine teams


def test_tag_team_both_sides_yield_partner_obs():
    obs, _ = derive_observations("tag_team", "decisive", ["p:1", "p:2"], ["p:3", "p:4"])
    assert rels(obs, "same") == [("p:1", "p:2"), ("p:3", "p:4")]
    assert len(rels(obs, "opposed")) == 4


def test_team_implied_both_sides_yield_partner_obs():
    obs, _ = derive_observations("team_implied", "draw", ["p:1", "p:2"], ["p:3"])
    assert rels(obs, "same") == [("p:1", "p:2")]


# ------------------------------------------------------------- battle royal


def test_battle_royal_br_opposed_only_no_partners():
    obs, sup = derive_observations(
        "battle_royal", "decisive", ["p:9"], ["p:1", "p:2", "p:3"]
    )
    assert rels(obs, "same") == []
    assert rels(obs, "opposed") == []
    assert rels(obs, "br") == [("p:1", "p:9"), ("p:2", "p:9"), ("p:3", "p:9")]
    assert sup["battle_royal_partner_pairs_suppressed"] == 3
    # nothing within the loser pool
    assert ("p:1", "p:2") not in rels(obs, "br")


# -------------------------------------------------------- unknown sentinel


def test_unknown_members_produce_nothing():
    # resolver strips x:unknown from member lists; an unknown-only side is empty
    obs, _ = derive_observations("singles", "decisive", ["p:1"], [])
    assert obs == []


def test_self_pairs_skipped():
    obs, _ = derive_observations("singles", "decisive", ["p:1"], ["p:1"])
    assert obs == []


# -------------------------------------------------------------- aggregation


def _rec(mid, date, form, kind, w, l, title=None, tc=0, promo=1):
    return {
        "id": mid,
        "card_id": 100 + mid,
        "date": date,
        "day": 0,
        "promotion_id": promo,
        "form": form,
        "kind": kind,
        "res": "def." if kind == "decisive" else "draw",
        "fin": None,
        "title_components": [title] if title else [],
        "title_change": tc,
        "_promo_bit": 1,
        "sides": [
            {"members": w, "has_unknown": False, "size_raw": len(w), "row": 0},
            {"members": l, "has_unknown": False, "size_raw": len(l), "row": 0},
        ],
    }


def test_aggregator_edge_weights_equal_evidence_counts():
    agg = PairAggregator()
    agg.add_match(_rec(1, "2001-01-05", "singles", "decisive", ["p:1"], ["p:2"]))
    agg.add_match(_rec(2, "2001-02-05", "singles", "decisive", ["p:2"], ["p:1"], title=8, tc=1))
    agg.add_match(_rec(3, "2001-03-05", "tag_team", "decisive", ["p:1", "p:2"], ["p:3", "p:4"]))
    pairs = dict(agg.sorted_pairs())
    p12 = pairs["p:1|p:2"]
    assert p12["opposed"] == 2 and p12["same"] == 1 and p12["br"] == 0
    # every weight equals its evidence entry count
    assert len(p12["evidence"]) == p12["same"] + p12["opposed"] + p12["br"] == 3
    assert p12["titleMatches"] == 1
    # evidence is sorted by (date, match id)
    assert [e[1] for e in p12["evidence"]] == [1, 2, 3]
    assert p12["firstDay"] == p12["lastDay"] == 0


def test_aggregator_title_counts_and_dual_side_quality_ledger():
    agg = PairAggregator()
    # dual-side corruption is suppressed for that member, logged, and the rest
    # of the match still derives; title weight tracks matches, not observations
    agg.add_match(
        _rec(9, "2001-01-05", "tag_team", "decisive", ["p:1", "p:2"], ["p:2", "p:3"], title=8)
    )
    agg.add_match(
        _rec(10, "2001-02-05", "tag_team", "decisive", ["p:1", "p:4"], ["p:2", "p:3"], title=8)
    )
    pairs = dict(agg.sorted_pairs())
    assert "p:1|p:2" not in pairs or pairs["p:1|p:2"]["titleMatches"] == 1
    # match 9 collapses to p:1 vs p:3 after suppressing p:2
    p13 = pairs["p:1|p:3"]
    assert p13["opposed"] == 2 and p13["titleMatches"] == 2
    assert agg.dual_side_match_ids == [9]
    assert agg.counters["dual_side_members_suppressed"] == 1


# ------------------------------------------------------------ reign-derive@1


def test_reign_derive_interval_semantics():
    events = [
        ("2000-07-14", 5, 520, ["p:71"]),
        ("2001-01-07", 9, 761, ["p:80"]),
        ("2001-05-01", 12, 900, ["p:71", "p:72"]),
    ]
    reigns = derive_reigns(events)
    assert reigns[0] == {
        "holders": ["p:71"],
        "s": "2000-07-14",
        "e": "2001-01-07",
        "m": "m:520",
        "endM": "m:761",
    }
    assert reigns[1]["s"] == "2001-01-07" and reigns[1]["e"] == "2001-05-01"
    # final reign is open: no invented vacancy
    assert reigns[2] == {
        "holders": ["p:71", "p:72"],
        "s": "2001-05-01",
        "e": None,
        "m": "m:900",
    }


def test_reign_derive_orders_by_date_card_match():
    events = [
        ("2001-01-07", 9, 761, ["p:2"]),
        ("2000-07-14", 5, 520, ["p:1"]),
    ]
    reigns = derive_reigns(events)
    assert [r["m"] for r in reigns] == ["m:520", "m:761"]
    assert reigns[0]["e"] == "2001-01-07"


def test_dual_side_member_suppressed_entirely():
    # Source corruption: p:2 listed on both sides — nothing may be derived for them.
    obs, sup = derive_observations("tag_team", "decisive", ["p:1", "p:2"], ["p:2", "p:3"])
    assert sup["dual_side_members_suppressed"] == 1
    flat = {x for (_, a, b) in obs for x in (a, b)}
    assert "p:2" not in flat
    assert obs == [("opposed", "p:1", "p:3")]
