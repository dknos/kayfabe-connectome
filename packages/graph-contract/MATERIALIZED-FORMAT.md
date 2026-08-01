# Materialized Format — v2.0.0

Contract between `services/materializer` (producer, Python stdlib only) and
`apps/web` (consumer). Everything lives under `data/materialized/`. All JSON is
UTF-8, no NaN/Infinity. All binary is little-endian. Determinism: two runs over
the same source must produce byte-identical files (fixed seeds, sorted keys,
no timestamps outside `manifest.json`).

## Day encoding (v2)

Days since **1900-01-01** (v1 used 1950; the csv corpus reaches 1947).
`isoToDay`/`dayToDate` in graph-contract and `iso_to_day`/`day_to_iso` in the
materializer are the only implementations.

## Day encoding
`day = (date - 1950-01-01) in days`, integer. ISO dates only in dossier/
timeline JSON where humans read them.

## Node identity
Canonical ids per docs/CANONICAL-MODEL.md (`p:`, `p:d`, `pr:`, `t:`, …).
Graph node **index** = position in `graph/nodes.json` arrays; `edges.bin`
references indices, not ids.

## Files

### manifest.json
```json
{
  "schema_version": "1.0.0",
  "built_at": "<iso>",                      // only non-deterministic field
  "source_fingerprint": "sha256 of source sqlite",
  "layout_version": "global-layout@1",
  "projection_version": "encounters@1",
  "algorithms": {"communities": "louvain-seeded@1", "resolution": "exact-name-split@1",
                  "form_classify": "form-classify@1", "belt_split": "belt-split@1",
                  "reign_derive": "reign-derive@1"},
  "counts": {"people": 0, "derived_people": 0, "promotions": 6, "titles": 0,
              "cards": 0, "matches": 0, "edges": 0, "communities": 0,
              "title_changes": 0, "unresolved_side_parts": 0},
  "date_range": ["1963-01-25", "2026-01-16"],
  "edges_bin": {"count": 0, "stride_u32": 10,
    "fields": ["a","b","sameSide","opposed","brOpposed","titleMatches",
                "firstDay","lastDay","promoMask","formMask"]},
  "promo_bits": {"1": 0, "692": 1, "2715": 2, "4140": 3, "11561": 4, "11791": 5},
  "form_bits": {"singles": 0, "tag_team": 1, "multi_way": 2, "battle_royal": 3,
                 "team_implied": 4, "unknown": 5},
  "checksums": {"<relpath>": "sha256", "...": "..."},
  "validation": {"passed": true, "checks": {"...": "..."}}
}
```

### graph/nodes.json  (columnar, parallel arrays, length = count)
```json
{
  "count": 0,
  "id": ["p:86", "pr:4140", "t:8"],
  "type": [0, 1, 2],                  // 0 person, 1 promotion, 2 title
  "name": ["Christian York", "WWE", "ECW World Heavyweight Title"],
  "community": [3, -1, -1],           // -1 for non-person nodes
  "pos": [x,y,z, x,y,z, ...],         // flat, len = 3*count, normalized ~[-1,1]
  "firstDay": [..], "lastDay": [..],  // -1 unknown
  "matches": [..],                    // person: match count; promotion: card count; title: title-match count
  "degree": [..],                     // distinct graph neighbors (encounter graph)
  "reigns": [..],                     // person: derived reign count; title: reign count; else 0
  "promoMask": [..],                  // bitmask via manifest.promo_bits
  "resolution": [0, 0, 0]             // 0 confirmed, 1 probable (derived p:d), 2 unresolved
}
```
Ordering: people first (by ascending numeric source id, then derived people by
slug), then promotions, then titles. Stable across runs.

### graph/edges.bin
`count * 10` u32 LE values, layout per `manifest.edges_bin`. One record per
unordered person pair with ≥1 observation. `a < b` (node indices). Sorted by
(a, b). Weights are observation counts. `firstDay/lastDay` day-encoded.

### graph/communities.json
```json
{"count": K,
 "label": ["WWF 1980s cluster", ...],   // auto: dominant promotion + era; labeled computed in UI
 "size": [..], "center": [x,y,z, ...],  // flat
 "topMembers": [["p:1","p:2",...max 10], ...]}
```

### search/entities.json  (array; people + promotions + titles + event names)
```json
[{"id":"p:86","t":"person","n":"Christian York","first":"2001-01-13",
  "last":"2003-05-01","m":42,"pm":["ECW","WWF"]}, ...]
```
`t` ∈ person|promotion|title|event. Event-name entries (`en:`) carry card count
in `m` and no `first/last` when single-use. Client search normalizes case.

### evidence/pairs/{bb}.json — bb = fnv1a32(pairKey) % 256 as two hex digits
pairKey = `"<idA>|<idB>"` with idA/idB the canonical ids sorted lexicographically.
```json
{"p:123|p:86": [
  {"m":"m:36","c":"c:7","d":"2001-01-05","pr":"pr:1","rel":"opposed",
   "form":"multi_way","res":"def.","fin":null,"t":null,"tc":0}, ...]}
```
`rel` ∈ same|opposed|br. Entries sorted by (d, m). Every aggregated edge weight
MUST equal the count of matching entries here (validated).

fnv1a32: h=2166136261; for each byte: h ^= b; h = (h * 16777619) mod 2^32.

### timeline/density.json
`{"years": {"1963": {"matches": 62, "titleChanges": 1}, ...}}`

### timeline/by-year/{yyyy}.json  (sorted by date, then card id, then match id)
```json
[{"m":"m:1","c":"c:1","d":"2001-01-13","pr":"pr:1","en":"Pine Bluff Show",
  "loc":"Pine Bluff, Missouri","form":"singles","stip":"","res":"def.",
  "fin":"pin","w":["p:1"],"l":["p:2"],"unk":false,"t":null,"tc":0,
  "dur":274}, ...]
```
`w`/`l` = resolved member ids (winner/loser side; draws keep listed order,
consumers must check `res`). `unk` true when a side contained a placeholder.
`dur` seconds or null. `t` title id or null; `tc` 0/1.

### entities/people/{bb}.json — bb = fnv1a32(canonical id) % 256, hex
```json
{"p:86": {"n":"Christian York","first":"…","last":"…","m":42,
  "promos":{"pr:1":30,"pr:11791":12},
  "years":{"2001":18,"2002":24},
  "top":{"partners":[["p:123",17],...max 20],"opponents":[["p:44",9],...]},
  "teams":["Christian York & Joey Matthews"],       // side-row names they appeared in
  "titles":[{"t":"t:16","reigns":[{"s":"2001-04-01","e":null,"m":"m:812"}]}],
  "src":{"local_sql":86}}}
```
Derived people: `"src":{"local_sql_side_rows":[3, 977]}` instead.

### entities/championships.json
```json
{"t:8": {"n":"ECW World Heavyweight Title","pr":"pr:1","artifact":false,
  "reigns":[{"holders":["p:71"],"s":"2000-07-14","e":"2001-01-07",
              "m":"m:520","endM":"m:761"}],
  "titleMatches": 122, "changes": 31}}
```
Reigns derived (`reign-derive@1`): interval from a title_change match to the
next change of the same belt; open end = null. Never invent vacancies.

### reconciliation/decisions.json
Summary + bounded samples: `{"summary": {"exact_name_split": {"confirmed": N,
"derived": N}, "placeholders_detected": [...names...], "belt_splits": {"split":
N, "artifacts_kept": N}}, "samples": {"derived_people": [...50], "belt_artifacts":
[...all]}}`

### quality/metrics.json
Validation outcomes: edge/evidence count equality, day-encoding round-trip,
orphan checks, determinism hash of a canary subset, rule counters (partner obs
by form, multiway_loser_pairs_suppressed count, battle royal edges), and the
top-level `passed` boolean mirrored into manifest.validation.
```

## v2 additions

- `manifest.sources` — sha256 per source (`local_sql`, `csv_initial_matches`);
  `manifest.epoch` = "1900-01-01"; `manifest.promo_other_bit` = 30.
- `promo_bits`: family promotions keep bits 0-5; top-24 csv promotions (by
  kept matches) take bits 6-29; every other promotion shares bit 30. Bit 31
  unused (JS int32 sign safety).
- **graph/promotions.json** — `{"pr:<id>": {n, m, src, bit?}}` for ALL 571
  promotions, node or not (name/bit lookup for dossiers and filters).
- id classes: `p:c<fnv1a32-hex>` csv person (nodes.resolution = 2),
  `pr:c<n>` csv promotion, `t:c<n>` csv title, `m:c<n>`/`c:c<n>`/`en:c<n>`
  csv match/card/event. Mixed with v1 numeric ids; always treated as opaque
  strings on the wire.
- timeline events gain optional `wu`/`lu` (unit partitions, present when a
  side has >= 2 units), `mr` (Meltzer), `ppv`, `apx` (approximate date).
- evidence entries gain optional `mr`.
- by-year ordering is now the string tuple (d, c, m) — ids are not all
  numeric; clients must not Number() them.
- entities/championships.json entries gain `src`; csv titles always have
  `reigns: []` and `changes: 0` (no title-change data in that source).
