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

## Orbit Map

Orbit Map is the person-centered graph-distance reading. The selected
canonical person occupies the sole center slot; documented direct person
relationships occupy stable opposed, same-side, mixed, and
battle-royal-only sectors of the inner orbit. A relationship with any opposed
and same-side evidence is mixed, while battle-royal-only is reserved for
edges with neither ordinary opposed nor same-side evidence.

Direct strength is one shared, inspectable formula: opposed + same-side +
0.35 × battle-royal contacts. Battle-royal evidence is down-weighted because
one large field can create many incidental pair contacts. Title context is
excluded from strength and cannot create a relationship. Direct ordering is
descending strength, earliest valid documented shared day, then stable entity
id; zero/missing days remain unavailable rather than becoming 1900 dates.

Second-hop bridge candidates are derived by expanding only displayed direct
adjacency lists, never by scanning every corpus pair. The selected person,
already-direct people, invalid ids, and nonperson entities are excluded. One
candidate record accumulates all displayed intermediary paths; each path adds
`sqrt(center-to-intermediary strength × intermediary-to-candidate strength)`.
Candidates rank by summed path score, supporting route count, then stable id.
Their target angle is the weighted circular mean of intermediary angles,
followed by a fixed 12-pass, id-stable wrap-aware collision relaxation. No
force simulation continues after the board lands.

The direct and bridge populations and bridge connectors are capped by quality:

| Tier | Direct | Bridges | Bridge connectors |
| --- | ---: | ---: | ---: |
| High | 120 | 160 | 200 |
| Medium | 80 | 96 | 150 |
| Low | 48 | 48 | 80 |

Pinned, hovered, comparison, and path ids may survive these ordinary caps only
when the graph provides a supported one-hop or displayed two-hop placement.
Every displayed bridge retains at least one visible intermediary route; an
unusually small renderer trace budget reduces the bridge population instead
of showing unsupported outer nodes. Notes and Orbit statistics disclose total
and displayed direct/bridge populations, displayed and omitted supporting
routes (including paths belonging to omitted candidates), tier reduction,
guide count, and optional-dossier availability.

Radius encodes graph hop, direct angular sector encodes relationship role,
node size and route width encode the documented strength above, and Z is a
semantic layer: center +40, direct 0, bridge −125, promotion +170, and
championship +270 world units. Promotion copy says documented appearance
context and explicitly denies employment; championship copy exposes missing
title-change data rather than inferring a reign. Context-off only quiets the
distant corpus rack and never changes active Orbit placement.

## Hover, picking, and labels

`MorphHoverController` is the single transient owner for canvas, label, card,
and keyboard sources. The first valid canvas target acquires immediately; a
replacement needs two confirming frames. Related-surface leave uses one 100 ms
grace timer, so canvas → label → card → action travel does not clear emphasis.
Layout generation, context loss, lens exit, blur, pointer cancellation, and
touch transition clear stale state. Camera drag suppresses picking and hides
the transient card; pointer release resamples the last position.

Canvas pointer movement queues at most one pick per animation frame. Organized
layouts scan a compact active/semantic slot list before any ambient fallback.
The picker uses exact current interpolation, projected point radius, normalized
screen distance, frontmost depth, semantic priority, layout role, opacity,
sticky target, and mouse/touch hit slop. Regions are considered only after
eligible entities. `lastPickDiagnostic` exposes id, source, candidate count,
duration, normalized distance, depth, priority, and role for QA; the ordinary
interface never shows it.

Projected labels are keyed DOM groups: a primary entity button and sibling
Focus, Pin, comparison A/B, and Open buttons. Roving focus bounds Tab to useful
visible labels; arrow keys move through that pool and `F` focuses the current
label. Removing a focused pooled label returns focus to the Morph label host,
never a different entity. Touch-generated label focus is suppressed as hover,
so a tap cannot leave synthetic emphasis stuck.

The hover card anchors to the projected node and imperatively tracks camera and
morph motion. It chooses a stable free-space quadrant, clamps around desktop
rails and sheets, and never follows cursor pixels. Direct cards preserve every
component count; bridge cards state two hops, supporting intermediaries, and
that placement claims no direct relationship. Selection detail stays
persistent in the inspector while a separate Hover Peek mirrors this transient
explanation. Mobile uses persistent selection and Details instead of requiring
the pointer card.

## Controls and accessibility

Person modes are explicit Array, Orbit, Career, and Compare controls. Auto
remains a URL migration/default policy, not the only visible route to Array.
Fit, Focus, Return to Tissue, and Corpus context are scene controls. The legend,
mode explanation, and Reading metrics follow the landed topology. Promotion
and title selections expose only their valid network/lineage reading.

Morph owns shortcuts only while the lens is active and focus is outside text
controls: `R` fit, `F` focus, `T` tissue, `Escape` clear transient state then
ascend, and `Space` play/pause where valid. Person shortcuts are `1` Array, `2`
Orbit, `3` Career, and `C` Compare when a pair exists. Repeated keydown does not
rebuild a topology.

The canvas remains `aria-hidden`; labels, hover/selection detail, and the
inspector provide equivalent semantics. Focus rings and action names are
explicit, pointer hover does not spam live announcements, and each topology
has one concise screen-reader announcement. At the mobile breakpoint,
Layout/Details/Map and primary scene actions use touch-sized targets, safe-area
padding is honored, and the fitted volume excludes the active bottom sheet.

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
  lastLabelReport, qualityTier, frameTimeMs, currentPositionOf, orbitStats,
  `hover.snapshot()`, `lastPickDiagnostic`, cam).
- The web unit suites cover exact restore, one canonical slot per graph node,
  category rules, stable sorts, finite coordinates, meaningful Z separation,
  title/promotion membership, async semantic emphasis, URL migration and
  capture continuity.
- `tests/e2e/morph.spec.ts` runs desktop, mobile and reduced-motion journeys, including proof the
  morph actually travels and that the connectome camera survives the round
  trip.
- `tests/e2e/morph-orbit.spec.ts` covers Array → Orbit continuity, direct and
  bridge honesty, label/card ownership, drag suppression, five-target retarget,
  URL reload, optional-dossier degradation, mobile touch, and reduced motion.
- `tests/e2e/morph-resilience.spec.ts` forces Connectome and Morph WebGL
  creation failures, loses/restores a live context, rapid-retargets five
  selections, checks lens-scoped keyboard ownership and verifies mobile camera
  inset fitting.
- `tests/morph-qa.mjs` — screenshot + renderer/semantic/pick probe harness;
  `tests/morph-recordings.mjs` — Orbit and cross-topology journey recordings.
- `tests/morph-performance.mjs` records real frame intervals, renderer CPU EMA,
  pick latency and long tasks for tissue, wrestler, promotion, lineage, career
  and rapid-retarget readings. Set `QA_REQUIRE_HARDWARE=1` to reject software
  rasterizers. `QA_HEADFUL=1` permits WSLg hardware validation while the default
  stays headless and deterministic.
- URL state: `mo*` keys via `registerMorphUrl`; explicit Orbit and context
  state round-trip, while camera is serialized only after the user moves it.
