"""Validation of a materialized tree (standalone re-validation + build-time checks).

`run_checks(out, promo_bits)` performs the structural checks used both by
materialize.py (before the manifest exists) and by the CLI:
  * edge weights == evidence entry counts (per pair, per relation)
  * edges.bin stride/count/order consistency
  * no NaN / out-of-range positions
  * day-encode round trip
  * communities file consistency
  * determinism canary hash of a fixed subset

CLI (`python -m kayfabe_materializer.validate [dir]`) additionally verifies
every checksum recorded in manifest.json. Exit code != 0 on any failure.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
from pathlib import Path

from .normalize import FORM_BITS, bucket_of, day_to_iso, iso_to_day

STRIDE = 10


def _load(path: Path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def run_checks(out: Path, promo_bits: dict[str, int]) -> tuple[bool, dict]:
    checks: dict[str, dict] = {}

    # ---- nodes
    nodes = _load(out / "graph" / "nodes.json")
    n = nodes["count"]
    arrays = (
        "id",
        "type",
        "name",
        "community",
        "firstDay",
        "lastDay",
        "matches",
        "degree",
        "reigns",
        "promoMask",
        "resolution",
    )
    len_ok = all(len(nodes[a]) == n for a in arrays) and len(nodes["pos"]) == 3 * n
    finite = all(math.isfinite(v) for v in nodes["pos"])
    in_range = all(-1.0001 <= v <= 1.0001 for v in nodes["pos"])
    checks["nodes_columnar"] = {
        "passed": bool(len_ok and finite and in_range),
        "count": n,
        "lengths_ok": bool(len_ok),
        "positions_finite": bool(finite),
        "positions_in_range": bool(in_range),
    }
    person_count = sum(1 for t in nodes["type"] if t == 0)
    idx_of = {cid: i for i, cid in enumerate(nodes["id"])}

    # ---- edges.bin
    raw = (out / "graph" / "edges.bin").read_bytes()
    stride_ok = len(raw) % (STRIDE * 4) == 0
    count = len(raw) // (STRIDE * 4)
    records: list[tuple[int, ...]] = []
    order_ok = ab_ok = True
    prev = (-1, -1)
    for i in range(count):
        rec = struct.unpack_from(f"<{STRIDE}I", raw, i * STRIDE * 4)
        records.append(rec)
        a, b = rec[0], rec[1]
        if not (a < b < person_count):
            ab_ok = False
        if (a, b) <= prev:
            order_ok = False
        prev = (a, b)
    checks["edges_bin"] = {
        "passed": bool(stride_ok and order_ok and ab_ok),
        "count": count,
        "stride_ok": bool(stride_ok),
        "sorted_ok": bool(order_ok),
        "indices_ok": bool(ab_ok),
    }

    # ---- evidence <-> edges equality
    rec_by_ab = {(r[0], r[1]): r for r in records}
    mismatches = 0
    orphan_pairs = 0
    bucket_key_errors = 0
    evidence_pairs = 0
    all_dates: set[str] = set()
    for bnum in range(256):
        bb = "%02x" % bnum
        bucket = _load(out / "evidence" / "pairs" / f"{bb}.json")
        for key, entries in bucket.items():
            evidence_pairs += 1
            if bucket_of(key) != bb:
                bucket_key_errors += 1
            ida, idb = key.split("|")
            ia, ib = idx_of.get(ida), idx_of.get(idb)
            if ia is None or ib is None:
                orphan_pairs += 1
                continue
            a, b = (ia, ib) if ia < ib else (ib, ia)
            rec = rec_by_ab.get((a, b))
            if rec is None:
                orphan_pairs += 1
                continue
            same = sum(1 for e in entries if e["rel"] == "same")
            opp = sum(1 for e in entries if e["rel"] == "opposed")
            br = sum(1 for e in entries if e["rel"] == "br")
            tmatches = len({e["m"] for e in entries if e["t"] is not None})
            days = [iso_to_day(e["d"]) for e in entries]
            all_dates.update(e["d"] for e in entries)
            pmask = 0
            fmask = 0
            for e in entries:
                pmask |= 1 << promo_bits[e["pr"][3:]]
                fmask |= 1 << FORM_BITS[e["form"]]
            expect = (a, b, same, opp, br, tmatches, min(days), max(days), pmask, fmask)
            if rec != expect:
                mismatches += 1
    pair_count_ok = evidence_pairs == count
    checks["edge_evidence_equality"] = {
        "passed": bool(
            mismatches == 0
            and orphan_pairs == 0
            and bucket_key_errors == 0
            and pair_count_ok
        ),
        "evidence_pairs": evidence_pairs,
        "edge_records": count,
        "mismatched_records": mismatches,
        "orphan_pairs": orphan_pairs,
        "bucket_key_errors": bucket_key_errors,
    }

    # ---- day-encoding round trip (every distinct evidence date + density years)
    density = _load(out / "timeline" / "density.json")
    rt_fail = sum(1 for d in sorted(all_dates) if day_to_iso(iso_to_day(d)) != d)
    checks["day_roundtrip"] = {
        "passed": rt_fail == 0,
        "distinct_dates": len(all_dates),
        "failures": rt_fail,
        "density_years": len(density["years"]),
    }

    # ---- communities consistency
    comms = _load(out / "graph" / "communities.json")
    k = comms["count"]
    lens_ok = (
        len(comms["label"]) == k
        and len(comms["size"]) == k
        and len(comms["topMembers"]) == k
        and len(comms["center"]) == 3 * k
    )
    node_comm = nodes["community"]
    comm_range_ok = all(-1 <= c < k for c in node_comm)
    clustered = sum(1 for i, c in enumerate(node_comm) if c >= 0 and nodes["type"][i] == 0)
    sizes_ok = sum(comms["size"]) == clustered
    members_ok = all(cid in idx_of for tm in comms["topMembers"] for cid in tm)
    checks["communities"] = {
        "passed": bool(lens_ok and comm_range_ok and sizes_ok and members_ok),
        "count": k,
        "lengths_ok": bool(lens_ok),
        "community_ids_in_range": bool(comm_range_ok),
        "sizes_sum_matches": bool(sizes_ok),
        "top_members_resolve": bool(members_ok),
    }

    # ---- determinism canary (fixed subset, stable across runs)
    canary_obj = {
        "node_ids_head": nodes["id"][:200],
        "edges_head": [list(r) for r in records[:100]],
        "community_sizes": comms["size"],
    }
    canary = hashlib.sha256(
        json.dumps(canary_obj, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    checks["determinism_canary"] = {"passed": True, "sha256": canary}

    passed = all(c.get("passed", False) for c in checks.values())
    return passed, checks


def verify_checksums(out: Path, manifest: dict) -> tuple[bool, dict]:
    missing, mismatched = [], []
    for rel, want in sorted(manifest.get("checksums", {}).items()):
        p = out / rel
        if not p.exists():
            missing.append(rel)
            continue
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        if h != want:
            mismatched.append(rel)
    ok = not missing and not mismatched
    return ok, {
        "passed": ok,
        "files": len(manifest.get("checksums", {})),
        "missing": missing[:10],
        "mismatched": mismatched[:10],
    }


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        out = Path(argv[0])
    else:
        import os

        from .materialize import DEFAULT_OUT

        out = Path(os.environ.get("MATERIALIZED_OUT") or DEFAULT_OUT)

    manifest_path = out / "manifest.json"
    if not manifest_path.exists():
        print(f"validate FAILED — no manifest at {manifest_path}")
        return 1
    manifest = _load(manifest_path)

    cs_ok, cs = verify_checksums(out, manifest)
    passed, checks = run_checks(out, manifest["promo_bits"])
    checks["checksums"] = cs

    edges_count_ok = manifest["edges_bin"]["count"] == checks["edges_bin"]["count"]
    dr = manifest["date_range"]
    dr_ok = all(day_to_iso(iso_to_day(d)) == d for d in dr)
    checks["manifest_consistency"] = {
        "passed": bool(edges_count_ok and dr_ok and manifest["validation"]["passed"]),
        "edges_count_matches": bool(edges_count_ok),
        "date_range_roundtrip": bool(dr_ok),
        "manifest_validation_passed": bool(manifest["validation"]["passed"]),
    }

    ok = cs_ok and passed and checks["manifest_consistency"]["passed"]
    for name in sorted(checks):
        c = checks[name]
        print(f"[{'PASS' if c.get('passed') else 'FAIL'}] {name}: "
              + ", ".join(f"{k}={v}" for k, v in c.items() if k != "passed"))
    print("validate", "PASSED" if ok else "FAILED", f"— {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
