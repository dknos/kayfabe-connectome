"""WrestlingDB (OWDB) API doctor — reports contract + credential state.

The full audit lives in docs/WRESTLINGDB-API-AUDIT.md; the machine contract in
config/wrestlingdb-contract.json. This command re-checks local state without
touching the network and never prints secret values.
"""

from __future__ import annotations

import json
import os

from .source_db import REPO_ROOT


def main() -> None:
    contract_path = REPO_ROOT / "config" / "wrestlingdb-contract.json"
    contract = json.loads(contract_path.read_text())

    key_present = bool(os.environ.get("WRESTLINGDB_API_KEY"))
    print("wrestlingdb:doctor")
    print(f"  contract: {contract_path.relative_to(REPO_ROOT)} (v{contract.get('contract_version')})")
    print(f"  derived from: {contract.get('repo')} @ {contract.get('commit_or_date')}")
    print(f"  api root: {contract.get('api_root') or 'NONE — no /api/ routes exist upstream'}")
    print(f"  WRESTLINGDB_API_KEY present: {key_present} (value never printed)")
    blocked = contract.get("blocked", {})
    for k, v in blocked.items():
        print(f"  BLOCKED — {k}: {v}")
    print(
        "  status: sync remains disabled until upstream ships API endpoints "
        "AND a key is configured. Local SQL corpus is the sole live source."
    )


if __name__ == "__main__":
    main()
