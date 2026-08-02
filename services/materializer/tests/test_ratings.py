"""Pure fixture tests for the canonical-timeline ratings projection."""

from __future__ import annotations

import json
import struct
import tempfile
import unittest
from pathlib import Path

from kayfabe_materializer.ratings_project import COVERAGE_STRUCT, LOD_STRUCT, MATCH_STRUCT, TITLE_STRUCT, build
from kayfabe_materializer.ratings_validate import validate


def put_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")))


def event(m, d, pr, w, l, **extra):
    value = {
        "m": m, "c": f"c:{m[2:]}", "d": d, "pr": pr, "en": "Fixture", "loc": "Test City",
        "form": "singles", "stip": "", "res": "def.", "fin": "pin", "w": w, "l": l,
        "unk": False, "t": None, "tc": 0, "dur": 60,
    }
    value.update(extra)
    return value


def fixture(root: Path) -> None:
    put_json(root / "manifest.json", {
        "schema_version": "2.0.0", "projection_version": "encounters@2", "source_fingerprint": "fixture-source",
        "built_at": "2026-08-02T01:02:03+00:00",
    })
    put_json(root / "graph" / "promotions.json", {
        "pr:a": {"n": "Alpha"}, "pr:z9": {"n": "Zed Nine"},
    })
    put_json(root / "entities" / "championships.json", {
        "t:x": {"n": "Fixture Title"}, "t:y": {"n": "Second Fixture Title"},
    })
    put_json(root / "entities" / "people" / "00.json", {
        "p:alpha": {"n": "Alpha Person"}, "p:beta": {"n": "Beta Person"},
        "p:omega": {"n": "Omega Person"}, "p:z": {"n": "Z Person"},
    })
    # Jan/Feb are Q1, Apr is Q2. March is intentionally absent (sparse gap).
    put_json(root / "timeline" / "by-year" / "2020.json", [
        event("m:c10", "2020-01-01", "pr:z9", ["p:beta", "p:alpha"], ["p:beta"], mr=-1.0, ppv=1, t="t:x", ts=["t:x", "t:y"], tc=1),
        event("m:2", "2020-01-20", "pr:a", ["p:beta"], ["p:z"]),
        event("m:c3", "2020-02-01", "pr:a", ["p:alpha"], ["p:omega"], mr=0.0, apx=1),
        event("m:opaque", "2020-04-01", "pr:z9", ["p:z"], ["p:omega"], mr=5.5, placement=9),
    ])


class RatingsProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "canonical"
        fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_byte_identical_rebuild_and_validation(self):
        first = Path(self.temp.name) / "first"
        second = Path(self.temp.name) / "second"
        build(self.root, first)
        # The upstream materializer's timestamp is deliberately wall-clock;
        # it must not perturb the ratings fingerprint or any derived bytes.
        source = json.loads((self.root / "manifest.json").read_text())
        source["built_at"] = "2099-12-31T23:59:59+00:00"
        put_json(self.root / "manifest.json", source)
        build(self.root, second)
        for name in ("manifest.json", "matches.bin", "participants.bin", "dictionaries.json", "coverage.bin", "lod.bin", "histograms.json"):
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)
        projection_manifest = json.loads((first / "manifest.json").read_text())
        self.assertEqual(projection_manifest["built_at"], "2020-04-01T00:00:00Z")
        self.assertIn("built_at omitted", projection_manifest["source_manifest_sha256_policy"])
        self.assertEqual(projection_manifest["rating_value_range"], [-1.0, 5.5])
        self.assertEqual(projection_manifest["overall_coverage"], {
            "rated_matches": 3, "total_documented_matches": 4, "fraction": 0.75,
        })
        self.assertEqual(projection_manifest["promotions_with_ratings"], 2)
        self.assertEqual(projection_manifest["aggregate_bin_sizes"], {
            "month": {"calendar_months": 1, "resolution_code": 2},
            "quarter": {"calendar_months": 3, "resolution_code": 1},
            "year": {"calendar_months": 12, "resolution_code": 0},
        })
        self.assertTrue(validate(self.root, first)[0])

    def test_mixed_ids_nonpositive_and_exact_period_aggregates(self):
        out = Path(self.temp.name) / "ratings"
        build(self.root, out)
        dictionaries = json.loads((out / "dictionaries.json").read_text())
        self.assertEqual(dictionaries["matches"]["id"], ["m:c10", "m:c3", "m:opaque"])
        self.assertEqual(dictionaries["events"]["id"], ["c:c10", "c:c3", "c:opaque"])
        self.assertEqual(dictionaries["participants"]["id"], ["p:alpha", "p:beta", "p:omega", "p:z"])
        self.assertEqual(len((out / "matches.bin").read_bytes()), 3 * MATCH_STRUCT.size)
        matches = [MATCH_STRUCT.unpack_from((out / "matches.bin").read_bytes(), i) for i in range(0, (out / "matches.bin").stat().st_size, MATCH_STRUCT.size)]
        opaque_index = dictionaries["matches"]["id"].index("m:opaque")
        opaque = next(row for row in matches if row[10] == opaque_index)
        self.assertEqual(opaque[9], 9)
        self.assertTrue(opaque[5] & (1 << 4))
        first = next(row for row in matches if row[10] == dictionaries["matches"]["id"].index("m:c10"))
        self.assertEqual(first[7], dictionaries["events"]["id"].index("c:c10"))
        self.assertEqual((first[11], first[12]), (0, 2))
        title_values = [TITLE_STRUCT.unpack_from((out / "titles.bin").read_bytes(), i)[0] for i in range(0, (out / "titles.bin").stat().st_size, TITLE_STRUCT.size)]
        self.assertEqual([dictionaries["titles"]["id"][i] for i in title_values[first[11]:first[11] + first[12]]], ["t:x", "t:y"])
        # A present zero and a negative / above-five value are ratings, while
        # the unrated m:2 record is deliberately absent from matches.bin.
        self.assertEqual([row[1] for row in matches], [-1.0, 0.0, 5.5])
        histogram = json.loads((out / "histograms.json").read_text())
        self.assertEqual(histogram["global"]["values"], {"-1.0": 1, "0.0": 1, "5.5": 1})

        lod = [LOD_STRUCT.unpack_from((out / "lod.bin").read_bytes(), i) for i in range(0, (out / "lod.bin").stat().st_size, LOD_STRUCT.size)]
        # Global year 2020: 4 canonical matches, 3 rated values [-1, 0, 5.5].
        row = next(r for r in lod if r[0] == 0xFFFFFFFF and r[1] == 0 and r[4] == 2020)
        self.assertEqual((row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12]), (4, 3, -1.0, 5.5, 4.5, 0.0, 1, 1))
        # Q1 direct sample is [-1, 0], so its exact even median is -0.5.
        q1 = next(r for r in lod if r[0] == 0xFFFFFFFF and r[1] == 1 and r[4] == 20201)
        self.assertEqual((q1[5], q1[6], q1[10]), (3, 2, -0.5))

        coverage = [COVERAGE_STRUCT.unpack_from((out / "coverage.bin").read_bytes(), i) for i in range(0, (out / "coverage.bin").stat().st_size, COVERAGE_STRUCT.size)]
        beta = dictionaries["participants"]["id"].index("p:beta")
        # m:c10 lists beta on both sides, but person coverage counts it once.
        beta_jan = next(r for r in coverage if r[0] == 2 and r[3] == beta and r[1] == 2 and r[4] == 202001)
        self.assertEqual(beta_jan[5:9], (2, 1, 1, 0))
        title_y = dictionaries["titles"]["id"].index("t:y")
        title_y_jan = next(r for r in coverage if r[0] == 3 and r[3] == title_y and r[1] == 2 and r[4] == 202001)
        self.assertEqual(title_y_jan[5:9], (1, 1, 1, 0))
        self.assertFalse(any(r[0] == 0 and r[1] == 2 and r[4] == 202003 for r in coverage))
        self.assertFalse(any(r[0] == 0xFFFFFFFF and r[1] == 2 and r[4] == 202003 for r in lod))

    def test_no_rated_corpus_keeps_denominators_and_uses_null_rated_range(self):
        rows = json.loads((self.root / "timeline" / "by-year" / "2020.json").read_text())
        for row in rows:
            row.pop("mr", None)
        put_json(self.root / "timeline" / "by-year" / "2020.json", rows)
        out = Path(self.temp.name) / "no-rated"
        build(self.root, out)
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual(manifest["counts"]["rated_matches"], 0)
        self.assertEqual(manifest["counts"]["participant_values"], 0)
        self.assertEqual(manifest["counts"]["title_values"], 0)
        self.assertIsNone(manifest["date_ranges"]["rated"])
        self.assertIsNone(manifest["rating_value_range"])
        self.assertEqual(manifest["overall_coverage"], {
            "rated_matches": 0, "total_documented_matches": 4, "fraction": 0.0,
        })
        self.assertEqual(manifest["promotions_with_ratings"], 0)
        self.assertEqual((out / "matches.bin").read_bytes(), b"")
        self.assertEqual((out / "participants.bin").read_bytes(), b"")
        self.assertEqual((out / "titles.bin").read_bytes(), b"")
        histogram = json.loads((out / "histograms.json").read_text())
        self.assertEqual(histogram["global"], {
            "total": 4, "rated": 0, "values": {},
            "bands": {"negative": 0, "zero": 0, "four_plus": 0, "five_plus": 0},
        })
        lod = [LOD_STRUCT.unpack_from((out / "lod.bin").read_bytes(), i) for i in range(0, (out / "lod.bin").stat().st_size, LOD_STRUCT.size)]
        self.assertTrue(all(row[6] == 0 and row[7:11] == (0.0, 0.0, 0.0, 0.0) for row in lod))
        self.assertTrue(validate(self.root, out)[0])

    def test_title_buffer_offset_corruption_is_rejected(self):
        out = Path(self.temp.name) / "offset-corrupt"
        build(self.root, out)
        raw = bytearray((out / "matches.bin").read_bytes())
        # titleOffset@40 points past the two-value titles.bin fixture buffer.
        struct.pack_into("<I", raw, 40, 999_999)
        (out / "matches.bin").write_bytes(raw)
        ok, checks = validate(self.root, out)
        self.assertFalse(ok)
        self.assertFalse(checks["checksums"])
        self.assertFalse(checks["matches_offsets_indexes_finite_range"])

    def test_titles_histogram_and_manifest_checksum_corruption_are_rejected(self):
        for name, mutate, expected_check in (
            ("titles", lambda out: (out / "titles.bin").write_bytes(b"\xff\xff\xff\xff" + (out / "titles.bin").read_bytes()[4:]), "titles_indexes"),
            ("histogram", lambda out: (out / "histograms.json").write_bytes(b"{}"), "histograms_exact"),
            ("checksum", self._corrupt_manifest_checksum, "checksums"),
        ):
            with self.subTest(name=name):
                out = Path(self.temp.name) / f"corrupt-{name}"
                build(self.root, out)
                mutate(out)
                ok, checks = validate(self.root, out)
                self.assertFalse(ok)
                self.assertFalse(checks[expected_check])

    def test_manifest_summary_or_algorithm_corruption_is_rejected(self):
        for field, replacement in (
            ("rating_value_range", [0.0, 5.5]),
            ("overall_coverage", {"rated_matches": 4, "total_documented_matches": 4, "fraction": 1.0}),
            ("promotions_with_ratings", 1),
            ("aggregate_bin_sizes", {}),
            ("algorithms", {}),
        ):
            with self.subTest(field=field):
                out = Path(self.temp.name) / f"manifest-corrupt-{field}"
                build(self.root, out)
                manifest = json.loads((out / "manifest.json").read_text())
                manifest[field] = replacement
                put_json(out / "manifest.json", manifest)
                ok, checks = validate(self.root, out)
                self.assertFalse(ok)
                self.assertFalse(checks["manifest_contract"])

    @staticmethod
    def _corrupt_manifest_checksum(out: Path) -> None:
        manifest = json.loads((out / "manifest.json").read_text())
        manifest["checksums"]["matches.bin"] = "0" * 64
        put_json(out / "manifest.json", manifest)

    def test_checksum_or_binary_corruption_is_rejected(self):
        out = Path(self.temp.name) / "ratings"
        build(self.root, out)
        damaged = bytearray((out / "matches.bin").read_bytes())
        damaged[4] ^= 1
        (out / "matches.bin").write_bytes(damaged)
        ok, checks = validate(self.root, out)
        self.assertFalse(ok)
        self.assertFalse(checks["checksums"])


if __name__ == "__main__":
    unittest.main()
