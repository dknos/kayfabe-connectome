# Finance Rules — attendance-demand@1 + ledger@1

Implemented in `packages/sim-core/src/finance/`. Data inputs:
`packages/sim-core/src/data/markets.json` (12 original North American markets) and
`packages/sim-core/src/data/era-profiles.json` (5 era profiles, resolved by
`resolveEra(date)` over `appliesFrom`/`appliesTo`). Both files are validated at module
load; malformed data throws instead of seeding a ledger with garbage.

Two determinism constraints shape the math:

- **No transcendental functions.** `Math.exp`/`Math.pow` are not exactly specified by
  IEEE 754 and can differ in the last ulp across JS engines — a state-hash hazard.
  Soft curves are built from divisions; `Math.sqrt` (exactly specified) is the only
  non-arithmetic function used.
- **rng is optional.** `rng: null` yields the pure expectation (used by forecasts and
  AI planning); a passed `RngStream` adds bounded show-night noise. Same stream state ⇒
  same attendance.

## 1. Attendance demand (`attendance-demand@1`)

```
raw     = population · CONVERSION · awareness01 · interest01 · affinityFactor
          · cardAppealFactor · priceFactor · showTypeFactor
pool    = population · POOL_FRACTION                    (per-event audience ceiling)
demand  = raw / (1 + raw/pool)                          (saturation dampening)
noisy   = demand · (1 + u),  u ~ Uniform(−8%, +8%)      (only when rng given)
attendance = clamp(round(noisy), 0, venue.capacity)     (integer)
```

| Constant | Value | Meaning |
|---|---|---|
| `CONVERSION` | 0.003 | fraction of the aware+interested population a baseline show converts |
| `POOL_FRACTION` | 0.003 | per-event audience ceiling as a fraction of raw market population |
| `NOISE_BAND` | ±8% | show-night attendance noise (uniform) |
| `FORECAST_BAND` | ±15% | forecast attendance range around the expectation |

Factor definitions (all standings are national values plus the sparse per-market delta,
clamped to their ranges):

- **awareness01** — company awareness in the show's market, 0..1.
- **interest01** — `market.wrestlingInterest / 100`.
- **affinityFactor** — `0.35 + 0.65·(affinity+100)/200`, i.e. 0.35 at −100 (a hated
  company still draws some), 1.0 at +100.
- **cardAppealFactor** — `0.3 + 0.7·√appeal01`. `appeal01` is the top-3 weighted
  (0.5/0.3/0.2) per-worker draw score `awareness01 · (0.4 + 0.6·|affinity|/100)` over the
  *advertised* workers. Absolute affinity on purpose: a hated act can be famous, and
  heels sell tickets. Sublinear (√) so stacking names has diminishing returns; no
  advertised names ⇒ 0.3 (walk-in interest only); a lone name caps `appeal01` at 0.5
  (factor ≈ 0.79) — thin cards draw less than stacked ones by construction. Ties sort by personId for
  determinism.
- **priceFactor** — versus `reference = era.ticketPriceTypicalCents ·
  (0.7 + 0.6·economicStrength/100)` (rich markets tolerate higher prices). With
  `ratio = price/reference`: underpricing boosts mildly, `1 + 0.15·(1−ratio)` (max +15%
  for free tickets); overpricing follows `1/ratio` — double the reference price halves
  demand.
- **showTypeFactor** — house 0.6 · tv 1.0 · ppv 1.15.
- **saturation dampening** — Michaelis–Menten `raw/(1 + raw/pool)`: linear while
  `raw ≪ pool`, asymptotic to the pool. The pool is the market's realistic per-event
  audience; high-interest markets push `raw` toward it faster and saturate sooner.

**Sellout flag:** pre-clamp demand `> capacity · 1.05` (surfaced as a forecast warning;
the show sim may use it for atmosphere later).

### Forecast (`forecastShow`)

Always built from the rng-null expectation — ranges, never false precision:

- `attendanceRange` — `[⌊E·0.85⌋, ⌈E·1.15⌉]`, both clamped to 0..capacity, so the range
  always contains the expectation, including when demand clamps at capacity.
- `gateCentsRange` — range endpoints × ticket price (integer cents).
- `qualityRange` — coarse band `30 + 55·√appeal01 ± 12`, clamped 0..100. A placeholder
  owned by this module only until the show/crowd sim provides real quality forecasts.
- `warnings`, emitted in fixed order:
  1. no advertised names;
  2. `priceRatio > 1.3` — price too high for the market's economics;
  3. expectation `< 0.4 · capacity` — venue too big;
  4. `raw > 0.7 · pool` — market saturation;
  5. demand `> 1.05 · capacity` — likely sellout.

## 2. Show settlement (`settleShow`, ledger@1)

Every revenue/expense line becomes **exactly one** `Transaction` (amount positive,
direction carries sign, `showId` set, memo = line label). Zero-amount lines are skipped.
`profitCents = Σrevenue − Σexpenses`. A show/company mismatch or non-integer attendance
throws.

Revenue:

- **tickets** — `attendance × ticketPriceCents`.
- **ppv** (only when `showType === "ppv"`, era has PPV, buy rate and price > 0) —
  `buys = round(NATIONAL_PPV_AUDIENCE · awareness01 · affinityFactor · ppvBuyRateBase ·
  hotShow)` where `NATIONAL_PPV_AUDIENCE = 20,000,000` and
  `hotShow = 0.5 + 0.75·min(1, attendance/capacity)`. Settlement never sees the
  advertised roster, so the building's fill rate stands in for card appeal — live demand
  is honest evidence of how hot the card was. Revenue =
  `buys × era.ppvPriceCents × 0.45` (promoter's share after the carrier split), rounded
  through `scaleCents`.
- **merchandise** — `attendance × merchPerHead`,
  `merchPerHead = era.ticketPriceTypicalCents · (0.08 + 0.22·affinity01)` — affinity
  driven (loved companies sell shirts), era-scaled through the typical ticket.

Expenses:

- **venue_rental** — `venue.rentalCents`.
- **production** — `era.showOverheadCents[company.sizeTier]` (production + travel
  baseline).
- **appearance_fees** — per appearance worker, `contract.perAppearanceCents`, one line
  and one transaction per contract (personId set), iterated in contract-id order.
  **Exclusive contracts with a weekly downside pay 0 here** — that labor is bought by
  the weekly guarantee; paying both would double-count it.

## 3. Weekly cycle (`runWeeklyFinances`)

Per company, per week (date = the tick date, `showId: null`):

- **talent_payroll** — `weeklyDownsideCents` for every *active* contract that carries
  one (> 0), in contract-id order, personId set. Appearance-only deals pay nothing
  weekly. Contracts belonging to another company throw.
- **office_overhead** — `era.weeklyOverheadCents[company.sizeTier]`. Scaling overhead is
  the anti-snowball lever: bigger tiers carry structurally bigger fixed costs.
- **broadcast_rights** (income) — `tvDeal.weeklyRightsCents` when the company has a TV
  deal.

## 4. Ledger discipline (`applyTransactions`, `auditLedger`)

- All amounts are positive integer cents; direction carries sign. All arithmetic goes
  through `money.ts` (`assertCents`/`addCents`/`scaleCents`) so a stray float fails at
  the point of corruption, never inside a save.
- `applyTransactions(company, txs)` mutates `cashCents` (in adds, out subtracts) and
  throws on wrong-company or non-positive transactions — silent filtering would hide
  engine bugs.
- `auditLedger(companies, ledger, initialCash)` verifies the invariant from
  DATA_CONTRACT.md §5: `cash == initial + Σin − Σout` per company, iterating companies
  in sorted-id order. It *reports* problems (bad amounts, unknown companies, missing
  initial cash, imbalance) rather than throwing — an audit that crashes on the
  corruption it exists to find is useless. Missing initial cash is an error, never
  coerced to 0. Empty array = balanced.

## 5. Calibration sanity (era-national-war)

WWF-scale company (awareness 85, affinity 30) running TV in the NYC market at the
era-typical ticket with a three-name card: raw ≈ 23k against a 54k pool ⇒ ≈ 16k dampened
— a strong Manhattan TV house. A 1997 PPV with ~60/20 standing and an 80%-full 10k
building settles ≈ 176k buys ≈ $2.4M net PPV revenue. Territory-era saves get no PPV
line at all (`ppvBuyRateBase = 0`) and 27× smaller ticket prices purely from data —
same code path.
