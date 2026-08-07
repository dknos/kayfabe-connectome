# ai-booker@1 — Rival-Company AI

How AI-controlled companies book themselves. Implemented in
`packages/sim-core/src/ai/`; the engine calls `aiDailyTick(ctx)` once per AI
company per simulated day and applies the returned `AiActions` through the
same gates as player commands (cards go through `validateCard`, offers through
`evaluateOffer`). The AI proposes; the engine disposes.

## Contract

- Input: `AiTickContext` — the company, the date, the whole worker/title/show/
  venue/market world, active contracts for every company, the era profile, a
  dedicated rng stream (`ai:<companyId>`), and a deterministic id minter.
- Output: `AiActions` — shows to schedule, card updates, the **full
  replacement list** for `company.programs`, contract releases, contract
  offers, and `AiDecisionRecord`s (`seq` always 0; the engine assigns real
  sequence numbers).
- Purity: `aiDailyTick` never mutates its context. Same context + same rng
  state ⇒ byte-identical actions (covered by test).

## Determinism rules

- Every `Record` is iterated in sorted-key order (`aiSortedKeys`).
- Randomness only through the passed stream, and only where personality
  should wobble the outcome: title-change appetite, occasional DQ finishes,
  free-agent appetite. Everything positional (venue rotation, PPV names, the
  TV wrestle/promo split) uses `hashPick` — a string hash, zero rng draws —
  so adding a scheduling feature can never shift another subsystem's rolls.
- Subsystem order is fixed: scheduling (no draws) → programs → cards → roster.
- All ties break on lexicographic `personId` / entity id.

## 1. Scheduling

- **Weekly TV** (`tvDeal` + `era.tvAvailable`): for each of the next 21 days
  that falls on `tvDeal.dayOfWeek` and has no scheduled company show, add a
  TV show named after the program. Venue = `hashPick(companyId:date)` over
  the candidate list (home-market venues, else same-region, else any, always
  sorted). Ticket price = `era.ticketPriceTypicalCents`.
- **Monthly PPV** (`ppvWeek` set, `era.ppvAvailable`, national/regional
  only): lands on the Sunday of week-of-month `ppvWeek` (pulled back a week
  if it spills into the next month), scheduled up to 42 days out, one per
  calendar month. Venue = largest home candidate; ticket = 1.5× typical;
  name = company shortName + a pooled original event name picked by
  company/month hash.
- **House shows**: out of slice scope, never emitted.
- Reason codes: `tv-cadence:<date>`, `ppv-monthly:<date>`; considered lists
  the top-3 venues by capacity.

## 2. Programs (title feuds)

One live program per active company title, tiers ordered world → secondary →
other (tag programs are out of slice scope). The list returned replaces
`company.programs` wholesale; unmanaged programs (no title / foreign title)
are carried through untouched.

- **Creation** (no live program for the title): challenger = highest-utility
  available roster member not already committed to another program.
  Utility parts (weights are design values):
  `momentum×0.5 + awareness×0.4 + credibility×0.3 + opposition
  (+20 opposite alignment, +5 involving neutral) + freshness (−25 if in the
  just-finished program) + youth (−youthBias/100 × (experience−10)) +
  starBias (charisma×0.2 | mean(technical,psychology)×0.2 | powerhouse+15 |
  prestige×0.2 + min(exp,25)×0.5)`.
  The reason code names the dominant part: `build-challenger:momentum` etc.
- **Intended winner**: champ retains outright when `planLoyalty ≥ 70`;
  otherwise the belt changes with probability
  `clamp(riskTolerance/300 + 0.1, 0.05, 0.5)` (reason `title-change:<part>`).
  Vacant or unresolvable champion: top two candidates feud, favorite wins
  (`crown-champion:vacant`).
- **Target date** = the next company PPV (scheduled or planned this tick),
  falling back to +28 days.
- **Phases** by days to target: building (>14) → peak (8–14) → blowoff (≤7),
  forward-only (`advance-program` / `phase:<p>` decisions). A blowoff whose
  title match ran on a completed show near the target date — or whose target
  passed — becomes `done`; the **next** tick builds the successor, penalizing
  the finished participants for freshness.

## 3. Cards

The next un-carded, non-house company show within 2 days gets a card.
Availability = active, not injured past the show date (mirrors
`validateCard`); nobody appears twice on one card (stricter than the
validator, which tolerates angle repeats).

- **TV — 5 segments (4 matches + 1 angle)**: the world-program pair splits
  by date-hash — one wrestles the main event (vs the strongest fresh
  opponent, program person wins, never for the title), the other cuts a
  `challenge` promo angle. Undercard: 3 singles pairs rotated by
  least-recently-used (`condition.daysSinceMatch` desc). Order: two
  undercard, angle, third undercard, main event.
- **PPV — up to 7 segments (≤6 matches + 1 angle)**: main event is the
  program's title match with `winnerSide` from `intendedWinner` — the only
  place a belt is defended. Up to 5 LRU undercard matches, one voice
  reserved for a `promo` angle when the roster allows; smaller rosters
  degrade gracefully (a 12-person roster yields 5 matches + angle).
- **Undercard winners**: `momentum×0.5 + pushRank` per side; when
  `planLoyalty < 40` and the gap exceeds 25 points, a 25% rng chance turns
  the finish into a DQ win (the jobber eats a disqualification, not a pin).
- Durations: TV 8/15/4 min (undercard/main/angle), PPV 10/20/5. Segment ids
  minted via `nextId("seg")`; `advertised` = every booked participant.
- Reason code: `card:<showType>:<date>`; considered lists the top-3 roster
  members by win score.

## 4. Roster upkeep

- **Re-sign**: contracts expiring within 30 days for active workers with
  `push ≠ unused` get an offer with terms from the market module's
  `aiOfferFor` (askingPrice-based, era-shaped, cash-capped). Priority order:
  push rank desc. Reason `re-sign:expiring`.
- **Release**: only when `cashCents < 0`, and only workers with push
  `unused` (reason `release:cash-pressure:unused`). The current cash sign is
  the slice's proxy for a negative trend.
- **Free agents**: workers under contract nowhere, awareness > 55, healthy.
  Daily appetite `0.03 + riskTolerance/1000`; on a hit, the most-known
  candidate gets an offer (reason `sign:free-agent:hot`).
- **Solvency gate**: an offer is dropped (reason `offer-skipped:budget`)
  unless `cash − 8 × (existing weekly downside + accepted new downside +
  this offer's downside) > 0`. Deliberately conservative: re-sign overlap
  weeks are double-counted.

## 5. Decision ledger

Every action ships an `AiDecisionRecord` (reason code + up to three
considered options with utilities) for the dev-mode AI reasoning ledger, per
GAME_DESIGN §17. Reason vocabulary: `tv-cadence` `ppv-monthly`
`build-challenger:*` `title-change:*` `crown-champion:vacant` `phase:*`
`card:*` `re-sign:expiring` `sign:free-agent:hot`
`release:cash-pressure:unused` `offer-skipped:budget`.

## Known slice limits

- Tag-title programs and multi-side matches are not booked yet.
- "Cash negative trend" is just the current cash sign.
- One card per tick (the next show only) — enough at a daily cadence.
- PPV target of 7 segments needs a 14-person roster; smaller rosters
  produce valid shorter cards rather than repeat-booking anyone.
