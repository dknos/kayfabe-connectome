# Known Limitations — v1 vertical slice

Honest boundaries of what is built. None are silent; the UI states them where relevant.

## Data
- **Corpus scope**: local WWE-family records run through 2026 and the merged CSV
  adds global promotions through 2024-09. Outside those documented boundaries,
  absence is a corpus gap, not a historical claim.
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
- **Lenses**: Connectome, Morph Lab and Geo Replay β ship. Search results,
  semantic inspectors, keyboard navigation and ARIA announcements provide
  accessible non-canvas readings without restoring a separate table mode.
- **Edge picking** works on focused fibers (selection neighborhood, path);
  arbitrary background fibers are selected via dossier link lists instead.
- **Quality cap** may hide thinnest fibers on weak hardware — always disclosed
  in the filter panel with the exact hidden count.

## CSV corpus (csv_initial_matches) limitations

- **No title-change data.** The csv records that a match was for a
  championship but not whether it changed hands. Reigns, lineages, and gold
  pulses therefore exist only for the six local_sql promotions. Championship
  dossiers for csv titles say so explicitly instead of guessing.
- **Cross-promotion identity is exact-name.** A ring name shared by different
  humans across 571 promotions (masked lucha lineages especially) will merge
  into one node; a person billed under different spellings splits. Same rule
  as v1, wider blast radius. Every csv-only person carries resolution class 2
  and its exact source name in the dossier.
- **1,638 family csv rows excluded** (crosswalk misses; ledgered in
  reconciliation/decisions.json). 919 are date-shifted twins; ~231 appear to
  be house-show cards local_sql genuinely lacks — those are real matches the
  chronology projection currently omits rather than risk double-counting.
- **Small promotions share one filter bit.** Only the six family promotions
  plus the top-24 csv promotions have individual filter bits; the remaining
  541 share "Other promotions". Their records, evidence and dossiers are
  complete — only one-click mask filtering is coarse.
- **csv ends 2024-09; local_sql continues to 2026-01.** Global (non-WWE)
  coverage stops at the csv boundary; the chronology data shows this honestly in the
  density histogram rather than padding.
- **~84 csv matches list a person on both sides** (source corruption): the
  person is dropped from that match and the match id ledgered, mirroring the
  9 local_sql cases.
