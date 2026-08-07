# THE BOOK — Wrestling Promoter Simulator

A wrestling business & booking simulator built on the Kayfabe Connectome's canonical
historical corpus (365,485 documented matches, 1947–2026). Sibling application to the
Connectome visualizer; consumes the same materialized data **read-only** and forks
mutable alternate-history universes from immutable start-date snapshots.

## Run

```bash
# from the repo root (data/materialized must exist — see docs/simulator-audit.md)
pnpm install
pnpm --filter @kayfabe/simulator dev     # http://127.0.0.1:9465
```

## Test

```bash
pnpm --filter @kayfabe/sim-contract test
pnpm --filter @kayfabe/sim-core test          # engine, seeder, show, finance, market, AI
pnpm --filter @kayfabe/history-adapter test   # crosswalk, snapshot builder (+ real-corpus integration)
npx playwright test -c apps/simulator/playwright.config.ts   # vertical-slice E2E
```

## Documentation

- `docs/simulator-audit.md` — workspace & data audit (read first)
- `docs/simulator/GAME_DESIGN.md` — design intent
- `docs/simulator/ARCHITECTURE.md` — three-layer data architecture, packages
- `docs/simulator/DATA_CONTRACT.md` — corpus consumption + owned formats
- `docs/simulator/SIMULATION_RULES.md` — every formula, versioned, tested
- `docs/simulator/SAVE_FORMAT.md`, `docs/simulator/HISTORICAL_SNAPSHOTS.md`,
  `docs/simulator/AI_BOOKING.md`, `docs/simulator/MODDING.md`,
  `docs/simulator/PERFORMANCE.md`, `docs/simulator/ACCESSIBILITY.md`
- `docs/simulator/PROGRESS.md` — honest implementation status, acceptance table, gaps
- `docs/simulator/CHANGELOG.md`, `docs/simulator/RELEASE_CHECKLIST.md`

## Principles

History is terrain; no look-ahead; explainable numbers; unknown ≠ zero; one human, many
masks; deterministic replay. The corpus is never mutated and never bundled with images
or private source data.
