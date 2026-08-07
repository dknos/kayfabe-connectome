# Changelog — THE BOOK

## 0.1.0 — 2026-08-07 · the playable vertical slice

First playable build, on branch `agent/simulator`.

- Three-layer data architecture: immutable corpus → start-date snapshot → mutable save
  universe. Anti-look-ahead enforced at extraction and under test.
- `snapshot-builder@1`: real-corpus universe creation (flagship 1997-01-06: WWF/WCW/ECW
  playable with historically correct rosters and champions), `roster-infer@1`,
  `persona-crosswalk@1` (40 curated identity groups), `company-lineage@1`.
- `evidence-seeder@1`: attribute seeding with confidence grades and named evidence.
- Deterministic engine: seeded serializable RNG streams, canonical state hashing,
  integer-cent double-entry-style ledger, command processor, day advancement.
- Show pipeline: `attendance-demand@1`, `crowd-flow@1`, `segment-eval@1`, settlement,
  participant effects, injuries, title lineage continuation.
- `negotiation@1` contracts with explainable counters; era-gated contract kinds.
- `ai-booker@1` rival companies: persistent title programs, weekly TV + monthly PPVs,
  roster upkeep, reason-coded decision ledger.
- 15-screen UI in an original editorial identity (wizard, control center, roster,
  profile, booker, live show, review, creative room, contracts, finance, wire,
  calendar, companies, championships, almanac, settings).
- `save-format@1`: IndexedDB envelopes, hash verification, tamper rejection.
- 115 automated tests including a full-journey Playwright E2E; one simulated year
  headless in 1.6 s.
