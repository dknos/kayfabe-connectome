# Contract negotiation — `negotiation@1`

Implemented in `packages/sim-core/src/market/negotiation.ts`. Deterministic: the only
randomness is one bounded wobble draw from the caller's `RngStream`, so identical
context + identical stream state ⇒ identical outcome. All money is integer cents.

## 1. Asking price — `askingPrice(worker, era, kind)`

What the worker believes they are worth. No rng.

```
momentum01     = clamp((momentum + 100) / 2, 0, 100)
marketability  = clamp(0.45·awarenessNational + 0.35·prestige + 0.20·momentum01, 0, 100)
base           = era.ticketPriceTypicalCents × (2 + (marketability/100)² × 400)
```

Awareness leads (you pay for names), prestige second, momentum third. The quadratic
makes stars cost multiples of unknowns rather than a linear step. Era scaling rides the
era's typical ticket price, so a territory-era guarantee and a streaming-era guarantee
differ by parameters, not code.

Kind shapes the base into terms (weekly value assumes the standard cadence of
**2 appearances/week** used everywhere in this module):

| kind | per-appearance | weekly downside | weekly value |
|---|---|---|---|
| handshake / appearance | 1.25 × base | 0 | 2.5 × base |
| written | 0.5 × base | 1.5 × base | 2.5 × base |
| exclusive | 0.7 × base | 2.1 × base | 3.5 × base |

Per-shot deals carry a no-guarantee risk premium so their weekly value matches a
written deal; **exclusive is written × 1.4** — the exclusivity premium is baked into
the kind's asking shape. Terms round to the nearest whole dollar, floored at $1.

## 2. Evaluating an offer — `evaluateOffer(ctx)`

### Era gates (hard rejections, before the rng draw)

- `offer.kind` not in `era.allowedContractKinds` → reject, era reason.
- `offer.exclusive` while the era has no `exclusive` kind → reject, era reason.

Gated evaluations return before drawing, so they never perturb the stream.

### Utility components

`ratio` = offered weekly value / effective asking weekly value, where the effective
asking is the kind's asking price, scaled ×1.4 when `offer.exclusive` is set on a
non-exclusive kind (the exclusive kind already carries it).

| component | range | notes |
|---|---|---|
| compensation | 0–65 | **dominant**: `50·min(ratio,1)` plus an overpay bonus capped at +15 (`ratio` 1.5 saturates it) |
| company standing | 0–12 | `prestige/100 × 7` + tier bonus (national +5, regional +2.5, indie 0) |
| stability | ±8 | preference `p ∈ [−1,1]` = ½·clamp((experienceYears−8)/12) + ½·clamp(−momentum/60); score = 8·p·clamp((lengthMonths−12)/24, −0.75, 1). Veterans and cold workers value long deals; rising stars resent them |
| loyalty | ≈ ±10 | pull = ((morale−50)/50)·(3 + 7·loyalty/100). Re-signing with the current company adds it; poaching against a current contract subtracts it (an unhappy worker is easier to poach) |
| rival interest | 0 to −12 | −rivalInterest × 0.12 — a hot market raises the bar |
| product fit | ±3 | small: worker styles vs company DNA (technician/highflyer → athleticCompetition, brawler/hardcore → violence, entertainer → characterSpectacle, powerhouse → starDriven; allrounder neutral) |
| wobble | ±2.1 | one `gaussish(0, 0.7)` draw — bounded by construction |

### Thresholds

- utility ≥ **52** → accept.
- **42 ≤** utility **< 52** → counter.
- otherwise → reject.

### Counter construction

Asking blended toward the offer, per term: `0.6·ask + 0.4·offer`, rounded to the
dollar and clamped between the two; a term already at or above asking is kept as
offered (no downward counters). Length: the midpoint of the offered length and the
worker's preferred length (12 + p·12, clamped 6–24), snapped to the nearest plausible
length in {3, 6, 12, 18, 24, 36}, ties toward shorter.

### Reasons

Plain language only; never utility numbers. Non-accepted outcomes list up to three
reasons sorted by actual point contribution, so the dominant term speaks first:

- money (phrasing picks the larger shortfall term, guarantee vs per-appearance;
  "well below what similar names earn" when ratio < 0.85, "close, but not quite there"
  otherwise)
- "an exclusive deal has to pay a real premium" (when the premium is what sinks it)
- "wants to stay where they are" (poaching against positive loyalty pull)
- "a rival is offering more" (rivalInterest ≥ 40)
- stability mismatch ("wants the security of a longer deal" / "doesn't want to be
  locked in that long")

Accepted offers explain themselves the same way ("the money is right", "taking a
little less to stay put", "happy where they are", …).

## 3. AI offers — `aiOfferFor(worker, company, era)`

Deterministic, no rng. Kind preference by size tier, filtered to era-allowed kinds:

- national: exclusive → written → appearance → handshake
- regional: written → appearance → exclusive → handshake
- indie: appearance → handshake → written → exclusive

Terms open at 0.95 × asking (the AI expects to negotiate up). Budget sanity: the
weekly commitment (downside + 2 × per-appearance) of this one deal must not exceed
`floor(cashCents / 26)` — 26 weeks of runway. The first preferred kind that fits is
offered; if none fits, the cheapest candidate is scaled down to the cap with terms
floored at $1 (a broke company still tenders a minimum-scale offer). Lengths by kind:
handshake 3, appearance 6, written 24, exclusive 36 months. `exclusive` flag is set
iff the kind is `exclusive`.

## 4. Invariants under test (`packages/sim-core/test/market.test.ts`)

- Fair offer at asking accepted by a neutral worker; deep lowball rejected with a
  money reason; ~80% offer counters with terms strictly between offer and asking.
- High-morale, high-loyalty worker re-signs at a discount a stranger turns down.
- Exclusivity flips an otherwise-accepted fair offer to non-accepted, with an
  exclusivity reason.
- Era gating: exclusive terms in a non-exclusive era reject with an era reason and
  no counter.
- Cloned rng state ⇒ identical outcome; `askingPrice`/`aiOfferFor` are pure.
- AI offers use era-allowed kinds only and respect the weekly-commitment cap.
