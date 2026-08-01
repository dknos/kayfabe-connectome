# Geographic algorithms

How a source location string becomes a coordinate, and what each verdict is
allowed to claim. Companion documents: `GEO-DATA-QUALITY.md` (what the corpus
could and could not resolve), `GEO-PROJECTION.md` (the wire format),
`GEO-VISUAL-ENCODINGS.md` (what the globe draws), `GEO-PERFORMANCE.md`.

## The surface is not the 687-row Locations table

The specification assumed the geographic surface was the sqlite `Locations`
table: 687 rows of `"City, Region"`. That table covers **14,398 of 54,138
cards**. The other **39,740** are csv cards whose location is a `(Venue, City)`
pair where the city is **bare** — no region, no country.

Measured before any resolver existed (`pnpm geo:doctor`):

| | distinct location strings | cards |
|---|---|---|
| sqlite `City, Region` | 674 | 14,398 |
| csv `Venue, City` | 5,226 | 39,740 |
| **total** | **5,900** | **54,138** |

Card-weighted cumulative coverage over those 5,900 strings:

| target | distinct strings needed |
|---|---|
| 50% of cards | 194 |
| 75% | 793 |
| 90% | 2,116 |
| 95% | 3,284 |
| **98%** | **4,818** |

That measurement decided the design. A hand-authored override list could never
reach 98% — 4,818 reviewed rows is not a review queue, it is a second corpus.
Automated gazetteer resolution is mandatory; manual review is for the head and
for whatever the automation cannot settle.

## Why the ladder differs from the specification

The spec's ladder resolves on `city + region + country`. Two thirds of this
corpus has none of region or country. What it *does* have is a **venue**, and a
venue name is near-unique to a place: 5,379 distinct venues over 6,075 distinct
`(city, venue)` pairs. "Korakuen Hall" is always Tokyo. "London" is three
countries.

So two rungs are added above the spec's steps, and both are documented as
deviations:

1. a reviewed **venue registry**, and
2. a **promotion-country prior**.

The prior **constrains candidates and never selects one**. Promotions tour:
WWE runs Tokyo, NJPW runs Long Beach, CMLL runs Tokyo. A match reached through
the prior is recorded as `probable`, never `confirmed`.

## The ladder

Highest precedence first. The first rung that yields a decisive answer wins.

| | rung | source | verdict | confidence |
|---|---|---|---|---|
| R0 | manual override | `config/geo/location-overrides.csv` | confirmed | 1.00 |
| R1 | reviewed venue registry | `config/geo/venue-places.csv` | confirmed | 0.97 |
| R2 | city + region → admin-1, unique in that admin-1 | gazetteer | confirmed | 0.95 |
| R3 | city + region → country, unique in that country | gazetteer | confirmed | 0.90 |
| R4 | city already **confirmed** from the sqlite side | this run | probable | 0.85 |
| R5 | unique inside the promotion-country prior set | gazetteer | probable | 0.80 |
| R5a | unique inside the promotion's **home** country | gazetteer | probable | 0.72 |
| R6 | globally unique name | gazetteer | probable | 0.75 |
| R7 | population dominance ≥ 8× runner-up | gazetteer | probable | 0.65 |
| — | otherwise | | ambiguous / unresolved | 0 |

`ambiguous` and `unresolved` both end with **null coordinates**. They are
counted, reported in the review queue, shown in the UI, and never plotted,
never snapped to 0,0, never dropped from a total.

### R4, cross-family

The sqlite side has regions. When `"Philadelphia, Pennsylvania"` resolves
confirmed, the bare csv `"Philadelphia"` can borrow that verdict — but only if
**exactly one** confirmed reading of that name exists. Two means the name is
genuinely ambiguous and borrowing would launder a guess into a fact.

### R5a, home country

Narrower than the full prior and it **requires uniqueness**. A UK promotion's
"Manchester" is Manchester, England, because the UK holds exactly one. A US
promotion's "London" stays ambiguous, because the US holds several.

### R7, population dominance

8× is deliberately conservative. London GB beats London ON by 23× and resolves.
Springfield MO beats Springfield IL by 1.5× and goes to review. Inside a
promotion's prior country set the threshold loosens to **3×**, because the
wrong-country candidates are already gone and the remaining contest is between
same-country namesakes: Newark NJ over Newark OH is 6× and resolves; Springfield
MO over Springfield IL is still 1.5× and still does not.

A candidate under 20,000 population never wins on dominance at all — below
that, population is noise.

## The gazetteer, and a correctness hazard in it

Source: **GeoNames** (<https://www.geonames.org>), CC BY 4.0. Attribution is
carried in the geo manifest and shown on screen in the GEO lens, not only here.

Three name indexes, **consulted in order and never pooled**:

1. `cities500` primary names (`name`, `asciiname`) — 235,092 places
2. per-country dumps (`JP GB CA DE MX US`), primary names, populated places only
3. alternate names, from either file

**Why they are never pooled.** GeoNames' `alternatenames` column is
community-maintained and contains outright errors. Lake Charles, Louisiana
lists `"Charlestown"`. Taguig, Philippines lists `"Santa Ana"`. Asheville,
North Carolina lists `"Morristown"`. Pooled with primary names, a populous
impostor can win the population-dominance test and produce a **confidently
wrong coordinate**. Separated, an exact primary-name match always wins, and an
alternate-name match is flagged, penalised 0.15 confidence, and can never be
`confirmed`.

Tier 2 exists because the per-country dumps carry the wards and districts that
host shows and that `cities500` omits — Hakata and Kokura (wards of Fukuoka and
Kitakyushu), Ybor City (a district of Tampa). Half the unresolved Japanese
cards were there. Lower tiers are consulted only when a higher one gives no
decisive answer, so adding a tier can only **add** coverage, never remove it.

Country dumps are filtered to feature class `P` (populated places): a river
named "Tokyo" must never be a candidate for a city named Tokyo.

## Normalization

`fold()` is the match key: NFKD accent-fold, lowercase, punctuation-strip,
whitespace-collapse, then expand the abbreviations that differ between sources
(`St.` → `saint`, `Ft.` → `fort`, `Mt.` → `mount`, `Ste.` → `sainte`,
`Pt.` → `port`). `"St. Louis"`, `"St Louis"` and `"Saint Louis"` all collapse
to one key; `"México"` and `"Mexico"` do too.

Venue parsing strips two things before matching:

* the parenthetical rename history —
  `"2300 Arena (AKA ECW Arena/Asylum Arena/…)"` matches as `"2300 Arena"`, and
  the parenthetical becomes an alias list;
* a trailing hall number — `"Ishikawa Industrial Exhibition Hall #3"` and
  `"… #1"` are halls of one complex and therefore one place.

Location keys are `sql:<location_id>` and `csv:<venue>\x1f<city>`. The unit
separator is `\x1f` so a venue containing commas, pipes or colons cannot forge
a key boundary. Overrides may spell that separator as `|` for hand editing.

## Configuration format

`config/geo/*.csv`, not YAML. The materializer is stdlib-only by contract
(`docs/ARCHITECTURE.md`) and the Python standard library has no YAML reader.
The content is the same; the encoding is CSV. Files:

| file | purpose |
|---|---|
| `location-overrides.csv` | reviewed verdict for one source location key |
| `venue-places.csv` | reviewed venue → place (137 rows) |
| `promotion-country.csv` | promotion → ordered candidate countries |
| `region-aliases.csv` | region names the gazetteer spells differently |
| `country-aliases.csv` | country short forms in the region slot |
| `location-aliases.csv` | corrected city spellings (typos, old names) |
| `resolved-places.json` | **generated**, committed, the only geographic input downstream |

## Determinism and the offline boundary

Exactly one command touches the network:

```
pnpm geo:gazetteer:fetch     # explicit, one-time, writes to a gitignored dir
pnpm geo:doctor              # audit; no network
pnpm geo:resolve             # needs the gazetteer; no network
pnpm geo:review              # renders the review queue; no network
pnpm geo:materialize         # reads ONLY config/geo/resolved-places.json
pnpm geo:validate            # 34 checks against the canonical corpus
```

`geo:materialize` never reads the gazetteer. A fresh clone rebuilds the whole
geographic projection from the two source corpora plus the committed
`resolved-places.json` — no 100 MB download, no network, and no test run ever
contacts a geocoding service.

Everything is sorted, keyed and rounded deterministically. Cards sort by
`(date, card id AS A STRING)`: csv ids like `c:c1773` are `NaN` under a numeric
sort, and a mixed numeric sort silently reorders the entire csv half of the
corpus.

## What a coordinate is allowed to claim

Every plotted coordinate is **city-level** unless a reviewed row supplied a
venue coordinate (none do yet). The globe shows the town a show is documented
in, never the building. Labels in the UI say so.

Language used, and language deliberately not used:

| used | never used |
|---|---|
| documented card location | venue (unless venue-level) |
| documented show footprint | tour route, travel route |
| first / latest known card here | debut city, final match location |
| city-level coordinate | actual travel distance |
| chronological record connection | territorial control, headquarters |
| computed centre of documented cards | home city, roster location |
