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
- timeline events gain `ts` (the complete ordered canonical title set; `t`
  remains the legacy first title) plus optional `wu`/`lu` (unit partitions, present when a
  side has >= 2 units), `mr` (Meltzer), `ppv`, `apx` (approximate date), and
  `placement` (CSV card position when an exact canonical crosswalk supports it).
- evidence entries gain optional `mr`.
- by-year ordering is now the string tuple (d, c, m) — ids are not all
  numeric; clients must not Number() them.
- entities/championships.json entries gain `src`; csv titles always have
  `reigns: []` and `changes: 0` (no title-change data in that source).

## Ratings projection — `ratings/` (meltzer-ratings@2)

`ratings/` is a separate deterministic projection of the already-materialized
canonical timeline. Its producer reads `timeline/by-year/*.json`; it never
reads an incoming CSV or `data/private`. A ratings record is therefore a view
of the canonical corpus, not a competing source or match identity system.

`TimelineEvent.mr` is optional. A missing `mr` means no reported rating and is
not a 0-star rating. Present `mr` values, including `0` and negative values,
are retained exactly. `matches.bin` contains only canonical records with a
present `mr`; `coverage.bin` supplies the all-canonical denominator so clients
can disclose sparse coverage instead of treating unrated matches as zero.

All binary values are little-endian. Days use the v2 1900 epoch. Dictionary
indexes are zero-based. IDs are opaque strings and dictionary IDs are sorted
lexicographically by Python Unicode code point; do not coerce CSV-shaped IDs
to numbers. Match records retain canonical timeline order `(date, card id,
match id)`. The manifest SHA-256 checksums cover every emitted projection
file; consumers should reject a failed validation block or a checksum mismatch.

### ratings/manifest.json

```json
{
  "schema_version":"2.0.0",
  "projection_version":"meltzer-ratings@2",
  "built_at":"<latest canonical date>T00:00:00Z",
  "built_at_policy":"latest canonical timeline date at 00:00:00Z; a deterministic data clock, not wall-clock build time",
  "source_fingerprint":"<canonical manifest fingerprint>",
  "source_schema_version":"2.0.0",
  "source_projection_version":"encounters@2",
  "source_manifest_sha256":"sha256 of canonical manifest JSON with top-level built_at omitted",
  "source_manifest_sha256_policy":"sha256 of canonical manifest JSON with top-level built_at omitted",
  "date_ranges":{"canonical":["…","…"],"rated":["…","…"]},
  "rating_value_range":[-1.0,7.0],
  "overall_coverage":{"rated_matches":0,"total_documented_matches":0,"fraction":0.0},
  "promotions_with_ratings":0,
  "aggregate_bin_sizes":{"year":{"resolution_code":0,"calendar_months":12},
                         "quarter":{"resolution_code":1,"calendar_months":3},
                         "month":{"resolution_code":2,"calendar_months":1}},
  "counts":{"canonical_matches":0,"rated_matches":0,"participant_values":0,"title_values":0,
            "coverage_records":0,"lod_records":0},
  "dictionary_counts":{"matches":0,"participants":0,"promotions":0,"titles":0,"events":0},
  "algorithms":{"input":"canonical-timeline-by-year@1","ratings":"mr-present@1",
                "coverage":"direct-canonical-denominators@1",
                "lod":"direct-sample-exact-median@1","id_order":"opaque-lexicographic@1"},
  "binary":{"endianness":"little",
    "matches":{"file":"matches.bin","record_count":0,"stride":48,"offsets":{"day":0,"rating":4,"promotion":12,"participantOffset":16,"participantCount":20,"flags":22,"form":24,"eventIndex":26,"title":28,"placement":32,"matchIdIndex":36,"titleOffset":40,"titleCount":44,"reserved":46}},
    "participants":{"file":"participants.bin","record_count":0,"stride":4,"offsets":{"participantIndex":0}},
    "titles":{"file":"titles.bin","record_count":0,"stride":4,"offsets":{"titleIndex":0}},
    "coverage":{"file":"coverage.bin","record_count":0,"stride":28,"offsets":{"kind":0,"resolution":1,"subject":4,"periodKey":8,"total":12,"rated":16,"titleChanges":20,"approximate":24}},
    "lod":{"file":"lod.bin","record_count":0,"stride":72,"offsets":{"promotion":0,"resolution":4,"periodStartDay":8,"periodEndDay":12,"periodKey":16,"total":20,"rated":24,"min":28,"max":36,"sum":44,"median":52,"fourPlus":60,"fivePlus":64,"approximate":68}}},
  "checksums":{"matches.bin":"sha256", "…":"…"},
  "validation":{"passed":true,"checks":{"canonical_records_exact":true,"binary_contract":true,
                  "coverage_exact":true,"lod_exact":true,"checksums":true}}
}
```

`built_at` is the latest canonical timeline date at midnight UTC: it is a
non-null deterministic data clock, not the process wall clock. The source
manifest fingerprint omits the primary manifest's wall-clock `built_at`, so a
canonical no-data rebuild remains byte-identical. `date_ranges.rated` is
`null` only when no canonical match has a present rating. `source_*` fields
bind the projection to canonical facts rather than producer clock noise.
`rating_value_range` is likewise `null` only for an empty rated set.
`overall_coverage.fraction` is the exact rated numerator divided by the full
canonical documented-match denominator; missing ratings are never zeros.
`aggregate_bin_sizes` names the calendar resolutions used by both coverage and
LOD records, including their on-wire resolution codes.

### ratings/dictionaries.json

```json
{
  "schema_version":"2.0.0",
  "ordering":"opaque ids sorted lexicographically by Python Unicode code point",
  "forms":["singles","tag_team","multi_way","battle_royal","team_implied","unknown"],
  "participants":{"id":["p:…"],"name":["…"]},
  "promotions":{"id":["pr:…"],"name":["…"]},
  "titles":{"id":["t:…"],"name":["…"]},
  "matches":{"id":["m:…"]},
  "events":{"id":["c:…"],"name":["…"]}
}
```

The `id` position is the binary dictionary index. `matches.id` contains only
rated canonical match IDs; participant, promotion, and title dictionaries
cover the canonical entities needed to decode the projection. `events.id`
uses stable canonical card ids and its name is that card's canonical event
display name. Forms map to codes 0–5 in the displayed order.

### ratings/matches.bin — 48-byte rated-match records

Records are only canonical matches with a present `mr`, in canonical timeline
order `(date, card id, match id)`.

| Offset | Type | Field | Meaning |
| ---: | --- | --- | --- |
| 0 | i32 | day | canonical match date, days since 1900-01-01 |
| 4 | f64 | rating | present canonical `mr`, exactly retained |
| 12 | u32 | promotion | `dictionaries.promotions` index |
| 16 | u32 | participantOffset | first packed value in `participants.bin` |
| 20 | u16 | participantCount | number of packed participant indexes |
| 22 | u16 | flags | PPV=bit 0, approximate date=bit 1, has title=bit 2, title change=bit 3, has placement=bit 4 |
| 24 | u16 | form | `dictionaries.forms` index |
| 26 | u16 | eventIndex | `dictionaries.events` index for the canonical card/event |
| 28 | i32 | title | `dictionaries.titles` index, or -1 when no title |
| 32 | i32 | placement | canonical placement, or -1 when absent |
| 36 | u32 | matchIdIndex | `dictionaries.matches` index |
| 40 | u32 | titleOffset | first packed value in `titles.bin` |
| 44 | u16 | titleCount | number of canonical title indexes in `titles.bin` |
| 46 | u16 | reserved | exactly 0 |

Only the documented flag bits are set. `title == -1` iff `titleCount == 0`;
`placement == -1` iff has-placement is clear. Participants occupy
`[participantOffset, participantOffset + participantCount)` in
`participants.bin` and preserve canonical `w` then `l` order.

### ratings/participants.bin — 4-byte values

Each value is one `u32 participantIndex` into `dictionaries.participants`.
There is no independent record identity or sorting beyond the match ranges
above.

### ratings/titles.bin — 4-byte values

Each value is one `u32 titleIndex` into `dictionaries.titles`. A match owns
`[titleOffset, titleOffset + titleCount)` and preserves canonical `ts` order.
The legacy `title` field is exactly the first index in that range, or `-1`.

### ratings/coverage.bin — 28-byte sparse denominator records

Records are ordered `(kind, subject, resolution, periodKey)` and include all
canonical matches, rated or not.

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u8 | kind: global=0, promotion=1, person=2, title=3 |
| 1 | u8 | resolution: year=0, quarter=1, month=2 |
| 2 | u16 | reserved, exactly 0 |
| 4 | u32 | subject dictionary index; global is `0xffffffff` |
| 8 | u32 | periodKey (year YYYY; quarter YYYYQ encoded `YYYY*10+Q`; month YYYYMM) |
| 12 | u32 | total canonical matches |
| 16 | u32 | rated matches with present `mr` |
| 20 | u32 | title-change matches |
| 24 | u32 | approximate-date matches |

For person coverage, a participant is counted at most once per match. Title
coverage adds one row contribution for every title in canonical `ts`, not only
the legacy primary `t`. Sparse
absence means there were no canonical records for that subject/period; it must
not be rendered as a known zero-rating aggregate.

### ratings/lod.bin — 72-byte sparse global/promotion aggregates

Records are ordered `(promotion, resolution, periodKey)`. `promotion` is a
`dictionaries.promotions` index, or `0xffffffff` for the global aggregate.
All rating statistics are computed directly from the period's sorted match
rating samples: never from child aggregates. Median is exact; for even sample
counts it is the arithmetic mean of the two middle samples. If `rated == 0`,
`min`, `max`, `sum`, and `median` are each exactly `0.0`.

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | promotion |
| 4 | u8 | resolution: year=0, quarter=1, month=2 |
| 5 | 3 bytes | padding, exactly 0 |
| 8 | i32 | periodStartDay |
| 12 | i32 | periodEndDay |
| 16 | u32 | periodKey |
| 20 | u32 | total canonical matches |
| 24 | u32 | rated matches |
| 28 | f64 | min rating |
| 36 | f64 | max rating |
| 44 | f64 | direct-sample sum |
| 52 | f64 | direct-sample exact median |
| 60 | u32 | ratings >= 4.0 |
| 64 | u32 | ratings >= 5.0 |
| 68 | u32 | approximate-date matches |

`histograms.json` is the checksummed canonical distribution companion: it carries direct
rating-value counts globally and by year, with `total`/`rated` coverage and
the exact `mr` value distribution. Use it for an honest deferred detail view;
do not invent a distribution from LOD medians or bins.
