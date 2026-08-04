# Kayfabe Spacetime — Warp Field

A career is a worldline. Every documented match is an exact spacetime
convergence: the subject's line runs gold through the middle of the field, the
people they are documented with approach it on the exact dates the corpus
records, and a transparent warp bubble rides the timeline playhead, expanding
the period under examination while distant history compresses toward the
horizon. This is a reading instrument, not a graph skin: every position is a
date, every dip is a match, and everything the lens hides it counts out loud.

Sixth lens, beside Connectome / Morph Lab / Arena Array / Meltzer Ratings /
Geo Replay. `packages/spacetime-renderer` + `apps/web/src/spacetime/`, fed by
`data/materialized/spacetime/` (spacetime-projection@1). Nothing in the other
lenses moved.

## What is specified vs what is inferred

Specified by the corpus: every event's date, promotion, form, participants,
title flags, result, reported rating; every relationship's same-side / opposed
/ battle-royal counts (reused from `evidence/pairs`, encounters@2 — never
re-derived here); first/latest documented days; persona provenance.

Chosen by the lens (and marked as choices): lane spacing and sqrt rank
compression, the bubble's R/sigma/gain, warp-speed-from-playback mapping,
sector cap, tier budgets. Physics changes APPARENT geometry only; corpus data
controls source geometry, magnitude, labels and semantic color.

## Visual grammar

| Dimension | Meaning |
|---|---|
| X | exact calendar time through the tanh focus lens (D-008 epoch 1900) |
| Y band | relationship family — opponents above, partners below, mixed alternating nearest the line, battle-royal co-presence outermost and faint |
| distance from centre | documented relevance rank within the band (sqrt-compressed) |
| Z sector | dominant shared promotion (documented appearance, never employment) |
| line thickness / brightness | emphasis + bounded evidence weight |
| solid bead | exact documented match (approximate dates break their ring) |
| brass ring | title match with no documented change of hands |
| gold ring + caustic | documented title change ONLY (`tc=1`, local_sql promotions — csv sources carry no change flag, so csv titles can never earn gold) |
| dashed / dissolved span | gap longer than `GAP_DISSOLVE_DAYS` (730) — geometry never implies undocumented activity |
| italic segment label | persona provenance ("competed as Evan Bourne") |

## Identity: spacetime-alias@1

The corpus has one display name per person and no alias table
(LIMITATIONS.md); Matt Sydal `p:116704` and Evan Bourne `p:35621` are separate
nodes everywhere else in this repository. This projection carries a small
CURATED table of exact ids merging documented personas of one performer into
one canonical worldline — one label, one line, one set of aggregated
statistics, per-event provenance. The merge is projection-local; the build
fails if merged personas ever co-occur in a match, and the validator recounts
each persona's events against its canonical dossier. Relationship echoes are
deterministic five-year evidence buckets (`floor(year/5)*5`, documented
matches only) — never invented career phases.

## The paper, and what was taken from it

arXiv:1107.5650 (Müller & Weiskopf 2012, *Detailed study of null and
time-like geodesics in the Alcubierre Warp spacetime*). Adopted:

* the shape function `f(r) = [tanh(σ(r+R)) − tanh(σ(r−R))] / (2 tanh(σR))` —
  used twice: as the bubble wall in the optics integration, and as the
  TIMELINE FOCUS FIELD, whose closed-form ln-cosh antiderivative is what lets
  the same lens be evaluated per-vertex in GLSL and per-event in TS with no
  integration;
* their renderer architecture: a precomputed (source angle × log-sampled warp
  speed) lookup applied in shaders, bridge observer, point-source stars, no
  sci-fi streaks;
* their closed forms as validation anchors: ξ=90° is an exact fixed point
  (no aberration, no shift, every v); `δ = ω_obs/ω_emit = 1 + v·cos φ` with γ
  replaced by 1 (bridge proper time = coordinate time); the invisible rear
  cone `φ > arccos(−1/v)` for v > c (120° at 2c, 96.4° at warp 9). The
  materializer integrates actual null geodesics through the comoving "river"
  form of the metric and `spacetime_validate.py` asserts the finished table
  against those forms — wrong physics fails the build.

Deliberate divergences: thin wall R=1 σ=8 (they plot R=2 σ=1; the far-field
closed forms are wall-independent); a v=0 identity row for unwarp blending;
magnification from the solid-angle Jacobian of the principal-branch inversion
rather than the full Sachs/Jacobi bundle (the bundle reaches 1e-7 rear
dimming; this table clamps at ±3 decades anyway); bridge observer only (their
exterior views used 4D ray tracing, out of scope here).

## LUT wire format

`data/materialized/spacetime/lut/` — full byte layout in
`spacetime_lut.py`'s docstring and the projection manifest:

* `bridge.f16.bin` — 4096×256 texels, 4 IEEE half floats each, row-major
  from v=0 upward. Feeds the CPU sampler (exact picking, unwarp readouts).
* `bridge-rgba8.bin` — the same values quantised to bytes. Feeds the GPU
  texture: UNSIGNED_BYTE + linear filtering works on every WebGL2 stack
  including SwiftShader, where half-float filtering needs an extension with
  no headless verification story. 8 bits ≈ 0.7° of apparent angle.

Channels (identical normalised encoding in both): R = θ_apparent/π,
G = signed log frequency shift (`ln δ` clamped ±6), B = signed log
magnification (`log10 M` clamped ±3), A = visibility / apparent-horizon mask.
Row t maps `v = 10^t − 1` (v_max 9). Integration grid 768×64, output grid
interpolated — recorded in the manifest, not hidden.

## Event shard wire format

`people/{bb}.events.bin` — 8 little-endian u32 per record, sorted
(date, match id as string); `people/{bb}.parts.bin` — flat u32 graph-node
indexes (same-side, then opposed, then unclassified context per event).
Field-by-field layout in `spacetime_project.py`'s docstring, mirrored in the
manifest's `event_record` block. Participants with no evidence entry for a
match (collapsed multi-way loser sides) ride as CONTEXT — present, never
classified. Missing ratings are 0 = absent, never zero stars.

## Two observers

**Exterior** — the worldline field from outside. Orbit / pan / dolly, WASDQE
ground-basis walk, the arena's formationTarget + userOffset decomposition so
reader travel survives retargets. Convergence dips articulate with the focus
field: inside the bubble a shared match pulls its line to the centre; in
compressed history lines rest in their lanes and the beads carry the record.

**Bridge** (B) — the camera rides the subject's worldline at the playhead,
facing the future. Entering at the end of a career jumps to the debut: the
flight starts with every documented match still ahead. Playback speed maps to
warp speed (`one year of records per second = 1c`, capped at the table's
warp 9); the LUT then bends every ribbon, bead and label through the same
apparent sky — forward blueshifts and magnifies, the rear redshifts toward
the horizon cone, and upcoming championships read as gold rings around the
flight axis. Distant records dim so the tunnel stays legible; the local
window carries the reading. W/S scrub time, A/D step exact events, Q/E lean,
drag looks around, wheel nudges time.

**Unwarp** (hold U) — eases the sky back to source geometry while held; the
readout keeps quoting the full-precision CPU samples. Reduced motion snaps
instead of easing, and parks the packets entirely.

## Controls

B observer · U hold to unwarp · Space play/pause (routes through the shared
timeline bar — one clock, one history) · F centre on selection · R reset
framing · Backspace / Alt+← shared Back. Click inspects; double-click (or the
inspector's action) CHOOSES — routing through the shared store and earning a
browser history entry, the arena rule. Clicking a bead opens the exact
record: date, promotion, form, participants by class, result, title status,
reported rating if any, persona provenance.

## Quality tiers

`SPACETIME_TIERS` — each lever degrades individually; low is a coherent
scene. Worldlines and beads are one draw call each regardless of count, so
the ladder cuts fill (bloom, bubble shell, DPR) before it cuts reading:
high 150 lines / 160 labels / 52 packets / bloom / bubble / DPR 2;
medium 96 / 120 / 28 / bloom / bubble / 1.5;
low 48 / 80 / 12 / no bloom / no shell / 1.
The governor is the arena's: wall-clock frames, graduated scoring, steps
down after sustained misses, never climbs back on its own. Bloom is a closed
list — title-change caustics, the packet stream, the selection halo.
Whatever a budget hides is printed: "444 further documented relationships
beyond the drawn budget" is part of the reading, not an apology.

## Validation

`pnpm spacetime:materialize` builds and self-validates;
`pnpm spacetime:validate` re-checks an existing tree. Corpus side: persona
event counts against canonical dossiers, alias disjointness, event ordering,
binary shapes, relationship totals recounted from `evidence/pairs`, bucket
sums. Physics side: v=0 identity row, ξ=90° fixed point, closed-form δ, rear
horizon placement, NaN sweep. Web side: 22 vitest units
(`spacetime.test.ts`), 7 Playwright journeys × 3 projects
(`tests/e2e/spacetime.spec.ts`), and `pnpm spacetime:qa` — a probe that
fails a screenshot contradicting its own seam state.

## Known limitations

* **WebGL2, not WebGPU.** The build brief names `webgpu_tsl_*` examples;
  this repository has no WebGPU renderer path anywhere
  (docs/LIMITATIONS.md: "the documented fallback IS the primary path"), and
  headless QA on this machine is SwiftShader with no WebGPU story. The
  examples were adapted as concepts: instanced sprite fields, storage-free
  bounded packets, layer-restricted selective bloom. The LUT-in-vertex-shader
  architecture ports to TSL when a WebGPU path lands repo-wide.
* **Vertical slice: one projected subject.** Curated aliasing means shards
  exist for Matt Sydal (± Evan Bourne). Anyone else gets an honest empty
  state, not an improvised worldline. Corpus-wide shards are the projection's
  Phase 3; the format already buckets by canonical id.
* **No worker.** No lens in this app decodes off-thread; a one-subject shard
  is ~100 KB and decodes in microseconds. Revisit with corpus-wide shards.
* **Single-image optics.** The principal branch only — the paper's exterior
  multiple/phantom images and time-reversed replay need an outside-observer
  table (a second texture, listed as future work).
* **The GLSL/TS twin risk.** `lnCosh` / `focusF` / `focusIntegral` /
  `timeAxisX` exist twice (WorldlineField GLSL, types.ts). The unit suite
  pins the TS side; keep the shader byte-identical when touching either.
* **Fixed default subject.** The lens seeds the shared selection with the
  first projected subject when nothing is selected — correct for one
  subject; revisit when there are many.
