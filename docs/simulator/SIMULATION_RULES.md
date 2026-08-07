# THE BOOK — Simulation Rules

Umbrella document for the engine's numerical systems. Every formula here is original,
bounded, and covered by tests; each subsystem's full derivation lives in its own rules
file, written alongside the code that implements it:

| System | Version | Rules document | Implementation | Tests |
|---|---|---|---|---|
| Ratings seeding | `evidence-seeder@1` | [rules/seeder.md](rules/seeder.md) | `sim-core/src/seeder/` | `test/seeder.test.ts` |
| Crowd & segment evaluation | `crowd-flow@1`, `segment-eval@1` | [rules/show.md](rules/show.md) | `sim-core/src/show/` | `test/show.test.ts` |
| Attendance & money | `attendance-demand@1`, `ledger@1` | [rules/finance.md](rules/finance.md) | `sim-core/src/finance/` | `test/finance.test.ts` |
| Contract negotiation | `negotiation@1` | [rules/negotiation.md](rules/negotiation.md) | `sim-core/src/market/` | `test/market.test.ts` |
| AI booking | `ai-booker@1` | [rules/ai.md](rules/ai.md) | `sim-core/src/ai/` | `test/ai.test.ts` |
| Snapshot & rosters | `snapshot-builder@1`, `roster-infer@1`, `free-agent-pool@1` | [HISTORICAL_SNAPSHOTS.md](HISTORICAL_SNAPSHOTS.md) | `history-adapter/src/` | adapter tests |
| Company growth | `company-growth@1` | this file, below | `sim-core/src/engine.ts` | `test/founder.test.ts` |

## Cross-cutting principles

1. **Bounded, explainable, never raw addition.** Scores compose through normalized
   components with soft nonlinear transforms; every player-facing number decomposes into
   labeled `ScoreComponent`s.
2. **Execution vs reception.** A segment is first *performed* (worker execution of their
   actual roles) and then *received* (execution measured against expectation, stakes,
   affinity, novelty, product alignment, pacing). A company is graded against its own
   Product DNA, not a universal taste.
3. **Separate audience quantities.** Awareness ≠ affinity ≠ momentum ≠ credibility ≠
   prestige. Drawing power derives from combinations, never one popularity scalar.
4. **Missing data is not zero.** Sparse evidence widens confidence, never lowers value.
5. **Determinism.** All randomness through named seeded streams; no wall clock; no
   float money; sorted iteration; state hashes reproduce across save/load.
6. **The plan decides finishes.** The simulation grades booking; it never overrides a
   booked winner. Titles change hands only through booked title matches (DQ/count-out
   protects the champion) or explicit administrative action.

## company-growth@1

Checked every Monday for every active company (player and AI under the same rule):

- **indie → regional**: national awareness ≥ 35 AND cash ≥ $250,000 AND ≥ 10 completed
  shows. Grants a weekly TV slot when the era has television (reach 30).
- **regional → national**: national awareness ≥ 55 AND cash ≥ $2,000,000 AND ≥ 30
  completed shows. TV reach rises to 70; a monthly pay-per-view slot opens when the era
  has PPV; +5 prestige.

Promotion is earned, never free: the moment the tier changes, weekly office overhead and
per-show production costs bill at the new tier's rates (`era.weeklyOverheadCents` /
`era.showOverheadCents`), so growing before the gate receipts support it is a real way
to die. There is no demotion in the slice; failure expresses itself through cash.

## free-agent-pool@1 (adapter)

Window-active people (≥ 4 appearances across all promotions in the 540-day window, last
appearance within 240 days of the start date) who cleared **no** company's roster
inference start the universe unattached and hireable, capped at the top 120 by window
appearances. Same anti-look-ahead boundary as everything else; the pool is noted in the
snapshot's data-health report. Player-founded startups hire from this pool through the
same negotiation rules as everyone else.
