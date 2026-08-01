# Materializer — LIMITATIONS and resolved contract ambiguities

Recorded by the graph-materialization build (2026-07-31). Each entry states the
ambiguity or corpus limitation and the deterministic resolution shipped in v1.

## Resolved ambiguities

1. **form-classify@1 marker spelling variants.** CANONICAL-MODEL.md lists
   `three-way|3-way|triple threat|four-way|4-way|five-way|six-way|…`. The
   corpus additionally contains `triple-threat` (hyphenated, ~800 matches) and
   digit forms `5-way`…`10-way` that the literal list misses; classifying them
   as tag/singles would fabricate partner edges from collapsed multi-way rows —
   which the same document forbids as correctness-critical. Resolution:
   markers are matched with hyphens normalized to spaces and the N-way family
   generalized to `\d+-way`. Single-word markers (`tag`, `rumble`, `dance`,
   `fatal`, `gauntlet`) match on word boundaries so `"3 stages of hell"` is not
   a tag match. `"ready to rumble" steel cage handicap` still classifies as
   battle_royal per the literal `rumble` rule (conservative: fewer edges).
2. **Opposed observations for draws/unknown results.** "Winner-side ×
   loser-side" is applied to the two listed sides regardless of result kind —
   cross-side opposition is factual in draws. Multi-way partner observations
   additionally require a decisive result (a draw has no "winner side"); a
   multi-way draw derives no partner observations at all.
3. **Split concat belts are not graph nodes.** A belt whose name fully splits
   against the standalone-title list (47 of them) has its matches, title
   changes, and reigns attributed to each component title; the concat id gets
   no `t:` node. Evidence/timeline `t` fields carry the FIRST component in
   split order (the wire format has a single title slot). Unsplittable
   suspected concats (2) are kept as title nodes with `artifact: true`.
   Suffix-based concat suspicion requires a title-shaped head, so qualified
   names ("Undisputed WWE Championship", "Interim …") are NOT artifacts.
4. **`counts.title_changes` = 1,753**, the title_change=1 matches with a real
   (non-sentinel) title. The raw source count is 1,762; 9 rows have
   `title_change=1` with `title_id=1` (no belt to attribute) and are recorded
   in quality metrics as `title_changes_raw` but excluded from reign
   derivation and density.
5. **`unresolved_side_parts` = 51**: occurrences of placeholder parts inside
   ampersand side rows. Individual placeholder rows used directly as a match
   side (`Unknown Participants` etc., 4 rows incl. the empty-name row id 3401)
   are tracked separately (`placeholder_rows` in quality metrics).
6. **Derived-person merging by exact name.** exact-name-split@1 keys derived
   people on the exact part string, so all unmatched `Jr.` fragments (source
   split artifacts of names like "X, Jr.") merge into one derived person, as
   do genuinely distinct people who only ever appear under one shared side-row
   spelling (`Rey Misterio`). No fuzzy correction in v1 by design.
7. **Dossier `teams`** lists only side rows that acted as genuine team sides
   (tag/team_implied, or the winning side of a decisive multi-way) — collapsed
   multi-way loser rows and battle-royal pools are not "teams".
8. **Unclustered people.** Persons with zero encounter edges (all matches vs
   placeholders only) get `community: -1` (same sentinel as non-person nodes)
   and sit on a deterministic outer shell in the layout.
9. **Evidence ordering** "(d, m)" is implemented as (date, numeric match id) so
   `m:100` sorts after `m:36`.
10. **Search entities**: person/promotion/title entries include `first`/`last`
    only when at least one dated match/card exists; event entries only when
    multi-use (per contract). `pm` is emitted for persons only.

## Corpus limitations carried through

- First/last observed dates are record boundaries, never debut/retirement;
  promotion appearance is never employment (per CANONICAL-MODEL.md).
- Reigns are derived intervals between in-corpus change events; vacancies and
  off-corpus changes remain gaps (never invented).
- One display name per person; the persona/alias layer stays reserved (source
  has no alias table).
- Battle-royal opposition is stored/weighted separately (`brOpposed`) and must
  never be rendered as a rivalry claim.

## Dev-environment note

pytest was installed for python3.12 (`pip install --user --break-system-packages
pytest`) solely to run the mandated test suite; the pipeline itself is stdlib
only.
