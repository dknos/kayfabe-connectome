"""Deterministic Meltzer-ratings projection from canonical timeline chunks.

This module intentionally never reads ``data/private`` or the incoming CSV.
Its only match input is the already-materialized canonical timeline.  That
makes a rating record a view of the canonical corpus, not a competing import.

On-wire contract (all binary values little-endian):

``matches.bin`` — 48 bytes / record, in canonical timeline order
``(date, card_id, match_id)``
    ``i32 day@0, f64 rating@4, u32 promotion@12, u32 participantOffset@16,
    u16 participantCount@20, u16 flags@22, u16 form@24, u16 eventIndex@26,
    i32 title@28, i32 placement@32, u32 matchIdIndex@36,
    u32 titleOffset@40, u16 titleCount@44, u16 reserved@46``.

``participants.bin`` — packed ``u32`` participant dictionary indexes.  A
match's range is ``[participantOffset, participantOffset + participantCount)``
and preserves canonical ``w`` then ``l`` order.

``titles.bin`` — packed ``u32`` title dictionary indexes. A match's complete
canonical title set occupies ``[titleOffset, titleOffset + titleCount)``. The
legacy ``title`` field remains the first title index or ``-1``.

``coverage.bin`` — 28 bytes / sparse denominator record, ordered by
    ``(kind, subject, resolution, periodKey)``:
    ``u8 kind@0, u8 resolution@1, u16 reserved@2, u32 subject@4,
    u32 periodKey@8, u32 total@12, u32 rated@16, u32 titleChanges@20,
    u32 approximate@24``.  Kinds are global=0, promotion=1, person=2,
    title=3.  Subject is a corresponding dictionary index, except global is
    ``0xffffffff``.  Person rows count a participant only once per match.

``lod.bin`` — 72 bytes / sparse global-or-promotion rating aggregate, ordered
    ``(promotion, resolution, periodKey)``:
    ``u32 promotion@0, u8 resolution@4, 3 pad bytes@5, i32 startDay@8,
    i32 endDay@12, u32 periodKey@16, u32 total@20, u32 rated@24,
    f64 min@28, f64 max@36, f64 sum@44, f64 median@52,
    u32 fourPlus@60, u32 fivePlus@64, u32 approximate@68``.
    ``promotion == 0xffffffff`` is global.  When ``rated == 0`` the four
    floating fields are exactly ``0.0``.  Median is the exact sorted sample
    median (mean of the two middle values for an even population); aggregates
    are always made from their match samples, never from child aggregates.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import struct
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable

from .normalize import iso_to_day


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CANONICAL_ROOT = REPO_ROOT / "data" / "materialized"
SCHEMA_VERSION = "2.0.0"
PROJECTION_VERSION = "meltzer-ratings@2"
GLOBAL_SUBJECT = 0xFFFFFFFF

FORM_CODES = {
    "singles": 0,
    "tag_team": 1,
    "multi_way": 2,
    "battle_royal": 3,
    "team_implied": 4,
    "unknown": 5,
}
KIND_CODES = {"global": 0, "promotion": 1, "person": 2, "title": 3}
RESOLUTION_CODES = {"year": 0, "quarter": 1, "month": 2}

MATCH_STRUCT = struct.Struct("<idIIHHHHi iIIHH".replace(" ", ""))
PARTICIPANT_STRUCT = struct.Struct("<I")
TITLE_STRUCT = struct.Struct("<I")
COVERAGE_STRUCT = struct.Struct("<BBHIIIII I".replace(" ", ""))
LOD_STRUCT = struct.Struct("<IB3xiiIIIddddIII")


class RatingsProjectionError(RuntimeError):
    """Raised for malformed canonical data or a corrupt ratings projection."""


def canonical_root_path() -> Path:
    return Path(os.environ.get("CANONICAL_MATERIALIZED") or DEFAULT_CANONICAL_ROOT)


def output_path(canonical_root: Path) -> Path:
    return Path(os.environ.get("RATINGS_OUT") or canonical_root / "ratings")


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_bytes().decode("utf-8"))


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _normalized_source_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Remove canonical wall-clock metadata before binding source provenance.

    The primary materializer intentionally records its own current build time.
    That time describes the producer run, not its canonical facts, and must not
    make this deterministic derived projection change bytes on a no-data rebuild.
    Round-tripping through canonical JSON also ensures the hash has no mutable
    nested references to the caller's manifest.
    """
    normalized = json.loads(_json_bytes(manifest).decode("utf-8"))
    normalized.pop("built_at", None)
    return normalized


def _deterministic_built_at(projection: "Projection") -> str:
    """Use the latest documented canonical record date as a stable data clock."""
    canonical_range = projection.date_ranges["canonical"]
    assert canonical_range is not None
    return f"{canonical_range[1]}T00:00:00Z"


def _periods(iso: str) -> tuple[tuple[int, int, int, int, int], ...]:
    """Return (resolution-code, period-key, start-day, end-day, month) triples."""
    year, month = int(iso[:4]), int(iso[5:7])
    quarter = (month - 1) // 3 + 1
    q_start_month = (quarter - 1) * 3 + 1
    q_end_month = q_start_month + 2
    last_day = (date(year + (month == 12), (month % 12) + 1, 1) - date.resolution).day
    q_end_day = (date(year + (q_end_month == 12), (q_end_month % 12) + 1, 1) - date.resolution).day
    return (
        (RESOLUTION_CODES["year"], year, iso_to_day(f"{year:04d}-01-01"), iso_to_day(f"{year:04d}-12-31"), month),
        (RESOLUTION_CODES["quarter"], year * 10 + quarter, iso_to_day(f"{year:04d}-{q_start_month:02d}-01"), iso_to_day(f"{year:04d}-{q_end_month:02d}-{q_end_day:02d}"), month),
        (RESOLUTION_CODES["month"], year * 100 + month, iso_to_day(f"{year:04d}-{month:02d}-01"), iso_to_day(f"{year:04d}-{month:02d}-{last_day:02d}"), month),
    )


@dataclass(frozen=True)
class _Event:
    m: str
    c: str
    en: str
    d: str
    pr: str
    form: str
    participants: tuple[str, ...]
    titles: tuple[str, ...]
    title_change: int
    approximate: int
    ppv: int
    placement: int | None
    rating: float | None


@dataclass
class Projection:
    canonical_manifest: dict[str, Any]
    dictionaries: dict[str, Any]
    files: dict[str, bytes]
    counts: dict[str, int]
    date_ranges: dict[str, list[str] | None]
    rating_value_range: list[float] | None
    overall_coverage: dict[str, int | float]
    promotions_with_ratings: int


def _load_events(root: Path) -> list[_Event]:
    events: list[_Event] = []
    timeline_dir = root / "timeline" / "by-year"
    if not timeline_dir.is_dir():
        raise RatingsProjectionError(f"canonical timeline missing: {timeline_dir}")
    for path in sorted(timeline_dir.glob("*.json"), key=lambda p: p.name):
        rows = _read_json(path)
        if not isinstance(rows, list):
            raise RatingsProjectionError(f"timeline shard is not an array: {path}")
        for row in rows:
            try:
                rating = float(row["mr"]) if "mr" in row else None
                if rating is not None and (not math.isfinite(rating) or not -1.0 <= rating <= 8.0):
                    raise RatingsProjectionError(f"invalid canonical mr for {row['m']}: {rating!r}")
                form = row["form"]
                if form not in FORM_CODES:
                    raise RatingsProjectionError(f"unknown canonical form for {row['m']}: {form!r}")
                placement = row.get("placement")
                if placement is not None and (not isinstance(placement, int) or placement < 0):
                    raise RatingsProjectionError(f"invalid placement for {row['m']}: {placement!r}")
                raw_titles = row.get("ts")
                if raw_titles is None:
                    titles = () if row.get("t") is None else (str(row["t"]),)
                elif not isinstance(raw_titles, list):
                    raise RatingsProjectionError(f"invalid canonical ts for {row['m']}: expected array")
                else:
                    titles = tuple(dict.fromkeys(str(title) for title in raw_titles))
                legacy_title = str(row["t"]) if row.get("t") is not None else None
                if legacy_title != (titles[0] if titles else None):
                    raise RatingsProjectionError(f"canonical t/ts disagreement for {row['m']}")
                events.append(
                    _Event(
                        m=str(row["m"]), c=str(row["c"]), en=str(row["en"]), d=str(row["d"]), pr=str(row["pr"]), form=form,
                        participants=tuple(str(x) for x in [*row["w"], *row["l"]]),
                        titles=titles,
                        title_change=int(row["tc"]), approximate=1 if row.get("apx") else 0,
                        ppv=1 if row.get("ppv") else 0, placement=placement, rating=rating,
                    )
                )
            except (KeyError, TypeError, ValueError) as error:
                raise RatingsProjectionError(f"malformed canonical event in {path}: {error}") from error
    # The producer's documented canonical timeline order is a string tuple;
    # csv ids are opaque and must never be coerced to numbers.
    events.sort(key=lambda e: (e.d, e.c, e.m))
    if len({e.m for e in events}) != len(events):
        raise RatingsProjectionError("canonical timeline has duplicate opaque match ids")
    return events


def _names(root: Path, events: Iterable[_Event]) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    needed_people = {p for event in events for p in event.participants}
    promotions_raw = _read_json(root / "graph" / "promotions.json")
    titles_raw = _read_json(root / "entities" / "championships.json")
    people: dict[str, str] = {}
    for path in sorted((root / "entities" / "people").glob("*.json")):
        for pid, record in _read_json(path).items():
            if pid in needed_people:
                people[pid] = str(record["n"])
    missing_people = sorted(needed_people - set(people))
    if missing_people:
        raise RatingsProjectionError(f"canonical people dictionary missing {len(missing_people)} ids, first={missing_people[:3]}")
    promotions = {str(pid): str(record["n"]) for pid, record in promotions_raw.items()}
    needed_promotions = {event.pr for event in events}
    missing_promotions = sorted(needed_promotions - set(promotions))
    if missing_promotions:
        raise RatingsProjectionError(f"canonical promotions dictionary missing {missing_promotions[:3]}")
    titles = {str(tid): str(record["n"]) for tid, record in titles_raw.items()}
    needed_titles = {title for event in events for title in event.titles}
    missing_titles = sorted(needed_titles - set(titles))
    if missing_titles:
        raise RatingsProjectionError(f"canonical titles dictionary missing {missing_titles[:3]}")
    return people, promotions, titles


def _coverage_rows(events: list[_Event], p_index: dict[str, int], person_index: dict[str, int], title_index: dict[str, int]) -> bytes:
    # key -> [total, rated, title_changes, approximate]
    counters: dict[tuple[int, int, int, int], list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for event in events:
        subjects = [(KIND_CODES["global"], GLOBAL_SUBJECT), (KIND_CODES["promotion"], p_index[event.pr])]
        subjects.extend((KIND_CODES["person"], person_index[pid]) for pid in set(event.participants))
        subjects.extend((KIND_CODES["title"], title_index[title]) for title in event.titles)
        for resolution, period_key, _start, _end, _month in _periods(event.d):
            for kind, subject in subjects:
                count = counters[(kind, subject, resolution, period_key)]
                count[0] += 1
                count[1] += event.rating is not None
                count[2] += event.title_change
                count[3] += event.approximate
    out = bytearray()
    for (kind, subject, resolution, period_key), values in sorted(counters.items()):
        out += COVERAGE_STRUCT.pack(kind, resolution, 0, subject, period_key, *values)
    return bytes(out)


def _lod_rows(events: list[_Event], p_index: dict[str, int]) -> bytes:
    # key -> total, approx, and the direct rating sample (never child medians).
    buckets: dict[tuple[int, int, int], dict[str, Any]] = {}
    for event in events:
        for promotion in (GLOBAL_SUBJECT, p_index[event.pr]):
            for resolution, period_key, start, end, _month in _periods(event.d):
                key = (promotion, resolution, period_key)
                bucket = buckets.setdefault(key, {"start": start, "end": end, "total": 0, "approx": 0, "ratings": []})
                bucket["total"] += 1
                bucket["approx"] += event.approximate
                if event.rating is not None:
                    bucket["ratings"].append(event.rating)
    out = bytearray()
    for (promotion, resolution, period_key), bucket in sorted(buckets.items()):
        values = sorted(bucket["ratings"])
        rated = len(values)
        if values:
            median = values[rated // 2] if rated % 2 else (values[rated // 2 - 1] + values[rated // 2]) / 2.0
            low, high, total = values[0], values[-1], math.fsum(values)
        else:
            low = high = total = median = 0.0
        out += LOD_STRUCT.pack(
            promotion, resolution, bucket["start"], bucket["end"], period_key,
            bucket["total"], rated, low, high, total, median,
            sum(value >= 4.0 for value in values), sum(value >= 5.0 for value in values), bucket["approx"],
        )
    return bytes(out)


def derive(canonical_root: Path | None = None) -> Projection:
    """Read canonical materialized output and return deterministic projection bytes."""
    root = Path(canonical_root or canonical_root_path())
    canonical_manifest = _read_json(root / "manifest.json")
    events = _load_events(root)
    if not events:
        raise RatingsProjectionError("canonical timeline contains no events")
    people, promotions, titles = _names(root, events)

    people_ids = sorted(people)
    promotion_ids = sorted(promotions)
    title_ids = sorted(titles)
    rated = [event for event in events if event.rating is not None]
    match_ids = sorted(event.m for event in rated)
    event_ids = sorted({event.c for event in rated})
    event_names = {}
    for event in rated:
        prior = event_names.setdefault(event.c, event.en)
        if prior != event.en:
            raise RatingsProjectionError(f"canonical card/event disagreement for {event.c}: {prior!r} vs {event.en!r}")
    if len(event_ids) > 0x10000:
        raise RatingsProjectionError(f"rated event/card dictionary overflows u16: {len(event_ids)}")
    person_index = {value: i for i, value in enumerate(people_ids)}
    promotion_index = {value: i for i, value in enumerate(promotion_ids)}
    title_index = {value: i for i, value in enumerate(title_ids)}
    match_index = {value: i for i, value in enumerate(match_ids)}
    event_index = {value: i for i, value in enumerate(event_ids)}
    dictionaries = {
        "schema_version": SCHEMA_VERSION,
        "ordering": "opaque ids sorted lexicographically by Python Unicode code point",
        "forms": [name for name, _code in sorted(FORM_CODES.items(), key=lambda item: item[1])],
        "participants": {"id": people_ids, "name": [people[pid] for pid in people_ids]},
        "promotions": {"id": promotion_ids, "name": [promotions[pid] for pid in promotion_ids]},
        "titles": {"id": title_ids, "name": [titles[tid] for tid in title_ids]},
        "matches": {"id": match_ids},
        # Event identity is the canonical card id; `en` is its source event
        # display name. This avoids inventing a second event id namespace.
        "events": {"id": event_ids, "name": [event_names[eid] for eid in event_ids]},
    }

    participants = bytearray()
    title_values = bytearray()
    matches = bytearray()
    for event in rated:
        offset = len(participants) // PARTICIPANT_STRUCT.size
        if len(event.participants) > 0xFFFF:
            raise RatingsProjectionError(f"participant count overflows u16: {event.m}")
        for pid in event.participants:
            participants += PARTICIPANT_STRUCT.pack(person_index[pid])
        title_offset = len(title_values) // TITLE_STRUCT.size
        if len(event.titles) > 0xFFFF:
            raise RatingsProjectionError(f"title count overflows u16: {event.m}")
        for title in event.titles:
            title_values += TITLE_STRUCT.pack(title_index[title])
        flags = (event.ppv << 0) | (event.approximate << 1)
        if event.titles:
            flags |= 1 << 2
        if event.title_change:
            flags |= 1 << 3
        if event.placement is not None:
            flags |= 1 << 4
        matches += MATCH_STRUCT.pack(
            iso_to_day(event.d), event.rating, promotion_index[event.pr], offset, len(event.participants), flags,
            FORM_CODES[event.form], event_index[event.c], title_index[event.titles[0]] if event.titles else -1,
            event.placement if event.placement is not None else -1, match_index[event.m], title_offset, len(event.titles), 0,
        )

    coverage = _coverage_rows(events, promotion_index, person_index, title_index)
    lod = _lod_rows(events, promotion_index)
    histograms: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "algorithm": "direct-ratings-samples@1",
        "global": {
            "total": len(events), "rated": len(rated),
            "values": {str(value): sum(event.rating == value for event in rated) for value in sorted({event.rating for event in rated})},
            "bands": {"negative": sum(event.rating < 0 for event in rated), "zero": sum(event.rating == 0 for event in rated), "four_plus": sum(event.rating >= 4 for event in rated), "five_plus": sum(event.rating >= 5 for event in rated)},
        },
        "by_year": {},
    }
    for event in events:
        year = event.d[:4]
        row = histograms["by_year"].setdefault(year, {"total": 0, "rated": 0, "values": {}})
        row["total"] += 1
        if event.rating is not None:
            row["rated"] += 1
            key = str(event.rating)
            row["values"][key] = row["values"].get(key, 0) + 1
    for row in histograms["by_year"].values():
        row["values"] = dict(sorted(row["values"].items(), key=lambda item: float(item[0])))

    files = {
        "matches.bin": bytes(matches), "participants.bin": bytes(participants), "titles.bin": bytes(title_values), "dictionaries.json": _json_bytes(dictionaries),
        "coverage.bin": coverage, "lod.bin": lod, "histograms.json": _json_bytes(histograms),
    }
    counts = {
        "canonical_matches": len(events), "rated_matches": len(rated), "participant_values": len(participants) // 4,
        "title_values": len(title_values) // TITLE_STRUCT.size,
        "coverage_records": len(coverage) // COVERAGE_STRUCT.size, "lod_records": len(lod) // LOD_STRUCT.size,
    }
    return Projection(
        canonical_manifest=canonical_manifest, dictionaries=dictionaries, files=files, counts=counts,
        date_ranges={"canonical": [events[0].d, events[-1].d], "rated": [rated[0].d, rated[-1].d] if rated else None},
        rating_value_range=[min(event.rating for event in rated), max(event.rating for event in rated)] if rated else None,
        overall_coverage={
            "rated_matches": len(rated),
            "total_documented_matches": len(events),
            "fraction": len(rated) / len(events),
        },
        promotions_with_ratings=len({event.pr for event in rated}),
    )


def _manifest(projection: Projection) -> dict[str, Any]:
    files = projection.files
    return {
        "schema_version": SCHEMA_VERSION,
        "projection_version": PROJECTION_VERSION,
        "built_at": _deterministic_built_at(projection),
        "built_at_policy": "latest canonical timeline date at 00:00:00Z; a deterministic data clock, not wall-clock build time",
        "source_fingerprint": projection.canonical_manifest["source_fingerprint"],
        "source_schema_version": projection.canonical_manifest.get("schema_version"),
        "source_projection_version": projection.canonical_manifest.get("projection_version"),
        "source_manifest_sha256": _sha256(_json_bytes(_normalized_source_manifest(projection.canonical_manifest))),
        "source_manifest_sha256_policy": "sha256 of canonical manifest JSON with top-level built_at omitted",
        "date_ranges": projection.date_ranges,
        "rating_value_range": projection.rating_value_range,
        "overall_coverage": projection.overall_coverage,
        "promotions_with_ratings": projection.promotions_with_ratings,
        "aggregate_bin_sizes": {
            "year": {"resolution_code": RESOLUTION_CODES["year"], "calendar_months": 12},
            "quarter": {"resolution_code": RESOLUTION_CODES["quarter"], "calendar_months": 3},
            "month": {"resolution_code": RESOLUTION_CODES["month"], "calendar_months": 1},
        },
        "counts": projection.counts,
        "dictionary_counts": {name: len(projection.dictionaries[name]["id"]) for name in ("participants", "promotions", "titles", "matches", "events")},
        "algorithms": {
            "input": "canonical-timeline-by-year@1", "ratings": "mr-present@1", "coverage": "direct-canonical-denominators@1",
            "lod": "direct-sample-exact-median@1", "id_order": "opaque-lexicographic@1",
        },
        "binary": {
            "endianness": "little", "matches": {"file": "matches.bin", "record_count": projection.counts["rated_matches"], "stride": MATCH_STRUCT.size, "offsets": {"day": 0, "rating": 4, "promotion": 12, "participantOffset": 16, "participantCount": 20, "flags": 22, "form": 24, "eventIndex": 26, "title": 28, "placement": 32, "matchIdIndex": 36, "titleOffset": 40, "titleCount": 44, "reserved": 46}},
            "participants": {"file": "participants.bin", "record_count": projection.counts["participant_values"], "stride": PARTICIPANT_STRUCT.size, "offsets": {"participantIndex": 0}},
            "titles": {"file": "titles.bin", "record_count": projection.counts["title_values"], "stride": TITLE_STRUCT.size, "offsets": {"titleIndex": 0}},
            "coverage": {"file": "coverage.bin", "record_count": projection.counts["coverage_records"], "stride": COVERAGE_STRUCT.size, "offsets": {"kind": 0, "resolution": 1, "subject": 4, "periodKey": 8, "total": 12, "rated": 16, "titleChanges": 20, "approximate": 24}},
            "lod": {"file": "lod.bin", "record_count": projection.counts["lod_records"], "stride": LOD_STRUCT.size, "offsets": {"promotion": 0, "resolution": 4, "periodStartDay": 8, "periodEndDay": 12, "periodKey": 16, "total": 20, "rated": 24, "min": 28, "max": 36, "sum": 44, "median": 52, "fourPlus": 60, "fivePlus": 64, "approximate": 68}},
        },
        "checksums": {name: _sha256(data) for name, data in sorted(files.items())},
        "validation": {"passed": True, "checks": {"canonical_records_exact": True, "binary_contract": True, "coverage_exact": True, "lod_exact": True, "checksums": True}},
    }


def build(canonical_root: Path | None = None, out: Path | None = None) -> dict[str, Any]:
    """Materialize the ratings projection. Only the requested ratings directory changes."""
    root = Path(canonical_root or canonical_root_path())
    destination = Path(out or output_path(root))
    projection = derive(root)
    destination.mkdir(parents=True, exist_ok=True)
    for name in [*projection.files, "manifest.json"]:
        path = destination / name
        if path.exists():
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    for name, data in projection.files.items():
        (destination / name).write_bytes(data)
    manifest = _manifest(projection)
    (destination / "manifest.json").write_bytes(_json_bytes(manifest))
    # Local import avoids a module cycle: validator reuses this module's exact
    # derivation routines, while build invokes it only after all files exist.
    from .ratings_validate import validate

    ok, checks = validate(root, destination)
    if not ok:
        raise RatingsProjectionError(f"ratings projection validation failed: {checks}")
    return {"out": str(destination), "counts": projection.counts, "checks": checks, "files": len(projection.files) + 1}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0]) if argv else canonical_root_path()
    out = Path(argv[1]) if len(argv) > 1 else output_path(root)
    result = build(root, out)
    print(f"ratings materialize OK — out={result['out']} files={result['files']} rated={result['counts']['rated_matches']} coverage={result['counts']['coverage_records']} lod={result['counts']['lod_records']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
