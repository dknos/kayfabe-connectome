# Canonical Model — v2

Versioned canonical schema for Kayfabe Connectome. Source of truth for the
materializer and every projection. Wire formats: `packages/graph-contract`.

## Identity scheme

| Prefix | Entity | Source |
|---|---|---|
| `p:<n>` | Person (individual Wrestlers row) | Wrestlers.id |
| `p:d<slug>` | Person derived from a side-row part with no solo row (deterministic slug of exact name) | side-row split |
| `s:<n>` | Side row (ampersand-joined Wrestlers row) — internal, never a graph node | Wrestlers.id |
| `pr:<n>` | Promotion | Promotions.id |
| `t:<n>` | Championship | Belts.id (≠1) |
| `c:<n>` | Card (event occurrence) | Cards.id |
| `en:<n>` | Event name | Events.id |
| `m:<n>` | Match | Matches.id |
| `x:unknown` | Unresolved-identity sentinel (placeholder rows) | detection list |

## People, sides, resolution

- A Wrestlers row without `' & '` is an **individual**. Disambiguation suffixes
  (`(II)` …) stay distinct people. Placeholder rows (`Unknown Participants`, …)
  map to `x:unknown`, never to a person.
- A Wrestlers row with `' & '` is a **side row**: an ordered list of part names.
  Each part resolves to an individual by **exact name match** (algorithm
  `exact-name-split@1`, state `confirmed`, evidence recorded). Unmatched parts
  become derived persons `p:d<slug>` (state `probable`, evidence = side row id).
- Never merge on similar names. No fuzzy matching in v1.
- Persona/alias layer: v1 has one display name per person (source has no alias
  table). The alias search index still indexes side-row memberships and the
  model reserves persona records — see LIMITATIONS.

## Matches are temporal hyperedges

Canonical match = `{ id, card, date, promotion, form, stipulation_text, result,
finish, duration_s|null, title|null, title_change, sides: [side_w, side_l] }`
where each side = `{ role: winner|loser|draw-a|draw-b|unknown, members:
[person ids], has_unknown: bool, collapsed_multiway: bool }`.

### Result/finish parse (`win_type`)
- `def.` → decisive; parenthetical → finish ∈ {pin, sub, DQ, CO, TKO, KO, forfeit}
- `draw` → draw; parenthetical → {NC, DCO, DDQ, time}
- `vs.` / empty → result unknown
- Draws/unknown: sides keep listed order but NO winner/loser semantics.

### Match-form classification (`form-classify@2`)
Lowercased stipulation string, first matching rule wins:
1. `battle_royal`: contains `battle royal` | `royal rumble` | `rumble`
2. `multi_way`: `three-way|3-way|triple threat|four-way|4-way|five-way|six-way|
   fatal|elimination chamber|gauntlet|dance` (incl. `… dance tag`)
3. `tag_team`: `tag` | `N-man` | `N-person` | `handicap`
4. `singles`: side sizes 1v1
5. `team_implied`: any side has >1 member, no multi-way marker (confidence: inferred)
6. `unknown`: otherwise

### Derivation rules (projection B — person encounters)
Every derived observation carries its match id. Aggregated edges carry the full
supporting match-id list. **These rules are correctness-critical:**

- **Opposed**: winner-side members × loser-side members — always derived, EXCEPT
  class `battle_royal` which produces `battle_royal_opposed` (rendered/weighted
  separately; never a "rivalry" claim).
- **Same-side (partner)**: within a side, ONLY when the side is a genuine team:
  - form `tag_team` / `team_implied`: both sides yield partner observations.
  - form `multi_way`: ONLY the winner side (a real team that won together);
    the loser row is collapsed opposition — deriving partners from it would
    fabricate tag teams out of triple threats. NEVER derive within-loser-group
    pairs (neither partner nor opposed — membership of sub-teams is unknowable).
  - form `battle_royal`: no partner observations at all.
- `x:unknown` members never produce observations.
- Repeated opposition is labeled **"opposed encounters"** — never "feud".
- Promotion appearance = person appeared on a card of that promotion. Never
  labeled employment. First/last known record ≠ debut/retirement.

### Championships
- Belt id 1 = no-title sentinel. Concat artifacts split against the
  standalone-title name list (`belt-split@1`); unsplittable names keep a
  `concat_artifact` flag.
- Title match: `title != null`. Title change: `title_change = 1` → winner side
  becomes champion(s). Reigns are **derived intervals** between successive
  change events per belt (`reign-derive@1`, labeled computed): vacancies are
  invisible to this corpus and are NOT invented; transitions where the source
  lacks a change event stay gaps.

## Entity-resolution decisions
Every automatic decision records: algorithm@version, inputs, candidate ids,
score, state (`confirmed|probable|possible|unresolved|rejected`), evidence,
timestamp. Emitted to `reconciliation/`.

## Source assertions
When wrestlingdb_api (or any future source) disagrees with local_sql on a
field, both values persist as assertions `{entity, field, value, source,
source_record, retrieved, confidence, review_state}`. No averaging, no silent
overwrite. UI shows conflict state.

## v2: the csv corpus (csv-source@1, crosswalk@1, encounters@2)

### csv-source@1 — staging grammar
The csv corpus (cp1252, 363,728 rows, 571 promotions, 1947-2024) shares the
profightdb result grammar with local_sql but keeps richer side structure:

- `', '` separates **competitive units** (teams or individuals in a
  multi-way); `' & '` separates members **within** a unit. local_sql collapses
  the same information into one `&`-joined blob.
- A trailing `\xa0(c)` marks the incoming champion — stripped from names,
  never part of identity.
- `'Name, Jr.'` (lucha convention) is rejoined to `'Name Jr.'` — the
  local_sql convention — so the same person never splits. A bare suffix that
  survives rejoining is a placeholder, never a person.
- A literal `<U+2245> ` date prefix marks an approximate date (kept, flagged
  `apx`). Rows with unparseable dates, an empty side, or exact-duplicate keys
  are quarantined and counted, never guessed.

### form-classify@2
Ordered rules; sources without unit grammar pass units_total=2 and reduce to
@1 exactly (plus the team-elimination marker refinement):
1. battle-royal markers → `battle_royal`
2. **units_total >= 3 → `multi_way`** (comma grammar proves the field)
3. multi-way markers → `multi_way`
4. **team-elimination markers (cibernetico / survivor series / wargames /
   team war / 'N on N') → `tag_team`**
5. tag/handicap/N-man markers → `tag_team`
6-8. side-shape rules → `singles` / `team_implied` / `unknown`

### encounters@2 — unit-aware derivation
A side is a list of units. Single-unit sides reproduce encounters@1 verbatim.
- `battle_royal`: brOpposed winner-side x loser-side only; nothing within.
- `multi_way`: opposed between every pair of **distinct units** — including
  units on the same listed side (a triple threat's two listed losers opposed
  each other too). Partners within a unit only when the unit is genuine: its
  side has >= 2 explicit units, or it is the whole winner side of a decisive
  result. A single-unit multi-way loser side is a collapsed group — nothing
  is derived within it.
- team forms: opposed across sides; partners within each unit.
- Dual-side people (source corruption) are dropped from the match and the
  match id ledgered.
The web client mirrors these rules bit-for-bit for record-accurate date
filtering and playback pulses (timeline events carry `wu`/`lu` unit
partitions whenever a side has >= 2 units).

### crosswalk@1 — merge policy
See docs/DECISIONS.md D-007. Family rows enrich (never duplicate) local_sql
matches; non-family rows are csv-canonical; unmatched family rows are
excluded and ledgered. Identity ids: `p:c<fnv1a32-hex>` csv person (resolution
class 2), `pr:c<n>` csv promotion, `t:c<n>` csv championship, `m:c<n>` /
`c:c<n>` / `en:c<n>` csv match / card / event-name — all deterministic
(alphabetical registries, salted rehash on hash collision).

### csv enrichment fields
`mr` (Meltzer rating, floats -1..8), `ppv` (flag), `placement` (card
position), venue/city (into `loc`). Attached to timeline records and
evidence rows; a family match receives them only through an exact crosswalk
key (Meltzer only when the key maps to exactly one local_sql match).
