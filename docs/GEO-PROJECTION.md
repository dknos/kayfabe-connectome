# Geographic projection — wire format

Contract between `services/materializer` (producer, Python stdlib only) and
`apps/web` (consumer), for everything under `data/materialized/geo/`. Rules
match the main materialized format: UTF-8 JSON, no NaN/Infinity, little-endian
binary, sorted keys, deterministic across runs.

Day encoding is the corpus-wide one: **days since 1900-01-01**.

## The unit is the CARD

One record per canonical card, not per match. A card with ten matches lights
one city once, with an intensity that can encode its ten matches. It does not
produce ten city-to-city movements. Match-level detail is reached *from* the
card through the existing evidence store; it is not modelled as separate
geographic events.

## Files

```
data/materialized/geo/
  manifest.json            versions, counts, coverage, attribution, checksums
  places.json              canonical places, columnar
  source-location-map.json every source string -> its verdict and provenance
  cards.bin                one 8x u32 record per card
  cards-strings.json       card ids, promotion ids/names, event names
  scopes/promotions.json   promotion id -> card indices
  scopes/places.json       place id  -> card indices
  scopes/events.json       event name -> card indices
  scopes/titles.json       title id  -> card indices
  scopes/people/{bb}.json  person id -> card indices, 256 shards
  by-year/index.json       year -> [start, end) into the card table
  density/by-year.json     per-year cards / matches / title changes / places
  quality.json             coverage and verdict breakdown
  unresolved.json          every location that could not be plotted
```

## cards.bin

`count * 8` u32 LE per record, in the order declared by
`manifest.cards_bin.fields`:

| # | field | meaning |
|---|---|---|
| 0 | `day` | days since 1900-01-01 |
| 1 | `promotionIdx` | index into `cards-strings.promotionIds` |
| 2 | `placeRef` | **0 = not plotted**, otherwise `placeIdx + 1` |
| 3 | `eventNameIdx` | index into `cards-strings.eventNames` |
| 4 | `matchCount` | |
| 5 | `personCount` | distinct resolved participants |
| 6 | `titleCounts` | `titleMatchCount | titleChangeCount << 16` |
| 7 | `flags` | bit0 unresolved participant, bit1 csv-sourced |

`placeRef` is offset by one so that "unplotted" is the zero value and can never
be confused with place index 0.

Records are sorted by **`(date, card id AS A STRING)`**. csv ids like `c:c1773`
are `NaN` under `Number()`; a mixed numeric sort silently reorders the whole
csv half of the corpus.

## places.json

Columnar, all arrays length `count`:

`id displayName city admin1 country countryCode lat lon precision cards matches
titleMatches titleChanges firstDay lastDay resolution confidence source`

Place ids are `g:<geonamesId>` (permanent, so they survive a gazetteer refresh)
or `x:<slug>` for a manually supplied coordinate. `resolution` and `confidence`
carry the **worst** verdict of every source string that maps into the place — a
place is only as trustworthy as its weakest inbound key.

Only places a card actually reaches are emitted. A reviewed place no card uses
is resolution config, not projected data.

## source-location-map.json

`location key -> { placeId, resolution, confidence, rung, reviewed, notes,
rawName, family, cards, matches, venue?, city?, sourceLocationId? }`

This is the provenance trail the inspector shows: which raw string produced a
dot, which rung decided it, and what the resolver noted while deciding. Kept
out of `places.json` so the hot path stays small.

Location keys are `sql:<locationId>` and `csv:<venue>\x1f<city>`.

## Scope indices

Every scope resolves to **card indices into the one shared, date-sorted table**,
so all scopes play in the same chronological order and switching scope is an
index-list swap rather than a reload.

Person scopes are sharded 256 ways by `fnv1a32(id) % 256`, matching the
evidence and dossier sharding already in use.

**Pair scopes have no index by design.** A pair's geography is exactly the
geography of its evidence: every supporting match already names its card, so
the client reads the existing `evidence/pairs/{bb}.json` and maps card ids to
indices. Adding a parallel pair index would create a second source of truth
that could drift from the evidence.

## manifest.json

Versions (`schema`, `projection`, `resolution`, `gazetteer`), the coordinate
reference system (`EPSG:4326 (WGS 84), decimal degrees`), counts, date and day
range, the `cards_bin` layout, flag bits, coverage, precision counts, required
**attribution**, and a sha256 per emitted file. `pnpm geo:validate` re-hashes
every file against the manifest.

## Validation

34 checks, run by `pnpm geo:validate`. Each reconciles a derived number against
the **canonical corpus**, not against another derived number, so a systematic
error cannot agree with itself. Covered: coordinate finiteness and range, the
0,0 trap, precision and provenance presence, unresolved records keeping null
coordinates while staying counted, `cards.bin` shape and ordering, card id
uniqueness, per-card match/day/title-change reconciliation, total match
reconciliation, every scope index (promotion, place, person, championship)
against the canonical corpus, year ranges and density, checksum integrity, and
three safety checks: no source HTML emitted, no credential-shaped string
emitted, no raw gazetteer file shipped.
