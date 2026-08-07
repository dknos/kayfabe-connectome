# Show & Crowd Simulation Rules — `crowd-flow@1` + `segment-eval@1`

Implemented in `packages/sim-core/src/show/`. Every formula the engine uses is
written down here; if code and doc disagree, that is a bug. All scores live on
0–100, all deltas are small and bounded, and every reported score decomposes
into labeled `ScoreComponent`s that sum (to one-decimal rounding) to the score
— clamping is absorbed into a visible `"Score bounded"` component so the sum
property never silently breaks.

## Entry point

```
simulateShowPerformance(ctx: ShowSimContext): ShowSimOutcome
```

Pure with respect to game state: it reads workers/titles/storylines/company,
returns `SegmentReport`s (sim-contract shape), title changes and bounded
per-person deltas for the caller to apply. Worker condition does **not**
accumulate segment-to-segment within one show; the caller applies
`fatigueDelta` etc. after the show. The only mutation is the passed
`RngStream`, whose draws follow a fixed schedule (below).

## Determinism

- **RNG is used for exactly one thing: injury rolls.** One `rng.next()` per
  match participant, drawn in flattened side order (side 0 members, then
  side 1, …), segment by segment in running order. The draw happens even when
  the injury chance is zero, so the schedule never depends on attributes,
  and adding a safe worker never shifts another worker's roll.
- Chemistry, injury kinds, and all scoring are hash- or formula-derived, not
  rolled. Curves use softsign `s(x) = x / (1 + |x|)` — a tanh-like S-curve in
  rational arithmetic, bit-identical across JS engines (no `Math.tanh`).
- The only `Record` iterated is `ctx.storylines` (confusion scan), always via
  sorted keys.
- Same ctx + same rng state ⇒ identical outcome (covered by test).
- Reported numbers are rounded to one decimal (`r1`), with `-0` normalized.

## Chemistry proxy

For an unordered pair of person ids `{a, b}` (sorted so order never matters):

```
chem(a,b) = (parseInt(hashString("chem|" + lo + "|" + hi).slice(0,8), 16) % 7) − 3
          ∈ {−3 … +3}, integer
```

A stand-in until a relationship system exists: stable, deterministic, and
different for every pairing.

## Crowd initialization (`crowd-flow@1`)

Inputs: show type, attendance (resolved upstream by finance), venue capacity
and prestige, market `wrestlingInterest`, company `Standing` with the show
market's delta applied.

```
fill   = clamp(attendance / max(1, capacity), 0, 1)
aff    = clamp(affinityNational + marketDelta.affinity, −100, 100);  aff01 = (aff+100)/200
awa    = clamp(awarenessNational + marketDelta.awareness, 0, 100)
heat   = { ppv: +12, tv: +4, house: −6 }[showType]

energy       = 36 + 30·fill + 16·aff01 + heat + 0.05·venuePrestige
attention    = 48 + 14·fill + 0.5·heat
investment   = 28 + 34·aff01 + 0.12·awa + 0.10·(wrestlingInterest−50) + 0.5·heat
fatigue      = 0
hostility    = 0.25·max(0, −aff)          (a crowd that hates you arrives hostile)
satisfaction = 50
anticipation = { ppv: 68, tv: 52, house: 40 }[showType] + 12·fill
```

All clamped 0–100. A packed PPV in a loving market opens near 80 energy; a
half-empty house show in a cold market opens sluggish.

## Segment execution (`segment-eval@1`)

### Matches

Per participant, style-weighted in-ring craft:

```
styleSkill: technician→technical · brawler/hardcore→brawling · highflyer→aerial
            powerhouse→(athleticism+brawling)/2 · allrounder→(technical+brawling+aerial)/3
            entertainer→(charisma+psychology)/2 · no styles→fundamentals

craft = 0.28·fundamentals + 0.22·psychology + 0.14·athleticism + 0.36·mean(styleSkills)
```

Penalties (averaged across participants for the components; applied
individually for `contribution`):

```
fatiguePen = 0.15 · condition.fatigue                       (0..15)
staminaPen = 0.2 · max(0, durationMin·(intensity/100)·3.5 − stamina)
hurtPen    = 12 if condition.injury present (worked hurt) else 0
```

Execution components:

| Component | Value |
|---|---|
| In-ring craft | `mean(craft) + 0.15·(max(craft) − mean(craft))` — a great worker can carry |
| Chemistry | `1.5 · mean(chem over all cross-side pairs)` (−4.5..+4.5) |
| Fatigue coming in | `−mean(fatiguePen)` |
| Overbooked length | `−mean(staminaPen)` |
| Working hurt | `−mean(hurtPen)` |
| Injury disruption | `−{minor:3, moderate:8, severe:15}` for the worst in-match injury |

`contribution` (per person, 0–100) = own craft − own penalties − own injury
disruption.

### Injuries (matches only)

```
hazard = (risk/100) · ((100 − safety)/100)          (worker's own safety)
chance = 0                          if hazard ≤ 0.02   ← hazard floor
       = 0.25·(hazard−0.02)/0.98    otherwise          (max 0.25 at hazard 1)
```

One uniform `u` per participant. Injured iff `u < chance`; severity from
`t = u/chance`: `t<0.6` minor, `t<0.9` moderate, else severe. The hazard floor
means safe workers in low-risk matches are **never** dice-injured (risk 5 ×
safety 95 → hazard 0.0025 → chance 0); a risk-95 match with safety-5 workers
rolls at ≈0.225 per participant.

```
outDays  = round(baseDays · (0.75 + intensity/200)),  baseDays = {7, 30, 120}
outUntil = showDate + outDays
kind     = hash-picked from a per-severity list (deterministic, no extra draw)
```

Angles roll no injuries in this slice: worked angle contact is choreographed;
injuries are a match phenomenon.

### Angles

Each beat scores each participant **only on their `AngleBeat` role** — a
silent victim is never rated on promo delivery:

| Role | Judged on | Aggregate weight |
|---|---|---|
| speaker | 0.45 promo + 0.35 charisma + 0.20 crowdConnection | 1.0 |
| attacker | 0.40 brawling + 0.35 starPresence + 0.25 charisma (menace proxy) | 1.0 |
| victim | 0.50 psychology + 0.30 fundamentals + 0.20 crowdConnection (selling) | 0.7 |
| target | 0.40 crowdConnection + 0.30 charisma + 0.30 psychology | 0.7 |
| interviewer | 0.50 promo + 0.30 charisma + 0.20 psychology | 0.5 |
| bystander | 0.50 reliability + 0.50 psychology | 0.25 |

Beat craft = role-weight-weighted mean of role scores. Segment craft = beat
crafts weighted by beat duration. Components: `Delivery` (craft),
`Chemistry` (`0.75 ·` duration-weighted mean of per-beat pair chem),
`Fatigue coming in` (`−0.08 · mean(fatigue)` — talking is easier than
working). `contribution` = own duration-weighted role score − 0.08·own
fatigue.

## Reception

Measured against the crowd state **before** the segment. Components:

| Component | Value | Notes |
|---|---|---|
| Execution carried through | `0.62 · execution` | the work itself |
| Crowd energy | `(energy − 50) · 0.15` | ±7.5 |
| Crowd attention | `(attention − 50) · 0.08` | ±4 |
| Crowd burnout | `−fatigue · 0.18` | 0..−18 — hot cards pay this |
| Title stakes | `{world:8, secondary:5, tag:4, other:3}` | resolved title only |
| Storyline heat | `heat · 0.08` | linked storyline only |
| Main-event spot | `4 + (anticipation − 50) · 0.10` | flagged main event only |
| Star power | `0.10 · mean(0.5·awareness + 0.5·|affinity|)` | a hated act still draws |
| Repetition | `−8` | exact participant set already appeared this show |
| Storyline overexposure | `−3` | ≥3 storyline beats in the last 14 days |
| Product fit | `Σ 3·((dna−50)/50)·((feat−50)/50)` over 4 axes, clamped ±8 | see below |
| Confusion | `−5 · min(2, conflictingPairs)` | see below |
| Pacing slot | `+3` breather / `−4` burnout | only when energy < 42 |

**Product fit** compares segment content features against company DNA on the
axes `violence`, `athleticCompetition`, `characterSpectacle`,
`serializedStory`. Match features: violence = `0.6·intensity + 0.4·risk
(+15 if stipulated)`; athletic = mean `(technical+athleticism+aerial)/3`;
spectacle = mean `(charisma+starPresence)/2`; story = `55 + 0.45·heat` if
storyline-linked else 30. Angle features: violence = 70 with an
attack/betrayal beat else 20; athletic = 15; spectacle as matches; story =
`60 + 0.4·heat` else 35. A 20-minute technical clinic therefore reads
differently to a violence-heavy DNA than to an athletic one — signed in both
directions.

**Confusion**: for each opposed pair (cross-side in matches; attacker↔struck
in attack/betrayal beats), if both people share an *active* storyline
(building/peak/blowoff) with the **same** role (allies) and the segment is
not booked under any storyline, the crowd reads it as nonsense. Opposed
protagonist-vs-antagonist pairs are expected and never penalized.

## Crowd update (`crowd-flow@1`)

After every segment (reception `r`, softsign `s`):

```
load    = match: durationMin·(0.30 + intensity/200) · angle: durationMin·0.12
hot     = 2 if r ≥ 80 else 0                       (hot segments spend the crowd)
relief  = angle: 4 · low-intensity match (≤40): 2 · else 0
recover = angle: 5 · low-intensity match (≤40): 3 · else 0
spend   = 0.5·load + 0.10·max(0, r − 60)
cheap   = 6 if dq/countout/no-contest on a title match or main event else 0

energy'       = energy + 12·s((recover − spend)/12)
attention'    = attention + 10·s((r − 52)/14)
investment'   = investment + 8·s((r − 55 + [storyline: 6])/15)
fatigue'      = fatigue + 20·s((load + hot − relief)/20)
hostility'    = hostility + 10·s((r<45: 0.3·(45−r), else −0.10·max(0,r−60)) + cheap)/10)
satisfaction' = satisfaction + 0.35·(r − satisfaction)          (EMA toward reception)
anticipation' = main event: anticipation·0.3 (released)
                else: anticipation + 7·s((r − 45)/20)           (builds through the card)
```

All clamped 0–100 and rounded. Energy is a finite tank: hot matches drain it,
breathers refill it — which is why three consecutive 90-intensity wars leave
the third one flat while a spaced card keeps the crowd alive (tested).

## Winners and title changes

**The plan decides.** `MatchPlan.winnerSide` is booking; the sim never
overrides it. Title consequences:

- Decisive finish (pin / submission / KO) and the winning side's members are
  not the current holders (set comparison) ⇒ emit
  `TitleChange { titleId, newHolderIds }` (winning side's members, booking
  order). Winning a vacant title counts.
- DQ / count-out ⇒ **no change** (wrestling convention), noted on the report.
- no-contest / time-limit draw / null winnerSide ⇒ no change.
- Unknown `titleId` (not in ctx) ⇒ treated as a non-title match; nothing
  invented.

## Participant effects (documented ranges)

All rounded to one decimal; the caller applies them after the show.

| Delta | Match rule | Range |
|---|---|---|
| momentumDelta | winner: `min(12, 4 + 0.06·r)` · clean loser: `max(−8, −(3 + 0.05·max(0,60−r)))` · dq/countout loser: `−1` (finish protected them) · draw/no-contest: 0 | −8..+12 |
| affinityDelta | `clamp(0.04·(r−50), −2.5, 2.5)` | ±2.5 |
| awarenessDelta | `min(3, (0.2 + attendance/15000) · reach · (mainEvent: 1.5))`, reach = tv 1.0 / ppv 0.8 / house 0.15 | 0..3 |
| fatigueDelta | `min(25, durationMin·(0.35 + intensity/200))` | 0..25 |
| moraleDelta | winner +2 · main event +1.5 · clean loss −1.5 · r≥80 +1 · main-event-push worker outside the main event −1 (misused); clamped | ±4 |
| credibilityDelta | clean win +1.5 (+2.5 with title) · win by dq/countout +0.5 · clean loss −2 · protected loss −0.5 | ±2.5 |

Angle participants: momentum `clamp(0.08·(r−55)·wt, −8, 10)` with `wt` 1.0
for speaker/attacker roles, 0.5 otherwise; fatigue `0.1 · minutes on screen`;
morale `clamp(0.03·(r−55), −4, 4)`; credibility +0.5 for an attacker in a hot
(r≥70) angle, −0.5 for an unsaved victim (a `save` beat cancels it);
`role` is the person's sorted beat roles. Storyline-based loss protection is
not modeled in this slice (no such field on `Storyline`); protection is
finish-based.

## Overall show score

| Component | Value |
|---|---|
| Card quality | `Σ wᵢ·rᵢ / Σ wᵢ` with `wᵢ = max(1, durationMin)`, main event `×(1.8 + max(0, starDriven−50)/100)` (DNA-weighted), storyline segments `×1.15` when `serializedStory > 60`, unflagged closer `×1.3` |
| Pacing arc | `clamp(0.15·(mean last-third receptions − mean first-third), −4, 4)` (cards of ≥3) |
| Crowd sent home | `(final satisfaction − 50) · 0.12` |
| Closing finish | closer (last flagged main event, else last segment) if a match: decisive +3, dq/countout −4, no-contest −6, time-limit draw −2 |

Empty card ⇒ overall 0, note "No segments were booked."

## Headlines and notes

- Match headline: `"A def. B (pin) — TW World Championship"`; draws/no
  contests render `"A vs. B — time-limit draw"`. Finish labels: pin,
  submission, DQ, count-out, KO, no contest, time-limit draw.
- Angle headline from the first beat's purpose and roles ("X ambushes Y",
  "X cuts a promo on Y", "X calls out Y", "Contract signing: …").
- Segment notes are plain language: exhausted performers, working hurt,
  in-match injuries with return dates, burned-out crowd, title stakes,
  repeated pairings ("This pairing repeated segment 3."), overexposed
  storylines, confusion, breathers, main-event payoff (anticipation ≥ 65),
  cheap-finish grumbling, and title retention on DQ/count-out.
- Show notes: new champions, injuries, end-state crowd (burned out / went
  home happy / unhappy), pacing verdicts (built to its finish / peaked too
  early).

## Non-goals of this version

Per-market standing refinements inside reception (national values only),
relationship-driven chemistry (hash proxy instead), angle injuries, worker
fatigue accumulation *within* a show, and storyline-flagged loss protection.
Each is noted where the future hook belongs.
