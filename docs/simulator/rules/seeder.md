# evidence-seeder@1 — Ratings Seeding Rules

How THE BOOK turns a worker's pre-start career evidence (`EvidenceSummary`,
extracted by `@kayfabe/history-adapter`, strictly ≤ start date) into seeded
attributes, standing scalars, styles, and alignment (`WorkerSeedResult`).
Implemented in `packages/sim-core/src/seeder/index.ts`. Original design.

Every number this seeder emits is explainable: each `SeededAttribute` carries
`method = "evidence-seeder@1"`, a confidence grade, and an `inputs` list naming
the exact evidence values that moved it (e.g. `["prior:45", "matches:412",
"meltzerMean:4.2"]`). The seeder is **pure and deterministic** — no RNG, no
clock; per-person variation comes from hashing `(personId, key)` into bounded
integer offsets (§7).

## 1. Estimation model

Every attribute starts at a role-conditioned **prior** and moves toward each
evidence **signal** by Bayesian-style shrinkage:

```
value ← value + w · (signal − value),   w = n / (n + k)
```

where `n` is the sample size behind the signal (usually match count) and `k`
is a per-signal half-strength constant — the sample size at which evidence and
prior split the estimate 50/50. Signals apply in a fixed documented order
(experience, then quality, then small additive folds), so the computation is
reproducible.

Consequences of this shape, by design:

- **Sparse careers regress to priors, not to zero.** A 3-match rookie gets
  `w ≈ 0.02` on every signal: values stay near priors and confidence is
  `speculative`. Missing data means *uncertain*, never *untalented*.
- **Diminishing returns.** Volume signals are log-scaled; the 4,000th match
  teaches the model far less than the 40th.
- **Positioning ≠ skill.** Title-match share and win share feed credibility,
  prestige, and push positioning only — they never touch in-ring attributes.

All attribute values are clamped to 1..99 after the per-person offset.

## 2. Priors

| Attribute group | Attributes | Prior |
|---|---|---|
| In-ring execution | fundamentals, psychology, athleticism, technical, brawling, aerial, stamina, safety | 45 |
| Presentation | charisma, promo, starPresence, crowdConnection | 45 |
| Professional / personality | reliability, ambition, ego, loyalty | 50 |
| Standing scalar | credibility | 45 |
| Standing scalar | prestige | 40 |

The slice seeds wrestlers only, so priors are one column; the table is
role-conditioned by construction and grows columns when non-wrestler roles are
seeded (roadmap). Personality anchors at 50 because the corpus records no
personality evidence whatsoever — those attributes are prior + offset with
`speculative` confidence, awaiting in-game scouting.

## 3. Shrinkage constants (k)

| Constant | Value | Applied to |
|---|---|---|
| `K_INRING` | 150 matches | experience signal → fundamentals, psychology, stamina |
| `K_TECH_VOLUME` | 300 matches | experience signal → technical (volume alone is weak evidence of technique) |
| `K_MELTZER_TECHNICAL` | 12 rated matches | Meltzer signal → technical |
| `K_MELTZER_PSYCHOLOGY` | 20 rated matches | Meltzer signal → psychology |
| `K_MELTZER_FUNDAMENTALS` | 25 rated matches | Meltzer signal → fundamentals |
| `K_POSITIONING` | 250 matches | positioning lifts → presentation group |
| `K_STANDING` | 200 matches | credibility/prestige signals, win-share push fold |
| `K_SMALL_FOLD` | 300 matches | tag/opponent/longevity/reliability folds |

## 4. Signals and formulas

Notation: `m` matches, `yrs` careerYears, `nat` promoLevelMix.national,
`mes` mainEventShare (nullable), `win` winShare (nullable),
`tms` titleMatchShare, `tag` formMix.tag, `opp` distinctOpponents,
`dens` recentDensity (matches/yr over the last two pre-start years),
`log10p(x) = log10(1 + x)`. Nullable inputs that are absent contribute nothing
and are omitted from `inputs`.

### 4.1 Experience curve (volume + span)

```
expSig = clamp(32 + 17·log10p(m) + min(9, 0.75·yrs), 1, 90)
```

Shrunk into fundamentals, psychology, stamina with `n = m, k = K_INRING`, and
into technical with `k = K_TECH_VOLUME`.

### 4.2 Meltzer quality (only when `meltzer` present)

```
qualSig = clamp(42 + 10·mean + 2·max(0, best − mean), 1, 95)
```

Shrunk into technical / psychology / fundamentals with `n = meltzer.count` and
the per-attribute k above. When `meltzer` is null there is **no quality lift**
and no meltzer entry appears in any `inputs` list.

### 4.3 Positioning lifts (presentation group)

Being placed on top implies the presentation was valued by real bookers — the
one honest presentation signal the corpus carries. Additive lift, never a
penalty (absence of placement data cannot lower a value):

```
lift(A, B) = ((mes ?? 0)·A + nat·B) · m/(m + K_POSITIONING)
```

| Attribute | A (mes weight) | B (nat weight) |
|---|---|---|
| starPresence | 52 | 16 |
| charisma | 42 | 14 |
| crowdConnection | 40 | 12 |
| promo | 38 | 13 |

starPresence additionally takes the push fold (win share is *push* evidence):

```
pushFold = 20·(win − 0.5) · m/(m + K_STANDING)      (only when win ≠ null)
```

### 4.4 Small additive folds

| Fold | Formula | Applied to |
|---|---|---|
| tag awareness proxy | `6·tag · m/(m + K_SMALL_FOLD)` | psychology |
| adaptability proxy | `min(4, 1.4·log10p(opp)) · m/(m + K_SMALL_FOLD)` | psychology |
| current sharpness | `12 · dens/(dens + 60)` | stamina |
| longevity (safe hands survive) | `(min(8, 2.2·log10p(m)) + min(5, 0.45·yrs)) · m/(m + K_SMALL_FOLD)` | safety |
| sustained schedule | `(min(5, 0.35·yrs) + 4·dens/(dens + 80)) · m/(m + K_SMALL_FOLD)` | reliability |

### 4.5 Prior-only attributes

athleticism, brawling, aerial (no honest corpus evidence — no style data per
match) and ambition, ego, loyalty (no personality evidence) stay at prior +
per-person offset, `inputs = ["prior:<v>"]`.

## 5. Standing scalars

```
awarenessNational = clamp(5 + 20·log10p(m·nat) + 25·(mes ?? 0) + offset, 5, 95)

affinityNational  = clamp(6 + 32·(mes ?? 0) + 10·dens/(dens + 60) + 8·nat + offset, 0, 60)

credibility = clamp(shrink(45, 30 + 40·(win ?? 0.5) + 34·tms, n=m, k=K_STANDING) + offset, 1, 99)

prestige    = clamp(shrink(40, 28 + 42·tms + min(14, 1.1·yrs) + 16·nat, n=m, k=K_STANDING) + offset, 1, 99)
```

- Awareness is log-scaled national exposure (`m·nat` ≈ nationally televised-era
  match count) with a main-event boost.
- Affinity seeds mildly positive only (0..60): the corpus can evidence that
  audiences *saw* someone recently and on top, but cannot evidence heat, so
  nobody starts hated.
- Credibility blends win share and title-match share — believability in the
  presented competitive role. Prestige blends title exposure, career span, and
  national reach. Both are shrunk positioning estimates, never skill.

## 6. Confidence grades

`m < 10` forces `speculative` on every attribute.

| Group | speculative | low | medium | high |
|---|---|---|---|---|
| In-ring (fundamentals, psychology, technical) | m < 10 | m < 100 | m ≥ 100 | m ≥ 100 **and** meltzer.count ≥ 15 |
| Stamina | m < 10 | m < 100 | m ≥ 100 | m ≥ 300 and dens ≥ 30 |
| Presentation | m < 10 | mes null or m < 100 | m ≥ 100 | m ≥ 300 and mes recorded and nat ≥ 0.5 |
| Prior-only in-ring (athleticism, brawling, aerial, safety) + reliability | m < 10 | otherwise | — | — |
| Personality (ambition, ego, loyalty) | always | — | — | — |

`high` requires rich *driving* signals: third-party quality coverage for
in-ring, sustained recent volume for stamina, a large nationally-placed sample
for presentation. Volume alone never earns `high`.

## 7. Per-person offsets (anti-clone jitter)

```
offset(personId, key) = (parseInt(hashString(personId + "#" + key)[0..8], 16) mod 5) − 2
```

An integer in [−2, +2] per attribute and per standing scalar, derived from the
canonical person ID via the engine's `hashString`. Two workers with identical
evidence therefore differ by at most ±4 on any value, deterministically, with
no RNG. Offsets apply before clamping; final attribute values are rounded to
one decimal.

## 8. Styles and alignment

Styles are coarse heuristics from the same evidence (refined in play, never
authoritative):

| Style | Rule |
|---|---|
| technician | meltzer present, count ≥ 10, mean ≥ 4.0 |
| entertainer | (mes ?? 0) ≥ 0.3 and (meltzer null or mean < 3.5) — pushed on top without match-quality coverage |
| allrounder | default when nothing else fires |

`alignment` is always `"neutral"` at seed time: face/heel is a booking
decision made inside the save, not a career fact the corpus can attest.

## 9. Worked examples (matching `test/seeder.test.ts`)

- **3-match rookie**: every shrinkage weight ≈ 0.02 → all attributes within
  ±5 of their priors, all `speculative`, `inputs` include `matches:3`.
- **National main-eventer** (800 matches, mes 0.5, nat 0.9, meltzer 40 @ 4.5):
  starPresence ≈ 77, awareness ≈ 74, fundamentals/psychology/technical `high`.
- **Title-heavy midcarder**: raising `tms` 0.05 → 0.4 raises credibility
  (+~8) and prestige (+~10) and moves **no attribute at all**.
