"""Kayfabe Connectome materializer.

All source-database access is read-only (sqlite URI mode=ro&immutable=1).
No module in this package may execute DDL/DML against the source corpus.
"""

SOURCE_SCHEMA_VERSION = "wwe_db_2026-01-18"
MATERIALIZATION_SCHEMA_VERSION = "2.0.0"
