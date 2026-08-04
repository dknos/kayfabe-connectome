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

**The renderer governs its own tier.** Postprocessing is not affordable
everywhere: measured at 1920×1080 on a software rasteriser, the bloom chain
costs ~89 ms a frame against ~18 ms without it, because every full-screen pass
is fill-bound. Half-resolution glow helps (135 ms → 89 ms) but does not close
that gap, and restricting the pass to the bloom layer does not either — the cost
is fill, not object count.

So the renderer measures its own **wall-clock** frame and steps down after
sustained misses, faster the worse the miss. Observed descent on the software
path: high 129 ms → medium 85 ms → low, bloom off, **17 ms (58 fps)**. It never
climbs back on its own, because oscillating between tiers is worse than either.

Governing on CPU submission time would have been useless here: the same frame
reads 1.1 ms of JS and 89 ms of wall clock, so the signal has to be the one the
reader actually experiences.

The low tier is a coherent scene, not a broken one — the selection rail is a
real material edge, so selection stays unambiguous with bloom off entirely.

**Motion is not uniform, and the tests know it.** A card animates over only
`FORMATION_WINDOW` (0.62) of the clock, and quintic in-out peaks at 5x its own
average, so its fastest frame is expected to be roughly 8x the naive
journey-over-frames figure. Reporting that ratio without the model briefly made
a healthy transition look like a hitch; profiling it found a 32 ms worst frame
carrying 0.56 ms of CPU, which is one dropped vsync.

**Evidence routes** run from the subject to its documented relationships and
nowhere else: no all-to-all spaghetti, and aggregate cards get no route because
a summary is not an encounter. They reveal only after the cards are 55% settled.

**Bloom is a closed list.** Only objects on `BLOOM_LAYER` can glow, which today
is the selection halo alone. Cards, labels, section text and background are
excluded by construction rather than by tuning a threshold.

## Screenshots

`canvas.toDataURL()` captures the WebGL surface only, and the label layer is a
sibling DOM node — so a naive capture drops every name, which is the one thing
that makes the picture legible. The Arena composites labels at their live
positions plus a metadata strip naming the subject, the counts, the tier and the
section breakdown, because an unlabelled arena screenshot is not evidence of
anything.

The capture renders immediately before reading. The context is not created with
`preserveDrawingBuffer`, so the buffer is undefined after a swap; the first
working capture came back with perfect labels sitting on a blank frame.

That screenshot also caught a real violation the live view had hidden: the
selection halo was blowing out into an amber wash across the whole arena — the
"giant glow" the brief forbids. Bloom is now strength 0.32, radius 0.22,
threshold 0.55 over a thin 0.5-opacity ring.

## The championship rail

A gold chronology across the front of the Arena, revealing left to right. Each
segment is a run of years the corpus documents title activity for; **a year with
none is left empty**, because an unbroken rail would claim a continuity the
evidence does not have. AAA draws 3 segments across 1993–2025, so its documented
title history has two real gaps, and the rail shows them as gaps.

The rail belongs to the Arena reading only. The Index is an archive and the Echo
is a source topology, so neither carries one. No rail is drawn at all when the
corpus documents no title activity, rather than an empty one implying we looked.

Pulses ride the routes once those routes are actually drawn — a packet on an
unrevealed route would be a claim about nothing. They are the only objects
besides the selection halo permitted on the bloom layer.

## Chronicle: deliberately not built

The brief asks for a Chronicle formation "only if completed" and warns against
adding a helix for novelty. Chronology in this lens is already carried where it
is legible: era sections fan chronologically across the horseshoe, and the
championship rail is a true time axis with honest gaps. A fourth formation that
re-spiralled the same cards would be the generic helix the brief rules out, so
it is left unbuilt on purpose rather than by omission.

## Not yet built

- co-holder grouping within a rail segment, and a playhead travelling the rail
  during timeline playback
- person-scope title rails (the promotion projection carries per-year title
  counts; the per-person equivalent would need another projection read)
