"""geo-resolve@1 — deterministic, offline resolution of source locations to
canonical places.

The spec's ladder assumes every record has city + region + country. Two thirds
of this corpus does not: csv cards carry a BARE city ("Ontario", "Florence",
"Charleston", "London") plus a venue. So the ladder here adds a venue rung and
a promotion-country prior above the spec's city+region steps. The deviation is
documented in docs/GEO-ALGORITHMS.md.

Ladder, highest precedence first:

  R0  manual override            config/geo/location-overrides.csv    confirmed
  R1  reviewed venue registry    config/geo/venue-places.csv          confirmed
  R2  city + region -> admin1    gazetteer, unique in that admin1     confirmed
  R3  city + region -> country   gazetteer, unique in that country    confirmed
  R4  cross-family city          a city already CONFIRMED via R2/R3   probable
  R5  promotion-country prior    unique inside the prior country set  probable
  R5a home country only         unique inside the promotion home country  probable
  R6  globally unique name       exactly one entry on Earth           probable
  R7  population dominance       top >= 8x runner-up                  probable
  --  otherwise                  ambiguous (candidates recorded) or unresolved

Ambiguous and unresolved both end with NULL coordinates. They are counted,
reported, and offered for review — never plotted, never snapped to 0,0, and
never dropped from the analytical totals.

The prior CONSTRAINS candidates; it never selects one on its own. Promotions
tour, so a prior-derived match is 'probable' at best.

No network. No clock. Same inputs -> byte-identical output.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import geo_gazetteer
from .geo_normalize import (
    CONFIG,
    clean,
    fold,
    is_venue_placeholder,
    load_country_aliases,
    load_location_aliases,
    load_overrides,
    load_promotion_countries,
    load_region_aliases,
    load_venue_places,
    parse_city_region,
    parse_venue,
)
from .geo_source import STAGING, load_geo_source

RESOLVED = CONFIG / "resolved-places.json"
REVIEW_JSON = STAGING / "geo-review.json"
RESOLVE_VERSION = "geo-resolve@1"

# A candidate wins on population only when it dwarfs the runner-up. 8x is
# deliberately conservative: London GB beats London ON by 23x, but Springfield
# MO vs Springfield IL is 1.4x and correctly lands in review instead.
DOMINANCE = 8.0
# Inside a promotion's prior country set the wrong-country candidates are
# already gone, so the remaining contest is between same-country namesakes and
# population carries more signal. 3x still keeps Springfield MO vs Springfield
# IL (1.5x) in review while letting Newark NJ vs Newark OH (6x) resolve.
PRIOR_DOMINANCE = 3.0
# Below this, population is noise rather than signal (villages, hamlets).
DOMINANCE_MIN_POP = 20_000

CONFIDENCE = {
    "override": 1.0,
    "venue-registry": 0.97,
    "city+admin1": 0.95,
    "city+country": 0.90,
    "cross-family": 0.85,
    "promotion-prior": 0.80,
    "promotion-home-country": 0.72,
    "global-unique": 0.75,
    "population-dominance": 0.65,
}


def _display(place, gz) -> dict:
    """Canonical place fields for one gazetteer entry."""
    admin1_name = gz.admin1_display.get(f"{place.country}.{place.admin1}", "")
    country_name = gz.country_names.get(place.country, place.country)
    bits = [place.name] + [b for b in (admin1_name, country_name) if b]
    return {
        "id": place.place_id,
        "displayName": ", ".join(bits),
        "city": place.name,
        "admin1": admin1_name or None,
        "country": country_name,
        "countryCode": place.country,
        "latitude": round(place.lat, 5),
        "longitude": round(place.lon, 5),
        "precision": "city",
        "population": place.pop,
        "source": "geonames",
        "sourceRecord": str(place.gid),
    }


def _override_place(row: dict) -> dict | None:
    """A manual override may name a gazetteer id OR carry its own coordinate
    (a venue whose town is below the gazetteer's population floor)."""
    lat, lon = row.get("latitude", ""), row.get("longitude", "")
    if not lat or not lon:
        return None
    city = clean(row.get("city", "")) or clean(row.get("display_name", ""))
    bits = [b for b in (city, clean(row.get("admin1", "")), clean(row.get("country", ""))) if b]
    slug = fold(row.get("place_id", "") or ", ".join(bits)).replace(" ", "-")
    return {
        "id": row.get("place_id") or f"x:{slug}",
        "displayName": clean(row.get("display_name", "")) or ", ".join(bits),
        "city": city or None,
        "admin1": clean(row.get("admin1", "")) or None,
        "country": clean(row.get("country", "")) or None,
        "countryCode": (row.get("country_code", "") or "").upper() or None,
        "latitude": round(float(lat), 5),
        "longitude": round(float(lon), 5),
        "precision": row.get("precision", "city") or "city",
        "population": 0,
        "source": "manual-override",
        "sourceRecord": row.get("note", "") or None,
    }


class Resolution:
    __slots__ = ("place", "resolution", "confidence", "rung", "matched_label", "notes", "candidates")

    def __init__(self, place=None, resolution="unresolved", rung="", matched_label=None,
                 notes=None, candidates=None):
        self.place = place
        self.resolution = resolution
        self.rung = rung
        self.confidence = CONFIDENCE.get(rung, 0.0)
        self.matched_label = matched_label
        self.notes = notes or []
        self.candidates = candidates or []


def _pick(cands: list, gz, dominance: float = DOMINANCE) -> tuple[object | None, str, list]:
    """Apply uniqueness then dominance to a candidate list."""
    if not cands:
        return None, "", []
    if len(cands) == 1:
        return cands[0], "unique", []
    top, second = cands[0], cands[1]
    if top.pop >= DOMINANCE_MIN_POP and second.pop * dominance <= top.pop:
        return top, "dominance", cands[1:6]
    return None, "", cands[:6]


# City strings that name no place. Kept separate from the venue placeholder
# list because a card CAN legitimately have an unknown venue in a known city.
CITY_PLACEHOLDERS = {"", "unknown", "unknown unknown", "na", "n a", "tbd", "none"}


def _is_city_placeholder(city: str) -> bool:
    return fold(city) in CITY_PLACEHOLDERS


def _region_targets(region_key: str, gz, region_aliases: dict) -> list[tuple[str, str]]:
    """Every (country, admin1) a region name could denote. Region names repeat
    across countries — 'Florida' is a US state AND a Uruguayan department — so
    all readings are kept and the city lookup decides between them."""
    targets = list(gz.admin1_names.get(region_key, ()))
    alias = region_aliases.get(region_key)
    if alias:
        targets.insert(0, alias)
    return targets


def _resolve_fields(city_raw: str, region_raw: str, prior: list[str], gz, configs) -> Resolution:
    """Rungs R2, R3 then the R5–R7 fallback, over parsed city/region fields."""
    if _is_city_placeholder(city_raw):
        return Resolution(None, "rejected", "",
                          notes=["the source names no city (placeholder string)"])
    city_key = fold(configs["city_aliases"].get(fold(city_raw), city_raw))
    if not city_key:
        return Resolution(notes=["no city name in the source record"])
    tiers = gz.candidate_tiers(city_key)
    region_key = fold(region_raw)

    region_ambiguous: list = []
    if region_key:
        targets = _region_targets(region_key, gz, configs["region_aliases"])
        ccode = configs["country_aliases"].get(region_key) or gz.country_by_fold.get(region_key)
        countries = {c for c, _a in targets} | ({ccode} if ccode else set())
        for tier, cands in tiers:
            # R2 — the region names an admin-1 and the city sits inside it.
            in_admin1 = [
                p for p in cands
                if any(p.country == c and (not a or p.admin1 == a) for c, a in targets)
            ]
            pick, how, rest = _pick(in_admin1, gz)
            if pick is not None:
                return _hit(pick, gz, "confirmed", "city+admin1", how, tier, [])
            # R3 — the region names a country instead ("Birmingham, England").
            in_country = [p for p in cands if p.country in countries]
            pick, how, rest2 = _pick(in_country, gz)
            if pick is not None:
                return _hit(pick, gz, "confirmed", "city+country", how, tier, [])
            region_ambiguous = region_ambiguous or rest or rest2
        if region_ambiguous:
            # The region IS understood; the city inside it is what is ambiguous.
            return Resolution(None, "ambiguous", "",
                              notes=[f"several places named {city_raw!r} inside {region_raw!r}"],
                              candidates=[_brief(p, gz) for p in region_ambiguous])
    return _fallback(city_raw, city_key, tiers, prior, gz)


# Confidence penalty per lookup tier, and whether a 'confirmed' verdict
# survives it. A primary name in the major-cities file is the clean case.
TIER_PENALTY = {"primary": 0.0, "local": 0.05, "alt": 0.15}
TIER_NOTE = {
    "local": "matched a small place from the per-country gazetteer, not the "
             "major-cities file",
    "alt": "matched a GeoNames alternate name, not a primary name",
}


def _hit(place, gz, resolution: str, rung: str, how: str, tier: str, notes: list) -> Resolution:
    notes = list(notes)
    if how == "dominance":
        notes.append("chosen by population dominance over the other candidates")
    if TIER_NOTE.get(tier):
        notes.append(TIER_NOTE[tier])
    r = Resolution(_display(place, gz), resolution, rung, matched_label=place.name, notes=notes)
    penalty = TIER_PENALTY.get(tier, 0.0)
    if penalty:
        r.confidence = round(r.confidence - penalty, 3)
    if tier == "alt" and r.resolution == "confirmed":
        # Alternate names are community-maintained and demonstrably carry
        # errors, so a match through one never claims a confirmed verdict.
        r.resolution = "probable"
    return r


def resolve_all(geo: dict, gz, configs: dict) -> dict[str, Resolution]:
    overrides = configs["overrides"]
    venues = configs["venues"]
    region_aliases = configs["region_aliases"]
    country_aliases = configs["country_aliases"]
    city_aliases = configs["city_aliases"]
    priors = configs["priors"]
    promo_names = geo["promotion_names"]

    out: dict[str, Resolution] = {}
    # fold(city) -> place ids confirmed through an explicit region. Feeds R4.
    confirmed_cities: dict[str, set] = {}

    surface = geo["surface"]
    sql_keys = sorted(k for k in surface if k.startswith("sql:"))
    csv_keys = sorted(k for k in surface if k.startswith("csv:"))

    def apply_override(key: str) -> Resolution | None:
        row = overrides.get(key)
        if row is None:
            return None
        verdict = (row.get("resolution") or "").strip().lower()
        if verdict == "rejected":
            return Resolution(None, "rejected", "override", notes=[row.get("note", "")])
        gid = (row.get("geonames_id") or "").strip()
        if gid and gid.isdigit() and int(gid) in gz.places:
            return Resolution(_display(gz.places[int(gid)], gz), "confirmed", "override",
                              matched_label=gz.places[int(gid)].name)
        manual = _override_place(row)
        if manual is not None:
            return Resolution(manual, "confirmed", "override", matched_label=manual["displayName"])
        return Resolution(None, "unresolved", "override",
                          notes=["override row carries neither geonames_id nor coordinates"])

    def prior_countries(key: str) -> list[str]:
        codes: list[str] = []
        for pid in surface[key]["promotions"]:
            for c in priors.get(fold(promo_names.get(pid, "")), ()):
                if c not in codes:
                    codes.append(c)
        return codes

    # ---------------------------------------------------------- pass 1: sql
    for key in sql_keys:
        s = surface[key]
        r = apply_override(key)
        city_raw, region_raw = parse_city_region(s["raw_name"])
        if r is None:
            r = _resolve_fields(city_raw, region_raw, prior_countries(key), gz, configs)
        out[key] = r
        # A city confirmed here had a REGION to disambiguate it. That verdict is
        # what the bare-city csv side borrows on rung R4.
        if r.resolution == "confirmed" and r.rung in ("city+admin1", "city+country", "override"):
            confirmed_cities.setdefault(fold(city_raw), set()).add(r.place["id"])

    # ---------------------------------------------------------- pass 2: csv
    place_by_id = {r.place["id"]: r.place for r in out.values() if r.place}
    for key in csv_keys:
        s = surface[key]
        r = apply_override(key)
        if r is None:
            venue, _aliases = parse_venue(s["raw_venue"])
            # The csv City column is usually bare, but a minority of rows carry
            # "City, State" in it. Parse rather than assume.
            city_raw, region_raw = parse_city_region(clean(s["raw_city"]))
            prior = prior_countries(key)
            # R1: reviewed venue registry — the strongest csv signal, because a
            # venue name is near-unique to a place ("Korakuen Hall" is Tokyo).
            vrow = venues.get(fold(venue)) if venue and not is_venue_placeholder(venue) else None
            if vrow is not None:
                gid = (vrow.get("geonames_id") or "").strip()
                if gid.isdigit() and int(gid) in gz.places:
                    place = _display(gz.places[int(gid)], gz)
                    if vrow.get("latitude") and vrow.get("longitude"):
                        place = dict(place, latitude=round(float(vrow["latitude"]), 5),
                                     longitude=round(float(vrow["longitude"]), 5),
                                     precision="venue")
                    r = Resolution(place, "confirmed", "venue-registry", matched_label=venue)
                else:
                    manual = _override_place(vrow)
                    if manual is not None:
                        r = Resolution(manual, "confirmed", "venue-registry", matched_label=venue)
            if r is None and not region_raw:
                # R4: this exact city name was already CONFIRMED from the sqlite
                # side, where a region disambiguated it. Exactly one confirmed
                # reading only — two means the name is genuinely ambiguous.
                known = confirmed_cities.get(fold(city_raw), set())
                if len(known) == 1:
                    place = place_by_id.get(next(iter(known)))
                    if place and (not prior or place.get("countryCode") in prior):
                        r = Resolution(place, "probable", "cross-family",
                                       matched_label=place.get("city"),
                                       notes=["city confirmed from the sqlite corpus, where a "
                                              "region name disambiguated the same name"])
            if r is None:
                r = _resolve_fields(city_raw, region_raw, prior, gz, configs)
        out[key] = r
    return out


def _fallback(city_raw: str, city_key: str, tiers: list, prior: list[str], gz) -> Resolution:
    """R5 promotion-country prior, R6 globally unique, R7 population dominance,
    applied within each gazetteer tier in turn."""
    if not tiers:
        return Resolution(notes=[f"no gazetteer entry named {city_raw!r}"])
    for tier, cands in tiers:
        if prior:
            in_prior = [p for p in cands if p.country in prior]
            pick, how, _rest = _pick(in_prior, gz, PRIOR_DOMINANCE)
            if pick is not None:
                return _hit(pick, gz, "probable", "promotion-prior", how, tier,
                            [f"candidates constrained to {'/'.join(prior)} by the promotions "
                             f"that ran this location; a prior narrows, it never selects"])
            # R5a — the promotion's HOME country (the first entry in its prior)
            # contains exactly one place with this name. Deliberately narrower
            # than the full prior and deliberately requires uniqueness: a UK
            # promotion's "Manchester" is Manchester, England, but a US
            # promotion's "London" stays ambiguous because the US holds several.
            home = [p for p in cands if p.country == prior[0]]
            if len(home) == 1:
                return _hit(home[0], gz, "probable", "promotion-home-country", "unique", tier,
                            [f"the only place named {city_raw!r} in {prior[0]}, the home "
                             f"country of the promotions that ran this location"])
        pick, how, rest = _pick(cands, gz)
        if pick is not None and how == "unique":
            return _hit(pick, gz, "probable", "global-unique", how, tier,
                        ["only one place in the gazetteer carries this name"])
        if pick is not None:
            r = _hit(pick, gz, "probable", "population-dominance", how, tier,
                     [f"population dominance over {len(rest)} other candidates"])
            r.candidates = [_brief(p, gz) for p in rest]
            return r
    tier, cands = tiers[0]
    return Resolution(None, "ambiguous", "",
                      notes=[f"{sum(len(c) for _t, c in tiers)} places named {city_raw!r}, "
                             f"none dominant"],
                      candidates=[_brief(p, gz) for p in cands[:6]])


def _brief(p, gz) -> dict:
    return {
        "geonames_id": p.gid,
        "name": p.name,
        "admin1": gz.admin1_display.get(f"{p.country}.{p.admin1}", ""),
        "country": gz.country_names.get(p.country, p.country),
        "countryCode": p.country,
        "population": p.pop,
        "latitude": round(p.lat, 5),
        "longitude": round(p.lon, 5),
    }


def run(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    geo = load_geo_source(use_cache="--fresh" not in argv)
    print(f"geo:resolve — {geo['totals']['locations']} locations, {geo['totals']['cards']} cards")
    gz = geo_gazetteer.load()
    print(f"  gazetteer {geo_gazetteer.GAZETTEER_VERSION}: {len(gz.places)} places, "
          f"{len(gz.by_fold)} name keys")
    configs = {
        "overrides": load_overrides(),
        "venues": load_venue_places(),
        "region_aliases": load_region_aliases(),
        "country_aliases": load_country_aliases(),
        "city_aliases": load_location_aliases(),
        "priors": load_promotion_countries(),
    }
    print(f"  config: {len(configs['overrides'])} overrides, {len(configs['venues'])} venues, "
          f"{len(configs['priors'])} promotion priors")

    res = resolve_all(geo, gz, configs)
    surface = geo["surface"]

    places: dict[str, dict] = {}
    keys: dict[str, dict] = {}
    for key in sorted(res):
        r = res[key]
        if r.place:
            places.setdefault(r.place["id"], r.place)
        keys[key] = {
            "place_id": r.place["id"] if r.place else None,
            "resolution": r.resolution,
            "confidence": round(r.confidence, 3),
            "rung": r.rung,
            "matchedLabel": r.matched_label,
            "reviewed": r.rung == "override" or r.rung == "venue-registry",
            "notes": [n for n in r.notes if n],
        }

    payload = {
        "version": RESOLVE_VERSION,
        "gazetteer": geo_gazetteer.GAZETTEER_VERSION,
        "dominance_factor": DOMINANCE,
        "dominance_min_population": DOMINANCE_MIN_POP,
        "places": places,
        "keys": keys,
    }
    CONFIG.mkdir(parents=True, exist_ok=True)
    RESOLVED.write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1), encoding="utf-8"
    )

    # ---- coverage, card-weighted (the number that actually matters) ----
    stats = _coverage(res, surface, geo["totals"])
    review = [
        {
            "location_key": k,
            "raw_name": surface[k]["raw_name"],
            "raw_venue": surface[k]["raw_venue"],
            "raw_city": surface[k]["raw_city"],
            "family": surface[k]["family"],
            "cards": surface[k]["cards"],
            "matches": surface[k]["matches"],
            "first_date": surface[k]["first_date"],
            "last_date": surface[k]["last_date"],
            "promotions": [
                {"name": geo["promotion_names"].get(p, p), "cards": n}
                for p, n in sorted(surface[k]["promotions"].items(), key=lambda kv: (-kv[1], kv[0]))[:5]
            ],
            "resolution": res[k].resolution,
            "rung": res[k].rung,
            "confidence": round(res[k].confidence, 3),
            "chosen": res[k].place,
            "notes": res[k].notes,
            "candidates": res[k].candidates,
        }
        for k in sorted(
            res,
            key=lambda k: (-surface[k]["cards"], k),
        )
        if res[k].resolution in ("ambiguous", "unresolved", "rejected")
        or res[k].confidence <= CONFIDENCE["population-dominance"]
    ]
    STAGING.mkdir(parents=True, exist_ok=True)
    REVIEW_JSON.write_text(
        json.dumps({"version": RESOLVE_VERSION, "coverage": stats, "queue": review},
                   ensure_ascii=False, sort_keys=True, indent=1),
        encoding="utf-8",
    )

    print(f"\n  canonical places: {len(places)}")
    print("  resolution by location row:")
    for k, v in sorted(stats["by_resolution"].items()):
        print(f"    {k:>11}: {v['locations']:>5} locations  {v['cards']:>6} cards  "
              f"{v['matches']:>7} matches")
    print("\n  COVERAGE")
    print(f"    location rows : {stats['row_coverage'] * 100:6.2f}%   target 95%")
    print(f"    cards         : {stats['card_coverage'] * 100:6.2f}%   target 98%")
    print(f"    matches       : {stats['match_coverage'] * 100:6.2f}%   target 98%")
    print(f"\n  review queue: {len(review)} locations "
          f"({sum(r['cards'] for r in review)} cards) -> {REVIEW_JSON}")
    print(f"  wrote {RESOLVED}")
    return 0


def _coverage(res: dict, surface: dict, totals: dict) -> dict:
    by_res: dict[str, dict] = {}
    plotted_cards = plotted_matches = plotted_rows = 0
    for key, r in res.items():
        s = surface[key]
        b = by_res.setdefault(r.resolution, {"locations": 0, "cards": 0, "matches": 0})
        b["locations"] += 1
        b["cards"] += s["cards"]
        b["matches"] += s["matches"]
        if r.place is not None:
            plotted_rows += 1
            plotted_cards += s["cards"]
            plotted_matches += s["matches"]
    return {
        "by_resolution": by_res,
        "resolved_rows": plotted_rows,
        "resolved_cards": plotted_cards,
        "resolved_matches": plotted_matches,
        "total_rows": totals["locations"],
        "total_cards": totals["cards"],
        "total_matches": totals["matches"],
        "row_coverage": round(plotted_rows / max(1, totals["locations"]), 4),
        "card_coverage": round(plotted_cards / max(1, totals["cards"]), 4),
        "match_coverage": round(plotted_matches / max(1, totals["matches"]), 4),
    }


if __name__ == "__main__":
    raise SystemExit(run())
