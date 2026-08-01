# Data Dictionary — source corpus

## Belts (178 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| name | TEXT |  | 0.0 | 0.6 |  |

> Some names are concatenation artifacts of two titles contested together (e.g. 'ECW FTW Title ECW World Heavyweight Title'); the normalizer must split them against the standalone-title name list.

> Belts.id=1 (empty name) is the no-title sentinel.

## Cards (14,399 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| table_id | INTEGER |  | 0.0 | 0.0 |  |
| location_id | INTEGER |  | 0.0 | 0.0 |  |
| promotion_id | INTEGER |  | 0.0 | 0.0 |  |
| event_date | TEXT |  | 0.0 | 0.0 |  |
| event_id | INTEGER |  | 0.0 | 0.0 |  |
| url | TEXT |  | 0.0 | 0.0 |  |
| info_html | TEXT |  | 0.0 | 0.0 | PRIVATE |
| match_html | TEXT |  | 0.0 | 0.0 | PRIVATE |

> One row per event occurrence. url is the provenance link (100% www.profightdb.com in the audited snapshot); info_html/match_html are raw scraped payloads — PRIVATE, never published or shipped to the browser.

> event_date is uniformly YYYY-MM-DD with zero nulls in the audited snapshot.

## Events (6,046 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| name | TEXT |  | 0.0 | 0.0 |  |

## Locations (687 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| name | TEXT |  | 0.0 | 0.0 |  |

## Match_Types (1,296 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| name | TEXT |  | 0.0 | 0.1 |  |

> Free-text stipulation strings (1,296 distinct incl. empty). The normalizer classifies them into structured form (singles/tag/multi-side/battle-royal/unknown) while preserving the original stipulation text.

## Matches (88,243 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| card_id | INTEGER |  | 0.0 | 0.0 |  |
| winner_id | TEXT |  | 0.0 | 0.0 |  |
| win_type | TEXT |  | 0.0 | 0.0 |  |
| loser_id | TEXT |  | 0.0 | 0.0 |  |
| match_type_id | TEXT |  | 0.0 | 0.0 |  |
| duration | TEXT |  | 0.0 | 79.3 |  |
| title_id | TEXT |  | 0.0 | 0.0 |  |
| title_change | INTEGER |  | 0.0 | 0.0 |  |

> Exactly two side references per match: winner_id and loser_id, each a single Wrestlers row id stored as TEXT (verified all-numeric, no comma lists).

> Multi-way matches are COLLAPSED: the losing 'side' row joins all non-winners with ' & '. Same-side (partner) observations are only valid for genuine team match forms, never for multi-way singles forms.

> win_type encodes result + finish: 'def. (pin|sub|DQ|CO|TKO|KO|forfeit)', 'draw (NC|DCO|DDQ|time)', bare 'def.'/'draw', and 'vs.' meaning unknown result.

> title_id references Belts; Belts.id=1 has empty name and is the NO-TITLE sentinel. title_change is 0/1.

> duration is 'MM:SS' text, frequently empty.

## Promotions (6 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| name | TEXT |  | 0.0 | 0.0 |  |

## Tables (1,457 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| html | TEXT |  | 0.0 | 0.0 |  |
| url | TEXT |  | 0.0 | 0.0 |  |

## Wrestlers (19,278 rows)

| Column | Type | PK | Null% | Empty% | Private |
|---|---|---|---:|---:|---|
| id | INTEGER | ✓ | 0.0 | 0.0 |  |
| name | ANY |  | 0.0 | 0.0 |  |

> Rows conflate PEOPLE and SIDES: names containing ' & ' are ampersand-joined participant lists (teams or collapsed multi-way opposition), not individuals.

> Placeholder rows exist (e.g. 'Unknown Participants') and must resolve to an unresolved-identity sentinel, never a person.

> Disambiguation suffixes like '(II)' distinguish successive mask/gimmick holders; they are distinct canonical people.
