# ATLAS Projection — `atlas-projection@1`

The materialized semantic view the ATLAS lens reads: every promotion in the
corpus, every championship, and every person's documented route between
promotions. Producer: `services/materializer/kayfabe_materializer/atlas_project.py`
(`pnpm atlas:materialize`). Validator: `atlas_validate.py` (`pnpm atlas:validate`).
Wire types: the `ATLAS` banner in `packages/graph-contract/src/index.ts`.

It is a **separate entry point** from `pnpm data:materialize`. `atlas` is not in
that module's `_MANAGED` tuple, so the connectome build neither creates nor
deletes this tree, and this build touches nothing outside `data/materialized/atlas/`.

## What it is

Nothing here is a new claim about wrestling. Every field is a count of
documented records, a span between documented records, or a flag saying which
of those two the source could not supply. The projection exists to keep the
whole corpus visible — 571 promotions, not just the 165 that earned a graph
node — without inventing anything to fill the gaps that visibility exposes.

## Identity and bucketing

Ids are the canonical prefixed ids from `docs/CANONICAL-MODEL.md`: `pr:<n>`,
`t:<n>`, `p:<n>`. Shard files use `bb = bucket_of(id) = fnv1a32(id) % 256`, hex,
over the **prefixed** id — the same key `entities/people/{bb}.json` uses, so a
person is in the same `bb` in both trees and the lens can open them together.
Bucketing the bare id would silently split the two.

Only non-empty shards are written: 232 promotion shards, 256 people shards. A
loader must glob, not assume 256 files. `manifest.buckets` is the modulus (256),
not a file count.

Every sort is over the id **as a string**. The merged id space mixes `'1'` with
`'c361'`; a numeric sort either raises or silently reorders the whole csv half.

## Files

| File | Type | Notes |
|---|---|---|
| `manifest.json` | `AtlasManifest` | counts, checksums, validation, `reuses` |
| `promotions.json` | `AtlasPromotionsFile` | all 571, columnar — 54 KB |
| `titles.json` | `AtlasTitlesFile` | all 4389, columnar — 557 KB |
| `promotions/{bb}.json` | `AtlasPromotionsBucket` | focus board per promotion — 9.6 MB total, largest shard 236 KB |
| `people/{bb}.json` | `AtlasPeopleBucket` | routes only — 9.2 MB total, largest shard 56 KB |

`promotions.json` and `titles.json` load the moment the lens opens, so they are
columnar (parallel arrays, index-aligned), integer where possible, and carry
their yearly series run-length encoded rather than as year-keyed objects. The
shards are opened on demand.

### Yearly series (`run-length-from-year@1`)

`yearFrom` plus a dense array: `counts[i]` is the count for year `yearFrom + i`,
including explicit zeros for silent years. An empty series is `yearFrom = -1`
and `[]` — `-1` rather than `0`, so an absent series can never be read as "the
year 0". `encode_years` / `decode_years` in `atlas_project.py` are the only
implementations. The first and last slots of a non-empty series are always
non-zero, and the validator checks that they line up with `firstDay`/`lastDay`.

## Derivation rules

### Promotion membership

A person is a member of a promotion because they appear on a documented card
for it. That is the whole rule. `matches` is documented matches, `cards` is
distinct documented cards, `people` is distinct documented members, and
`firstDay`/`lastDay` are the ends of that documented span.

`cards` and `matches` are derived **uniformly from the match corpus** for all
571 promotions. A sqlite card that carries no match therefore does not appear
here: WCW has 1101 cards in the sqlite table and 1100 with a documented match.
The `matches` column of a promotion node in `graph/nodes.json` is not
comparable to either — it holds sqlite *card* counts for the six family
promotions and csv *match* counts for everyone else. Two definitions inside one
file would be worse than one definition that differs from a neighbouring
file's, so atlas uses one and states it here.

`src` labels the **registry** a promotion came from (`local_sql` for the six
family promotions, `csv_initial_matches` for the other 565), not the source of
each match: family promotions also carry csv-enriched matches.

`bit` is `manifest.promo_bits` from the connectome manifest, or `-1` for the
541 promotions that share the other-bit. It is recomputed from the two source
corpora (family bits fixed, then the top 24 csv promotions by match count, ties
by display name) so this tree can be built without the connectome tree; the
build cross-checks it against `data/materialized/manifest.json` when that file
exists (`promo_bits_match_connectome`).

### Title → promotion (`atlas-title-assoc@1`)

| `assoc` | When | `pr` | `assocShare` |
|---|---|---|---|
| `registry` | the csv source names the promotion outright | that promotion | `1.0` |
| `dominant` | a sqlite belt with ≥1 documented title match | argmax of documented title matches, ties by promotion id string ASC | `round(dominant / total, 4)` |
| `unresolved` | no supporting record of either kind | `""` | `0.0` |

Current corpus: 4259 `registry`, 130 `dominant`, 0 `unresolved`.

`materialize.py` assigns a sqlite belt with no counts at all to
`sorted(FAMILY_PROMO_BITS)[0]`, which is ECW. **That fallback is not copied.**
A belt with no supporting record is `unresolved` and belongs to no promotion
lane. Today that branch is empty — every sqlite belt has at least one
documented title match — so the fallback in `materialize.py` is currently dead
code rather than an active error. The branch stays because the guarantee is
about what the projection will do, not about today's row count.

`assocShare` is published so a low share reads as what it is: the WWF/WWE-era
belts sit at `1.0`, and three belts sit below `0.6`. A `dominant` belt is not
"owned" by its promotion — at best it is the promotion where most of its
documented title matches happened.

**A share of exactly `0.5` is a tie, not a plurality.** Two belts sit there:
`t:26250` (SMW Tag Team Titles — one documented title match under WCW and one
under WWF) and `t:8751` (Million Dollar Title — three under WWF and three under
NXT). Nothing in the records prefers either promotion; the string tie-break on
promotion id chose, and for `t:8751` it chose WWF only because `'11791'`
precedes `'692'` lexicographically. Consumers must render `assocShare == 0.5`
as an undecided association rather than as a weak majority, and must not let it
read as a sanctioning claim. The knock-on is real and worth naming: `t:26250`'s
single derived reign flags its two holders as champions on the WWF board, so
that `champ` marker descends from the tie-break.

`AtlasPromotionsFile.titles` counts only the titles whose `pr` is that
promotion, so the column sums to the number of **placed** titles, not to 4389.
113 promotions have no championship at all.

### Lineage (`atlas-lineage@1`)

`lineage` says whether a lineage can be derived **at all**, and it follows the
SOURCE, never the reign count:

- `derived` — `src == "local_sql"`. The sqlite corpus carries a `title_change`
  flag, so `reigns` is a real derivation. 130 titles.
- `no-changes` — `src == "csv_initial_matches"`. The csv corpus has no
  title-change column, so no reign is derived rather than guessed. 4259 titles.
  These belts still have documented title *matches*.

A sqlite belt whose flag simply never fired is still `derived`: `reigns == 0`
there means "the source recorded no change", while `reigns == 0` under
`no-changes` means "the source cannot record one". Reading the two as the same
number would be wrong for 4259 of 4389 belts.

Reigns come from `project.derive_reigns` (`reign-derive@1`) unchanged —
intervals between successive change events, never a vacancy, never an
interpolated date. 1792 reigns across 94 titles. `holders` is the distinct
people named in those reigns, so `holders == 0` wherever `reigns == 0`, and the
`champ` flag on a member means that person holds a derived reign in one of that
promotion's titles — 814 flagged members today, on the six family boards and
nowhere else, because only sqlite belts derive reigns.

`atlas/titles.json` `pr` and `entities/championships.json` `pr` agree on all
4389 titles today. They would diverge on an unresolved belt: atlas writes `""`,
championships writes the ECW fallback. The lens reads both files together, so
prefer atlas's `pr` when they disagree.

A title's `yearCounts` inside a promotion's focus board is the belt's **global**
per-year title-match series, matching its global `titleMatches`, not the slice
defended in that promotion. The two would otherwise disagree in the same object.

### Members and routes

`members` is ordered by `(-matches, p)` so the label budget follows corpus
weight, capped at `MEMBER_CAP = 4000` per promotion. When the cap bites,
`membersTruncated` carries the number left out — never silently, because a
capped roster that reads as complete is a false claim. The invariant the
validator enforces is `people == len(members) + membersTruncated`, so a
truncated board can still be read as a total. The largest roster in the corpus
today is 2497 (WWF), so nothing is currently truncated.

`people/{bb}.json` carries routes only: name, span, match count, and one
`AtlasRoute` per promotion ordered by `(firstDay, pr)`. The same
(person, promotion) pair is written twice by two different loops — once as a
route, once as a member — and the validator reconciles them.

### Reuse, not duplication

`manifest.reuses` records what this projection deliberately does not copy:

| Needed by the lens | Read from |
|---|---|
| person teams | `entities/people/{bb}.json` `.teams` |
| top partners / opponents | `entities/people/{bb}.json` `.top` |
| person yearly activity | `entities/people/{bb}.json` `.years` |
| title reign lineage | `entities/championships.json` `.reigns` |

Copying them would double the bytes and create a second version that can drift
from the first.

## Missing stays missing

`firstDay`/`lastDay` are `-1` when there is no dated record, and the validator
rejects a half-span (one end `-1`, the other real). No date is ever
interpolated, no span is ever extended to a round year, and no gap inside a
span is filled. Every promotion in the corpus has at least one dated match
today, so `-1` currently appears only on the unresolved-title branch.

## Determinism

Two runs produce byte-identical files. Sorted keys, compact separators, no
NaN, no timestamps anywhere — including the manifest, which has no `built_at`.
Verified by re-running the build and comparing a sha256 over the whole tree,
and guarded in-band by the `determinism_canary` check.

## Validation

`atlas_validate.run_checks(out, counts=None)` reads the written tree from disk
and returns `(passed, checks)`. The build calls it before writing the manifest
and records the result in `manifest.validation`; the browser loader refuses to
render a projection whose own validation failed, so every check is an assertion
about the files, never a warning.

| Check | Asserts |
|---|---|
| `columnar_shape` | array lengths equal `count`, exact key sets, ids unique and sorted as strings |
| `title_association` | each `assoc` branch's `pr`/`assocShare`/`titleMatches` shape; `pr` resolves; promotion title counts equal the lanes and sum to the placed titles |
| `title_lineage` | `derived` ⇔ `src == local_sql`; `no-changes` ⇒ no reigns and no changes; `holders == 0` wherever `reigns == 0` |
| `bucket_assignment` | every id lands in the `bb` `bucket_of()` says, details cover every promotion |
| `spans_monotonic` | `firstDay <= lastDay` wherever both `>= 0`, and no half-missing span, across promotions, titles, details, members and routes |
| `id_resolution` | every `pr`, `t` and `p` reference resolves to a row that exists |
| `promotion_people_reconcile` | `promotions.json` row equals its detail field-for-field, and `people == len(members) + membersTruncated` |
| `member_ordering` | rosters sorted by `(-matches, p)`, routes by `(firstDay, pr)`, `cards <= matches` |
| `yearly_reconcile` | every series sums to its total, spans its `firstDay`..`lastDay` years, has no padding at the ends, and the detail's series equals `promotions.json`'s |
| `person_routes_reconcile` | a person's totals equal their routes' totals, one route per promotion, and member rows agree with route rows |
| `champ_flags` | a board with no derivable lineage has no champions, and a board's champions never outnumber the holders of its own titles |
| `finite_values` | no NaN or infinity at any numeric leaf |
| `manifest_counts` | every count equals the array length it describes |
| `determinism_canary` | sha256 over a fixed sorted subset |
| `promo_bits_match_connectome` | recomputed `promo_bits` equal the connectome manifest's (build-time; skipped, not failed, when that manifest is absent) |
| `checksums` | standalone runs only: every recorded sha256 still matches |
| `manifest_consistency` | standalone runs only: date/day range round-trip, recorded validation passed |

The build additionally hard-fails (raises) if the lineage rule stops matching
the source split, if a title outside the sqlite corpus derives a reign, or if a
documented member has no name. Those are not warnings either.

## What this projection does NOT claim

- **Not employment.** Promotion membership is documented appearance on a card.
  The corpus records no contract, no roster, no signing, no departure and no
  exclusivity, and neither does this projection. A person appearing under two
  promotions in the same month is two documented appearances, not a jump.
- **Not a complete roster.** `people` counts the people who appear in the
  documented matches, not everyone who worked there. Absence is absence of
  records.
- **Not a complete lineage.** `reigns` is derived only where the source records
  title changes. `lineage: "no-changes"` covers 4259 belts whose histories exist
  and are simply not in this corpus. Zero reigns is never a claim that a belt
  never changed hands.
- **No champions for csv-only promotions.** Because only sqlite belts can
  derive reigns, only sqlite belts can flag a `champ` member. A csv-sourced
  promotion showing no champions is a source limitation, not a finding.
- **Not an ownership claim.** `assoc: "dominant"` says where most of a belt's
  documented title matches happened, and `assocShare` says how thin that
  plurality is — down to `0.5`, which is a tie the id ordering broke rather
  than a plurality at all. It is not a statement about who sanctioned the belt.
- **No promotion hierarchy.** There is no parent, child, successor, territory
  or affiliate field, because there is no such record in the corpus. Two
  promotions sharing a name or a roster are not related here.
- **No inferred dates.** No vacancy, no interpolation, no rounding of a span to
  a year boundary, no filling of a gap inside a span.
- **Not a fixed universe.** `titles` per promotion excludes unresolved belts, so
  the column does not sum to 4389; `cards` differs from the sqlite card table by
  the cards that carry no match. Both are stated above rather than reconciled by
  adjusting a number.
