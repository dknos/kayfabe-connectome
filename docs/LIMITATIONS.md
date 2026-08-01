# Known Limitations — v1 vertical slice

Honest boundaries of what is built. None are silent; the UI states them where relevant.

## Data
- **Corpus scope**: the source is a WWE-family corpus (ECW, NXT, WCW, WWE, WWWF,
  WWF; 1963–2026). No AJPW/NJPW/indies — absence there is corpus gap, not history.
- **Multi-way collapse**: the source flattens multi-way matches into
  winner-vs-rest. Within collapsed loser groups no relationships are derived
  (correctness over coverage); their true sub-structure is unknowable from this corpus.
- **Personas/aliases**: the source has one name per identity and no alias table.
  Persona records are reserved in the canonical model but empty in v1; side-row
  membership is surfaced in dossiers as context.
- **Reigns are derived** from recorded title changes; vacancies/interim reigns
  invisible to the corpus are not invented. Belt concat artifacts that resist
  splitting stay flagged, unsplit.
- **WrestlingDB enrichment inactive**: upstream exposes no API endpoints
  (verified 2026-07-31) and no key is configured. Crosswalk plumbing exists;
  sync ledger records the blocked state.

## Application
- **Renderer backend**: WebGL2 via Three.js. WebGPU not yet wired; documented
  fallback IS the primary path today.
- **apps/api deferred** (D-006): v1 serves static materialized chunks; no
  server-side path/query compute is required by the slice.
- **Lenses**: Living Connectome, Ego focus, Six Degrees, History Pulse, and the
  accessible Table lens ship. Promotion Lobes / Career Tract / Championship DNA /
  Similarity Cloud are NOT shipped and have no dead buttons.
- **Edge picking** works on focused fibers (selection neighborhood, path);
  arbitrary background fibers are selected via dossier link lists instead.
- **Quality cap** may hide thinnest fibers on weak hardware — always disclosed
  in the filter panel with the exact hidden count.
