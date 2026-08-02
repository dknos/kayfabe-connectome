# Architecture

Initial sketch — refined as audits land. See DECISIONS.md for rationale.

## Flow

```
source SQLite (read-only, private copy)
   → db doctor (audit, schema map proposal)
   → extraction (Python, Polars/DuckDB)
   → canonical normalization (person/persona/alias, matches with explicit sides)
   → wrestlingdb staging + crosswalk (when key present)
   → conflict detection → identity resolution → validation
   → graph projections (versioned recipes)
   → ratings projection (canonical timeline → exact ratings, coverage, LOD)
   → analytics (communities, centrality — igraph/rustworkx)
   → offline global layout (community-level + intra-community, deterministic)
   → materialized chunks (Parquet/Arrow/typed binary + manifest + checksums)
   → apps/web (Vite + React panels + custom Three.js renderer)
```

## Ownership

- `services/materializer` (Python 3.12): all data work. Never writes to source.
- `packages/domain-contract` (TS): canonical entity types, Zod schemas.
- `packages/graph-contract` (TS): projection/chunk/manifest wire formats.
- `packages/graph-engine` (TS): browser graph state, workers, local layouts.
- `packages/renderer` (TS): Three.js WebGPU/WebGL2 connectome renderer. No React inside.
- `packages/ratings-renderer` (TS): Three.js WebGL MELTZER RIDGE renderer;
  consumes only the validated ratings projection.
- `packages/state` (TS): Zustand stores — selection, timeline, filters, URL codec.
- `apps/web`: shell, panels, lenses. React never owns per-node rendering.
- `apps/api`: narrow typed FastAPI surface over materialized data.

## Non-negotiables

- Graph state, timeline state, and camera are independent of the renderer backend.
- One canonical schema; projections are versioned recipes, never ad-hoc queries.
- Every displayed edge carries supporting record IDs end-to-end.
- Deterministic layouts and fiber curvature (seeded, keyed on stable IDs).
- Instanced batches; no per-node meshes/materials/lights; bounded pulse pool.
