# Decisions

Chronological record of architectural decisions. Newest last.

## D-001 — Fresh repository (2026-07-31)
Clean-room build in `~/kayfabe-connectome`. No code, CSS, components, routes, or
layouts from any prior project. Domain lessons (person ≠ persona, alias
resolution, explicit match sides, evidence-backed edges, provenance) are
reimplemented from first principles.

## D-002 — Source of truth (2026-07-31)
The local SQLite database (`wwe_db_2026-01-18.sqlite`, 171 MB) is the canonical
bulk corpus. wrestlingdb.org API is enrichment only: it may fill nulls and
propose candidate entities, never silently overwrite SQL values. Conflicts
become field assertions with explicit resolution state.

## D-003 — Missing credentials are not blockers (2026-07-31)
`WRESTLINGDB_API_KEY` is absent from the environment at build start. Scaffolding,
audits, materialization from SQL, and the full web app proceed. The WrestlingDB
sync ledger records the blocked state; the client ships with contract tests
against fixtures.

## D-004 — Read-only source access (2026-07-31)
The source database is opened with SQLite URI `mode=ro&immutable=1` on a private
copy in `data/private/`. No writes, no migrations, no repair statements ever
target the source. All project-owned state lives in separate files.
