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
  ArenaControls.ts           orbit / pan / dolly / WASDQE, moveTo, input counter
  --- the stadium ---
  ArenaStadiumKit.ts         structural palette, deterministic hash, merges
  ArenaStage.ts              floor, ring, entrance ramp, tunnel, barricades
  ArenaArchitecture.ts       terraces, upper bowl, aisles, truss, ribbon lights
  ArenaLighting.ts           three lights, additive shafts, fog
  ArenaSignage.ts            section signs, one atlas, billboarded
  ArenaScoreboard.ts         suspended four-sided board, pooled CanvasTexture
  ArenaEnvironment.ts        rebuild policy, visibility, disposal, budgets
  ArenaCameraDirector.ts     named viewpoints solved from content
apps/web/src/arena/
  arenaAdapter.ts            canonical graph + chronology -> ArenaCard + facts
  ArenaLens.tsx              mounting, scope, controls
```

## The stadium

The Arena is a room. The shell is built from the layout's own measurements
rather than modelled: the floor and bowl follow the seating radius, the
terraces step to the seated rows, the entrance runs through the ~80-degree gap
the horseshoe already leaves at -Z, and the aisle cuts sit on the real section
boundaries. `SEAT_INNER_RADIUS`, `SEAT_TIER_STEP`, `SEAT_BASE_Y`,
`SEAT_TIER_RISE` and `FLOOR_Y` live in `types.ts` and are read by both the
layout that seats cards and the shell built around them, so the two cannot
drift.

**The architecture is subordinate by construction.** Structural surfaces stay
in graphite, charcoal, steel and desaturated navy. The saturated palette is
spoken for and means something — gold is championship, cyan is documented tag
partnership, ember is documented opposition — so the shell never enters it. A
stadium that tinted its seating amber would be making a championship claim
about a bank of chairs.

**There is no crowd.** Not a single seat is populated with a figure anywhere in
`ArenaArchitecture.ts`. An invented audience is an invented count, and the
brief forbids fake crowd population. The bowl reads as a bowl through geometry
and light, not through occupancy.

**Nothing in the shell is pickable.** `ArenaPicking.pick` is handed the card
field explicitly, so architecture cannot intercept a click on a wrestler. That
is a property of the design rather than of a filter someone could forget, and
the QA probe verifies it by measuring picking with the shell built and
suspended and comparing every answer: **0 of 520 differ**.

**Determinism.** No `Math.random()` appears in any builder. Panel shading,
marker-light placement and every other variation comes from `hash01(index,
salt)`, so the same scope builds the same stadium on every mount — which is
what screenshot comparison and URL restore both depend on.

### Two failures worth recording

**The shell rendered the entire lens black at high and medium tier.** Not
"looked wrong" — black, exactly like a renderer drawing nothing, which is where
the time went. Two independent causes, both in geometry that looked obviously
correct:

- Terrace risers were built from the floor up to each row's height, so the
  outermost row became a 12-unit wall wrapped around the whole bowl. A riser is
  one step tall; it has a tread.
- `arcPanel` took its facing from the segment TANGENT, which makes the normal
  direction depend on which way the arc is traversed. Here it came out inward,
  so the enclosing bowl rendered `BackSide` drew its near wall instead of
  culling it. Facing now comes from the midpoint radial direction.

The low tier never showed either symptom, because it builds no upper bowl —
which is exactly why the bug survived the first round of green checks.

The bowl is now a separate mesh with `depthWrite: false` drawn first. Correct
winding already keeps the near wall culled; the depth flag means that even if a
later edit breaks the winding again, the bowl cannot occlude a card, because
there is no depth for a card to fail against.

**The shell cost 25–30 ms a frame on the software path at every tier**, taking
the low tier from 16.7 ms to 42.2 ms and removing the only thing the low tier
promises. It was fill, not draw calls. `MeshStandardMaterial` buys matte
structural surface nothing a reader can see, so the shell is Lambert; treads
and most of the floor are dropped at the simple tier. Low tier now pays 4.8 ms.

## Section signage

Each section carries a sign standing behind the back row it names, with its
documented label and count. Placement comes from `ArenaSectionReport.arc`,
which `layoutArena` now reports as MEASURED output — row depth follows from how
many cards actually fit, so a sign positioned from the section definition
floats off a crowded bank, which is precisely when it matters.

**Signs billboard about the vertical axis, in the vertex shader.** This is not
a stylistic choice. The horseshoe wraps past 90 degrees on both flanks, so some
sections sit between the reader and centre stage while others sit beyond it.
Under any fixed orientation the reader sees the correct face of one group and
the mirrored face of the other — "OPPONENTS 382" read cleanly while "FOUGHT AND
TEAMED" came back right-to-left — and orbiting swapped which group was broken.
Two attempts (a winding flip, then negating the span) each fixed one group by
breaking the other. Billboarding keeps the POSITION on the section arc and lets
orientation follow the reader.

Signs fade out below ~7 world units and reach full opacity by ~17, because
signage written to be read across the room spans the entire frame close in — at
the ring viewpoint a near sign cut straight across the scoreboard.

One canvas, one texture, **one draw call** for every sign. The canvas is
allocated once and redrawn, so a scope change costs an upload rather than a GPU
allocation. A truncated roster is labelled on the sign itself: a capped bank
that reads as complete is a false claim, and the note belongs where the claim
is made.

## The scoreboard

A suspended four-sided board over the ring carries the scope, the canonical
name, documented aliases, the documented span, documented totals, and whatever
the reader has selected.

**Every field is nullable and every null prints "not documented", never 0.**
This is the point of the component. A board reading "0 matches" for someone
whose count the projection does not carry is a fabricated record set in the
largest type in the room, and a reader has no way to tell an absent count from
a real one. A promotion's reigns are null for exactly this reason — a promotion
does not hold titles, its wrestlers do, and 0 would claim it held none.

Facts are computed in `arenaAdapter.ts`, never in the renderer. Person totals
come from the graph node; promotion totals come from the projection's own
members, so the match figure is what the projection documents *for that
promotion* rather than each member's whole career. Matches and relationships
are labelled separately because they are different quantities: one multi-way
match contributes a single match and several relationships.

One `BoxGeometry`, one canvas, one texture, one draw call — three's default box
UVs map the whole texture onto each face, which is what a four-sided jumbotron
does. The canvas redraws only when the text changes. Measured: **0 redraws
across a camera move, 1 for a selection change.**

## The camera director

Named viewpoints over the top of `ArenaControls`, each solved from the CONTENT
rather than from a stored pose — an arena with 382 opponents and one with 31
are different rooms.

| Key | Preset | Frames |
|---|---|---|
| `1` | Establishing | every seated card |
| `2` | Ring | centre stage: subject card, ring and scoreboard together |
| `3` | Section | the selection's section, or the largest, along its own radial |
| `4` | Relationship | subject and selected card, with context |
| `5` | Head to head | the same pair, tighter |
| `6` | Championship rail | documented title activity |
| `7` | Index wall | switches formation — the Index IS a formation |

`F` focuses the selected or hovered relationship, `R` returns the camera to the
formation, `Home` goes to the ring, `C` toggles the director. WASDQE, orbit,
pan and dolly are unchanged.

Three guarantees, each measured by `pnpm arena:director` rather than asserted:

- **No instant cuts.** Every move goes through `ArenaControls.moveTo`, which
  writes only the spherical GOALS and lets existing damping carry it. Measured:
  the largest single-frame step is a small fraction of total travel for every
  preset. SPIKE 1 measured what a cut costs — 0.786 NDC in one frame against a
  0.0003 ordinary step.
- **Manual input cancels direction immediately.** `ArenaControls.userInputSeq`
  increments on deliberate reader input and never on a directed move; the
  director samples it and abandons the move when it changes. Measured: a wheel
  event takes the camera back within two frames.
- **No control silently does nothing.** A preset the scope cannot honour
  reports a reason. On a person scope the rail preset returns *"the corpus
  documents no title activity for this scope"* rather than quietly not moving.

A directed target is expressed as an offset in `userOffset`, not written into
`formationTarget` — `updateCamera` re-proposes the formation's look-at on every
engaged frame and would copy over it on the next one. That is the same trap
recorded against pan.

The framing solver is shared with the formation (`ArenaRenderer.solveFraming`),
so a preset and the default view agree about what "everything is visible"
means. It accepts an occlusion fraction that shrinks the usable half-angle, so
a focused card is not framed underneath the inspector.

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

| Tier | Cards | Labels | Routes | Pulses | Bloom | DPR cap |
|---|---|---|---|---|---|---|
| high | 600 | 160 | 40 | 52 | on | 2 |
| medium | 360 | 120 | 22 | 28 | on | 1.5 |
| low | 160 | 80 | 10 | 12 | **off** | 1 |

The stadium extends the same ladder. Each row is a separate lever, and the low
tier is a coherent room rather than a broken one:

| Tier | Stage | Bowl | Signage | Scoreboard | Shafts | Fog | Measured draw calls |
|---|---|---|---|---|---|---|---|
| high | full ring, ropes, ramp, tunnel | terraces + treads + upper bowl + truss + speakers | full | yes | 4 | yes | **5 / 24** |
| medium | full ring, ropes, ramp, tunnel | terraces + treads + upper bowl + truss | full | yes | 2 | yes | **5 / 12** |
| low | floor, mat, barricade | terraces only, no treads, no upper bowl | full | yes | 0 | no | **2 / 6** |

Signage and the scoreboard are present at every tier on purpose. They are the
lens's *semantic* layer, not decoration — the low tier drops what is expensive
(fill, shafts, bloom, upper bowl) and keeps everything that says what the arena
means.

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

## Measured: the stadium

Every figure from `pnpm arena:stadium` and `pnpm arena:director`, at
1920×1080 unless stated. Headless here is **SwiftShader**, a software
rasteriser — the absolute frame times are not comparable to hardware, so the
shell's cost is reported as a DIFFERENCE measured by suspending it and
re-measuring.

| Property | high | medium | low |
|---|---|---|---|
| Environment draw calls (budget) | 5 (24) | 5 (12) | 2 (6) |
| Shell frame cost, delta | 21.8 ms on 68.5 ms | — | **4.8 ms on 16.7 ms** |
| Shell rebuild | 1.3–10.1 ms | 2.1–3.3 ms | 0.9–1.3 ms |

| Property | Measured |
|---|---|
| Rebuilds while idle (2 s) | **0** |
| Rebuilds arena → index → arena | **0** (visibility flip, not a rebuild) |
| Picking answers changed by the shell | **0 of 520** |
| Scoreboard redraws on a camera move | **0** |
| Scoreboard redraws on a selection change | 1 |
| Signage draw calls | 1 atlas, 3 signs, 0 mismatches vs layout |
| Cards inside viewport, shell present | **100%** at 1920×1080, 1366×768, 390×844 |
| Camera below the floor, any preset | **never** (min y 2.99 at head-to-head) |
| Console errors | **0** |

`drawCalls` previously measured nothing. three resets `info` inside every
`render()`, so with bloom on the reported figure was the OutputPass fullscreen
quad — 1, regardless of scene contents. `info.autoReset` is now off and the
counter is read once per frame, so every figure above is the frame's real
total.

Resource counts return to baseline across tier cycling and repeated lens
switching (geometries and textures). The shader *program* cache grows from 19
to 22 as the signage, scoreboard and Lambert shell variants compile, and stays
there — that is three's `WebGLPrograms` cache, bounded by the number of
distinct material configurations, not a leak.

## Capture procedure

`page.screenshot()` is the wrong tool and produces a confidently wrong picture.
The context is not created with `preserveDrawingBuffer`, so the WebGL surface
is undefined once the frame has been presented, and the capture returns perfect
DOM labels sitting on a black void — indistinguishable from a renderer that
draws nothing. This cost real time during the stadium work: the first three
"the shell renders black" investigations were partly chasing that artefact.

Use `pnpm arena:shots`, which drives `ArenaRenderer.screenshot()` — it renders
immediately before reading, inside the same task, and composites the DOM label
layer plus a metadata strip naming the subject, counts, tier and sections.

```
KAYFABE_BASE_URL=http://127.0.0.1:9464 \
QA_VIEWPORTS=1920x1080,1366x768,390x844 QA_TIER=high QA_PRESET=ring \
  pnpm arena:shots
```

Pin the tier through the **UI control**, not `applyTier()`. `ArenaLens` holds
the tier in React state and re-applies it on render, so a direct call is
silently reverted and every capture comes back labelled with a tier that is not
the one under test.

## Rejected approaches

| Rejected | Why |
|---|---|
| Volumetric raymarched light shafts | The bloom chain alone is ~89 ms half-resolution on the software path. A march lands hardest on exactly the devices the governor is rescuing. Additive cone meshes read as shafts from every reachable angle for one draw call. |
| Ribbon strips / scoreboard on `BLOOM_LAYER` | Bloom here is a closed list and is fill-bound. A ribbon wrapping the bowl on that layer would push the governor down a rung for decoration. Bright unlit additive gets the look for nothing. |
| `MeshStandardMaterial` for the shell | Measured 25–30 ms a frame at every tier on the software path. PBR buys matte structural surface nothing visible; Lambert cost 4.8 ms at low tier. |
| Crowd figures in the bowl | An invented audience is an invented count. Forbidden by the data laws, and the bowl reads without one. |
| A mesh and texture per section sign | A draw call per section plus a GPU allocation on every rebuild. One atlas, redrawn in place. |
| Fixed sign orientation (winding flip, span negation) | Both tried; each fixes the sections on one side of the camera and mirrors the ones on the other, and orbiting swaps which. Billboarding about Y is the only orientation that is correct everywhere. |
| Shadow maps | A second full render of the architecture to sharpen a step edge, on a lens that is already fill-bound at the tier that needs help most. |
| Deriving the shell from its own constants | Terraces, aisles and signage all read `SEAT_*` from `types.ts`. Duplicated, the shell drifts off the seating the moment either is tuned, and a terrace that no longer lines up reads as a rendering fault. |

## Not yet built

Stated plainly because the brief forbids documentation that outruns the code.
None of the following exists yet:

- **History Replay** (WS8). There is no playback engine, no transport, no rail
  playhead and no cross-lens replay handoff. `ArenaRenderer.replayDate` exists
  and the scoreboard renders it, but nothing sets it yet.
- **Canonical identities and aliases** (WS1). `ArenaSubjectFacts.aliases` is
  read and rendered by the scoreboard, but no alias table populates it. Matt
  Sydal (`p:116704`) and Evan Bourne (`p:35621`) are still two separate nodes;
  `services/materializer/LIMITATIONS.md:64` remains accurate.
- **Semantic LOD with hysteresis** (WS6). Labels still use the existing
  emphasis ordering, not projected-screen-size bands.
- **Inspector tabs** (WS9), the **UI/mobile release pass** (WS10) and **audio**
  (WS11).
- co-holder grouping within a rail segment, and a playhead travelling the rail
  during timeline playback
- person-scope title rails (the promotion projection carries per-year title
  counts; the per-person equivalent would need another projection read)
