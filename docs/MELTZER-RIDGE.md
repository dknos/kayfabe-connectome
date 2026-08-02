# MELTZER RIDGE

MELTZER RIDGE is the ratings lens for the already-materialized Kayfabe
Connectome corpus. It renders reported `mr` values as a three-dimensional,
time-aware field. It is a way to inspect what the canonical source reports;
it does not measure match quality, popularity, or fan consensus.

The lens is lazy-loaded. Its public payload is the deterministic
`data/materialized/ratings/` projection, built from canonical timeline files,
not directly from the private CSV or source database.

## Read the field

- **x / left to right:** canonical match date.
- **y / vertical:** the exact reported rating on a linear scale, with zero as
  the baseline. Negative values extend below it; values above five extend past
  the five-star threshold plane.
- **z / depth:** neutral on the landing chronology. Promotion does not sort or
  separate that view. Focused promotion/title, opponent/team career, and A/B
  comparison modes may use disclosed context tracks in depth.

An individual peak is one canonical match with a present `mr`. Its height is
the unrounded reported value. On the landing chronology every peak has `z=0`,
so position is determined only by date and rating. Focused semantic views may
separate same-day matches in depth by documented card placement where it
exists; otherwise they use a deterministic opaque-ID fallback.

The landing view has one global gray coverage rail containing all documented
canonical matches in a time cell. Its warm overlay is the subset carrying a
reported rating. Focused promotion views use the same encoding per lane.
An empty or faint warm rail therefore means sparse reporting, **not** a poor
rating. Missing is not zero. The landing rail claims the materialized global
denominator, while canonical promotion lanes may claim a per-promotion source
denominator. Derived opponent/comparison lanes label a lane denominator as
unavailable and use the complete current-scope ledger instead of inventing
opponent-lane coverage.

Aggregate ridges are time bins, not matches: height is the bin maximum, the
thin trace is the exact median, and width is the chronological bin span. Depth
is neutral in the global chronology; sample and coverage counts remain
inspectable rather than becoming an undeclared positional variable.
Clicking one narrows the shared time filter to that bin. Statistics are direct
sample statistics: medians sort the actual ratings (even counts average the two
middle values), and means use the actual ratings. They are never computed by
averaging lower-level medians.

### Layout, LOD, and transition formulas

For the active rated-date interval `[d0,d1]`, a match day `d` maps to
`x = -560 + clamp((d-d0)/(d1-d0),0,1) * 1120`. Reported rating `r` maps to
`height = r * 42`; the mesh grows upward for positive values and downward for
negative values from the same zero baseline. The landing chronology fixes
every exact peak and global aggregate at `z=0`. Focused context lanes are 42
world units apart and may use 58 units where added separation is useful. In
those focused views, a documented card placement uses
`((placement mod 9)-4)*1.7` as its same-day depth offset. Without placement,
the offset is a deterministic FNV-1a hash of the opaque match id plus a bounded
stable ordinal. None of these offsets changes time or height.

Exact peaks and aggregate ridges overlap through a real dolly crossfade from
camera distance 620 through 1180; point tips remain as the intermediate/distant
exact cue. A median trend dash requires at least three rated matches in its bin;
one- and two-match aggregates remain inspectable but do not assert a trend.
Aggregate lines are built only for supported bins and never connect across an
unsupported year. A semantic
retarget captures the exact geometry's current interpolated attributes, while
the old aggregate, rail, and guide layers fade out as the new layers settle.
Labels swap after the structural midpoint. Reduced motion lands geometry
immediately and uses opacity/state changes instead of a flight.

## Evidence and source boundaries

`mr` is optional on a canonical timeline event. A record enters
`matches.bin` only when `mr` is present. Present values, including `0`,
negative values, and values above five, are retained exactly. An unrated
canonical match is still counted by coverage, but it is not converted to a
zero-star peak or synthetic histogram value.

The upstream CSV is a user-supplied private corpus. Under the canonical
crosswalk policy, the six local-SQL family promotions remain SQL-canonical;
CSV ratings enrich a family match only for an unambiguous exact crosswalk.
Non-family CSV rows are CSV-canonical. Misses and ambiguities are ledgered,
not guessed. See [D-007](DECISIONS.md#d-007--csv-corpus-integration-policy-crosswalk1-2026-08-01)
and [the canonical model](CANONICAL-MODEL.md#crosswalk1--merge-policy).

Title filtering and title scope use the complete ordered canonical `ts` title
set, not just the legacy primary `t`. A source title match can be documented
without a source title-change outcome; the lens never infers a title transfer.
The CSV’s global coverage ends at its documented 2024-09 boundary, while the
local SQL family continues farther. Treat gaps as corpus/reporting limits, not
claims that no wrestling occurred.

## Views, filters, and disclosure

The controls provide five scopes:

- **Time + rating:** the global landing chronology. Time controls x, exact
  reported rating controls y, and promotion does not determine position.
- **Promotion:** one selected promotion.
- **Career:** a selected person, with named singles opponents, an “other
  opponents” lane when needed, and a team/multi-person context lane.
- **Title:** exact matches associated with one canonical title identity.
- **Compare A/B:** two promotions use adjacent A/B tracks. Two people use A,
  shared, and B tracks; a canonical match involving both is drawn once in the
  shared center track. Coverage reports both subjects’ documented exposures,
  and each side’s denominator remains visible.

Exact peaks can be filtered by date, reported-rating range, promotion, form,
PPV, title-match status, title-change status, date precision, and a promotion
coverage minimum. Form and event-flag filters affect rated peaks; the coverage
rail stays the all-match denominator for its time and lane. At a partial-month
date boundary, coverage uses complete calendar months and says so in the
layout notes.

Focused lanes can be ordered by stable whole-corpus order, rated or total
count, coverage, median, mean, 4-star or 5-star count, maximum, or name.
“Stable” is intentionally based on the full rated corpus; analytical ordering
uses the active time window. Lane-order and context controls are hidden on the
global chronology because they cannot change its time/rating-only position.
Individual peaks, aggregate ridges, and median traces remain independently
toggleable.

To stay interactive, the renderer applies quality-tier caps:

| Tier | Exact peaks | Focused lanes | Labels |
| --- | ---: | ---: | ---: |
| High | 18,000 | 48 | 126 |
| Medium | 10,000 | 32 | 78 |
| Low | 3,600 | 20 | 44 |

Kept exact peaks are selected deterministically by required state, rating,
date, and opaque match ID. A locked, hovered, playback-current, or pinned
match survives an ordinary cap even when it falls outside active filters. The
global chronology intentionally reports zero omitted promotion lanes because
it does not create them. Focused views disclose summarized peaks and omitted
lanes; search can still reach an omitted promotion.

In automatic quality mode, a frame-interval EMA over 30ms accumulates downgrade
pressure (faster above 50ms); 600ms of sustained pressure can step the renderer
down. An EMA below 17ms for 600 frames can step it up. Tier changes rebuild the
deterministic capped layout and DPR, not the canonical identity table. The
diagnostics-only override is intentionally not a normal reader control.

## Interaction, accessibility, and sharing

Pointer hover opens an evidence card for a peak, aggregate bin, or focused
coverage lane. An exact card can lock or pin the match, focus its peak, set comparison
A/B, open related Connectome or Morph Lab context, or copy a deep link. The
inspector’s exact-match ledger is a virtualized keyboard-accessible listbox;
selecting an item locks its canonical match and exposes available event,
location, participants, form, result, title, duration, and identifier fields.
Unavailable source fields remain “Not reported.”

The WebGL canvas is intentionally `aria-hidden`; an accompanying accessible
description states the axes, date/rating range, whether depth has a semantic
role, and the rail meaning.
Visible labels and the ledger provide non-canvas reading and keyboard paths.
On narrow screens, selecting a peak opens the inspector sheet, while controls,
details, and map are exposed as panel tabs. Global search occupies its own
mobile row and all four lens targets receive a 44px row; primary sheet actions
also retain 44px minimum targets.

Picking uses `InstancedMesh` raycasting first. A bounded screen-space fallback
handles deliberately thin spires (9px mouse, 13px pen, 20px touch) and prefers
an exact visible tip before a co-located aggregate hull. Aggregate raycasting
runs only if no exact candidate wins. Pointer motion replaces one pending pick,
so at most the final location is sampled per frame; camera dragging suppresses
picking and the final pointer is resampled when the drag ends. The diagnostic
records candidate count, source, duration, depth, normalized distance,
instance id, and hit/miss/suppression result.

One sticky hover controller owns canvas, label, card, and keyboard surfaces. It
uses a 110ms leave grace and two-frame canvas confirmation; crossing between
surfaces for the same stable id does not clear the card. Drag, pointer cancel,
blur, semantic generation change, context loss, lens exit, touch transition,
and disposal clear transient ownership. Locked inspector selection is separate
and persists.

Lens-scoped keyboard commands are `R` fit visible, `F` focus selection, `O` or
`1` return to the global time/rating chronology, `2` enter a valid selected career, `C` enter a
valid comparison, Space play/pause, brackets previous/next rated record, and
Escape clear hover, then lock, then ascend scope. Inputs, selects, editable
content, buttons, links, summaries, and tabs retain native ownership. Projected
labels use roving arrow-key focus without transferring focus when pooled labels
change identity.

The default global fit uses a near-frontal profile so chronology reads
left-to-right and rating reads vertically. Focused semantic views retain the
three-quarter perspective needed to separate context tracks. Camera actions
include fit-visible, focus-selection, and a top/analyst view.
Double-clicking a match focuses it. The active shared timeline can ignite
visual pulses for its rated canonical events; this does not create records or
alter their ratings. Reduced-motion mode lands transitions immediately and
clears pulses.

Ratings URL state uses `rtv=1`. Its stable fields are:

| Field(s) | Meaning |
| --- | --- |
| `rtm`, `rts`, `rtid` | layout mode, stable scope id, stable selected match id |
| `rtmin`, `rtmax`, `rtth` | rating range and threshold plane |
| `rtord`, `rtcov`, `rtctx` | focused lane order, coverage minimum, focused context amount |
| `rttr`, `rtag`, `rtex` | trend, aggregates, and exact visibility |
| `rtpr`, `rtform`, `rtppv`, `rttm`, `rttc`, `rtexd`, `rtapx` | evidence filters |
| `rta`, `rtb` | comparison A/B stable ids |
| `rtsheet` | mobile Layout/Details/Map state |
| `rtcx`, `rtcy`, `rtcz`, `rtd`, `rtaz`, `rtel` | bounded user-touched camera |

Cold and same-document warm restores wait for lazy data before validating ids.
Unknown, malformed, stale, or out-of-range values are ignored or bounded rather
than restored to a different entity. An incoming pasted/back-forward fragment
cancels the pending shared URL write, and a delayed writer always serializes
the currently active lens, so outgoing ratings state cannot overwrite it.

## Projection contract

The consumer accepts only `schema_version: "2.0.0"` and
`projection_version: "meltzer-ratings@2"`; it verifies file byte lengths,
manifest validation, and SHA-256 checksums before rendering. The full
authoritative wire specification is
[MATERIALIZED-FORMAT.md](../packages/graph-contract/MATERIALIZED-FORMAT.md#ratings-projection--ratings-meltzer-ratings2).

All binary values are little-endian; dates are days since 1900-01-01;
dictionary IDs are opaque lexicographically ordered strings. Ratings files:

```
ratings/
  manifest.json       schema, source binding, counts, checksums, validation
  dictionaries.json   forms and match/person/promotion/title/event dictionaries
  matches.bin         exact rated canonical matches
  participants.bin    packed participant dictionary indexes
  titles.bin          packed complete canonical title indexes
  coverage.bin        sparse all-canonical denominators
  lod.bin             sparse direct-sample global/promotion aggregates
  histograms.json     exact reported-value counts, globally and by year
```

`matches.bin` has a fixed **48-byte** record layout:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | i32 | `day` |
| 4 | f64 | `rating` |
| 12 | u32 | promotion dictionary index |
| 16 | u32 | participant packed-array offset |
| 20 | u16 | participant count |
| 22 | u16 | flags: PPV, approximate date, title, title change, placement |
| 24 | u16 | form dictionary index |
| 26 | u16 | canonical card/event dictionary index |
| 28 | i32 | legacy first title index, or `-1` |
| 32 | i32 | placement, or `-1` |
| 36 | u32 | rated-match dictionary index |
| 40 | u32 | complete-title packed-array offset |
| 44 | u16 | complete-title count |
| 46 | u16 | reserved, always zero |

`participants.bin` and `titles.bin` hold four-byte `u32` dictionary indexes.
The title range preserves canonical `ts` order; the legacy title field is its
first element or `-1`. `coverage.bin` is 28 bytes per global, promotion,
person, or title period row at year/quarter/month resolution. `lod.bin` is 72
bytes per global/promotion period row and stores direct min/max/sum/median,
threshold counts, and all-match/rated denominators. Sparse absence means no
canonical record for the subject/period, not a known zero rating.

The projection’s deterministic `built_at` is the latest canonical date at
midnight UTC, rather than build-wall-clock time. Its source-manifest checksum
normalizes the canonical manifest’s top-level `built_at`, so an unchanged
corpus can rebuild byte-identically. The manifest also states the exact rating
value range, overall rated/all-documented coverage, the number of promotions
with at least one reported rating, and the calendar month widths and wire codes
for year, quarter, and month aggregate bins. The validator re-derives and
compares each field; a disagreement prevents the browser from rendering.

## Build, validation, release, and QA

Run the normal materialization pipeline to create the ratings projection:

```bash
pnpm data:materialize
pnpm ratings:validate
pnpm test:py
```

`pnpm ratings:materialize` is available for the projection entry point, but
the full materializer is the normal release path. Ratings data is generated
only from canonical materialized timeline inputs. It is neither source data
nor committed repository content.

Browser coverage includes lazy loading and exact-ledger selection, filtering,
promotion/career/title/compare transitions, mobile and reduced-motion paths,
deep links, keyboard ownership, screenshot routing, WebGL creation failure
with Retry, context loss/restoration, and lens ownership. The dedicated QA
tools capture the required desktop/mobile evidence matrix, record human-review
journeys, and measure real rendered frame cadence and exact picking. They can
reject a software WebGL renderer when hardware proof is required:

```bash
node tests/ratings-qa.mjs /tmp/kayfabe-ratings-qa
node tests/ratings-recordings.mjs /tmp/kayfabe-ratings-recordings
node tests/ratings-performance.mjs
```

`QA_PERF_FRAMES` can shorten or lengthen the default 180-frame performance
window. Software renderers still enforce exact-pick identity but report frame
budgets rather than pretending they are hardware measurements;
`QA_REQUIRE_HARDWARE=1` makes software rendering a hard failure.

The global Screenshot action routes to the active ratings WebGL canvas and
adds a 44px metadata strip containing lens, date range, rating filter, rated
count, all-documented denominator, coverage, and selected scope. It never
captures the parked Connectome canvas.

For adversarial QA, `window.__kayfabeRatings` exposes the semantic mode and
tier; frame interval and renderer CPU EMAs; exact, aggregate, lane, and label
accounting; selection/hover/threshold/coverage/range state; transition progress;
`currentPositionOfMatch(id)`; full pick diagnostics; camera snapshot; draw,
triangle, point, geometry, texture, and context state; decode/layout duration
and long-task counts; plus `screenshot()`, `fit()`, and `focusSelection()`.
It exposes stable ids and aggregate diagnostics, not private source records.

For GitHub Pages, `scripts/deploy-pages.sh` requires a clean committed tree
and an existing `data/materialized/` corpus, builds the web app, stages the
materialized data, and blocks credential-shaped values and raw source HTML
before pushing the public artifact. It therefore publishes this generated
projection only as part of the reviewed materialized corpus.
