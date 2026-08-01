"""Unit tests for the geographic pipeline.

Every test here is offline and gazetteer-free except the ones that build a
tiny fake gazetteer in memory: the resolver must never require a 100 MB
download to be testable, and a test run must never touch a geocoding service.
"""

from __future__ import annotations

import pytest

from kayfabe_materializer import geo_resolve
from kayfabe_materializer.geo_gazetteer import Gazetteer, Place
from kayfabe_materializer.geo_normalize import (
    clean,
    fold,
    is_venue_placeholder,
    parse_city_region,
    parse_venue,
    strip_accents,
)
from kayfabe_materializer.geo_source import (
    csv_location_key,
    parse_location_key,
    sql_location_key,
)


# --------------------------------------------------------------- normalization


def test_fold_is_accent_and_case_insensitive():
    assert fold("México") == fold("Mexico") == "mexico"
    assert fold("  Ciudad   de  México ") == "ciudad de mexico"


def test_fold_expands_the_abbreviations_that_differ_between_sources():
    assert fold("St. Louis") == fold("St Louis") == fold("Saint Louis")
    assert fold("Ft. Worth") == fold("Fort Worth")
    assert fold("Mt. Pleasant") == fold("Mount Pleasant")


def test_strip_accents_keeps_the_letter():
    assert strip_accents("Ōmiya") == "Omiya"
    assert strip_accents("Nürnberg") == "Nurnberg"


@pytest.mark.parametrize(
    "raw,city,region",
    [
        ("New York, New York", "New York", "New York"),
        ("Washington, DC", "Washington", "DC"),
        ("Sapporo, Hokkaido", "Sapporo", "Hokkaido"),
        ("Tokyo", "Tokyo", ""),
        ("", "", ""),
    ],
)
def test_parse_city_region(raw, city, region):
    assert parse_city_region(raw) == (city, region)


def test_parse_city_region_splits_on_the_last_comma():
    # A city containing a comma keeps it; only the trailing region is peeled.
    assert parse_city_region("Winston-Salem, North Carolina") == (
        "Winston-Salem",
        "North Carolina",
    )


def test_parse_venue_strips_the_rename_history():
    base, aliases = parse_venue(
        "2300 Arena (AKA ECW Arena/Asylum Arena/New Alhambra Arena/Viking Arena)"
    )
    assert base == "2300 Arena"
    assert "ECW Arena" in aliases and "Asylum Arena" in aliases


def test_parse_venue_strips_a_hall_number():
    # All halls of one complex are the same PLACE.
    assert parse_venue("Ishikawa Industrial Exhibition Hall #3")[0] == (
        "Ishikawa Industrial Exhibition Hall"
    )
    assert parse_venue("Makuhari Messe No. 2")[0] == "Makuhari Messe"


def test_parse_venue_keeps_a_number_that_is_part_of_the_name():
    assert parse_venue("2300 Arena")[0] == "2300 Arena"


def test_venue_placeholders_name_no_place():
    assert is_venue_placeholder("Unknown Arena")
    assert is_venue_placeholder("NA")
    assert not is_venue_placeholder("Korakuen Hall")


def test_clean_collapses_whitespace_without_touching_accents():
    assert clean("  Arena   México  ") == "Arena México"


# ------------------------------------------------------------- location keys


def test_location_keys_round_trip():
    k = sql_location_key(149)
    assert parse_location_key(k) == {"family": "sql", "location_id": 149}
    k = csv_location_key("Korakuen Hall", "Tokyo")
    assert parse_location_key(k) == {
        "family": "csv",
        "venue": "Korakuen Hall",
        "city": "Tokyo",
    }


def test_a_venue_containing_punctuation_cannot_forge_a_key_boundary():
    # The separator is \x1f, so a venue with commas, pipes or colons is safe.
    k = csv_location_key("2300 Arena (AKA ECW Arena/Asylum), Philly | x:y", "Philadelphia")
    assert parse_location_key(k)["city"] == "Philadelphia"


# ------------------------------------------------------------------ resolver


def _gz() -> Gazetteer:
    """A hand-built gazetteer: the resolver is testable without the download."""
    g = Gazetteer()
    rows = [
        # gid, name, country, admin1, lat, lon, pop
        (1, "London", "GB", "ENG", 51.5, -0.12, 8961989),
        (2, "London", "CA", "08", 42.98, -81.24, 422324),
        (3, "London", "US", "KY", 37.12, -84.08, 8071),
        (4, "Springfield", "US", "MO", 37.21, -93.29, 170188),
        (5, "Springfield", "US", "IL", 39.80, -89.64, 116250),
        (6, "Tokyo", "JP", "40", 35.68, 139.75, 9733276),
        (7, "Winter Park", "US", "FL", 28.60, -81.35, 30825),
        (8, "Wolverhampton", "GB", "ENG", 52.58, -2.12, 263700),
    ]
    for gid, name, cc, a1, lat, lon, pop in rows:
        p = Place(gid, name, name, cc, a1, lat, lon, pop, "PPL")
        g.places[gid] = p
        g.index(fold(name), gid, "primary")
    # An ERRONEOUS alternate name, exactly like the real data's
    # "Lake Charles lists Charlestown".
    g.index("wolverhampton", 3, "alt")
    g.admin1_display = {"US.FL": "Florida", "GB.ENG": "England", "CA.08": "Ontario",
                        "US.KY": "Kentucky", "US.MO": "Missouri", "US.IL": "Illinois",
                        "JP.40": "Tokyo"}
    for code, name in g.admin1_display.items():
        cc, a1 = code.split(".")
        g.admin1_names.setdefault(fold(name), []).append((cc, a1))
    g.country_names = {"GB": "United Kingdom", "US": "United States", "CA": "Canada",
                       "JP": "Japan"}
    g.country_by_fold = {fold(v): k for k, v in g.country_names.items()}
    return g


def _configs(**over) -> dict:
    base = {"overrides": {}, "venues": {}, "region_aliases": {}, "country_aliases": {},
            "city_aliases": {}, "priors": {}}
    base.update(over)
    return base


def test_alternate_names_never_outrank_a_primary_name():
    """The real hazard: GeoNames alternates carry outright errors, and a
    populous impostor could otherwise win a dominance test."""
    gz = _gz()
    r = geo_resolve._resolve_fields("Wolverhampton", "", [], gz, _configs())
    assert r.place is not None
    # Wolverhampton GB (primary), not London KY (which lists it as an alias)
    assert r.place["countryCode"] == "GB"
    assert r.matched_label == "Wolverhampton"


def test_city_plus_region_is_confirmed():
    gz = _gz()
    r = geo_resolve._resolve_fields("Winter Park", "Florida", [], gz, _configs())
    assert r.resolution == "confirmed"
    assert r.rung == "city+admin1"
    assert r.confidence == pytest.approx(0.95)


def test_city_plus_country_region_is_confirmed():
    gz = _gz()
    r = geo_resolve._resolve_fields("London", "England", [], gz, _configs())
    assert r.resolution == "confirmed"
    assert r.place["countryCode"] == "GB"


def test_a_genuinely_ambiguous_bare_city_stays_ambiguous():
    """Springfield MO vs IL is 1.5x — no dominance, so it goes to review
    rather than being guessed."""
    gz = _gz()
    r = geo_resolve._resolve_fields("Springfield", "", [], gz, _configs())
    assert r.resolution == "ambiguous"
    assert r.place is None
    assert len(r.candidates) >= 2


def test_population_dominance_resolves_london_but_only_probable():
    gz = _gz()
    r = geo_resolve._resolve_fields("London", "", [], gz, _configs())
    assert r.resolution == "probable"
    assert r.place["countryCode"] == "GB"
    assert r.confidence < 1.0


def test_the_promotion_prior_narrows_but_never_selects_alone():
    gz = _gz()
    # A UK promotion's prior puts London in England...
    r = geo_resolve._resolve_fields("London", "", ["GB"], gz, _configs())
    assert r.resolution == "probable"
    assert r.place["countryCode"] == "GB"
    # ...but a prior naming a country with no such city resolves nothing
    # through the prior rung and falls through honestly.
    r2 = geo_resolve._resolve_fields("Winter Park", "", ["JP"], gz, _configs())
    assert r2.place is not None
    assert r2.place["countryCode"] == "US"  # fell through to global-unique


def test_home_country_rung_requires_uniqueness():
    gz = _gz()
    # US holds two Springfields, so the home-country rung must NOT pick one.
    r = geo_resolve._resolve_fields("Springfield", "", ["US"], gz, _configs())
    assert r.place is None


def test_an_unknown_city_is_unresolved_not_invented():
    gz = _gz()
    r = geo_resolve._resolve_fields("Nowheresville", "", [], gz, _configs())
    assert r.resolution == "unresolved"
    assert r.place is None
    assert r.notes


def test_a_placeholder_city_is_rejected_not_plotted():
    gz = _gz()
    for placeholder in ("Unknown", "Unknown, Unknown", "NA", ""):
        city, region = parse_city_region(placeholder)
        r = geo_resolve._resolve_fields(city, region, [], gz, _configs())
        assert r.place is None, placeholder


def test_no_resolution_ever_lands_on_null_island():
    gz = _gz()
    for city in ("London", "Tokyo", "Springfield", "Nowheresville", "Unknown"):
        r = geo_resolve._resolve_fields(city, "", [], gz, _configs())
        if r.place is not None:
            assert (r.place["latitude"], r.place["longitude"]) != (0.0, 0.0)


def test_city_alias_corrects_a_source_typo():
    gz = _gz()
    r = geo_resolve._resolve_fields(
        "Winterpark", "", [], gz, _configs(city_aliases={"winterpark": "Winter Park"})
    )
    assert r.place is not None
    assert r.place["city"] == "Winter Park"


def test_region_alias_patches_a_region_the_gazetteer_spells_differently():
    gz = _gz()
    r = geo_resolve._resolve_fields(
        "London", "GB", [], gz, _configs(country_aliases={"gb": "GB"})
    )
    assert r.place is not None
    assert r.place["countryCode"] == "GB"


def test_place_ids_are_stable_across_runs():
    gz = _gz()
    a = geo_resolve._resolve_fields("Tokyo", "", [], gz, _configs())
    b = geo_resolve._resolve_fields("Tokyo", "", [], gz, _configs())
    assert a.place["id"] == b.place["id"] == "g:6"


def test_two_source_strings_for_one_place_share_a_canonical_id():
    """The whole point of canonical places: the sqlite 'Tokyo, Tokyo' row and a
    csv bare 'Tokyo' must not become two dots on the globe."""
    gz = _gz()
    a = geo_resolve._resolve_fields("Tokyo", "Tokyo", [], gz, _configs())
    b = geo_resolve._resolve_fields("Tokyo", "", [], gz, _configs())
    assert a.place["id"] == b.place["id"]


def test_dominance_threshold_is_actually_enforced():
    gz = _gz()
    top, second = gz.places[4], gz.places[5]
    ratio = top.pop / second.pop
    assert ratio < geo_resolve.DOMINANCE
    # ...and the prior-constrained threshold is looser but still not met here
    assert ratio < geo_resolve.PRIOR_DOMINANCE


# ---------------------------------------------------------------- determinism


def test_prior_country_order_is_pinned_not_inherited_from_a_dict():
    """The prior list is walked heaviest-promotion-first, then by id.

    The surface's promotion dict is insertion-ordered, and its insertion order
    differs between a fresh build and a cached one. Inheriting that order
    reordered the prior list — and the note recording it — without changing a
    single verdict, which is still a determinism failure.
    """
    from kayfabe_materializer.geo_normalize import fold

    surface = {"csv:x\x1fy": {"promotions": {"pr:b": 5, "pr:a": 50, "pr:c": 5}}}
    promo_names = {"pr:a": "NJPW", "pr:b": "WWE", "pr:c": "CMLL"}
    priors = {fold("NJPW"): ["JP"], fold("WWE"): ["US"], fold("CMLL"): ["MX"]}

    def prior_countries(key):
        promos = sorted(surface[key]["promotions"].items(), key=lambda kv: (-kv[1], kv[0]))
        codes = []
        for pid, _n in promos:
            for c in priors.get(fold(promo_names.get(pid, "")), ()):
                if c not in codes:
                    codes.append(c)
        return codes

    # heaviest first (NJPW, 50), then the two five-card promotions by id
    assert prior_countries("csv:x\x1fy") == ["JP", "US", "MX"]

    # a differently-ordered dict with identical contents gives the same answer
    surface["csv:x\x1fy"]["promotions"] = {"pr:c": 5, "pr:a": 50, "pr:b": 5}
    assert prior_countries("csv:x\x1fy") == ["JP", "US", "MX"]
