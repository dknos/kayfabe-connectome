# MORPH LAB β

One persistent set of corpus entities transforming between readable
topologies. The lab is the fifth lens (`lens=morph`), beside the Connectome,
Atlas, Geo Replay and Table — it replaces none of them, and the Connectome
underneath stays mounted and suspended exactly as it does for the others.

## The reading

1. The lab opens on the ORGANIC positions — the same `graph/nodes.json pos`
   the connectome renders, cloned once (never mutated) and scaled ×300 into
   the lab's world units. Ambient fibers are the strongest lifetime edges,
   bounded and stated.
2. Clicking a wrestler reorganises the corpus into their RELATIONSHIP LOOM:
   the selection becomes the centre processor; documented opponents dock into
   the left rail, same-side partners into the right, battle-royal-only
   contacts into the lower rail. Promotions with documented appearances run
   along the upper context bus, documented championships along the gold
   module bus — both dashed/contextual, never drawn like match relationships.
3. Clicking another wrestler retargets the whole board from the current
   interpolated state (one bounded capture, never a snap back).
4. A promotion opens its MOTHERBOARD (activity bus, gold title modules,
   person port banks by first documented decade); a championship opens its
   LINEAGE (gold rail of documented reigns; gaps stay "unrecorded", open ends
   stay "open in corpus"); CAREER CIRCUIT reads one wrestler chronologically
   across promotion lanes. HEAD-TO-HEAD β compares two people (path A/B or
   selection + pin) as chronological rungs from the evidence shards.
5. "Return to tissue" restores the organic positions exactly — the organic
   layout only ever copies the clone, so the round trip is byte-identical
   (asserted by unit test and Playwright journey).

## Engine (`packages/morph-renderer`)

- **GPU morphing.** Every node slot carries from/to position, scale and
  opacity attributes; one staggered `uMorph` clock (`MORPH_MS` 920 ms,
  quintic in-out, per-element delay bands = the spec's anchor → isolate →
  reorganize → route → explain phases). No per-node CPU work per frame.
- **Trace morphing.** Every trace is exactly `TRACE_SAMPLES` (24)
  cross-sections; the organic bow and the routed schematic are the same
  vertices with two homes, so fibers untangle into traces continuously.
  Ribbon width is in pixels, expanded in the vertex shader. The material is
  **DoubleSide** — ribbon winding flips with travel direction, and FrontSide
  culling silently erases every upward segment (found the hard way).
- **Retargeting.** A click mid-flight folds the interpolated state into the
  from-buffers (`captureCurrent`, math byte-identical to the GLSL) and
  restarts the clock. Reduced motion lands geometry at once and crossfades
  opacity only; a snap (first layout, context restore) always wins over
  reduced motion.
- **Background compression.** Every non-participant node gets a deterministic
  target: promotions in a labeled top shelf, championships in a gold lower
  shelf, people in contiguous community grids (largest community first,
  degree-ordered within). The corpus visibly reorganises; nothing vanishes.
- **Virtual chips.** 406/571 promotions and 3,648/4,389 championships have no
  graph node; they appear as keyed virtual slots (768 cap) that fade in
  place. A selectable person without a corpus node (csv-belt holders) falls
  back to the organic reading — never an error screen.
- **Honesty.** Trace caps, label caps, member truncation and shard failures
  are surfaced in `stats`/notes. Membership wording is documented appearance
  — never employment; lineage gaps are unrecorded — never vacant; csv belts
  say their source cannot record title changes.
- Soma alpha is divided by √(community population) — the connectome's
  white-plateau lesson, applied at birth instead of re-learned.

## QA

- Seam: `window.__kayfabeMorph` (mode, morphing, morphProgress, traceLive,
  lastLabelReport, qualityTier, frameTimeMs, currentPositionOf, cam).
- `apps/web/src/__tests__/morph.test.ts` — 36 unit tests (exact restore,
  one-canonical-node-per-wrestler, category rules, stable sorts, NaN sweeps,
  wording contract, URL round-trip, capture continuity).
- `tests/e2e/morph.spec.ts` — 9 journeys × 3 projects, including proof the
  morph actually travels and that the connectome camera survives the round
  trip.
- `tests/morph-qa.mjs` — screenshot + probe harness;
  `tests/morph-recordings.mjs` — journey recordings.
- URL state: `mo*` keys via `registerMorphUrl`; camera serialized only after
  the user moves it.
