# Simulator Audit — Workspace, Data, and Boundaries

*Produced before implementation of THE BOOK (wrestling promoter simulator), branch
`agent/simulator`, worktree `~/kayfabe-connectome-simulator`. Audit performed against the
live workspace on 2026-08-07 by seven parallel read-only auditors (pipeline, contracts,
web-loader, materialized shapes, CSV corpus, quality probes, docs/decisions).*

## 1. Workspace reality

- pnpm@10.33.0 monorepo (`apps/*`, `packages/*` in the workspace; `services/materializer`
  is Python 3.12, stdlib-only, outside the JS workspace).
- Existing apps: `apps/web` (the Kayfabe Connectome visualizer, Vite 6 + React 18 + TS 5.7,
  dev on `127.0.0.1:9460` strictPort, preview 9461; spacetime worktree claims 9462).
  `apps/api` is an **empty directory** — there is no server; all data access is static
  same-origin fetch. Production deploy is **GitHub Pages** via `scripts/deploy-pages.sh`
  (no PM2 process for this repo).
- Real packages: `@kayfabe/graph-contract` (the only wire contract, ships raw TS via
  `main: src/index.ts`), plus renderer packages. **`packages/domain-contract`,
  `packages/state`, `packages/graph-engine`, `packages/test-fixtures`, `packages/ui` are
  empty husks** — described in docs/ARCHITECTURE.md but never populated. The simulator
  must not depend on them.
- Branch state: main worktree is on `agent/arena-array` (35 commits ahead of `main`) with
  uncommitted geo edits belonging to another agent. The simulator branch
  `agent/simulator` was cut from the committed tip `cb69ecc` into its own worktree; the
  shared `data/` directory (gitignored, 1.6 GB) is symlinked in.

## 2. Historical source data (inspected live, not inferred)

### 2.1 Source SQLite — `data/private/wwe_db_2026-01-18.sqlite` (171 MB, private)

Opened by the materializer strictly read-only (`mode=ro&immutable=1` + DDL/DML statement
guard). Tables and row counts:

| Table | Rows | Notes |
|---|---|---|
| Wrestlers | 19,278 | **4,599 individuals + 14,679 "side rows"** (names ampersand-joined participant lists) |
| Matches | 88,243 | exactly two side refs (`winner_id`/`loser_id`); multi-ways collapsed into the loser blob; `duration` 79.3% empty |
| Cards | 14,399 | `event_date` uniformly YYYY-MM-DD, zero nulls; provenance URL 100% profightdb.com; `info_html`/`match_html` PRIVATE |
| Events | 6,046 | event-name dictionary |
| Belts | 178 | id=1 is the no-title sentinel; 47 concatenation-artifact names split by belt-split@1 |
| Match_Types | 1,296 | free-text stipulations |
| Promotions | 6 | ECW(1), NXT(692), WCW(2715), WWE(4140), WWWF(11561), WWF(11791) |
| Locations | 687 | venue/location names |

Date range 1963-01-25 → 2026-01-16. 13,527 title matches, 1,762 title changes, zero
referential orphans, zero invalid dates.

### 2.2 CSV corpus — `InitialWrestingMatchesFinal.csv` (67.9 MB, cp1252, private)

363,728 rows, **571 promotions**, 1947-12-14 → 2024-09-17. 20 columns (Event, Placement,
Winner, Result, Loser, Match.Type, Championship, Meltzer.Rating, Minutes/Seconds/Total,
Promotion, Venue, City, Date, weekday parts, PPV). Participants are **names only, no
IDs**: `' & '` joins members within a unit, `', '` separates units, `\xa0(c)` marks
incoming champions. `'(title change)'` appears as a literal suffix inside 10,193
Championship strings. Meltzer ratings present on ~4.5% of rows. No title-change flag →
**no reign derivation possible for CSV titles**.

### 2.3 Materialized canonical corpus — `data/materialized/` (~700 MB, gitignored)

Built by `services/materializer` (schema 2.0.0, deterministic, validation PASSED, 600
sha256-checksummed files). This is the layer the simulator consumes.

**Totals:** 365,485 matches (88,243 sql + 277,242 csv kept), 30,291 canonical people
(4,595 sql `p:<int>` + 24,305 csv `p:c<hex>` + 1,391 derived `p:d<hex>`), 571 promotions
(165 graph nodes), 4,389 championships (**only 130 sql titles carry reign lineages**;
1,792 derived reigns, 1,753 changes), 465,704 pair edges, date range 1947-12-14 →
2026-01-16 (no matches in 1958).

**Key files** (shard scheme: `fnv1a32(key) % 256` → two lowercase hex digits):

| Path | Shape | Simulator use |
|---|---|---|
| `manifest.json` | counts, algorithm versions, per-file sha256, `validation.passed` gate | bundle fingerprint for saves |
| `search/entities.json` | one array, 72,781 records `{id,t,n,first?,last?,m,pm?}` — 30,291 people + 165 promos + 741 titles + 41,584 events | global search; **the** person universe roster |
| `entities/people/{00..ff}.json` | dossiers `{n, first, last, m, promos{}, years{}, top{partners,opponents}, teams[], titles[{t,reigns[{s,e,m}]}], src}` | profile screens, roster detail |
| `evidence/person/{00..ff}.json` | **the only affordable per-person career index** (person-matches@1, 1,186,388 rows) `{m,d,pr,f,r,o[],p?,en?,fin?…}`; optional fields omitted = not recorded | ratings-seeder evidence, pre-start career |
| `timeline/by-year/{yyyy}.json` | canonical match log `{m,c,d,pr,en,loc,form,stip,res,fin,w[],l[],unk,t,tc,ts[],dur,placement?,mr?,ppv?,apx?}` sorted by string tuple (d,c,m); 79 files, 1958 missing | roster inference window, almanac |
| `entities/championships.json` | `{n, pr, artifact, reigns[{holders[],s,e|null,m}], titleMatches, changes}` | champions at start date (sql titles only) |
| `graph/promotions.json` | promotion metadata; **`m` means CARDS for the 6 sql promos but MATCHES for csv promos** | company records (with care) |
| `graph/nodes.json` + `edges.bin` | columnar graph, 31,197 nodes; edges stride-10 u32 | Connectome's concern, not the sim's |
| `quality/metrics.json` | corpus counters, form distribution (206,919 singles / 52,270 tag / 86,488 team_implied / 17,418 multi_way / 2,390 battle_royal), determinism canary | data-health reporting |

**Day encoding:** integer days since **1900-01-01** (epoch v2 — a documented project
trap; a stale 1950-epoch paragraph survives in MATERIALIZED-FORMAT.md). All simulator
date comparisons against corpus day ints must use this epoch.

**ID discipline:** all IDs are opaque strings (`p:116704`, `p:c8f21aa04`, `t:c1042`,
`pr:11791`); numeric parsing or numeric sorting corrupts them. IDs are deterministic
across rebuilds of identical sources but hash-of-name for csv/derived classes.

## 3. Findings that shape the simulator design

### 3.1 No persona/alias layer exists (verified probe results)

The corpus resolves identity by **exact name string only** (exact-name-split@1):

- Matt Sydal `p:116704` (695 matches) and Evan Bourne `p:35621` (227) are **two people**.
- Mick Foley is **three**: Cactus Jack `p:8045`, Mankind `p:5961`, Mick Foley `p:118301`.
- Dustin Rhodes `p:36590`, Goldust `p:75326`, and The Artist Formerly Known As Goldust
  `p:151530` are separate.
- Conversely, distinct humans sharing one spelling merge (e.g. derived "Rey Misterio").

**Consequence:** the simulator's mandated identity canonicalization (one human = one
canonical person, ring names = time-bounded personas) must be built as an **overlay** in
`@kayfabe/history-adapter`: a versioned, curated persona-crosswalk data file mapping
corpus person IDs → sim person + persona intervals, with unresolved/ambiguous cases
surfaced in a data-health report, never silently merged. The corpus itself is not
mutated.

### 3.2 No employment data exists

Nothing in the corpus states who was under contract where. Rosters at a start date must
be **inferred** (`roster-infer@1`): person P is on promotion X's roster at date D if
their appearance pattern for X in [D−540d, D] clears documented thresholds (recency +
volume). This is a derived estimate and is labeled as such in-game.

### 3.3 Championship lineage is family-only

Only the 130 SQLite titles (WWE-family) have derivable reigns. The 4,259 csv titles have
`reigns:[]` — *underivable*, not "no history". Start-date champions can be resolved for
family promotions only; other companies' titles initialize vacant-with-unknown-history,
flagged in data health.

### 3.4 Promotion identity is fragmented

WWWF/WWF/WWE/NXT are four promotion IDs; TNA is three; EMLL/CMLL split. The adapter
carries a curated **company-lineage table** so a 1997 save shows "WWF" with WWWF history
stitched in, and the almanac renders era-correct names.

### 3.5 Coverage is era-skewed and has a cliff

Per-decade matches: 1940s 18 → 1990s 45,495 → 2010s 140,651. Non-family data ends
2024-09; family data runs to 2026-01. Pre-1985 rosters are thin. The New Universe wizard
must present per-date coverage warnings (supported start range, promotions above minimum
viability at that date). The vertical-slice flagship start (1997-01-06) sits in the
best-covered era with WWF/WCW/ECW all active — plus NJPW/AJPW/CMLL etc. as
abstract-tier companies.

### 3.6 Quality flags that gate ingestion

`apx:1` approximate dates, `unk:true` unknown-participant sides, 177 unresolved side
parts, placeholder person rows, 1,638 excluded family csv rows, 2 artifact championships,
94 dual-side corrupted matches (97 suppressed members), 89 people whose evidence row
count ≠ dossier match count. All tolerated, surfaced in the sim's Data Health report,
never repaired by guessing.

### 3.7 Meltzer ratings are sparse but legitimate

16,212 rated matches (4.4%, 1982–2024, values −1..7). Usable as *match-quality evidence*
for the ratings seeder where present; absence means unrated, never zero.

## 4. Boundaries the simulator must respect

1. **Read-only corpus.** Never write inside `data/materialized/` (600 checksums; the
   Pages deploy copies that tree wholesale — anything placed there would be published).
   Saves live in browser IndexedDB (slice) / app-data dir (desktop packaging, later).
2. **Never ship private data.** `data/private/`, raw HTML payloads, and the source
   SQLite never reach a browser bundle or a commit. The simulator bundles **no wrestler
   photographs or promotion logos**; an asset-pack loader (user-supplied, local) is the
   only image path.
3. **Don't touch the Connectome.** No changes to `apps/web`, renderer packages, or the
   materializer. The simulator is `apps/simulator` + `packages/sim-contract` +
   `packages/sim-core` + `packages/history-adapter`, dev port **9465** (9466 preview).
4. **Existing docs stay authoritative for the corpus.** Simulator docs live in
   `docs/simulator/` (plus this file) to avoid colliding with the Connectome's
   ARCHITECTURE.md etc.
5. **Semantics that must not be violated** (from docs/DECISIONS.md + CANONICAL-MODEL.md):
   promotion appearance ≠ employment; first/last record ≠ debut/retirement; repeated
   opposition ≠ "feud"; collapsed multi-way loser groups yield no partner inferences;
   missing ≠ zero; battle-royal opposition is a low-weight class, not rivalry.

## 5. Package boundaries (implemented)

```
packages/sim-contract     types + zod boundary schemas (no deps beyond zod)
packages/sim-core         deterministic engine: rng/hash/dates/money, snapshot builder,
                          ratings seeder, show/crowd sim, finance, contracts, AI, persistence
packages/history-adapter  corpus loading (fetch), persona crosswalk overlay, company
                          lineages, roster inference, evidence extraction, data health
apps/simulator            Vite+React UI (port 9465), IndexedDB saves, Playwright E2E
```

`sim-core` has no DOM dependency and runs identically under Node (Vitest) and the
browser. The engine consumes a `UniverseSnapshot` produced by the adapter; after
snapshot creation the corpus is only needed again for the Almanac (lazy, read-only).

## 6. Risk register (accepted, with mitigations)

| Risk | Mitigation |
|---|---|
| Persona overlay is curated, not exhaustive (30k people) | covers marquee cases + mechanical suffix rules; unresolved surfaced in Data Health; moddable JSON |
| Roster inference mislabels part-timers/touring talent | thresholds documented + tunable; wizard shows the inferred roster before generation |
| Corpus rebuild changes hash-of-name IDs | saves pin `bundleHash` (manifest fingerprint); mismatch → explicit warning, no silent remap |
| Era skew starves pre-1985 starts | wizard coverage warnings; slice targets 1997 |
| 700 MB corpus vs browser memory | eager loads limited to search/entities + promotions (+ manifest); everything else lazy by shard/year; snapshot keeps only sim-relevant extracts |
| Shared physical `data/` across three worktrees | simulator never writes there; rematerialization risk noted in coordination channel |

## 7. Verification of this audit

Every number above was read from the live workspace during this session (SQLite schema
dump via Python, manifest and shard sampling, zip streaming of the CSV, name probes for
Sydal/Bourne/Foley/Rhodes). Where memory or docs disagreed with the live data (e.g.
`counts.people` = 4,595 vs the real 30,291; the stale 1950 epoch paragraph), **live data
won**.
