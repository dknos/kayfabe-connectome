# THE BOOK — Save Format (`save-format@1`)

## Storage

Browser vertical slice: IndexedDB database `the-book`, object store `saves`, keyed by
`manifest.save_id` (`apps/simulator/src/saves.ts`). The store interface is deliberately
narrow (`putSave/getSave/listSaves/deleteSave`) so desktop packaging can swap in SQLite
without touching callers.

## Envelope

```jsonc
{
  "manifest": {
    "save_id": "universe-<worldSeed>",
    "created_at": "2026-08-07T05:00:00.000Z",   // app-shell wall clock; NEVER read by the engine
    "current_game_date": "1997-02-05",
    "original_start_date": "1997-01-06",
    "world_seed": "book-1997-01-06",
    "engine_version": "0.1.0",
    "schema_version": 1,
    "data_bundle_hash": "<hash of corpus manifest counts+algorithms+schema>",
    "mod_manifest": [],
    "simulation_options": { /* SimOptions verbatim */ },
    "current_state_hash": "<106-bit hex digest>"
  },
  "state": { /* SimState — see packages/sim-contract/src/state.ts */ }
}
```

## State hashing

`current_state_hash = hashValue(state)` where `hashValue` is canonical JSON (sorted keys,
no whitespace, `undefined` members dropped, NaN/Infinity are hard errors) digested by two
independently-seeded cyrb53 passes (`packages/sim-contract/src/hash.ts`). Everything in
`SimState` is hashed — including serialized RNG stream states, ID counters, the
append-only `eventLog`, and the AI ledger — so hash equality means full behavioral
equality: a loaded save continues exactly as the unloaded universe would have.

## Load guarantees (`openSaveEnvelope`)

1. `schema_version` newer than the build → refuse with an upgrade message.
2. Recomputed state hash ≠ `current_state_hash` → refuse (corrupted/edited save).
3. `data_bundle_hash` ≠ local corpus → **warn, never remap**: the universe continues from
   its own state; only the Almanac may disagree with the local corpus.

## Determinism contract

- All engine randomness flows through named, serialized sfc32 streams (`SimState.rng`).
- The engine never calls `Date.now()` / `Math.random()`; `created_at` exists only in the
  manifest and is excluded from state hashing by construction.
- Covered by tests: `packages/sim-core/test/engine.test.ts` ("save → open reproduces the
  exact state hash", "identical command sequences reproduce identical hashes",
  "rejects tampered saves").

## Migration policy

`schema_version` bumps ship with an explicit migration in `openSaveEnvelope`'s path
(none yet at v1). Migrations are additive transforms — a save is never destroyed or
silently reinterpreted. Loading a v(N) save in a v(N+1) engine migrates a **copy** at
load time; the stored envelope is rewritten only on the next explicit save.
