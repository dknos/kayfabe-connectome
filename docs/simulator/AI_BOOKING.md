# THE BOOK — AI Booking

Full design and formulas: [rules/ai.md](rules/ai.md) (`ai-booker@1`). This document is
the orientation layer.

## Shape

One pure function per AI company per simulated day:
`aiDailyTick(ctx) → AiActions` (`sim-core/src/ai/`). The engine applies actions through
the **same validators and negotiation rules as the player** — AI cards pass
`validateCard`, AI offers pass `evaluateOffer`, AI cash obeys the same ledger.

Layers implemented in the slice:

1. **Scheduling** — weekly TV held 21 days ahead on the company's TV night; monthly PPV
   on its week; deterministic venue rotation.
2. **Programs (persistent plans)** — one per active title; challenger chosen by utility
   (momentum, awareness, credibility, alignment opposition, repetition avoidance,
   owner-profile biases); intended winner set by risk tolerance and plan loyalty;
   phases build → peak → blowoff toward the PPV; successors created after blowoffs.
3. **Cards** — TV 1 angle + 4 matches, PPV 6 + 1; main event from the world-title
   program (title matches only at the blowoff); undercard rotated by least-recent use;
   injuries respected; no double booking.
4. **Roster** — expiring pushed talent gets re-sign offers (market-priced); unused
   talent released only under cash pressure; occasional free-agent pursuit gated by an
   8-week cash projection.

## Reasoning ledger

Every decision records `{ action, reason, considered[] (top options with utilities) }`
into `state.aiLedger` (capped at 400 entries, serialized in saves). It is a
developer-facing diagnostic: inspect it in a save envelope or the console; it is not
exposed in normal play, where AI behavior is legible through the Wire, World Companies,
and Championships screens instead.

## Deliberate slice boundaries

Tag-title programs, house shows, inter-company talent raids as a *strategy*, company
birth/death, and bounded learning-from-failure are Phase 4 scope — see PROGRESS.md.
