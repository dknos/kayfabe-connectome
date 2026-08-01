# Canonical Model — v1

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

### Match-form classification (`form-classify@1`)
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
