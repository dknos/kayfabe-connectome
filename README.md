# KAYFABE CONNECTOME

A database-first, time-aware, three-dimensional network of professional
wrestling history, rendered as a living biological connectome.

Clean-room fresh build. This repository does not reuse, copy, or extend any prior
visualization project.

## Data sources (v2)

| Source | Role | Access |
|---|---|---|
| Local SQL database (SQLite) | Canonical for the six WWE-family promotions | Read-only, path via `WRESTLING_DB_PATH` |
| InitialWrestingMatchesFinal.csv | Canonical for 565 further promotions (NJPW, AJPW, NOAH, Dragon Gate, CMLL, ROH, …); enrichment (venue, Meltzer, PPV, card placement) inside family territory | Read-only cp1252 csv, path via `CSV_MATCHES_PATH` |
| wrestlingdb.org API | Enrichment / cross-reference (dormant upstream) | Server-side key via `WRESTLINGDB_API_KEY` |

Merged corpus: **365,485 matches · 30,291 people · 571 promotions ·
1947–2026**. Family csv rows crosswalk against the sqlite (98.7% hit) instead
of duplicating it; misses are ledgered, never guessed (docs/DECISIONS.md
D-007). No scraping. No other sources. Missing fields stay missing.

## Layout

```
apps/web/                 Vite + React + Three.js application
apps/api/                 Narrow typed API (FastAPI)
services/materializer/    Python: db doctor, extraction, normalization, projections
packages/                 Shared TS contracts, graph engine, renderer, state, ui
data/private|staging/     Never committed
data/materialized/        Build outputs consumed by the web app (never committed)
config/                   schema-map, source-registry, projection recipes
docs/                     Audits, decisions, architecture, boundaries
```

## Commands

```
pnpm db:doctor            Read-only audit of the source SQL database
pnpm wrestlingdb:doctor   WrestlingDB API contract audit (redacted)
pnpm data:materialize     Full materialization pipeline (~6s, deterministic)
pnpm data:validate        Re-validate an existing materialized tree
pnpm dev                  Web app → http://127.0.0.1:9460
pnpm test                 Vitest + pytest suites
npx playwright test       Full journey suite (desktop / mobile / reduced-motion)
node tests/qa-capture.mjs Headless screenshot sweep (dev server must be running)
```

## Opening the connectome

1. Place the corpora at `data/private/wwe_db_2026-01-18.sqlite` and
   `data/private/incoming-csv/InitialWrestingMatchesFinal.csv`
   (or set `WRESTLING_DB_PATH` / `CSV_MATCHES_PATH`)
2. `pnpm install && pnpm data:materialize` (~60s, deterministic)
3. `pnpm dev` → open http://127.0.0.1:9460, press `/` and search anyone.

## Configuration

Copy `.env.example` to `.env` and fill in values. Secrets never enter Git,
logs, screenshots, or browser bundles.
