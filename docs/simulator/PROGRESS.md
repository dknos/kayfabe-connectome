# THE BOOK — Progress Ledger

Honest status against the full product vision. Nothing below is claimed without a test,
a screenshot, or a command you can rerun. Last updated: 2026-08-07 (branch
`agent/simulator`).

## Evidence of the current build

- `pnpm --filter @kayfabe/sim-core test` — **99 tests passing** (foundation, seeder,
  show, finance, negotiation, AI, engine integration, one-year benchmark).
- `pnpm --filter @kayfabe/history-adapter test` — **15 tests passing** (synthetic
  fixtures + real-corpus 1997-01-06 integration build).
- `npx playwright test -c apps/simulator/playwright.config.ts` — **the vertical-slice
  E2E passes** (12.6 s): create universe from the real corpus → alias search (Cactus
  Jack / Mankind → one Mick Foley) → profile with provenance → contract negotiation →
  schedule at a real venue → book 3 segments → run the show → crowd replay →
  explainable review → ledger → 30 days with AI rivals → save → reload →
  **identical state hash**.
- `npx vite build` — production bundle 352 KB (108 KB gzip).
- Screenshots of every core screen: `test-results/simulator-shots/` (12 captures).
- Typechecks clean across all four packages (strict TS).

## Vertical-slice acceptance (spec XXXIII) — item by item

| # | Criterion | Status |
|---|---|---|
| 1 | Launch without dev intervention | ✅ `pnpm --filter @kayfabe/simulator dev` → :9465 |
| 2 | Select a supported historical start date | ✅ wizard presets + free date, coverage note |
| 3 | Generate valid universe from real canonical data | ✅ 1997-01-06: WWF 56 / WCW 76 / ECW 45 rosters, real champions (Sycho Sid, The Giant, Raven) |
| 4 | Select promotion + owner/booker/hybrid role | ✅ role selected & stored; ⚠️ roles currently play identically (see gaps) |
| 5 | Alias search without duplicate people | ✅ Almanac canonicalizes via persona-crosswalk@1 (40 curated groups) — E2E-verified |
| 6 | Inspect pre-start history + current state | ✅ profile: history note, evidence-backed scouted attributes with confidence + input tooltips |
| 7 | Negotiate/alter a contract | ✅ offer→accept/counter/reject with plain-language reasons; counters acceptable in one click |
| 8 | Schedule event at real venue and date | ✅ venues derived from corpus locations (capacity is a documented estimate) |
| 9 | Storyline with future milestone | ✅ Creative Room; heat evolves from segment reception |
| 10 | Drag participants into matches/segments | ✅ click-to-assign primary + HTML5 drag; multi-side matches; multi-beat angles with roles |
| 11 | Run the show | ✅ full pipeline: attendance → performance → settlement → effects |
| 12 | Crowd-state changes during the card | ✅ 7-axis crowd replay, segment by segment |
| 13 | Explainable segment/show feedback | ✅ execution vs reception component tables, per-participant effects, plain notes |
| 14 | Attendance/revenue/expenses/profit in ledger | ✅ every line is a typed transaction; balance invariant under test |
| 15 | Morale/momentum/affinity/awareness/fatigue/injuries update | ✅ bounded deltas from participant effects; injuries with recovery dates |
| 16 | AI companies run shows and make roster decisions | ✅ persistent programs, weekly TV + monthly PPVs, re-signings, reason codes in `state.aiLedger` |
| 17 | Advance ≥30 days | ✅ E2E advances 30; benchmark advances 365 |
| 18 | Save and reload | ✅ IndexedDB envelope |
| 19 | Same state hash after reload | ✅ E2E-verified, unit-verified, tamper-detected |
| 20 | Almanac without altering the save | ✅ read-only corpus reads, labeled immutable |
| 21 | Automated E2E passes | ✅ |
| 22 | Production desktop package | ⚠️ **not done** — production *web* build exists; Electron packaging is Phase 6. This is the one acceptance item honestly unmet. |

## Beyond the slice: the hard camera (0.3.0)

`match-engine@1` gives every match a beat-by-beat in-ring story (presentational over the
computed result, own RNG stream, deterministic), animated in the Live Show's canvas ring
visual — crowd bowl density = real attendance vs venue capacity, seats pop with beat
heat, tokens act out control/high spots/near-falls/the finish, play-by-play call
beneath, full beat sheet in the Post-Show Review. `autobook@1` puts the AI's card
builder behind an Auto-book button: deterministic proposals, fully editable, same
validation gate. 124 unit tests + both E2E journeys (which now assert the ring renders).

## Beyond the slice: founder mode (0.2.0)

Added after the slice acceptance: **found your own promotion** — empty roster, chosen
backing and Product DNA, a home athletic club, and the real free-agent pool
(`free-agent-pool@1`, up to 120 window-active unrostered workers) to hire from via the
Talent Market screen. Custom championships (`CREATE_TITLE`, inaugural champions crowned
in the ring on vacant belts) and earned tier progression (`company-growth@1`:
indie → regional → national, TV/PPV arriving on promotion, overheads scaling to match —
for AI companies too). Verified by 4 founder engine tests and a second Playwright
journey (found → hire two free agents → create title → run night one).

## Implemented systems (with their rules docs)

- Deterministic core: seeded serializable RNG streams, canonical hashing, pure calendar,
  integer-cent money (`sim-core` foundation).
- `snapshot-builder@1` + `roster-infer@1` + `persona-crosswalk@1` + `company-lineage@1`
  (docs/simulator/HISTORICAL_SNAPSHOTS.md) — anti-look-ahead by construction and by test.
- `evidence-seeder@1` (rules/seeder.md) — Bayesian shrinkage, confidence grades, evidence
  named per attribute; titles/win% treated as positioning, never skill.
- `crowd-flow@1` + `segment-eval@1` (rules/show.md) — role-aware execution (silent
  victims not rated on promo), DNA-weighted reception, bounded crowd axes, plan-decided
  finishes, DQ protects titles.
- `attendance-demand@1` + `ledger@1` (rules/finance.md) — demand model, settlement,
  weekly finances, balance invariant.
- `negotiation@1` (rules/negotiation.md) — explainable utility, counters, era gating.
- `ai-booker@1` (rules/ai.md) — persistent programs, scheduling, valid cards through the
  same validator as the player, budget respect, reason codes.
- Save format `save-format@1` (SAVE_FORMAT.md) — hash-verified envelopes, migration policy.
- 15 connected screens in an original editorial visual identity.

## Known gaps and honest caveats (the road ahead)

**Spec phases not yet started:** owner/booker delegation depth, departments & staff,
Creative Cohesion, broadcasting negotiation, touring routing, media/press interactions,
tournaments, teams/stables as first-class state, training & rookie generation, company
birth/death/acquisition, mod manager UI, era-spanning saves, Electron packaging,
AI creative assistant. `HistoricalMode` guided/strict/fictional are contract-only.

**Within the slice, flagged for tuning/deepening:**
- Owner, booker and owner-booker currently grant identical control (disclosed in-game on
  Settings).
- PPV buy-rate math is generous for weak cards (a 4,000-seat show grossed $4.6M PPV in
  the screenshot walk); needs card-quality gating in the buy-rate factor.
- Indie AI companies without TV deals run no shows (house-show AI is a slice non-goal);
  they still hold rosters and negotiate.
- Relationships are minimal (blanket locker-room morale effects; no per-edge model yet).
- `mainEventShare` and Meltzer evidence are null in seeding — person-matches@1 rows
  carry neither placement nor `mr` (verified in the producer); the seeder handles both
  as evidence when a future materializer adds them.
- Markets are a static original 12-market dataset; per-market audience simulation is
  shallow (national + sparse deltas).
- Roster inference misses part-timers below thresholds; thresholds are shown in-game.
- The engine runs on the UI thread behind an async-ready store; at measured speeds
  (4.4 ms/day fixture) this is invisible, and the worker move is architected for.

## How to pick the work back up

1. Read docs/simulator-audit.md, then docs/simulator/ARCHITECTURE.md.
2. Run the test suites and the E2E (commands above) — they are the spec of record.
3. Highest-value next increments, in order: PPV buy-rate gating; per-market audience
   depth; owner/booker authority split (contract types exist); teams/stables state;
   press-conference loop; Electron shell + SQLite `SaveStore`.
