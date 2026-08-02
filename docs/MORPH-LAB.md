# MORPH LAB

One persistent set of corpus entities transforming between readable
3D topologies. Morph Lab is the organized companion to Connectome
(`lens=morph`); Geo Replay β remains the secondary geographic view. The
Connectome underneath stays mounted and suspended so its exact camera state
survives a round trip.

## The reading

1. The lab opens on the ORGANIC positions — the same `graph/nodes.json pos`
   the connectome renders, cloned once (never mutated) and scaled ×300 into
   the lab's world units. Ambient fibers are the strongest lifetime edges,
   bounded and stated.
2. Clicking a wrestler reorganises the corpus into a 3D RELATIONSHIP ARRAY:
   the selection becomes the spatial focus; documented opponents occupy the
   left bank, same-side partners the right, mixed relationships the front and
   battle-royal-only contacts the lower bank. Promotions rise behind the
   focus and championships occupy a distinct gold upper/front rail. Height
   communicates strength and depth communicates documented chronology.
3. Clicking another wrestler retargets the spatial structure from the current
   interpolated state (one bounded capture, never a snap back).
4. A promotion opens a 3D PROMOTION NETWORK (documented participant era shelves
   and a gold championship tier); a championship opens TITLE LINEAGE (gold
   chronological rail, with overlap separated into depth lanes). CAREER SPINE
   reads one wrestler left-to-right across promotion lanes. HEAD-TO-HEAD places
   two people at opposing anchors and distinguishes shared and exclusive
   documented relationships.
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
- **Context reduction.** Non-participating nodes retain deterministic identity
  in a distant, low-opacity spatial context whose visibility is user-controlled.
  Semantic members and the selected entity remain visible at every quality tier.
- **Shared semantic emphasis.** Connectome and Morph consume the same resolved
  contract for selection, hover, members, anchors, pins and paths. Membership
  updates remain independent of layout roles, so a late promotion/title shard
  illuminates the full graph-resident population without rebuilding the board.
- **Virtual entities.** Below-threshold promotions and championships have no
  graph node; they appear as keyed virtual slots that fade in
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
- The web unit suites cover exact restore, one canonical slot per graph node,
  category rules, stable sorts, finite coordinates, meaningful Z separation,
  title/promotion membership, async semantic emphasis, URL migration and
  capture continuity.
- `tests/e2e/morph.spec.ts` runs desktop, mobile and reduced-motion journeys, including proof the
  morph actually travels and that the connectome camera survives the round
  trip.
- `tests/e2e/morph-resilience.spec.ts` forces Connectome and Morph WebGL
  creation failures, loses/restores a live context, rapid-retargets five
  selections, checks lens-scoped keyboard ownership and verifies mobile camera
  inset fitting.
- `tests/morph-qa.mjs` — screenshot + probe harness;
  `tests/morph-recordings.mjs` — journey recordings.
- `tests/morph-performance.mjs` records real frame intervals, renderer CPU EMA,
  pick latency and long tasks for tissue, wrestler, promotion, lineage, career
  and rapid-retarget readings. Set `QA_REQUIRE_HARDWARE=1` to reject software
  rasterizers.
- URL state: `mo*` keys via `registerMorphUrl`; camera serialized only after
  the user moves it.
