"""Human-readable summary of an existing materialized tree."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        out = Path(argv[0])
    else:
        from .materialize import DEFAULT_OUT

        out = Path(os.environ.get("MATERIALIZED_OUT") or DEFAULT_OUT)

    manifest_path = out / "manifest.json"
    if not manifest_path.exists():
        print(f"No materialized tree at {out} (missing manifest.json). Run:")
        print("  PYTHONPATH=services/materializer python3.12 -m kayfabe_materializer.materialize")
        return 1
    manifest = json.loads(manifest_path.read_text())
    comms = json.loads((out / "graph" / "communities.json").read_text())
    metrics = json.loads((out / "quality" / "metrics.json").read_text())

    c = manifest["counts"]
    print("Kayfabe Connectome — materialized graph")
    print(f"  schema {manifest['schema_version']}  built {manifest['built_at']}")
    print(f"  source sha256 {manifest['source_fingerprint'][:16]}…")
    print(f"  dates {manifest['date_range'][0]} → {manifest['date_range'][1]}")
    print(
        f"  people {c['people']:,} (+{c['derived_people']:,} derived)  "
        f"promotions {c['promotions']}  titles {c['titles']:,}"
    )
    print(
        f"  cards {c['cards']:,}  matches {c['matches']:,}  edges {c['edges']:,}  "
        f"title changes {c['title_changes']:,}"
    )
    print(f"  communities {c['communities']}  files {len(manifest['checksums']) + 1}")
    print("  top communities:")
    order = sorted(range(comms["count"]), key=lambda i: -comms["size"][i])[:8]
    for i in order:
        tops = ", ".join(comms["topMembers"][i][:3])
        print(f"    #{i:<3} {comms['label'][i]:<14} size {comms['size'][i]:>5}  top: {tops}")
    cnt = metrics["counters"]
    print(
        "  projection: obs "
        f"{cnt['observations_total']:,} (partner {sum(cnt['partner_obs_by_form'].values()):,}, "
        f"opposed {sum(cnt['opposed_obs_by_form'].values()):,}, br {cnt['br_obs']:,}); "
        f"multiway loser pairs suppressed {cnt['multiway_loser_pairs_suppressed']:,}"
    )
    ok = manifest["validation"]["passed"] and metrics["passed"]
    print(f"  validation: {'PASSED' if ok else 'FAILED'} "
          f"({', '.join(k for k, v in manifest['validation']['checks'].items() if v)})")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
