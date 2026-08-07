# Changelog — THE BOOK

## 0.3.0 — 2026-08-07 · the hard camera

- **`match-engine@1`**: every match now generates a beat-by-beat in-ring story —
  entrances, style-flavored openings, control/cutoff/comeback structure, risk-scaled
  high spots, reception-earned near-falls, and a finish call matching the booked result
  (with title-change announcements). Presentational only; its RNG derives from
  (show, segment) so existing determinism is bit-for-bit untouched.
- **Ring visual**: the Live Show screen renders the arena on canvas — crowd bowl density
  is the night's real attendance vs venue capacity, seats pop with beat heat, wrestler
  tokens act out each beat (control, high spots, near-fall counts, the finish), with the
  play-by-play call beneath. Honors reduced motion; sized to the building.
- **`autobook@1` + Auto-book button**: fill any card through the same booking philosophy
  the AI uses (programs, rotation, no double-booking) — deterministic per show, fully
  editable afterward, same validation gate as hand-booking.
- Post-Show Review gains the collapsible "call, beat by beat" sheet per match.
- Tests: +6 (match-engine structure/determinism/title calls, autobook validity/purity);
  both E2E journeys now exercise auto-book and assert the ring scene renders. 124 unit
  tests + 2 E2E journeys green.

## 0.2.0 — 2026-08-07 · found your own promotion

- **Founder mode** in the New Universe wizard: name your promotion, pick a home market,
  choose backing ($75K / $250K / $1M) and a Product DNA identity preset; start with an
  empty roster, a modest home venue, and no television.
- **`free-agent-pool@1`**: the snapshot now includes up to 120 window-active but
  unrostered workers as hireable free agents (January 1997 yields Bam Bam Bigelow,
  Bob Backlund, Scott Steiner and 117 more).
- **Talent Market screen**: unattached workers with market-price estimates, plus a
  watchlist of rival contracts expiring within 30 days (exclusive vs approachable).
- **CREATE_TITLE command + Championships UI**: unveil your own belts (low prestige until
  defended); inaugural champions crowned through booked title matches on vacant titles.
- **`company-growth@1`**: earned tier progression for player AND AI companies —
  indie → regional → national with TV deals and PPV slots arriving on promotion, and
  overheads scaling up to match. An indie can genuinely rise to rival the giants.
- Calendar now defaults new shows to a home-market venue.
- Tests: +4 founder-mode engine tests, adapter free-agent assertions, and a second
  Playwright journey (found → hire ×2 → create title → run night one). 118 unit tests +
  2 E2E journeys green.

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
