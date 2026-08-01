"""csv-source@1 — staging reader for the InitialWrestingMatchesFinal CSV corpus.

Source characteristics (measured, see docs/DATABASE-AUDIT.md):
  * cp1252 encoding (NOT utf-8; 'Finn Bálor' breaks a utf-8 read at byte 6370)
  * 363,728 rows, 571 promotions, 1947-2024
  * Date format 'Tue, Sep 17th 2024'; a literal '<U+2245> ' prefix marks an
    approximate date (10 rows)
  * side grammar: ', ' separates competitive UNITS (teams or individuals in a
    multi-way), ' & ' separates members WITHIN a unit — richer than the source
    sqlite, which collapses multi-way groups into one '&'-joined blob
  * champions carry a trailing '\\xa0(c)' marker -> stripped from names
  * lucha names are written 'Volador, Jr.' -> rejoined to 'Volador Jr.'
    (the sqlite corpus convention; zero sqlite names contain ', ')
  * enrichment columns: Match.Card.Placement, Meltzer.Rating, Championship,
    Venue, City, PPV, Total.Seconds

Everything here is deterministic and stdlib-only. The reader never writes.
"""

from __future__ import annotations

import csv
import os
import re
from pathlib import Path

from .normalize import iso_to_day

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CSV = REPO_ROOT / "data" / "private" / "incoming-csv" / "InitialWrestingMatchesFinal.csv"

CSV_SOURCE_ID = "csv_initial_matches"
CSV_ENCODING = "cp1252"

# CSV promotion name -> sqlite promotion id, for the six family promotions
# whose territory the sqlite corpus covers canonically.
FAMILY_PROMOS = {
    "ECW": 1,
    "NXT": 692,
    "WCW": 2715,
    "WWE": 4140,
    "WWWF": 11561,
    "WWF": 11791,
}

_MONTHS = {m: i + 1 for i, m in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
)}
_DATE = re.compile(
    r"^(?P<apx><U\+2245> )?[A-Z][a-z]{2}, (?P<mon>[A-Z][a-z]{2}) (?P<day>\d{1,2})[a-z]{2} (?P<year>\d{4})$"
)
_CHAMP_MARK = re.compile(r"\s*\((?:c|C)\)\s*$")
_BARE_SUFFIX = re.compile(r"(?i)^(?:jr\.?|sr\.?|ii|iii|iv)$")
_DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def csv_source_path() -> Path:
    p = os.environ.get("CSV_MATCHES_PATH")
    return Path(p) if p else DEFAULT_CSV


def parse_csv_date(raw: str) -> tuple[str, int] | None:
    """'Tue, Sep 17th 2024' -> ('2024-09-17', approx_flag) or None."""
    m = _DATE.match((raw or "").strip())
    if not m:
        return None
    mon = _MONTHS.get(m.group("mon"))
    day = int(m.group("day"))
    year = int(m.group("year"))
    if mon is None or not (1 <= day <= _DAYS_IN_MONTH[mon - 1]) or not (1850 <= year <= 2030):
        return None
    return f"{year:04d}-{mon:02d}-{day:02d}", 1 if m.group("apx") else 0


def norm_name(part: str) -> str:
    """Normalize one member name: nbsp -> space, strip '(c)' champion marker."""
    p = part.replace("\xa0", " ").strip()
    p = _CHAMP_MARK.sub("", p)
    return p.strip()


def parse_side(raw: str) -> list[list[str]]:
    """Side string -> list of units, each a list of member names.

    ', ' separates units; ' & ' separates members within a unit. A comma chunk
    whose first member is a bare generational suffix is a name artifact
    ('Volador, Jr.') and is rejoined to the previous chunk as 'Volador Jr.'.
    """
    chunks: list[str] = []
    for chunk in (raw or "").split(", "):
        first = chunk.split(" & ", 1)[0]
        if chunks and _BARE_SUFFIX.match(norm_name(first)):
            chunks[-1] = f"{chunks[-1]} {chunk}"
        else:
            chunks.append(chunk)
    units: list[list[str]] = []
    for chunk in chunks:
        members = [n for n in (norm_name(p) for p in chunk.split(" & ")) if n != ""]
        if members:
            units.append(members)
    return units


def _int_or_none(raw: str | None) -> int | None:
    s = (raw or "").strip()
    return int(s) if s.isdigit() else None


def _meltzer(raw: str | None) -> float | None:
    s = (raw or "").strip()
    if s in ("", "NA"):
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if -1.0 <= v <= 8.0 else None


def load_csv_rows(path: Path | None = None) -> dict:
    """Parse + stage the CSV corpus. Returns {"rows": [...], "quality": {...}}.

    Each kept row dict:
      idx        row number in the file (0-based, deterministic tiebreaker)
      date/day   ISO date + day encoding;  apx = approximate-date flag
      promo      raw promotion name;  family = sqlite promotion id or None
      event, venue, city, placement, ppv, meltzer, championship, stip, dur
      res        raw Result string ('def. (pin)', 'draw (NC)', …)
      units_w / units_l   side grammar: units of member names
    Quarantined (never guessed): unparseable dates, empty sides, exact
    duplicate rows (first occurrence kept).
    """
    path = path or csv_source_path()
    rows: list[dict] = []
    seen: set[tuple] = set()
    q = {
        "encoding": CSV_ENCODING,
        "rows_total": 0,
        "kept": 0,
        "bad_date_rows": 0,
        "empty_side_rows": 0,
        "duplicate_rows_dropped": 0,
        "approx_date_rows": 0,
        "bad_date_samples": [],
        "empty_side_samples": [],
    }
    with open(path, newline="", encoding=CSV_ENCODING) as f:
        reader = csv.DictReader(f)
        for idx, row in enumerate(reader):
            q["rows_total"] += 1
            parsed = parse_csv_date(row.get("Date") or "")
            if parsed is None:
                q["bad_date_rows"] += 1
                if len(q["bad_date_samples"]) < 8:
                    q["bad_date_samples"].append(
                        {"idx": idx, "date": row.get("Date"), "event": row.get("Event")}
                    )
                continue
            iso, apx = parsed
            units_w = parse_side(row.get("Winner") or "")
            units_l = parse_side(row.get("Loser") or "")
            if not units_w or not units_l:
                q["empty_side_rows"] += 1
                if len(q["empty_side_samples"]) < 8:
                    q["empty_side_samples"].append(
                        {"idx": idx, "event": row.get("Event"), "d": iso}
                    )
                continue
            promo = (row.get("Promotion") or "").strip()
            event = (row.get("Event") or "").strip()
            placement = _int_or_none(row.get("Match.Card.Placement"))
            key = (
                iso,
                promo,
                event,
                placement,
                (row.get("Winner") or "").strip(),
                (row.get("Loser") or "").strip(),
                (row.get("Result") or "").strip(),
            )
            if key in seen:
                q["duplicate_rows_dropped"] += 1
                continue
            seen.add(key)
            if apx:
                q["approx_date_rows"] += 1
            champ = (row.get("Championship") or "").strip()
            stip = (row.get("Match.Type") or "").strip()
            if stip == "NA":
                stip = ""
            rows.append(
                {
                    "idx": idx,
                    "date": iso,
                    "day": iso_to_day(iso),
                    "apx": apx,
                    "promo": promo,
                    "family": FAMILY_PROMOS.get(promo),
                    "event": event,
                    "venue": (row.get("Venue") or "").strip(),
                    "city": (row.get("City") or "").strip(),
                    "placement": placement,
                    "ppv": 1 if (row.get("PPV") or "").strip().lower() == "yes" else 0,
                    "meltzer": _meltzer(row.get("Meltzer.Rating")),
                    "championship": champ if champ not in ("", "NA") else None,
                    "stip": stip,
                    "res": (row.get("Result") or "").strip(),
                    "dur": _int_or_none(row.get("Total.Seconds")),
                    "units_w": units_w,
                    "units_l": units_l,
                }
            )
            q["kept"] += 1
    return {"rows": rows, "quality": q}
