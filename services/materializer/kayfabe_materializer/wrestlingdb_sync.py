"""WrestlingDB synchronization — currently a safe, honest no-op.

Upstream OWDB exposes no API endpoints (verified 2026-07-31; see
docs/WRESTLINGDB-API-AUDIT.md). This command records a ledger entry describing
the blocked state instead of hammering a nonexistent service. When upstream
ships endpoints and WRESTLINGDB_API_KEY is set, the real client replaces the
`blocked` branch — the ledger format already matches the spec.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from .source_db import REPO_ROOT

LEDGER = REPO_ROOT / "data" / "staging" / "wrestlingdb" / "ledger.json"


def main() -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    entries = json.loads(LEDGER.read_text()) if LEDGER.exists() else []
    key_present = bool(os.environ.get("WRESTLINGDB_API_KEY"))
    entry = {
        "resource": "all",
        "started": datetime.now(timezone.utc).isoformat(),
        "completed": datetime.now(timezone.utc).isoformat(),
        "requests": 0,
        "responses": 0,
        "inserts": 0,
        "update_candidates": 0,
        "conflicts": 0,
        "errors": 0,
        "retries": 0,
        "quota_state": "n/a",
        "checkpoint": None,
        "source_contract_version": "1.0.0",
        "blocked": (
            "upstream exposes no API endpoints (404 verified 2026-07-31)"
            + ("" if key_present else "; WRESTLINGDB_API_KEY absent")
        ),
    }
    entries.append(entry)
    LEDGER.write_text(json.dumps(entries, indent=1))
    print(f"wrestlingdb:sync — blocked, ledger entry appended ({LEDGER.relative_to(REPO_ROOT)})")
    print(f"  reason: {entry['blocked']}")


if __name__ == "__main__":
    main()
