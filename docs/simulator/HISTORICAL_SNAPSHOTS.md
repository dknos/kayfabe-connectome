# THE BOOK — Historical Snapshots (`snapshot-builder@1`)

How an immutable corpus becomes a playable start-date world. Implementation:
`packages/history-adapter/src/` (see that package's tests for executable examples).

## Inputs

All read-only, all filtered to records dated ≤ `startDay` (epoch-1900 day int of the
chosen start date). The filter sits at the extraction boundary — nothing downstream
(seeder, engine, UI) ever sees a post-start record. This is the anti-look-ahead
guarantee, and it is tested with fixtures containing deliberately post-dated records.

| Corpus file | Contributes |
|---|---|
| `manifest.json` | validation gate + `data_bundle_hash` |
| `search/entities.json` | the person/promotion/title universe |
| `timeline/by-year/{Y}.json` (window years) | roster inference, recent activity |
| `entities/people/{bb}.json` | career dossiers for rostered workers |
| `evidence/person/{bb}.json` | per-person career rows → `EvidenceSummary` |
| `entities/championships.json` | reigns → champions at the start date |
| `graph/promotions.json` | promotion names/metadata |

## Simulator-owned overlays (versioned, moddable)

- **`persona-crosswalk@1`** — curated groups mapping corpus persons (exact-name splits)
  onto one canonical human with named personas. The corpus has no alias layer (see
  docs/simulator-audit.md §3.1); this overlay is the simulator's identity
  canonicalization. Unresolved suspects are *reported* in the snapshot's data-health
  block, never auto-merged. Duplicate membership across groups fails the load.
- **`company-lineage@1`** — stitches fragmented promotion IDs (WWWF→WWF→WWE, …) into one
  company with era-correct naming at the start date.

## Roster inference (`roster-infer@1`)

The corpus records appearances, not employment. A worker is on a company's roster at
date D iff, within the 540-day window before D: appearances for that company (lineage-
resolved, crosswalk-aggregated) ≥ 6 **and** the most recent appearance is within 120
days of D. Multi-company workers resolve to their most recent affiliation. Thresholds
are recorded in `snapshot.meta.rosterInference` and shown in the wizard — this is a
documented estimate, not a claim about historical contracts.

## Champions at the start date

For titles with derivable lineages (SQLite family titles only — csv titles have none, a
corpus limitation surfaced in data health), the reign satisfying
`s ≤ startDay < (e ?? ∞)` names the champion(s), crosswalk-applied. The last eight
pre-start reigns ship in the snapshot for profile/almanac display; the full lineage
stays in the corpus, reachable through the Almanac.

## Attribute seeding

`EvidenceSummary` per rostered worker (pre-start rows only) feeds
`evidence-seeder@1` (`packages/sim-core/src/seeder/`, documented in
`docs/simulator/rules/seeder.md`). Every seeded attribute records method, inputs, and a
confidence grade; sparse careers regress to priors with low confidence rather than low
values. Championships and win rates are treated as *positioning* evidence (credibility,
prestige, awareness), never as skill.

## Reproducibility

`snapshot.meta.snapshotHash` = canonical hash of the snapshot content. Same corpus +
same crosswalk version + same start date ⇒ same hash, byte-for-byte, run-to-run
(sorted iteration everywhere; no wall clock; no unseeded randomness). The hash is pinned
into every save manifest, and the wizard displays it.

## Modes beyond the slice

The New Universe wizard currently ships **Open Alternate History** only. Guided
history, strict-timeline sandboxes, and fictional universes are contract-ready
(`HistoricalMode` in sim-contract) but not yet implemented — see PROGRESS.md.
