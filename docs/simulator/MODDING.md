# THE BOOK — Modding (current state)

Honest status: **the data layer is built to be modded; the mod manager UI is not built
yet.** What exists today is versioned, validated overlay data that a motivated user can
already edit; packaging, diff preview, and in-app import are Phase 5 (see PROGRESS.md).

## Moddable today (edit + rebuild)

| File | Format | Validation |
|---|---|---|
| `packages/history-adapter/src/data/persona-crosswalk.json` | `persona-crosswalk@1` — identity merge groups | hard errors on duplicate membership, canonical-not-member, malformed groups |
| `packages/history-adapter/src/data/company-lineages.json` | `company-lineage@1` — promotion → company stitching with date bounds | structural validation at load |
| `packages/history-adapter/src/data/company-meta.json` | shortName / home market / Product DNA seeds per promotion | defaults derived when absent |
| `packages/sim-core/src/data/markets.json` | original market dataset | typed at import |
| `packages/sim-core/src/data/era-profiles.json` | era parameters (contract kinds, TV/PPV economics, overheads) | typed at import; date-resolved by `resolveEra` |

All five carry version numbers; every algorithm that consumes them stamps its own
`name@N` method version into snapshots and saves, so a modded universe is identifiable.

## Contract for future packs (designed, not yet shipped)

The mod manifest described in DATA_CONTRACT.md §4 (`mod_manifest` in every save) is
already recorded (empty today). Planned Phase 5 surface: manifest with id/version/
dependencies, dry-run diff preview, validation report, rollback, image-pack loading
(user-supplied, local only — the game ships no real-person imagery), CSV/JSON import
into a user data bundle. No Microsoft Access, ever.
