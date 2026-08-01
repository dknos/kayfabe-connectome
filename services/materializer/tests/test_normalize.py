"""Unit tests: parsers, classifiers, resolution, belts, hashing, days."""

from kayfabe_materializer.normalize import (
    Resolver,
    bucket_of,
    classify_form,
    day_to_iso,
    detect_placeholders,
    fnv1a32,
    iso_to_day,
    pair_key,
    parse_duration,
    parse_win_type,
    split_belts,
    split_side_name,
)

# ------------------------------------------------------------------ win_type


def test_win_type_decisive_variants():
    assert parse_win_type("def. (pin)") == ("decisive", "def.", "pin")
    assert parse_win_type("def. (sub)") == ("decisive", "def.", "sub")
    assert parse_win_type("def. (DQ)") == ("decisive", "def.", "DQ")
    assert parse_win_type("def. (forfeit)") == ("decisive", "def.", "forfeit")
    assert parse_win_type("def.") == ("decisive", "def.", None)


def test_win_type_draw_variants():
    assert parse_win_type("draw (NC)") == ("draw", "draw", "NC")
    assert parse_win_type("draw (DCO)") == ("draw", "draw", "DCO")
    assert parse_win_type("draw (time)") == ("draw", "draw", "time")
    assert parse_win_type("draw") == ("draw", "draw", None)
    assert parse_win_type("draw (curfew)") == ("draw", "draw", "curfew")
    # merged 'def.draw' tokens observed in the corpus are draws
    assert parse_win_type("def.draw (NC)") == ("draw", "draw", "NC")
    assert parse_win_type("def.draw (time)") == ("draw", "draw", "time")


def test_win_type_unknown_and_bare_parenthetical():
    assert parse_win_type("vs.") == ("unknown", "vs.", None)
    assert parse_win_type("") == ("unknown", "", None)
    assert parse_win_type(None) == ("unknown", "", None)
    # bare finishes infer the kind from the finish token
    assert parse_win_type("(pin)") == ("decisive", "def.", "pin")
    assert parse_win_type("(sub)") == ("decisive", "def.", "sub")
    assert parse_win_type("(NC)") == ("draw", "draw", "NC")


# ------------------------------------------------------------- form-classify


def test_form_classify_real_strings():
    assert classify_form("three-way dance tag", (2, 4)) == "multi_way"
    assert classify_form("6-person tag", (3, 3)) == "tag_team"
    assert classify_form("Battle Royal", (1, 20)) == "battle_royal"
    assert classify_form("", (1, 1)) == "singles"
    assert classify_form("", (2, 1)) == "team_implied"


def test_form_classify_priority_and_variants():
    # battle royal beats multi-way/tag markers
    assert classify_form("30-man royal rumble", (1, 29)) == "battle_royal"
    assert classify_form("rumble", (1, 5)) == "battle_royal"
    # multi-way beats tag markers; hyphen/digit variants recognized
    assert classify_form("triple-threat tag", (2, 4)) == "multi_way"
    assert classify_form("triple threat", (1, 2)) == "multi_way"
    assert classify_form("fatal 4-way", (1, 3)) == "multi_way"
    assert classify_form("5-way elimination", (1, 4)) == "multi_way"
    assert classify_form("gauntlet (tag)", (2, 2)) == "multi_way"
    assert classify_form("four-way dance", (1, 3)) == "multi_way"
    assert classify_form("elimination chamber", (1, 5)) == "multi_way"
    # tag family
    assert classify_form("handicap", (1, 2)) == "tag_team"
    assert classify_form("6-man tag falls count anywhere", (3, 3)) == "tag_team"
    assert classify_form("8-person tag", (4, 4)) == "tag_team"
    # 'tag' must match as a word, not inside 'stages'
    assert classify_form('"3 stages of hell"', (1, 1)) == "singles"
    # unmarked team side
    assert classify_form("street fight (4 on 4)", (4, 4)) == "team_implied"


# ---------------------------------------------------------------- durations


def test_duration_parse():
    assert parse_duration("04:34") == 274
    assert parse_duration("00:48") == 48
    assert parse_duration("60:00") == 3600
    assert parse_duration("") is None
    assert parse_duration(None) is None
    assert parse_duration("4:3") is None


# ----------------------------------------------------------- fnv / days


def test_fnv1a32_reference_vectors():
    assert fnv1a32("") == 2166136261
    # stable reference vector used by the wire contract
    assert fnv1a32("p:1|p:2") == 454477362
    assert bucket_of("p:1|p:2") == "32"  # 454477362 % 256 == 0x32
    assert pair_key("p:2", "p:1") == "p:1|p:2"
    # lexicographic, not numeric: 'p:123' < 'p:86'
    assert pair_key("p:86", "p:123") == "p:123|p:86"


def test_day_encoding():
    assert iso_to_day("1950-01-01") == 0
    assert day_to_iso(0) == "1950-01-01"
    for iso in ("1963-01-25", "2000-02-29", "2026-01-16"):
        assert day_to_iso(iso_to_day(iso)) == iso
    assert iso_to_day("1950-01-02") == 1


# ------------------------------------------------- placeholders + resolution


def test_placeholder_detection():
    got = detect_placeholders(
        ["Unknown Participants", "Unknown Male Wrestler", "", "Tracy Smothers", "John Betcha"]
    )
    assert got == {"Unknown Participants", "Unknown Male Wrestler", ""}


ROWS = [
    (1, "A"),
    (2, "B"),
    (3, "A & B"),
    (4, "A & C"),
    (5, "Unknown Participants"),
    (6, "A & Unknown Participants"),
    (7, "B & B"),
]


def test_side_split_and_exact_resolution():
    assert split_side_name("A & B & C") == ["A", "B", "C"]
    r = Resolver(ROWS)
    assert r.resolve(1) == (("p:1",), False, 1)
    assert r.resolve(3) == (("p:1", "p:2"), False, 2)
    # exact-name match only; 'C' has no solo row -> derived person
    slug = "%08x" % fnv1a32("C")
    members, unknown, size = r.resolve(4)
    assert members == ("p:1", f"p:d{slug}")
    assert not unknown and size == 2
    assert r.derived_people() == [(f"p:d{slug}", "C", [4])]


def test_placeholder_rows_resolve_to_unknown_sentinel():
    r = Resolver(ROWS)
    # placeholder individual row: no members, flagged unknown, never a person
    assert r.resolve(5) == ((), True, 1)
    # placeholder part inside a side row
    assert r.resolve(6) == (("p:1",), True, 2)
    assert r.unresolved_part_occurrences == 1
    assert "Unknown Participants" in r.placeholders


def test_side_row_duplicate_names_deduped():
    r = Resolver(ROWS)
    assert r.resolve(7) == (("p:2",), False, 2)


# ------------------------------------------------------------- belt-split@1


BELTS = {
    1: "",
    10: "ECW FTW Title",
    11: "ECW World Heavyweight Title",
    12: "ECW FTW Title ECW World Heavyweight Title",
    13: "ASWA Tag Team Titles MEWF Tag Team Titles",
    14: "ECW World Heavyweight Title WWA World Heavyweight Title",
    20: "WWE Championship",
    21: "WWE Championship WWE Championship",
    22: "Undisputed WWE Championship",
    23: "Interim ECW FTW Title",
    24: "Cruiserweight Classic Championship ECW FTW Title",
}


def test_belt_split_clean():
    m = split_belts(BELTS)
    assert m[12]["kind"] == "split"
    assert m[12]["components"] == [10, 11]
    assert m[12]["parts"] == ["ECW FTW Title", "ECW World Heavyweight Title"]
    # duplicated-name concat splits and dedupes to one component
    assert m[21]["kind"] == "split"
    assert m[21]["components"] == [20]


def test_belt_split_artifact_kept():
    m = split_belts(BELTS)
    # a standalone name prefixes it but the tail is not in the list -> artifact
    assert m[14]["kind"] == "artifact"
    assert m[14]["components"] == [14]
    # no standalone prefix/suffix at all -> ordinary title
    assert m[13]["kind"] == "title"
    # sentinel id 1 is excluded entirely
    assert 1 not in m
    # standalone titles stay standalone
    assert m[10]["kind"] == "title" and m[11]["kind"] == "title"


def test_belt_qualified_names_are_not_artifacts():
    m = split_belts(BELTS)
    # bare qualifier heads are genuine titles, not concat artifacts
    assert m[22]["kind"] == "title"  # 'Undisputed <known>'
    assert m[23]["kind"] == "title"  # 'Interim <known>'
    # a title-shaped head before a known suffix IS a suspected concat
    assert m[24]["kind"] == "artifact"


def test_bare_generational_suffix_is_never_a_person():
    r = Resolver([(1, "Rey Misterio"), (2, "Eddy Guerrero"), (3, "Eddy Guerrero & Jr. & Rey Misterio")])
    members, unknown, size = r.resolve(3)
    assert members == ("p:2", "p:1")
    assert unknown is True and size == 3
    assert not any("Jr" in p for p in r.derived_slug)
    # attached suffixes are untouched
    r2 = Resolver([(1, "Rey Misterio Jr."), (2, "Psicosis"), (3, "Psicosis & Rey Misterio Jr.")])
    assert r2.resolve(3) == (("p:2", "p:1"), False, 2)
