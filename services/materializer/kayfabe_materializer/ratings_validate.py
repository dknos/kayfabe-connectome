"""Validation for ``data/materialized/ratings``.

The validator independently re-derives the projection from canonical timeline
JSON.  It therefore checks all record values, offsets, sparse denominators and
direct-sample medians instead of merely checking that binary files parse.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

from .ratings_project import (
    COVERAGE_STRUCT,
    GLOBAL_SUBJECT,
    KIND_CODES,
    LOD_STRUCT,
    MATCH_STRUCT,
    PARTICIPANT_STRUCT,
    TITLE_STRUCT,
    PROJECTION_VERSION,
    RESOLUTION_CODES,
    SCHEMA_VERSION,
    Projection,
    RatingsProjectionError,
    _json_bytes,
    _manifest,
    _sha256,
    canonical_root_path,
    derive,
    output_path,
)


def _read(path: Path) -> bytes:
    if not path.is_file():
        raise RatingsProjectionError(f"ratings projection file missing: {path}")
    return path.read_bytes()


def _parse_matches(raw: bytes, dictionaries: dict[str, Any], participant_values: int, title_values: int) -> bool:
    if len(raw) % MATCH_STRUCT.size:
        return False
    participants = len(dictionaries["participants"]["id"])
    promotions = len(dictionaries["promotions"]["id"])
    titles = len(dictionaries["titles"]["id"])
    match_ids = len(dictionaries["matches"]["id"])
    events = len(dictionaries["events"]["id"])
    for offset in range(0, len(raw), MATCH_STRUCT.size):
        day, rating, promotion, participant_offset, participant_count, flags, form, event, title, placement, mid, title_offset, title_count, reserved = MATCH_STRUCT.unpack_from(raw, offset)
        if not math.isfinite(rating) or not -1.0 <= rating <= 8.0:
            return False
        if promotion >= promotions or form >= len(dictionaries["forms"]) or event >= events or reserved != 0 or mid >= match_ids:
            return False
        if title != -1 and not 0 <= title < titles:
            return False
        if bool(flags & (1 << 2)) != (title_count > 0) or bool(flags & (1 << 4)) != (placement != -1):
            return False
        if placement < -1 or participant_offset + participant_count > participant_values or title_offset + title_count > title_values:
            return False
        if (title == -1) != (title_count == 0):
            return False
    return True


def _parse_participants(raw: bytes, dictionaries: dict[str, Any]) -> bool:
    if len(raw) % PARTICIPANT_STRUCT.size:
        return False
    count = len(dictionaries["participants"]["id"])
    return all(PARTICIPANT_STRUCT.unpack_from(raw, offset)[0] < count for offset in range(0, len(raw), PARTICIPANT_STRUCT.size))


def _parse_titles(raw: bytes, dictionaries: dict[str, Any]) -> bool:
    if len(raw) % TITLE_STRUCT.size:
        return False
    count = len(dictionaries["titles"]["id"])
    return all(TITLE_STRUCT.unpack_from(raw, offset)[0] < count for offset in range(0, len(raw), TITLE_STRUCT.size))


def _parse_coverage(raw: bytes, dictionaries: dict[str, Any]) -> bool:
    if len(raw) % COVERAGE_STRUCT.size:
        return False
    limits = {KIND_CODES["global"]: None, KIND_CODES["promotion"]: len(dictionaries["promotions"]["id"]), KIND_CODES["person"]: len(dictionaries["participants"]["id"]), KIND_CODES["title"]: len(dictionaries["titles"]["id"])}
    previous = None
    for offset in range(0, len(raw), COVERAGE_STRUCT.size):
        kind, resolution, reserved, subject, period, total, rated, changes, approximate = COVERAGE_STRUCT.unpack_from(raw, offset)
        key = (kind, subject, resolution, period)
        if previous is not None and key <= previous:
            return False
        previous = key
        if kind not in limits or resolution not in RESOLUTION_CODES.values() or reserved != 0 or rated > total or changes > total or approximate > total:
            return False
        if kind == KIND_CODES["global"]:
            if subject != GLOBAL_SUBJECT:
                return False
        elif subject >= limits[kind]:
            return False
    return True


def _parse_lod(raw: bytes, dictionaries: dict[str, Any]) -> bool:
    if len(raw) % LOD_STRUCT.size:
        return False
    promotions = len(dictionaries["promotions"]["id"])
    previous = None
    for offset in range(0, len(raw), LOD_STRUCT.size):
        promotion, resolution, start, end, period, total, rated, low, high, total_rating, median, four, five, approximate = LOD_STRUCT.unpack_from(raw, offset)
        key = (promotion, resolution, period)
        if previous is not None and key <= previous:
            return False
        previous = key
        if (promotion != GLOBAL_SUBJECT and promotion >= promotions) or resolution not in RESOLUTION_CODES.values() or start > end or rated > total or five > four or four > rated or approximate > total:
            return False
        if not all(math.isfinite(value) for value in (low, high, total_rating, median)):
            return False
        if rated == 0:
            if (low, high, total_rating, median) != (0.0, 0.0, 0.0, 0.0):
                return False
        elif not (-1.0 <= low <= median <= high <= 8.0):
            return False
    return True


def _dictionary_shape(value: Any) -> bool:
    if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
        return False
    if not isinstance(value.get("forms"), list) or not isinstance(value.get("ordering"), str):
        return False
    for key in ("participants", "promotions", "titles", "events"):
        group = value.get(key)
        if not isinstance(group, dict) or not isinstance(group.get("id"), list) or not isinstance(group.get("name"), list):
            return False
        if len(group["id"]) != len(group["name"]) or group["id"] != sorted(group["id"]) or len(set(group["id"])) != len(group["id"]):
            return False
    matches = value.get("matches")
    return isinstance(matches, dict) and isinstance(matches.get("id"), list) and matches["id"] == sorted(matches["id"]) and len(set(matches["id"])) == len(matches["id"])


def validate(canonical_root: Path | None = None, out: Path | None = None) -> tuple[bool, dict[str, bool]]:
    """Return precise pass/fail checks without changing either input tree."""
    root = Path(canonical_root or canonical_root_path())
    destination = Path(out or output_path(root))
    checks: dict[str, bool] = {}
    try:
        expected: Projection = derive(root)
        expected_manifest = _manifest(expected)
        manifest = json.loads(_read(destination / "manifest.json").decode("utf-8"))
        checks["manifest_contract"] = (
            manifest.get("schema_version") == SCHEMA_VERSION
            and manifest.get("projection_version") == PROJECTION_VERSION
            and manifest.get("built_at") == expected_manifest["built_at"]
            and manifest.get("built_at_policy") == expected_manifest["built_at_policy"]
            and manifest.get("source_fingerprint") == expected_manifest["source_fingerprint"]
            and manifest.get("source_schema_version") == expected_manifest["source_schema_version"]
            and manifest.get("source_projection_version") == expected_manifest["source_projection_version"]
            and manifest.get("source_manifest_sha256") == expected_manifest["source_manifest_sha256"]
            and manifest.get("source_manifest_sha256_policy") == expected_manifest["source_manifest_sha256_policy"]
            and manifest.get("date_ranges") == expected_manifest["date_ranges"]
            and manifest.get("rating_value_range") == expected_manifest["rating_value_range"]
            and manifest.get("overall_coverage") == expected_manifest["overall_coverage"]
            and manifest.get("promotions_with_ratings") == expected_manifest["promotions_with_ratings"]
            and manifest.get("aggregate_bin_sizes") == expected_manifest["aggregate_bin_sizes"]
            and manifest.get("counts") == expected_manifest["counts"]
            and manifest.get("dictionary_counts") == expected_manifest["dictionary_counts"]
            and manifest.get("algorithms") == expected_manifest["algorithms"]
            and manifest.get("binary") == expected_manifest["binary"]
            and manifest.get("validation") == expected_manifest["validation"]
        )
        actual = {name: _read(destination / name) for name in expected.files}
        checks["checksums"] = manifest.get("checksums") == {name: _sha256(data) for name, data in sorted(actual.items())}
        try:
            dictionaries = json.loads(actual["dictionaries.json"].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            dictionaries = None
        checks["dictionary_shape_order_unique"] = _dictionary_shape(dictionaries)
        checks["dictionaries_exact"] = actual["dictionaries.json"] == expected.files["dictionaries.json"]
        checks["matches_offsets_indexes_finite_range"] = _parse_matches(actual["matches.bin"], dictionaries, len(actual["participants.bin"]) // PARTICIPANT_STRUCT.size, len(actual["titles.bin"]) // TITLE_STRUCT.size) and len(actual["matches.bin"]) == expected_manifest["binary"]["matches"]["record_count"] * MATCH_STRUCT.size
        checks["participants_indexes"] = _parse_participants(actual["participants.bin"], dictionaries) and len(actual["participants.bin"]) == expected_manifest["binary"]["participants"]["record_count"] * PARTICIPANT_STRUCT.size
        checks["titles_indexes"] = _parse_titles(actual["titles.bin"], dictionaries) and len(actual["titles.bin"]) == expected_manifest["binary"]["titles"]["record_count"] * TITLE_STRUCT.size
        checks["coverage_sparse_denominators"] = _parse_coverage(actual["coverage.bin"], dictionaries) and actual["coverage.bin"] == expected.files["coverage.bin"]
        checks["lod_direct_exact_medians"] = _parse_lod(actual["lod.bin"], dictionaries) and actual["lod.bin"] == expected.files["lod.bin"]
        checks["canonical_records_exact"] = actual["matches.bin"] == expected.files["matches.bin"] and actual["participants.bin"] == expected.files["participants.bin"] and actual["titles.bin"] == expected.files["titles.bin"]
        checks["histograms_exact"] = actual["histograms.json"] == expected.files["histograms.json"]
    except (OSError, ValueError, TypeError, RatingsProjectionError, struct.error):
        checks.setdefault("exception", False)
    return all(checks.values()) and bool(checks), checks


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0]) if argv else canonical_root_path()
    out = Path(argv[1]) if len(argv) > 1 else output_path(root)
    ok, checks = validate(root, out)
    for name in sorted(checks):
        print(f"[{'PASS' if checks[name] else 'FAIL'}] {name}")
    print("ratings validate", "PASSED" if ok else "FAILED", f"— {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
