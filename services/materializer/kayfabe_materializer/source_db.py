"""Read-only access to the source SQLite corpus."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB = REPO_ROOT / "data" / "private" / "wwe_db_2026-01-18.sqlite"

FORBIDDEN = ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE", "VACUUM", "REPLACE", "ATTACH")


def source_db_path() -> Path:
    p = os.environ.get("WRESTLING_DB_PATH")
    return Path(p) if p else DEFAULT_DB


def connect_readonly(path: Path | None = None) -> sqlite3.Connection:
    """Open the source corpus immutably. Any write attempt raises."""
    db = path or source_db_path()
    if not db.exists():
        raise FileNotFoundError(
            f"Source database not found. Set WRESTLING_DB_PATH (looked at {db})."
        )
    con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True)
    con.row_factory = sqlite3.Row
    return con


def guard_sql(sql: str) -> str:
    head = sql.lstrip().split(None, 1)[0].upper() if sql.strip() else ""
    if head in FORBIDDEN:
        raise PermissionError(f"Write statement blocked against source database: {head}")
    return sql
