# HANDOFF — THE BOOK (wrestling promoter simulator)

Read this first if you are a fresh session picking up this project. Everything below is
implemented and verified unless explicitly marked as a gap. Written 2026-08-07.

## What this is

**THE BOOK** is a playable wrestling business & booking simulator built on the Kayfabe
Connectome's canonical historical corpus (365,485 documented matches, 30,291 canonical
people, 571 promotions, 1947–2026). Pick a historical start date (flagship:
**1997-01-06**, the Monday Night War) and either take over a real promotion — WWF, WCW,
ECW with their real inferred rosters and real champions (Sycho Sid, The Giant, Raven) —
or **found your own indy** and grow it into a national rival. Everything before your
start date is the immutable record; everything after is your deterministic, seeded
alternate history.

Current version 0.3.0. Three feature waves shipped: the vertical slice, founder mode
(free agents, custom belts, tier growth), and "the hard camera" (beat-by-beat match
engine + canvas ring visual + auto-booking).

## Where and how

- **Worktree:** `~/kayfabe-connectome-simulator`, branch `agent/simulator`, pushed to
  `origin` (github dknos/kayfabe-connectome). This is a git worktree of
  `~/kayfabe-connectome` (whose main checkout is on `agent/arena-array` — another
  agent's territory, DO NOT touch it or `apps/web` or `services/materializer`).
- **Data:** `data/` here is a **symlink** to the main checkout's data dir (gitignored,
  ~1.6 GB). Read-only, always. Never write inside `data/materialized/` (600 sha256
  checksums; the Pages deploy publishes that tree wholesale).
- **Run:** `pnpm install && pnpm --filter @kayfabe/simulator dev` → http://127.0.0.1:9465
  (preview 9466). Ports 9460/9461/9462 belong to the Connectome apps — never take them.
- **Saves:** browser IndexedDB (`the-book`/`saves`), hash-verified envelopes.

## Verify before believing anything (the suites are the spec of record)

```bash
cd ~/kayfabe-connectome-simulator
pnpm --filter @kayfabe/sim-core test          # 109 tests: engine, seeder, show, finance,
                                              # negotiation, AI, founder, match engine, benchmark
pnpm --filter @kayfabe/history-adapter test   # 15 tests incl. real-corpus 1997 build (~1.5s)
npx playwright test -c apps/simulator/playwright.config.ts --grep-invert screenshots
                                              # 2 journeys: full slice loop + founder mode
npx playwright test -c apps/simulator/playwright.config.ts --grep screenshots
                                              # visual captures → test-results/simulator-shots/
```

All green as of the last commit. One simulated year runs headless in ~1.6 s (fixture);
the full E2E (real corpus, browser, 30 sim days, save/reload/hash-equality) runs ~12 s.

## Architecture in one breath

Three layers: **immutable corpus** (`data/materialized/`, built by the Python
materializer, consumed read-only over `/data/*` middleware) → **start-date snapshot**
(`@kayfabe/history-adapter`: anti-look-ahead by construction, everything ≤ startDay) →
**mutable save universe** (`@kayfabe/sim-core`: deterministic engine,
`(state, command) → {state', events}`, seeded serializable RNG streams, canonical-JSON
state hashing, integer-cent ledger). UI is `apps/simulator` (Vite + React 18 + zustand,
15 screens, editorial paper/ink design system in `src/theme.css`). Types live in
`@kayfabe/sim-contract`.

Docs, in reading order: `docs/simulator-audit.md` (the corpus ground truth) →
`docs/simulator/ARCHITECTURE.md` → `docs/simulator/PROGRESS.md` (honest acceptance
table + gaps) → `docs/simulator/SIMULATION_RULES.md` (every formula, versioned) →
`DATA_CONTRACT / SAVE_FORMAT / HISTORICAL_SNAPSHOTS / AI_BOOKING / MODDING /
PERFORMANCE / ACCESSIBILITY / CHANGELOG`.

## Traps that will bite you (learned the hard way)

1. **The corpus has NO alias layer.** Same human under different ring names = different
   corpus persons (Mick Foley is three). Identity merging is the simulator's
   `persona-crosswalk@1` overlay (40 curated groups,
   `packages/history-adapter/src/data/persona-crosswalk.json`). Never assume corpus
   person = human; never auto-merge — unresolved suspects go to data health.
2. **NO employment records exist.** Rosters are inferred (`roster-infer@1`: ≥6
   appearances in 540 days, last ≤120 days). Free agents are the looser bar
   (`free-agent-pool@1`: ≥4 apps, ≤240 days, cap 120, unrostered).
3. **Mixed date encodings.** Timeline/championships/evidence files use epoch-**1900**
   day ints; PersonDossier `first`/`last` and dossier reign `s`/`e` are ISO **strings**.
   `corpusDayToIso` in sim-core converts (1900→1970 offset 25567).
4. **evidence/person rows have no placement and no Meltzer** (`p` = partners list!).
   Seeder handles both as null; don't "fix" this by inventing values.
5. **Determinism is sacred.** No `Date.now()`/`Math.random()` in engine code (UI-only
   visuals may use them); all Record iteration via sorted keys; all randomness through
   named RngHub streams serialized into saves. The match engine deliberately derives its
   own stream from `(showId, segmentId)` so it consumes nothing from the show's draw
   schedule — preserve that pattern for any new presentational system.
6. **IDs are opaque strings** (`p:116704`, `p:c8f21aa04`, `pr:11791`). Never Number()
   them, never numeric-sort them.
7. **`sim-core/src/index.ts` re-exports everything**; engine result on validation error
   returns the ORIGINAL state object untouched with `errors` set — keep that contract.
8. **Money is integer cents everywhere.** `money.ts` asserts; floats throw.

## What's real (selected)

- Universe wizard: presets + any 1950–2025 date; take-over or found-your-own (name,
  market, backing $75K/$250K/$1M, Product-DNA identity presets).
- Booking: 3-pane board, multi-side matches, multi-beat angles with per-participant
  roles, click-to-assign + drag, per-segment explicit auto-fill, whole-card
  **Auto-book** (`autobook@1`, reuses the AI's `buildCardForShow`), live validation +
  attendance/gate forecasts.
- Show night: attendance demand model → `match-engine@1` beat logs → canvas ring visual
  (crowd bowl fills to attendance/capacity, tokens act out beats, referee counts) →
  crowd-state dials → fully explainable post-show review (execution vs reception
  component tables, per-participant deltas, beat sheet, itemized money).
- World: AI rivals with persistent title programs run weekly TV + monthly PPVs through
  the same validators; contracts negotiate with plain-language counters; injuries,
  morale, momentum, awareness/affinity all move; news via The Ringside Ledger;
  `company-growth@1` promotes indie→regional→national (TV/PPV unlock, overheads scale)
  for player AND AI.
- Almanac: read-only corpus search, crosswalk-canonicalized (searching "Cactus Jack" or
  "Mankind" yields one Mick Foley).
- Saves: deterministic state hash, tamper rejection, E2E-proven reload equality.

## Honest gaps (from PROGRESS.md — do not re-discover these)

- **Electron/desktop packaging absent** (the one unmet slice-acceptance item; web build
  works). Owner/booker/owner-booker roles play identically (disclosed in-game).
- PPV buy-rate is generous for weak cards (flagged for gating by card quality).
- Indie AI companies without TV run no shows (house-show AI unbuilt); they still hold
  rosters and negotiate. Relationships are minimal. Markets are a static original 12.
- Not started: departments/staff/Creative Cohesion, broadcasting negotiation, touring,
  tournaments, teams/stables as state, training/rookie generation, company
  birth/death/acquisition, mod manager UI, guided/strict/fictional modes.
- Suggested next increments (in order): PPV buy-rate gating; per-market audience depth;
  owner/booker authority split; teams & stables; press conferences; Electron + SQLite
  SaveStore; beat-playback speed toggle.

## Coordination protocol (this workspace is multi-agent)

Announce yourself in Discord `#errors` (channel 915789984282325016) as your agent name
before working; commit small and descriptive on `agent/simulator`; never `pnpm install`
new deps without checking the workspace; never touch the Connectome apps, the
materializer, `data/`, or other agents' branches (`agent/arena-array`,
`agent/spacetime-warp`). The curl snippet for #errors is in `~/CLAUDE.md`.

```bash
# start here
cd ~/kayfabe-connectome-simulator && git pull && git log --oneline -6
pnpm install && pnpm --filter @kayfabe/simulator dev   # :9465
```
