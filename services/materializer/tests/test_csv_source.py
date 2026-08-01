"""csv-source@1 grammar: dates, side units, name normalization, enrichment."""

from kayfabe_materializer.csv_source import (
    FAMILY_PROMOS,
    _meltzer,
    norm_name,
    parse_csv_date,
    parse_side,
)


def test_date_parse_and_approx_marker():
    assert parse_csv_date("Tue, Sep 17th 2024") == ("2024-09-17", 0)
    assert parse_csv_date("Wed, Jan 27th 2021") == ("2021-01-27", 0)
    assert parse_csv_date("Sat, Feb 1st 1997") == ("1997-02-01", 0)
    # literal '<U+2245>' prefix = approximate date, parsed but flagged
    assert parse_csv_date("<U+2245> Thu, Sep 10th 1998") == ("1998-09-10", 1)
    assert parse_csv_date("") is None
    assert parse_csv_date("10th") is None
    assert parse_csv_date("Tue, Sep 31st 2024") is None  # impossible day


def test_champion_marker_and_nbsp_stripped():
    assert norm_name("Cody Rhodes\xa0(c)") == "Cody Rhodes"
    assert norm_name("Iyo Sky (c)") == "Iyo Sky"
    # non-champion parentheticals are identity disambiguators — kept verbatim
    assert norm_name("Doink (Borne)") == "Doink (Borne)"
    assert norm_name("Blue Panther (II)") == "Blue Panther (II)"


def test_side_units_comma_and_ampersand():
    # ' & ' joins members within a unit, ', ' separates units
    assert parse_side("Lyra Valkyria & Tatum Paxley") == [["Lyra Valkyria", "Tatum Paxley"]]
    assert parse_side("Braun Strowman, Ilja Dragunov, Pete Dunne") == [
        ["Braun Strowman"], ["Ilja Dragunov"], ["Pete Dunne"]
    ]
    # three-way tag: two teams in a collapsed group
    assert parse_side("Karl Anderson & Luke Gallows, Angelo Dawkins & Montez Ford") == [
        ["Karl Anderson", "Luke Gallows"],
        ["Angelo Dawkins", "Montez Ford"],
    ]


def test_side_suffix_rejoin_never_creates_phantom_people():
    # 'Volador, Jr.' is one person, normalized to the sqlite convention
    assert parse_side("Volador, Jr.") == [["Volador Jr."]]
    assert parse_side("Volador, Jr. & Atlantis") == [["Volador Jr.", "Atlantis"]]
    # rejoin composes with unit grammar and champion markers
    assert parse_side("Rayo De Jalisco, Jr.\xa0(c), Dory Funk, Jr.") == [
        ["Rayo De Jalisco Jr."],
        ["Dory Funk Jr."],
    ]


def test_meltzer_parse_bounds():
    assert _meltzer("3.5") == 3.5
    assert _meltzer("4") == 4.0
    assert _meltzer("-1") == -1.0
    assert _meltzer("NA") is None
    assert _meltzer("") is None
    assert _meltzer("****") is None
    assert _meltzer("99") is None  # out of plausible range


def test_family_promos_match_sqlite_ids():
    assert FAMILY_PROMOS == {
        "ECW": 1, "NXT": 692, "WCW": 2715, "WWE": 4140, "WWWF": 11561, "WWF": 11791,
    }
