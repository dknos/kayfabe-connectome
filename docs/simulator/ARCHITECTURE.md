# THE BOOK — Architecture

Sibling application to the Kayfabe Connectome. The Connectome renders immutable history;
THE BOOK forks mutable alternate-history universes from immutable snapshots of the same
canonical corpus. Neither writes to the other.

## Three data layers

```
LAYER 1  Immutable historical corpus      data/materialized/  (built by services/materializer)
         365,485 matches · 30,291 people · 571 promotions · read-only, checksummed
                     │
                     │  @kayfabe/history-adapter
                     │  fetch + persona-crosswalk overlay + company lineages
                     │  + roster inference + evidence extraction  (all ≤ start date)
                     ▼
LAYER 2  Start-date snapshot              UniverseSnapshot (in-memory, hashed)
         active companies/rosters/champions/seeded attributes at date D
         reproducible: same corpus + same date + same crosswalk ⇒ same snapshotHash
                     │
                     │  @kayfabe/sim-core  createUniverse()
                     ▼
LAYER 3  Mutable save universe            SimState (IndexedDB, versioned envelope)
         seeded RNG streams · append-only event log · deterministic state hash
```

Anti-look-ahead is enforced **by construction**: the adapter's extraction functions take
`startDay` (epoch-1900 int, matching the corpus encoding) and filter every record stream
before anything downstream sees it; tests feed post-start fixtures and assert exclusion.

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@kayfabe/sim-contract` | every shared type; zod schemas at the two boundaries (corpus files in, save envelopes in) | zod |
| `@kayfabe/sim-core` | deterministic engine. Foundation: seeded serializable RNG streams, canonical-JSON hashing, pure Gregorian date math, integer-cent money. Systems: snapshot→state init, day advancement, contracts, booking validation, show/crowd simulation, popularity, finance ledger, injuries, AI companies, news, persistence | sim-contract |
| `@kayfabe/history-adapter` | corpus fetch (pluggable `fetchJson`), persona crosswalk overlay, company lineage stitching, roster inference (`roster-infer@1`), evidence extraction for the ratings seeder, data-health report | sim-contract, zod |
| `@kayfabe/simulator` (apps/simulator) | Vite+React UI, IndexedDB save store, worker-ready engine facade, Playwright E2E | all of the above |

`sim-core` is DOM-free and side-effect-free: the engine is
`(state, command) → { state', report?, events }` plus `advanceDay`. All iteration over
`Record` collections goes through sorted keys; the only nondeterminism source is the
seeded RNG hub, whose stream states serialize into every save.

## Serving & storage

- Dev/preview: Vite middleware serves `../../data/materialized` at `/data/*`
  (path-jailed, same pattern as apps/web). Simulator dev port **9465**, preview **9466**
  (9460/9461/9462 are claimed by web/spacetime).
- Saves: IndexedDB (`the-book/saves`), envelope = manifest + full SimState JSON.
  Manifest: `save_id, created_at, current_game_date, original_start_date, world_seed,
  engine_version, schema_version, data_bundle_hash, mod_manifest, simulation_options,
  current_state_hash`. `created_at` is stamped by the app shell (wall clock never enters
  the engine).
- Desktop packaging (Electron + SQLite saves) is a later phase; the storage interface is
  behind `SaveStore` so the swap is additive.

## Determinism contract

- `worldSeed` + snapshot + identical command sequence ⇒ identical `current_state_hash`
  (canonical JSON → 106-bit digest, `sim-core/hash.ts`).
- RNG: named sfc32 streams per subsystem (`crowd`, `injuries`, `ai:<companyId>`, …),
  serialized/restored exactly.
- No `Date.now()`, no `Math.random()`, no float money, no unsorted map iteration in the
  engine. NaN/Infinity in state is a hard error at hash time.
- Save→load→hash equality and replay-from-snapshot equality are covered by tests.

## Simulation detail tiers

- FULL: player company + named rivals — segment-level shows, full crowd model.
- STANDARD: other active inferred companies — abbreviated show simulation.
- ABSTRACT: distant companies — weekly aggregate tick (popularity drift, finances,
  occasional news). Tier migration by relevance is a Phase 4 concern; the field exists
  in state now so saves won't break.

## What deliberately does not exist yet

Owner/booker delegation depth, departments, broadcasting negotiation, touring routing,
mod manager UI, Electron packaging, and the full 24-screen set are roadmap (Phases 2–6).
`PROGRESS.md` tracks the honest line between implemented and planned.
