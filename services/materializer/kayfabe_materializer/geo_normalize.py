"""geo-normalize@1 — deterministic place-name normalization and parsing.

Turns raw source location strings into comparable match keys, and splits the
sqlite "City, Region" form into fields. Everything here is pure: same input,
same output, no I/O, no network, no clock.

Config lives in `config/geo/*.csv`. The spec sketches YAML; this project's
materializer is stdlib-only by contract (docs/ARCHITECTURE.md) and the stdlib
has no YAML reader, so the same content is carried as CSV. Documented in
docs/GEO-ALGORITHMS.md.
"""

from __future__ import annotations

import csv
import re
import unicodedata
from pathlib import Path

CONFIG = Path(__file__).resolve().parents[3] / "config" / "geo"

# Abbreviations that appear in one source and are spelled out in the other, or
# in the gazetteer. Applied on the folded token stream so "St. Louis",
# "St Louis" and "Saint Louis" all collapse to the same key.
_ABBREV = {
    "st": "saint",
    "ste": "sainte",
    "mt": "mount",
    "ft": "fort",
    "pt": "port",
}

_PUNCT = re.compile(r"[^\w\s-]", flags=re.UNICODE)
_WS = re.compile(r"[\s_-]+")


def strip_accents(s: str) -> str:
    """NFKD fold, then drop combining marks. 'México' -> 'Mexico'."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def fold(s: str) -> str:
    """The match key. Accent-folded, lowercased, punctuation-stripped,
    whitespace-collapsed, with common abbreviations expanded."""
    s = strip_accents(s).lower()
    s = _PUNCT.sub(" ", s)
    tokens = [t for t in _WS.split(s) if t]
    return " ".join(_ABBREV.get(t, t) for t in tokens)


def clean(s: str) -> str:
    """Display cleanup only: collapse whitespace, trim. Preserves accents and
    case, because the display name is what a reader sees."""
    return " ".join((s or "").split())


def parse_city_region(raw: str) -> tuple[str, str]:
    """Split the sqlite 'City, Region' form. Splits on the LAST comma so a
    city containing a comma keeps it. Returns ('', '') for empty input, and
    (raw, '') when there is no comma at all."""
    raw = clean(raw)
    if not raw:
        return "", ""
    if "," not in raw:
        return raw, ""
    city, _, region = raw.rpartition(",")
    return clean(city), clean(region)


# ---------------------------------------------------------------- config I/O


def _read_csv(name: str) -> list[dict]:
    """Read a config CSV. A missing file is empty config, not an error — a
    fresh clone must run before anyone has authored overrides."""
    path = CONFIG / name
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        first = (reader.fieldnames or [None])[0]
        return [
            {k: (v or "").strip() for k, v in row.items() if k}
            for row in reader
            # A '#' in the first column is a comment line. Checking a named
            # column instead silently admits every comment in files that do not
            # happen to use that column name.
            if row and not (row.get(first) or "").lstrip().startswith("#")
        ]


def load_region_aliases() -> dict[str, tuple[str, str]]:
    """folded region name -> (country_code, admin1_code).

    Seeds the gazetteer's own admin-1 table; this file only carries what the
    gazetteer gets wrong or spells differently ('England', 'Washington, DC')."""
    out: dict[str, tuple[str, str]] = {}
    for row in _read_csv("region-aliases.csv"):
        if row.get("alias") and row.get("country_code"):
            out[fold(row["alias"])] = (row["country_code"], row.get("admin1_code", ""))
    return out


def load_country_aliases() -> dict[str, str]:
    """folded country name -> ISO-3166 alpha-2."""
    return {
        fold(row["alias"]): row["country_code"]
        for row in _read_csv("country-aliases.csv")
        if row.get("alias") and row.get("country_code")
    }


def load_location_aliases() -> dict[str, str]:
    """folded raw city string -> corrected city string (typos, old names)."""
    return {
        fold(row["alias"]): row["city"]
        for row in _read_csv("location-aliases.csv")
        if row.get("alias") and row.get("city")
    }


def load_promotion_countries() -> dict[str, list[str]]:
    """promotion display name -> ordered candidate country codes.

    A PRIOR, never a verdict: promotions tour. It only constrains the
    candidate set when a bare city name is otherwise ambiguous, and a match
    found this way is at best 'probable'."""
    out: dict[str, list[str]] = {}
    for row in _read_csv("promotion-country.csv"):
        name, codes = row.get("promotion", ""), row.get("country_codes", "")
        if name and codes:
            out[fold(name)] = [c.strip().upper() for c in codes.split("|") if c.strip()]
    return out


def load_overrides() -> dict[str, dict]:
    """location_key -> reviewed verdict. Highest precedence in the ladder.

    csv keys separate venue from city with \\x1f, which is unwritable in a
    hand-edited file, so an override may spell that separator as a pipe:
    `csv:Unknown Arena|Charlestown`."""
    out: dict[str, dict] = {}
    for row in _read_csv("location-overrides.csv"):
        key = row.get("location_key")
        if not key:
            continue
        if key.startswith("csv:") and "|" in key:
            key = key.replace("|", "\x1f", 1)
        out[key] = row
    return out


def load_venue_places() -> dict[str, dict]:
    """folded venue name -> reviewed place fields. The venue is the strongest
    signal in the csv corpus: 'Korakuen Hall' is always Tokyo."""
    out: dict[str, dict] = {}
    for row in _read_csv("venue-places.csv"):
        venue = row.get("venue")
        if venue:
            out[fold(venue)] = row
    return out


# ------------------------------------------------------------- venue parsing

# Venue strings carry parenthetical rename histories:
#   "2300 Arena (AKA ECW Arena/Asylum Arena/New Alhambra Arena/Viking Arena)"
#   "WWE Performance Center (fka Capitol Wrestling Center)"
#   "Davis Arena (original)"
# The leading name is the resolution key; the parenthetical is an alias list.
_PAREN = re.compile(r"\s*\(([^)]*)\)\s*")
_ALIAS_LEAD = re.compile(r"^(?:aka|fka|a\.k\.a\.|f\.k\.a\.|formerly|now)\b[\s:]*", re.IGNORECASE)
# A hall number inside one complex: "Ishikawa Industrial Exhibition Hall #3",
# "Makuhari Messe No. 2". All halls of a complex are the same PLACE, so the
# number is dropped from the resolution key while the raw string is preserved.
_HALL_NO = re.compile(r"\s*(?:#|No\.?\s*)\d+\s*$", re.IGNORECASE)

# Venue placeholders that name no place at all.
VENUE_PLACEHOLDERS = {"unknown arena", "unknown", "na", "n a", "tbd", ""}


def parse_venue(raw: str) -> tuple[str, list[str]]:
    """('2300 Arena (AKA ECW Arena/Asylum Arena)') -> ('2300 Arena',
    ['ECW Arena', 'Asylum Arena']). Aliases are split on '/'."""
    raw = clean(raw)
    if not raw:
        return "", []
    aliases: list[str] = []
    for inner in _PAREN.findall(raw):
        inner = _ALIAS_LEAD.sub("", clean(inner))
        for part in inner.split("/"):
            part = clean(part)
            if part and part.lower() not in {"original", "old", "new"}:
                aliases.append(part)
    return clean(_HALL_NO.sub("", clean(_PAREN.sub(" ", raw)))), aliases


def is_venue_placeholder(venue: str) -> bool:
    """True when the venue string names no place ('Unknown Arena')."""
    return fold(venue) in VENUE_PLACEHOLDERS
