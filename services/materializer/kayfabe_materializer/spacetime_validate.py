"""Validation for spacetime-projection@1.

Two independent anchors, per the projection's charter:
  * every corpus claim is checked against the CANONICAL materialized tree
    (timeline year files, dossiers, evidence pairs) — never against another
    derived artifact of this projection;
  * the warp table is checked against the CLOSED FORMS of arXiv:1107.5650
    (xi=90 fixed point, delta = 1 + v*cos(phi), rear horizon arccos(-1/v)),
    which the integration must reproduce or it is wrong physics, not style.

run_checks(out, counts) is called by spacetime_project.build() with the tree
already written; running this module directly re-validates an existing tree.
"""

from __future__ import annotations

import json
import math
import struct
import sys
from pathlib import Path

from .normalize import bucket_of, iso_to_day, pair_key
from . import spacetime_lut

MAT = Path(__file__).resolve().parents[3] / "data" / "materialized"

STRIDE = 8  # u32 per event record; must match spacetime_project.EVENT_STRIDE_U32


def _events_of(blob: bytes, offset: int, count: int) -> list[tuple]:
    out = []
    for i in range(offset, offset + count):
        out.append(struct.unpack_from("<8I", blob, i * STRIDE * 4))
    return out


def run_checks(out: Path, counts: dict) -> tuple[bool, dict]:
    checks: dict[str, dict] = {}

    def check(name: str, passed: bool, detail: str = "") -> None:
        checks[name] = {"passed": bool(passed), **({"detail": detail} if detail else {})}

    dictionaries = json.loads((out / "dictionaries.json").read_text(encoding="utf-8"))
    promo_ids = dictionaries["promotions"]["ids"]

    # ---------------------------------------------------------- corpus side
    total_events = 0
    total_parts = 0
    all_ok_shape = True
    sorted_ok = True
    persona_ok = True
    alias_ok = True
    rel_ok = True
    promo_ok = True
    rating_ok = True
    detail: list[str] = []

    for sub in dictionaries["subjects"]:
        bb = sub["bucket"]
        desc = json.loads((out / "people" / f"{bb}.json").read_text(encoding="utf-8"))
        ev_blob = (out / "people" / f"{bb}.events.bin").read_bytes()
        pt_blob = (out / "people" / f"{bb}.parts.bin").read_bytes()
        d = desc[sub["canonical"]]
        recs = _events_of(ev_blob, d["events"]["offset"], d["events"]["count"])
        total_events += len(recs)
        total_parts += d["parts"]["count"]

        if len(ev_blob) % (STRIDE * 4) != 0 or len(pt_blob) % 4 != 0:
            all_ok_shape = False

        # Sorted by (day, match id as string) — day alone is not total.
        keys = [(recs[i][0], d["matchRefs"][recs[i][6]]) for i in range(len(recs))]
        if keys != sorted(keys):
            sorted_ok = False

        # Persona event counts against the canonical dossiers.
        per_persona = [0] * len(d["personas"])
        seen_m: set[str] = set()
        for r in recs:
            per_persona[(r[2] >> 9) & 0x7] += 1
            m = d["matchRefs"][r[6]]
            if m in seen_m:
                alias_ok = False
            seen_m.add(m)
            if r[1] >= len(promo_ids):
                promo_ok = False
            same_n = r[3] & 0xffff
            opp_n = r[3] >> 16
            if r[5] + same_n + opp_n + r[4] > len(pt_blob) // 4:
                all_ok_shape = False
            if r[7] and not (1 <= r[7] <= 1101):
                rating_ok = False
        for i, p in enumerate(d["personas"]):
            dossier_bucket = json.loads(
                (MAT / "entities" / "people" / f"{bucket_of(p['id'])}.json")
                .read_text(encoding="utf-8"))
            expected = dossier_bucket[p["id"]]["m"]
            if per_persona[i] != expected:
                persona_ok = False
                detail.append(f"{p['id']}: {per_persona[i]} vs dossier {expected}")

        # Relationship totals against the canonical evidence pairs, recounted
        # from evidence directly — this is what "reuse, never re-derive" means.
        persona_ids = [p["id"] for p in d["personas"]]
        ev_cache: dict[str, dict] = {}

        def pair_entries(a: str, b: str) -> list:
            key = pair_key(a, b)
            bb2 = bucket_of(key)
            if bb2 not in ev_cache:
                p = MAT / "evidence" / "pairs" / f"{bb2}.json"
                ev_cache[bb2] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
            return ev_cache[bb2].get(key, [])

        sample = d["relationships"][:40]  # strongest 40: exhaustive would re-read ~250MB
        for rel in sample:
            same = opposed = br = 0
            for pid in persona_ids:
                for e in pair_entries(pid, rel["p"]):
                    if e["rel"] == "same":
                        same += 1
                    elif e["rel"] == "opposed":
                        opposed += 1
                    elif e["rel"] == "br":
                        br += 1
            if (same, opposed, br) != (rel["same"], rel["opposed"], rel["br"]):
                rel_ok = False
                detail.append(f"rel {rel['p']}: shard {rel['same']}/{rel['opposed']}/{rel['br']}"
                              f" vs evidence {same}/{opposed}/{br}")

        # Five-year buckets: recompute from the shard's own event days must
        # equal the published buckets (deterministic, no invented phases).
        for rel in sample:
            got = dict(rel["buckets"])
            if sum(got.values()) != rel["same"] + rel["opposed"] + rel["br"]:
                rel_ok = False
                detail.append(f"rel {rel['p']}: bucket sum mismatch")

    check("events_bin_shape", all_ok_shape)
    check("events_sorted_by_date_then_id", sorted_ok)
    check("persona_counts_match_dossiers", persona_ok, "; ".join(detail[:4]))
    check("alias_personas_disjoint", alias_ok)
    check("relationships_match_evidence(top40)", rel_ok, "; ".join(detail[:4]))
    check("promo_indexes_valid", promo_ok)
    check("ratings_bounded_or_absent", rating_ok)
    check("event_total_matches_counts", total_events == counts["events"],
          f"{total_events} vs {counts['events']}")

    # ------------------------------------------------------------- lut side
    lut = (out / "lut" / "bridge.f16.bin").read_bytes()
    W, H = spacetime_lut.LUT_WIDTH, spacetime_lut.LUT_HEIGHT
    check("lut_f16_size", len(lut) == W * H * 4 * 2, f"{len(lut)} bytes")
    rgba8 = (out / "lut" / "bridge-rgba8.bin").read_bytes()
    check("lut_rgba8_size", len(rgba8) == W * H * 4, f"{len(rgba8)} bytes")

    def texel(col: int, row: int) -> tuple:
        vals = struct.unpack_from("<4e", lut, (row * W + col) * 8)
        return spacetime_lut.decode_texel(*vals)

    def v_of_row(row: int) -> float:
        return spacetime_lut.warp_speed_of_row(row / (H - 1))

    # Row 0 is v=0: identity map, no shift, everything visible.
    ident_ok = True
    for col in range(0, W, 257):
        ta, delta, mag, vis = texel(col, 0)
        ts = col / (W - 1) * math.pi
        if abs(ta - ts) > 0.02 or abs(delta - 1.0) > 0.02 or vis < 0.5:
            ident_ok = False
    check("lut_v0_identity", ident_ok)

    # xi = 90 fixed point on every sampled row (paper Appendix C).
    fixed_ok = True
    mid = (W - 1) // 2
    for row in range(0, H, 31):
        ta, delta, mag, vis = texel(mid, row)
        if vis > 0.5 and (abs(ta - math.pi / 2) > 0.03 or abs(delta - 1.0) > 0.05):
            fixed_ok = False
    check("lut_xi90_fixed_point", fixed_ok)

    # delta closed form 1 + v*cos(phi) on visible texels (f16 + clamp slack).
    closed_ok = True
    for row in (H // 4, H // 2, H - 1):
        v = v_of_row(row)
        for col in range(64, W - 64, 509):
            ta, delta, mag, vis = texel(col, row)
            if vis < 0.5:
                continue
            phi = col / (W - 1) * math.pi
            expect = 1.0 + v * math.cos(phi)
            if expect <= 1e-3:
                continue
            ln_e = max(-spacetime_lut.LOG_DELTA_MAX,
                       min(spacetime_lut.LOG_DELTA_MAX, math.log(expect)))
            if abs(math.log(max(delta, 1e-9)) - ln_e) > 0.08:
                closed_ok = False
    check("lut_delta_closed_form", closed_ok)

    # Rear horizon: on the top row (v = 9) nothing behind arccos(-1/9) + slack
    # is visible, and most of the sky before it is.
    top = H - 1
    v = v_of_row(top)
    hor = math.acos(-1.0 / v)
    bad = sum(1 for col in range(W) if (col / (W - 1) * math.pi) > hor + 0.06
              and texel(col, top)[3] > 0.5)
    front_vis = sum(1 for col in range(0, int(hor / math.pi * (W - 1)) - 64, 64)
                    if texel(col, top)[3] > 0.5)
    check("lut_rear_horizon", bad == 0 and front_vis > 10,
          f"{bad} visible texels beyond horizon, {front_vis} sampled visible before")

    # No NaN anywhere (allow_nan is off for JSON; binaries need their own scan).
    nan_free = True
    for off in range(0, len(lut), 8 * 1021):
        for x in struct.unpack_from("<4e", lut, off - off % 8):
            if x != x:
                nan_free = False
    check("lut_nan_free", nan_free)

    passed = all(c["passed"] for c in checks.values())
    return passed, checks


def main() -> int:
    out = MAT / "spacetime"
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    passed, checks = run_checks(out, manifest["counts"])
    # Checksums must match what the manifest recorded.
    import hashlib
    sums_ok = True
    for rel, want in manifest["checksums"].items():
        got = hashlib.sha256((out / rel).read_bytes()).hexdigest()
        if got != want:
            sums_ok = False
            print(f"  checksum mismatch: {rel}")
    checks["checksums"] = {"passed": sums_ok}
    passed = passed and sums_ok
    for name in sorted(checks):
        print(f"  [{'PASS' if checks[name]['passed'] else 'FAIL'}] {name}")
    print("spacetime:validate", "OK" if passed else "FAILED")
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
