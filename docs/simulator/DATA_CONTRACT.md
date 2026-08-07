# THE BOOK — Data Contract

How the simulator consumes the canonical corpus and what it guarantees about its own
artifacts. The corpus wire format itself is owned by `packages/graph-contract`
(`MATERIALIZED-FORMAT.md`); this document covers only the simulator's reading of it and
the simulator's own formats.

## 1. Corpus inputs (all read-only, fetched from `/data/*`)

| File | Read when | Fields used |
|---|---|---|
| `manifest.json` | universe creation | `counts`, `algorithms`, `schema_version`, `validation.passed` (hard gate), checksum set → `data_bundle_hash` = hash of (schema_version, counts, algorithms) |
| `search/entities.json` | universe creation | person/promotion/title records: `id`, `t`, `n`, `first`, `last`, `m` |
| `graph/promotions.json` | universe creation | promotion names/ids (semantics caveat: `m` = cards for sql promos, matches for csv) |
| `timeline/by-year/{Y}.json` | universe creation (window years only) + almanac (lazy) | `d,pr,w[],l[],unk,form,t,tc,ts,mr,placement,en,loc` |
| `entities/people/{bb}.json` | roster members only | dossier: `n,first,last,m,promos,years,titles,teams,top` |
| `evidence/person/{bb}.json` | roster members only | career rows `{m,d,pr,f,r,o[],p?,mr?,fin?}` filtered `d ≤ startDay` |
| `entities/championships.json` | universe creation | family-title reigns → champions at start date |

Day ints are epoch **1900-01-01**. IDs are opaque strings; the simulator never parses or
numerically sorts them. Missing optional fields mean *not recorded*, never zero.

## 2. Simulator-owned overlay data (versioned, moddable, shipped in-repo)

### 2.1 Persona crosswalk — `packages/history-adapter/src/data/persona-crosswalk.json`

`persona-crosswalk@1`. Maps corpus person IDs onto canonical sim humans:

```json
{
  "version": 1,
  "groups": [
    {
      "canonical": "p:118301",
      "displayName": "Mick Foley",
      "members": [
        { "id": "p:8045",   "persona": "Cactus Jack" },
        { "id": "p:5961",   "persona": "Mankind" },
        { "id": "p:118301", "persona": "Mick Foley" }
      ],
      "note": "curated"
    }
  ]
}
```

Rules: a corpus ID may appear in at most one group (violations = load error); the
canonical ID must be a member; groups never invent people. Career facts aggregate to the
canonical person; each match retains the persona (corpus person) it was recorded under.
Unmerged suspects (shared spellings, `(II)` suffixes) are *reported* by the data-health
builder, not auto-merged.

### 2.2 Company lineages — `packages/history-adapter/src/data/company-lineages.json`

`company-lineage@1`. Stitches fragmented promotion IDs into one company with a name
history, e.g. WWWF(`pr:11561`) → WWF(`pr:11791`) → WWE(`pr:4140`), with NXT(`pr:692`) as
a child brand from 2010. At a given start date the company presents its era-correct name;
pre-lineage history remains reachable in the almanac.

### 2.3 Markets & era profiles — `packages/sim-core/src/data/*.json`

Original datasets (no third-party content): ~12 North American markets with rough
population/interest/economy values, and era profiles (`era-1990s-national-war`, …) whose
parameters are documented in SIMULATION_RULES.md.

## 3. Derived artifacts

### 3.1 UniverseSnapshot (`snapshot-builder@1`)

Produced by the adapter at universe creation. Contains: meta (bundle hash, crosswalk
version, start date, method versions, snapshotHash), markets, venues, companies (active
at date, with lineage-correct names, size tier, inferred roster), workers (canonical
people with personas, seeded attributes + confidence, standing estimates, career
summaries), titles (with pre-start lineage tails and current holders where derivable),
and a data-health report (unresolved aliases, vacant-unknown titles, inference notes).

Roster inference `roster-infer@1`: appearances per promotion in `[D−540d, D]`; on-roster
iff `appearances ≥ 6` and `last appearance ≥ D−120d`, both thresholds recorded in the
snapshot meta. Exclusive-leaning era: a worker appearing for multiple family promotions
keeps the most recent affiliation; others noted as "recent free agency" evidence.

`snapshotHash` = canonical-JSON hash of the snapshot minus volatile fields; recorded in
every save manifest.

### 3.2 Ratings seeding (`evidence-seeder@1`)

Inputs per worker, all ≤ start date: match count, career span, opponents faced (count of
distinct), win share *in positioning terms*, main-event share (placement where present),
title-match share, promotion level mix, match-form mix, Meltzer ratings where present,
recent activity density. Outputs `SeededAttribute { value, confidence, method, inputs }`
per attribute. Championships and win% are treated as *positioning* evidence (push,
credibility, awareness), never directly as skill. Sparse careers regress to
role-conditioned priors with `low`/`speculative` confidence rather than low values.

## 4. Save format (`save-format@1`) — summarized; full doc in SAVE_FORMAT.md

IndexedDB DB `the-book`, store `saves`, key `save_id`. Envelope:

```json
{
  "manifest": {
    "save_id": "…", "created_at": "ISO-8601 (app shell wall clock)",
    "current_game_date": "1997-02-05", "original_start_date": "1997-01-06",
    "world_seed": "…", "engine_version": "0.1.0", "schema_version": 1,
    "data_bundle_hash": "…", "mod_manifest": [], "simulation_options": { … },
    "current_state_hash": "…"
  },
  "state": { /* SimState, canonical-JSON-hashable */ }
}
```

Guarantees: load verifies `schema_version` (future migrations are additive, never
destructive), recomputes the state hash and refuses silently-corrupted saves,
and warns (does not remap) when `data_bundle_hash` no longer matches the local corpus.
The engine's append-only `eventLog` ships inside the state; RNG stream states are
serialized exactly.

## 5. Invariants under test

- No record with corpus day > startDay reaches snapshot or seeder (anti-look-ahead).
- Crosswalk groups: no duplicate membership, canonical∈members, all IDs resolvable.
- Sydal/Bourne resolve to one sim person, searchable by either name, with two personas.
- Ledger balance: `cash == initial + Σin − Σout` per company at all times.
- Determinism: same seed+snapshot+commands ⇒ same state hash; save→load ⇒ same hash.
- Title changes only via completed shows or explicit administrative commands.
- Booking validity: winners are participants; no person in two segments of one show
  unless flagged; durations positive.
