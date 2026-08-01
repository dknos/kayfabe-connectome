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

## D-005 — WrestlingDB API is dormant upstream (2026-07-31)
Code audit of OWDB @ e53596e proved the documented REST API has no routes;
live probe 404s. The client ships as a doctor + blocked-state sync ledger
against the dormant contract (Token auth, PageNumberPagination page-size 100,
anon 100/hr, user 10000/hr). No polling, no auth guessing. Revisit when
upstream ships `/api/`. Fandom (user-suggested) recorded as v2 backlog only.

## D-006 — v1 serves static materialized chunks (2026-07-31)
The corpus (~4.6k people / 88k matches) materializes to a few MB of chunked,
lazily-loaded static files. The web app consumes them directly; the FastAPI
surface is deferred until a deployment needs server-side path/query compute.
Documented as a known limitation, not a gap: no endpoint the vertical slice
needs is missing.

## D-004 — Read-only source access (2026-07-31)
The source database is opened with SQLite URI `mode=ro&immutable=1` on a private
copy in `data/private/`. No writes, no migrations, no repair statements ever
target the source. All project-owned state lives in separate files.
