# Three.js examples audit — Arena Array

Every official example named in the Arena Array brief, inspected **at tag
r182**, cross-checked against the **installed** `three@0.182.0`, and decided.

The purpose is not to demonstrate that examples were consulted. It is to
decide, with evidence, which proven graphics ideas belong in a wrestling-history
reading instrument and which look impressive in isolation and would damage it.

## How this audit was produced

The installed package ships `examples/jsm/` only — **there are no example
`.html` files under `node_modules`**. So the two halves came from two places,
and they are not interchangeable:

| Question | Source | Why that source |
|---|---|---|
| What does the example demonstrate? | `raw.githubusercontent.com/mrdoob/three.js/**r182**/examples/<name>.html` | The tag, never `master`. All 26 fetched at 200. |
| Does the API exist here? | Local `node_modules/.pnpm/three@0.182.0/.../three/` | Exact by construction — it is the code that will run. |

Nothing below claims an API exists without a path and symbol that was actually
read. Claims marked **[verified here]** were additionally re-checked by hand
against the installed package while writing this document.

### Measurement environment, stated up front

Two facts constrain every number in this file, and both are easy to misread:

1. **Headless Chromium in this WSL2 has no hardware GL.** There is no
   `/dev/dri`; headless reports
   `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`.
   `QA_HEADFUL=1` under WSLg reports
   `ANGLE (Microsoft Corporation, D3D12 (AMD Radeon(TM) Graphics), OpenGL 4.2)`
   and is real hardware. Both are recorded; software is the pessimistic
   LOW-tier floor, not the headline.
2. **`requestAnimationFrame` is vsync-clamped and is saturated at this scale.**
   Every configuration tested — 160/360/600 cards, all three formations,
   SwiftShader *and* D3D12 — reads a flat **16.7 ms p50 and p95**. That is a
   legitimate *gate* ("the card field never approaches the frame budget") and a
   useless *comparator*. It cannot rank two render stacks. Where cost is
   compared, the unclamped CPU-side signals are used instead: transition CPU
   time, render-submission time, draw calls and render-target count.

Cost columns below are therefore explicitly labelled **estimate** (reasoned
from what the code does) or **measured** (produced by a re-runnable probe in
`tests/arena-spikes/`). No number is presented as measured unless a script in
this repository printed it.

---

## The matrix

Legend — decision: **SHIP** adopt the technique · **PROTO** prototype before
committing · **REJECT** do not adopt, reason recorded.

| # | Example | Release | Technique demonstrated | Possible Arena Array adaptation | Compatibility risk | Est. GPU/CPU cost | Prototype result | Decision & reason |
|---|---|---|---|---|---|---|---|---|
| A1 | `css3d_periodictable` | r182 | Precomputed index-aligned target-formation arrays driving one persistent object set | The core Arena idea: Echo / Arena / Index as three index-aligned target buffers over one card set | LOW as structure, **HIGH as literal port** — driver is per-object TWEEN | Structure: negligible. Demo driver: allocates per card per property | **SPIKE 1 built it.** 600 cards, 1 draw call, retarget ≤0.2 ms | **SHIP (structure only).** Adopted as `FormationTransition`. Driver rejected — see "What was deliberately not copied" |
| A2 | `css3d_mixed` | r182 | **Not the historical demo.** At r182 this is an iframe-in-picture-frame occlusion demo: dual renderers, one camera, a depth-writing cutout plane | Bounded real DOM cards occluded correctly by a WebGL field — the answer to "must not use full-population CSS3D" | **HIGH — concrete blocker.** Every renderer in this repo is `alpha: false` with an opaque clear (`ConnectomeRenderer.ts:187-190`); the technique needs `alpha: true` | 1 extra DOM layer + a depth-only cutout draw | not prototyped | **PROTO.** Highest-value transfer in the set, but gated on an `alpha` change that touches every existing lens. Not a Phase-1 decision |
| A3 | `css3d_orthographic` | r182 | CSS3D under an orthographic camera via the two-scene split | Reference only, for an Index-wall camera mode | MEDIUM — `setViewOffset` is 6 positional args (`OrthographicCamera.js:148`) | negligible | not prototyped | **PROTO (narrow).** ~95% demo scaffolding; the value is the orthographic branch inside `CSS3DRenderer` (`:241`, `:249`) **[verified here]** |
| A4 | `css2d_label` | r182 | Camera-synchronised DOM labels parented to 3D objects; layers as a visibility channel | Label patterns: parent to card transform, anchor translate, distance fade | MEDIUM — **layers is a visual gate, not a cost gate**: projection maths still runs for hidden labels | Per-label per-frame projection, unbounded | not prototyped | **REJECT (the addon).** `MorphLabels.ts` already does keyed DOM pooling, priority sort and collision suppression — strictly more than `CSS2DRenderer`. Adopt the three patterns, not the class |
| B1 | `webgl_instancing_dynamic` | r182 | `InstancedMesh` + `DynamicDrawUsage`, full per-frame matrix rewrite of 10,000 instances | Only the one-line `setUsage(DynamicDrawUsage)` idiom | LOW API. Loads `textures/edge3.jpg`, not shipped by npm | *estimate:* **40 KiB/frame** matrix re-upload — governed by the **allocated** buffer (our `CAPACITY = 640`), not the live card count, because `needsUpdate` with no update range does `bufferSubData` over the whole array | — | **REJECT as architecture template.** Independent of any cost figure: its central loop (`getMatrixAt`→`decompose`→`setMatrixAt` per instance per frame) is structurally the CPU-authored-transform pattern the brief forbids |
| B2 | `webgl_instancing_performance` | r182 | An A/B/C measurement harness (instanced vs merged vs naive), not a rendering technique | The *method*: prove the draw-call claim instead of asserting it | LOW API. Loads a model npm does not ship | — | — | **REJECT for runtime code / adopt as method.** No shippable technique. The measurement discipline is adopted in `tests/arena-spikes/` |
| B3 | `webgl_buffergeometry_instancing` | r182 | `InstancedBufferGeometry` + custom `InstancedBufferAttribute`s over a shared base geometry, one uniform driving the animation | **The ship template** for the card field with per-instance semantic attributes | MEDIUM — the real limit is the **vertex-attribute budget**: WebGL2 floor is `MAX_VERTEX_ATTRIBS ≥ 16` and a mat4 `instanceMatrix` alone consumes 4 | 1 draw call; per-instance attribute uploads only when the population changes | **SPIKE 1: 1 draw call at 600 cards** | **SHIP.** Already validated in-repo — `RatingPeaks.ts:163-169` sets seven custom instanced attributes against this exact three version |
| B4 | `webgl_buffergeometry_instancing_interleaved` | r182 | **Misleading name** — the interleaving is *per-vertex*, not per-instance; no `InstancedInterleavedBuffer` appears | Almost nothing. A card is a quad; interleaving its ~4 shared vertices saves ~100 bytes total | MEDIUM-HIGH if adopted wholesale — one buffer means one usage flag and one update range | — | — | **REJECT as template.** Does not demonstrate what its name implies, and its per-frame loop is the same anti-pattern as B1 |
| C1 | `webgl_instancing_raycast` | r182 | CPU raycast against `InstancedMesh`, yielding `intersection.instanceId` | Card picking | **Real trap, now measured: stale `boundingSphere`.** Null until computed and *not* recomputed as instances move **[verified: `InstancedMesh.js:100,151`]** | *measured:* p50 **0.1–0.2 ms**, idle 0.1 ms | **SPIKE 2: 96.8–100% agreement** with GPU ground truth at 160/360/600, while orbiting, and mid-transition. With bounds left stale: **69.5%, with 67 false misses** | **SHIP.** Wins on cost and accuracy together. Recomputing bounds per pick is mandatory, not optional |
| C2 | `webgl_interactive_cubes_gpu` | r182 | GPU integer-ID picking: 1-pixel scissored render + `readRenderTargetPixels` | Pixel-exact picking during GPU-side transforms | HIGH — readback format is driver-gated; readback also stalls the GPU (`GL Driver Message: GPU stall due to ReadPixels`) | *measured:* p50 **3.0–3.6 ms**, and **3 ms idle per sample** — every pointer move pays it | **SPIKE 2: correct (it is the reference), but ~20–30x the cost of raycast** | **REJECT for hover.** Accuracy it has; affordability it does not. Keep as a fallback only if raycast is ever shown to fail |
| C3 | `webgl_interactive_buffergeometry` | r182 | Face-level raycast granularity + zero-allocation highlight overlay | `intersection.uv` (`Mesh.js:455`) as a **sub-card** hook — a card is 2 triangles, so `faceIndex` is useless but `uv` locates a hit *within* the card | LOW-MEDIUM. The demo itself raycasts a one-frame-stale `matrixWorld` | negligible | — | **SPLIT: SHIP `intersection.uv`**, reject the demo's overlay construction and its stale-matrix ordering |
| D1 | `webgl_lines_fat` | r182 | Screen-space-width polylines via instanced quad expansion (`Line2`/`LineGeometry`/`LineMaterial`); width lives in a **uniform** | The base layer for curved evidence routes: sample curve → flat positions → `setPositions` | LOW. `resolution` uniform present **[verified here: `LineMaterial.js:13`]**. **Do not "clean up" the existing hand-set `resolution.set()` calls** (`RatingGuides.ts:103` and sibling): `onBeforeRender` overwrites the uniform per draw, so they are inert for *rendering* but are the only thing keeping **raycast** correct | 1 draw call per route batch | SPIKE 3 (pending) | **SHIP.** Correct and verified mechanism for controlled screen-space route width |
| D2 | `webgl_lines_fat_raycasting` | r182 | Hover against screen-space-expanded quads | Route hover | **MEDIUM — verified silent trap.** `Raycaster.params` has **no `Line2` key** by default, and `LineSegments2.js:329` reads `params.Line2 !== undefined ? … : 0` → **threshold silently 0** unless you create the bucket **[verified here]** | *measured:* p50 0.1 ms over 100 routes | **SPIKE 3: 90% hit-rate 5 px off-centreline with the bucket, 60% without** | **SHIP.** Creating `raycaster.params.Line2` is mandatory. Dead-centre aim hits either way, which is why this must be tested off-centre |
| D3 | `webgl_lines_colors` | r182 | Six plain `THREE.Line` objects with vertex colours. **Imports nothing from `lines/`** | The colour-parameterisation split only: hue for category, value for magnitude | LOW as written, **HIGH if adopted** — `LineBasicMaterial` linewidth is capped at 1 px by drivers (`LineBasicMaterial.js:62-64`) | trivial | — | **REJECT as a rendering path.** Structurally incapable of the brief's bounded, readable route width. Keep only the colour-encoding idea |
| D4 | `webgl_buffergeometry_drawrange` | r182 | Prefix reveal from an over-allocated, never-reallocated buffer via `setDrawRange` | Progressive route draw-in, championship rail reveal | LOW on API. **`drawRange` is inert on `Line2`** — but the equivalent exists: `LineSegmentsGeometry extends InstancedBufferGeometry` and the renderer honours `geometry.instanceCount` **[verified here: `WebGLRenderer.js:1317`]** | No reallocation; refill a prefix | **SPIKE 3: monotonic 0 / 6 / 12 / 23 segments** at reveal 0 / .25 / .5 / 1 | **SHIP (technique, via `instanceCount`).** The drawRange idea transfers to fat lines correctly; it just is not the drawRange *field* |
| D5 | `webgl_modifier_curve` | r182 | Curve baked to a `DataTexture` with full Frenet frame; vertices resampled in the vertex shader (`Flow`) | Wrong mode as demonstrated — the brief needs **rigid** placement, which the demo never exercises | MEDIUM-HIGH, top risk silent: the injected shader requires an **identity world matrix** | 1 half-float `DataTexture` per curve set | SPIKE 3 (pending) | **PROTO.** Not a straight port. Cards must be *positioned* by tangents, never deformed |
| D6 | `webgl_modifier_curve_instanced` | r182 | `InstancedFlow`: per-instance curve riding by **hijacking `instanceMatrix`** to smuggle scalars | Closest fit for small luminous route markers | **HIGH — `instanceMatrix` is fully consumed** by the encoding, so it cannot also carry transforms | 1 draw call for all markers | SPIKE 3 (pending) | **PROTO.** Highest potential fit for the marker requirement, gated on questions the demo cannot answer |
| E1 | `webgl_postprocessing_unreal_bloom_selective` | r182 | Two-composer selective bloom: layer bit for selection, additive composite | Bloom restricted to the pulse layer only | MEDIUM. Note the card field is ONE InstancedMesh, so the demo's darkened-material swap would blanket it — hide non-bloom objects instead | *measured:* **+0.29 ms submission, 4 render targets** | **SPIKE 4: works, layer-restricted so only pulses bloom** | **SHIP.** Cards, routes and text are excluded by construction rather than by threshold tuning |
| E2 | `webgl_postprocessing_unreal_bloom` | r182 | The canonical whole-scene chain: `RenderPass → UnrealBloomPass → OutputPass` | Inherited, not imported | LOW — identical chain already runs in this repo at this exact version | 1 composer, mip chain | — | **SHIP (already shipped).** `ConnectomeRenderer.ts:245-256` is this example with different constants. Work is parameters, not adoption |
| F1 | `webgl_postprocessing_outline` | r182 | Selection silhouette via a depth-compare mask over `selectedObjects` **[verified here: `OutlinePass.js:42`]** | Selection emphasis | **MEDIUM-HIGH: `selectedObjects` is object-granular.** Handing it the card `InstancedMesh` outlines *every instance* — exactly the failure the brief warns about | 2 extra full-res passes + RTs | SPIKE 4 (pending) | **PROTO with a documented reject branch.** Needs the proxy-mesh or shader-edge alternative; not shippable as-is |
| G1 | `webgl_postprocessing_afterimage` | r182 | Full-screen ping-pong feedback trail; `damp` **[verified here: `AfterimagePass.js:31`, default 0.96]** | Requested: pulse-only afterglow | LOW compatibility, **fatal behaviourally**: the pass composites the **entire** read buffer, so any motion smears — including cards, text and camera | *measured:* **+0.21 ms and 2 further render targets** on top of bloom | **SPIKE 4: runs, but still cannot be restricted to pulses** | **REJECT for the stated requirement.** Cost is modest; the blocker is that "pulse-only" is not expressible in a full-screen composite |
| J1 | `webgl_postprocessing_transition` | r182 | Two-scene crossfade with a threshold dissolve | Explicitly *not* the Arena→Index path | MEDIUM compatibility, HIGH architectural mismatch — renders **both** scenes every frame | 2 scenes + 2 RTs every frame, always | — | **REJECT for the primary path.** The brief requires a true object morph and SPIKE 1 built one. Keep only the dissolve formula for the reduced-motion fallback |
| I1 | `webgl_lod` | r182 | Discrete level swapping with a **hysteresis band** | Semantic LOD: far = section shells + headings + aggregates; near = names + metrics | Low on API, real on semantics — `LOD.update` measures world distance ÷ zoom, not apparent screen size | negligible | — | **SHIP (the ~10-line formula, not the class).** Drive the hysteresis band from projected screen size, which is what actually governs readability |
| I2 | `webgl_batch_lod_bvh` | r182 | BatchedMesh LOD with a BVH | — | **BLOCKER.** The LOD API this example is named for **does not exist at 0.182.0** — `grep -ic lod src/objects/BatchedMesh.js` returns **0** **[verified here]**. Also pulls third-party `three-mesh-bvh` | — | — | **REJECT.** Not a judgement call: the API is absent and the brief forbids both master-only APIs and new dependencies |
| I3 | `webgl_mesh_batch` | r182 | `BatchedMesh` + `addGeometry`/`setGeometryIdAt`/`setVisibleAt` **[verified here: `BatchedMesh.js:627`]** | Multi-geometry card variants (plaque, aggregate, section marker) in one draw call | LOW — present, no third-party dependency | 1 draw call across differing geometries | — | **SHIP-candidate.** The one example of the four that transfers as working code at 0.182.0 |
| I4 | `webgl_buffergeometry_selective_draw` | r182 | Per-vertex visibility attribute gating drawn geometry | Route/connector visibility without rebuilding buffers | LOW on API | negligible | — | **PROTO (scoped).** Sound, but scope it to the line layer — `BatchedMesh` cannot host it |

---

## SPIKE 1 — measured, not estimated

Probe: `tests/arena-spikes/spike1-formation.mjs`. Corpus:
`tests/arena-spikes/build-spike-corpus.mjs`. Both re-runnable; every figure
below was printed by them.

| Measure | Software (SwiftShader) | Hardware (D3D12 / Radeon) |
|---|---|---|
| Draw calls, 600 cards | **1** | **1** |
| Layout generation | ≤ 0.3 ms | ≤ 0.3 ms |
| Retarget (classify + capture + control points) | ≤ 0.2 ms | ≤ 0.2 ms |
| Per-frame transition CPU (600 cards) | 0.010–0.027 ms | 0.026–0.052 ms |
| Frame p50 / p95 | 16.7 / 16.8 ms (vsync gate) | 16.7 / 16.8 ms (vsync gate) |
| Heap across 60 retargets | −114 KB (counter verified live) | +332 KB ≈ 5.5 KB/retarget |

Correctness checks, all passing on both renderers:

- **Retained cards travel.** Tracking one card (Murder Clown) Arena→Index: net
  1.212 NDC, largest single-frame step 0.083 — 7% of the journey, so it moves
  and never jumps.
- **Mid-flight retarget is continuous.** Interrupting a transition produces a
  seam of **1.4e-11 NDC** against a 0.0010 NDC ordinary step.
- **Drill-down churn is sound.** 600 → top-360 → 600 measures leaving 240,
  entering 240, slots reclaimed 39 → 279 → 39, zero drops, and the tracked card
  **holds slot 89 across the whole round trip** — identity survives.

## SPIKE 2 — picking, measured

Probe: `tests/arena-spikes/spike2-picking.mjs`. GPU-ID is the reference because
it samples the exact pixel under the pointer through the same vertex path the
card draws with. Software renderer; the CPU-side ranking is what matters and it
is renderer-independent.

| Condition (600 cards unless noted) | projected p50 | raycast p50 | gpu p50 | raycast agreement | projected agreement |
|---|---|---|---|---|---|
| settled, 160 | <0.05 ms | 0.2 ms | 3.6 ms | **98.7%** | 59.3% |
| settled, 360 | <0.05 ms | 0.1 ms | 3.6 ms | **96.8%** | 6.8% |
| settled, 600 | <0.05 ms | 0.1 ms | 3.4 ms | **98.2%** | 12.7% |
| camera orbiting | <0.05 ms | 0.1 ms | 3.3 ms | **98.6%** | 38.6% |
| mid-transition | <0.05 ms | 0.1 ms | 3.2 ms | **99.1%** | 36.8% |
| mid-transition, **bounds left stale** | <0.05 ms | 0.1 ms | 3.0 ms | **69.5% (67 false misses)** | 100% |
| devicePixelRatio 2 | <0.05 ms | 0.1 ms | 3.2 ms | **100%** | 38.2% |

Three conclusions:

1. **Instanced raycast wins outright.** It agrees with the pixel-exact
   reference 96.8–100% in every condition including mid-transition and camera
   motion, at 0.1–0.2 ms. The audit's earlier worry that only GPU picking
   survives a transitioning field is **not borne out**, provided bounds are
   recomputed.
2. **GPU-ID picking is rejected on cost, not correctness.** 3 ms per sample
   *including idle pointer movement over empty space*, plus a driver-reported
   GPU stall on every readback. That is 20–30x raycast for an accuracy gain of
   at most 3 points.
3. **The stale-bounds trap is real and quantified.** Skipping
   `computeBoundingSphere` drops raycast to 69.5% and produces **67 false
   misses** — cards the pointer is directly over that report nothing. That is
   the audit's predicted failure, measured.

One honest caveat about the projected column: the incumbent's technique is
built for *points* (`MorphPicking.ts` scans node positions), and the adaptation
here approximates an oriented quad with an axis-aligned screen box. Its 6.8%
–100% swing is a property of that approximation, not a verdict on the shipped
morph picker. The conclusion is narrower and fair: **the point-scan technique
does not transfer to rotated card quads without becoming a raycast anyway**, so
raycast is the honest choice for the Arena.

## SPIKE 3 + 4 — routes and postprocessing, measured

Probe: `tests/arena-spikes/spike34-routes-post.mjs`. Software renderer; CPU
render-submission time (not GPU execution) is the comparator, because rAF is
saturated.

| Configuration | Render submit | Draw calls | Render targets |
|---|---|---|---|
| 0 routes | 0.209 ms | 1 | 0 |
| 25 routes | 0.262 ms | 26 | 0 |
| 50 routes | 0.305 ms | 51 | 0 |
| 100 routes | 0.459 ms | 101 | 0 |
| 100 routes + 10 pulses | 0.394 ms | 101 | 0 |
| 100 routes + 16 pulses | 0.425 ms | 101 | 0 |
| + selective bloom | 0.749 ms | — | 4 |
| + bloom and afterimage | 0.961 ms | — | 6 |

**Fat routes do not batch: one draw call each.** That is the single most
important number here. 100 routes is 101 draw calls against the card field's
one, so the brief's "routes must remain sparse" is not an aesthetic preference,
it is the cost model. Pulses are free by comparison — 16 of them ride a single
`InstancedMesh` and move the submission time by noise.

Draw calls are omitted for the post rows on purpose: `EffectComposer` resets
`renderer.info` on each internal render, so the number read afterwards
describes the last pass only and is not comparable to the no-post rows.
Reporting it as "bloom reduced draw calls to 1" would be an instrumentation
artefact, not a finding.

Three mechanisms verified working:

- **Progressive reveal on fat lines.** `setDrawRange` is inert on `Line2`, but
  `LineSegmentsGeometry extends InstancedBufferGeometry` and the renderer
  honours `geometry.instanceCount` (`WebGLRenderer.js:1317`). Measured
  monotonic: reveal 0 / 0.25 / 0.5 / 1 → **0 / 6 / 12 / 23 segments**. This is
  the `drawRange` technique transferred correctly rather than abandoned.
- **The `params.Line2` trap, quantified.** Probing 5 px off a route's
  centreline: **90% hover hit-rate with the bucket created, 60% without.**
  Aiming dead-centre hits either way, which is exactly why this trap survives
  casual testing.
- **`LineMaterial.resolution` is in CSS pixels, not drawing-buffer pixels.** At
  devicePixelRatio 2 the buffer correctly becomes 3840×2160 while the
  resolution uniform stays 1920×1080, because `onBeforeRender` sets it from
  `renderer.getViewport()`, which three keeps in CSS pixels. `linewidth` is a
  CSS-pixel width, so feeding it `w * devicePixelRatio` **halves apparent line
  width at dpr 2**. Rendering self-corrects every draw; raycasting does not,
  which is precisely why the shipped hand-set calls are load-bearing and must
  be right rather than merely present.

**Postprocessing verdict.** Selective bloom costs +0.29 ms submission and 4
render targets, restricted by layer so that only the pulse `InstancedMesh` can
bloom — cards, routes and text are excluded by construction rather than by
threshold tuning. Adding afterimage costs a further +0.21 ms and 2 more render
targets, and it still cannot express the brief's "pulse-only" requirement
because the pass composites the entire read buffer. Bloom ships; afterimage
stays rejected.

### Defects the spikes found

1. **The camera was the teleport.** With perfectly interpolated cards but an
   instant camera cut between formations, the tracked card jumped 0.786 NDC in
   one frame against a 0.0003 NDC ordinary step. Snapping the camera is itself
   a teleport. Putting it on the same shared clock took the seam to 1.4e-11.
   *This was only visible after fixing a tautological test that compared the
   seam against a maximum which included the seam.*
2. **The promotion Arena seated exactly one card.** `layoutArena` filtered on
   `bank`, which only person scopes carry — promotion cards carry an era — so
   `pr:c8` matched nothing while still reporting 601 live slots, because
   unreleased slots masked it. Sections are now explicit.
3. **Curved approach paths were a claim, not a fact.** Measured in world space
   the arc/chord ratio was **exactly 1.0000**; the curvature visible in screen
   space was entirely the camera dolly. The bow is now explicit state and the
   assembly leg measures **1.0321**.
4. **Half the horseshoe was invisible to picking.** Cards are yawed to face
   centre stage, which leaves roughly half the field back-facing from any given
   camera, and single-sided plaques are silently culled. GPU ground truth hit
   only **55.3%** of card centres until `side: DoubleSide` was set. A data
   plaque must not vanish because of viewing angle.
5. **A whole SPIKE 2 run was measured against a dead WebGL context.** The page
   loses its context once during boot under SwiftShader and restores ~1.5 s
   later, and `WebGLRenderer.render()` early-returns while it is lost — so
   every draw reported 0 calls and every picked pixel came back empty, while
   the probe cheerfully printed agreement percentages. Probes now refuse to
   measure unless the context is live, and the spike re-commits its formation
   on `webglcontextrestored`. This is also the acceptance criterion about
   context loss, arriving early and by accident.

---

## What the corpus forced

Two data facts, derived in `build-spike-corpus.mjs`, changed the design:

- **`pr:c8` (AAA) is 1,087 people against a 600-card budget**, and 417 of them
  have exactly one documented AAA match. Semantic aggregation is *forced by the
  data*, not chosen for style.
- **AAA owns no promotion bit.** Only 30 promotions do; the rest share "other"
  bit 30. A promotion scope taken from the edge `promoMask` would silently mean
  "AAA **or any of 540 other promotions**". Scope must come from person-level
  `promos` counts.
- **A person's era inside a promotion is not their global debut decade** — they
  differ for **326 of the 1,087**. Seating the fan by career debut would
  mis-place 30% of it, into decades AAA never had (AAA begins 1993).

## What was deliberately not copied

From `css3d_periodictable`, the brief's primary reference, three things are
load-bearing to the demo and fatal here — all three verified in the fetched
r182 source:

- `new TWEEN.Tween(object.position)` **per card, per property** (L403, L408)
- `Math.random() * duration + duration` — random per-card durations (L404)
- `Math.random() * 4000 - 2000` — random source positions (L272-274)

Random durations make the settle time unpredictable; per-card tweens allocate
in proportion to the population; random sources destroy the reading that the
entrance is a *compression of the connectome*. `FormationTransition` replaces
all three with one shared clock, a semantic delay band, and Echo sources taken
from genuine `global-layout@3` coordinates.

A fourth defect is subtler and would have been easy to inherit: the demo tweens
`object.rotation` **per Euler component** (L408-411) while its sphere and helix
targets take their orientation from `lookAt` (L302-304, L321-325). Lerping
Euler channels independently through `lookAt`-derived orientations gimbals and
flips. `FormationTransition` interpolates orientation with **shortest-arc
quaternion slerp** on flat arrays, which is why the Arena's inward-facing seats
can be oriented by angle without the horseshoe tumbling mid-transition.

## Verification pass

The 26 rows were produced by eight independent inspectors and then handed to an
adversarial verifier instructed to **refute**, with the installed package as
the only authority. Result: **21 rows confirmed, 6 corrections, and not one
API-existence claim refuted** — every class, export, method, uniform,
constructor option and shader define named across all 26 rows exists at 0.182.0
with the stated signature.

The two consequential *negative* claims were independently re-derived twice
(by the verifier and by hand while writing this document):

- `grep -ic lod src/objects/BatchedMesh.js` → **0**
- `Raycaster.params` lists exactly `Mesh, Line, LOD, Points, Sprite` — no `Line2`

The six corrections are folded into the cells above rather than kept as an
appendix, so the corrected statement is the one a reader encounters. For the
record they were: an `OrbitControls` connect-warning claim that described the
wrong guard (the real hazard is that omitting the constructor's second argument
silently yields non-functional controls); drifting line citations in
`css2d_label` and `webgl_batch_lod_bvh` whose substantive claims both held; a
recommendation that restated an estimate as fact with the qualifier stripped; a
contradictory instruction to delete `resolution.set()` calls that are
load-bearing for raycast; and the upload-size arithmetic above.

## Open items

SPIKES 2–5 (picking, route field, selective postprocessing, label field) are
not yet run; every row above that depends on them is marked **PROTO** and
carries no measured number. In particular:

- **SPIKE 2 has an incumbent, not a blank slate.** `MorphPicking.ts` already
  does an allocation-free projected-distance scan with a deterministic
  comparator, proven at this corpus's scale. The question is whether instanced
  raycast or GPU-ID picking *beats* it; the burden of proof is on the
  newcomers.
- **SPIKE 4 needs an unclamped instrument** before it can compare
  postprocessing stacks, for the vsync reason given at the top of this file.
