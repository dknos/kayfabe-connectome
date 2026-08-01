# Database Audit — source corpus

Generated: 2026-08-01T04:12:20.268213+00:00  
Dialect: SQLite (runtime 3.50.4) — access `mode=ro&immutable=1` on a private copy.  
File: `wwe_db_2026-01-18.sqlite` (never committed).

## Shape

| Table | Rows | Notes |
|---|---:|---|
| Belts | 178 | Some names are concatenation artifacts of two titles contested together (e.g. 'ECW FTW Title ECW World Heavywe |
| Cards | 14,399 | One row per event occurrence. url is the provenance link (100% www.profightdb.com in the audited snapshot); in |
| Events | 6,046 |  |
| Locations | 687 |  |
| Match_Types | 1,296 | Free-text stipulation strings (1,296 distinct incl. empty). The normalizer classifies them into structured for |
| Matches | 88,243 | Exactly two side references per match: winner_id and loser_id, each a single Wrestlers row id stored as TEXT ( |
| Promotions | 6 |  |
| Tables | 1,457 |  |
| Wrestlers | 19,278 | Rows conflate PEOPLE and SIDES: names containing ' & ' are ampersand-joined participant lists (teams or collap |

## Corpus facts

- Event date range: **1963-01-25 → 2026-01-16**, 0 invalid dates.
- Promotions: ECW, NXT, WCW, WWE, WWWF, WWF.
- Wrestlers rows: 4,599 individual-name rows, 14,679 ampersand-joined SIDE rows (teams / collapsed opposition).
- Title matches: 13,527; title changes: 1,762.
- Referential integrity: 0 orphan references across all checked joins.
- Provenance: card URLs resolve to www.profightdb.com.

## Result / finish taxonomy (win_type)

| win_type | count |
|---|---:|
| `def. (pin)` | 44,988 |
| `def.` | 29,974 |
| `def. (sub)` | 4,801 |
| `def. (DQ)` | 4,640 |
| `draw (NC)` | 1,621 |
| `def. (CO)` | 984 |
| `draw (DCO)` | 303 |
| `draw (time)` | 232 |
| `draw (DDQ)` | 198 |
| `draw` | 167 |
| `def. (TKO)` | 95 |
| `def. (KO)` | 62 |
| `vs.` | 44 |
| `def. (forfeit)` | 39 |
| `(pin)` | 27 |
| `draw (curfew)` | 23 |
| `draw (DPin)` | 17 |
| `draw (DTKO)` | 8 |
| `def.draw (NC)` | 4 |
| `(empty)` | 4 |
| `def.draw (time)` | 3 |
| `(sub)` | 3 |
| `(DQ)` | 3 |
| `draw (points)` | 2 |
| `def.draw (DCO)` | 1 |

## Hazards the normalizer MUST respect

- **Wrestlers**: Rows conflate PEOPLE and SIDES: names containing ' & ' are ampersand-joined participant lists (teams or collapsed multi-way opposition), not individuals.
- **Wrestlers**: Placeholder rows exist (e.g. 'Unknown Participants') and must resolve to an unresolved-identity sentinel, never a person.
- **Wrestlers**: Disambiguation suffixes like '(II)' distinguish successive mask/gimmick holders; they are distinct canonical people.
- **Matches**: Exactly two side references per match: winner_id and loser_id, each a single Wrestlers row id stored as TEXT (verified all-numeric, no comma lists).
- **Matches**: Multi-way matches are COLLAPSED: the losing 'side' row joins all non-winners with ' & '. Same-side (partner) observations are only valid for genuine team match forms, never for multi-way singles forms.
- **Matches**: win_type encodes result + finish: 'def. (pin|sub|DQ|CO|TKO|KO|forfeit)', 'draw (NC|DCO|DDQ|time)', bare 'def.'/'draw', and 'vs.' meaning unknown result.
- **Matches**: title_id references Belts; Belts.id=1 has empty name and is the NO-TITLE sentinel. title_change is 0/1.
- **Matches**: duration is 'MM:SS' text, frequently empty.
- **Belts**: Some names are concatenation artifacts of two titles contested together (e.g. 'ECW FTW Title ECW World Heavyweight Title'); the normalizer must split them against the standalone-title name list.
- **Belts**: Belts.id=1 (empty name) is the no-title sentinel.
- **Cards**: One row per event occurrence. url is the provenance link (100% www.profightdb.com in the audited snapshot); info_html/match_html are raw scraped payloads — PRIVATE, never published or shipped to the browser.
- **Cards**: event_date is uniformly YYYY-MM-DD with zero nulls in the audited snapshot.
- **Match_Types**: Free-text stipulation strings (1,296 distinct incl. empty). The normalizer classifies them into structured form (singles/tag/multi-side/battle-royal/unknown) while preserving the original stipulation text.

## Read-only guarantee

All access uses `mode=ro&immutable=1`; `guard_sql` additionally blocks DML/DDL verbs. No migration, index, or repair statement targets the source.
