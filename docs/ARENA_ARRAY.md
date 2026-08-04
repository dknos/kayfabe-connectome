# ARENA ARRAY

A reading instrument for one wrestler's documented relationships: a semantic
horseshoe where every seat is evidence, not decoration.

## A note on what is specified and what is inferred

The brief this lens was built from specifies the **graphics** in detail
(sections A–P of the Three.js examples gauntlet) and refers to this document as
though it already existed. It did not. The **semantic layer** below —
what a card is, what a section means, what strength and era are — was therefore
derived from the canonical corpus rather than handed down, and is stated here
so a reader can tell the difference. Where the corpus decides something, the
evidence is cited. Where a choice was made, it says so.

## The semantic model

| Arena concept | Corpus source | Why |
|---|---|---|
| card | a person node | one card, one documented human |
| **bank** | `edges.bin` `same` / `opposed` | the corpus's own distinction: `same` counts documented tag partnership, `opposed` counts documented opposition |
| **mixed bank** | both `same > 0` and `opposed > 0` | a pair who both fought *and* teamed is a third relationship, not an average of two |
| battle royal | `br`, weighted 0.25 | a battle royal does not document a specific meeting, so it cannot carry the same weight (docs/CANONICAL-MODEL.md) |
| **strength** | `same + opposed + br × 0.25` | prominence is evidence; it is bounded so one 170-match card cannot dwarf the field |
| **era** | the person's span *inside the active scope* | see the trap below |
| championship context | node `reigns` | documented reigns only; a missing reign stays missing |
| Echo positions | `nodes.pos` (`global-layout@3`) | the entrance is a compression of the real connectome, never a random scatter |

### Two traps the data imposes

**A promotion scope cannot come from the edge `promoMask`.** Only 30 promotions
own a bit; the remaining 541 share "other" bit 30. `pr:c8` (AAA) is one of the
541, so filtering edges by its bit would silently mean *"AAA or any of 540 other
promotions"*. The scope is taken from the chronology projection
(`atlas/promotions/*`), whose per-promotion member list carries exact per-person
match counts and spans.

**A person's era inside a promotion is not their global debut decade.** They
differ for **326 of AAA's 1,087 people**. Seating a chronological fan by career
debut would place roughly a third of it in decades AAA never had — the
promotion begins in 1993, while its roster includes wrestlers who debuted in the
1960s. Era is therefore the person's span *within the scope*.

**Aggregation is forced by the data, not chosen.** `pr:c8` alone is 1,087
people against a 600-card budget, and 417 of them have exactly one documented
AAA match. There is no card budget at which the long tail fits.

## The formations

One persistent card set, three precomputed target formations, one shared clock.

- **ECHO** — where these people sit in the canonical connectome, compressed and
  subdued. A source topology, not a reading.
- **ARENA** — the semantic horseshoe. Bank decides section, strength decides
  bounded prominence, and every card is yawed to face centre stage so the bank
  reads as seating rather than scatter.
- **INDEX** — the archival wall. A row is one semantic group, column order is
  rank inside it, and every card converges to the same camera-facing
  orientation because this formation is for comparison rather than emphasis.

Cards keep their instance across formations, which is what makes "follow one
named card from Arena to Index" true rather than aspirational.

## Architecture

```
packages/arena-renderer/     Three.js, no React inside
  ArenaTransition.ts         shared clock, semantic delay bands, slot pool
  ArenaLayouts.ts            Echo / Arena / Index target formations
  ArenaCards.ts              one instanced quad field + the pick material
  ArenaLabels.ts             pooled projected DOM labels
  ArenaPicking.ts            instanced raycast
  ArenaRoutes.ts             pooled curved fat lines, instanceCount reveal
  ArenaBloom.ts              layer-restricted selective emphasis
  ArenaRenderer.ts           scene, camera, tiers, disposal, context loss
apps/web/src/arena/
  arenaAdapter.ts            canonical graph + chronology -> ArenaCard
  ArenaLens.tsx              mounting, scope, controls
```

## Measured behaviour

Every figure comes from a re-runnable probe in `tests/arena-spikes/`. See
[the examples audit](THREE_EXAMPLES_AUDIT.md) for the full matrix and for the
measurement caveats (headless here is SwiftShader; rAF is vsync-clamped).

| Property | Measured |
|---|---|
| Card field | **1 draw call at 600 cards** |
| Layout generation | ≤ 0.3 ms |
| Retarget | ≤ 0.2 ms |
| Transition CPU, 600 cards | 0.026–0.052 ms |
| Picking | 0.1–0.2 ms, **96.8–100%** agreement with pixel-exact reference |
| Labels | 513 wanted → 48 shown, **0 overlapping pairs** |
| Heap across 60 retargets | no growth |
| Default view at 1920×1080 / 1366×768 | **100% of cards inside the viewport** |

## Decisions that look like details

- **Cards are `DoubleSide`.** They face centre stage, so half the horseshoe is
  back-facing from any camera. Single-sided plaques are culled: picking found
  only 55.3% of card centres before this was set.
- **The camera travels on the formation's clock.** An instant camera cut is
  itself a teleport — measured at 0.786 NDC in one frame against a 0.0003
  ordinary step, which destroys card trackability even when the cards
  interpolate perfectly.
- **The camera frames from the layout's own extent**, using the *horizontal*
  field of view. The arena is wide and shallow; framing on the vertical FOV
  pulls back roughly twice as far as needed.
- **Leaving cards return their slot only after their exit has played.**
  Releasing at retarget time hands a still-visible card's slot to an entering
  one, which reads as one wrestler mutating into another.
- **Label widths are measured, not estimated.** Proportional type gives two
  19-character Lucha names different widths; estimating produced real overlaps.
- **Quality tiers degrade individually** (`ARENA_TIERS`): cards, labels,
  routes, pulses, bloom and pixel-ratio cap are separate levers, so the low
  tier is a coherent scene rather than a broken one.

## Scopes

**Person** — everyone the subject shares a documented match with, seated by
what kind of relationship the evidence supports.

**Promotion** — its roster seated by era, fanning chronologically across the
horseshoe. The scope comes from the chronology projection (`data/atlas`), not
the graph, for the two reasons above. AAA seats 1990s:204, 2000s:129,
2010s:175, 2020s:91 and reads at 100% in-viewport with zero overlapping labels
at both 1920×1080 and 1366×768.

Where the roster exceeds the card budget the tail becomes one clearly-labelled
summary card per era (`+N more · 2010s`), and the projection's own
`membersTruncated` is surfaced in the readout. A capped roster that reads as
complete is a false claim.

## Effects, and how they degrade

`ARENA_TIERS` moves each lever on its own — the brief forbids one binary switch
that either enables everything or breaks the scene.

| Tier | Cards | Labels | Routes | Bloom | DPR cap |
|---|---|---|---|---|---|
| high | 600 | 48 | 100 | on | 2 |
| medium | 360 | 32 | 40 | on | 1.5 |
| low | 160 | 18 | 12 | **off** | 1 |

Measured in the lens: high 4.0 ms CPU, low 0.53 ms. The low tier is a coherent
scene, not a broken one — the selection rail is a real material edge, so
selection stays unambiguous with bloom switched off entirely.

**Evidence routes** run from the subject to its documented relationships and
nowhere else: no all-to-all spaghetti, and aggregate cards get no route because
a summary is not an encounter. They reveal only after the cards are 55% settled.

**Bloom is a closed list.** Only objects on `BLOOM_LAYER` can glow, which today
is the selection halo alone. Cards, labels, section text and background are
excluded by construction rather than by tuning a threshold.

## Not yet built

Stated plainly so nobody has to discover it:

- timeline pulses and the championship gold rail (measured in
  `apps/web/spikes/routes.ts`, not yet wired into the lens)
- the drill-down cascade — aggregate cards exist and the churn mechanics are
  proven in SPIKE 1, but opening an aggregate does not yet expand it
- Chronicle formation
- URL restoration, a semantic inspector, and screenshot compositing of the DOM
  label layer (`renderer.domElement.toDataURL()` will not capture it)
