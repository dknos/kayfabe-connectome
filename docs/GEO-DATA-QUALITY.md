# Geographic data quality

What the corpus could be resolved to, what it could not, and what the numbers
are allowed to mean. Generated numbers come from `pnpm geo:validate` and
`data/materialized/geo/quality.json`; regenerate both before quoting them.

## Coverage, three ways

Row coverage alone is misleading. One unresolved `"Korakuen Hall, Tokyo"` costs
2,402 cards; fifty unresolved one-off towns cost fifty. So coverage is reported
against all three denominators, and the card-weighted figure is the one the UI
shows.

| | resolved | target | meets |
|---|---|---|---|
| source location rows | **90.73%** (5,352 of 5,900) | 95% | no |
| **cards** | **98.01%** (53,059 of 54,138) | 98% | **yes** |
| matches | **97.94%** (357,962 of 365,485) | 98% | marginally under |

The row target is not met and, given the source, is not reachable honestly. The
residual is a flat tail of one- and two-card towns whose bare names are
genuinely ambiguous: 443 ambiguous locations carry 839 cards between them —
under two cards each. Closing it would mean guessing which Springfield, and a
guess plotted on a globe is indistinguishable from a fact.

Match coverage sits 0.06 points under target for the same reason. Both shortfalls
are disclosed in the lens, not rounded away.

## Verdicts

| verdict | locations | cards | matches | plotted |
|---|---|---|---|---|
| confirmed | 740 | 15,898 | 98,363 | yes |
| probable | 4,613 | 37,161 | 259,599 | yes |
| ambiguous | 443 | 839 | 5,939 | **no** |
| unresolved | 85 | 145 | 964 | **no** |
| rejected | 19 | 95 | 620 | **no** |

* **confirmed** — a manual override, a reviewed venue, or a gazetteer match
  disambiguated by an explicit region.
* **probable** — resolved through a promotion prior, a globally unique name, a
  population dominance test, or a cross-family borrow. Defensible, not certain.
* **ambiguous** — several real candidates, none dominant. Candidates are
  recorded so a reviewer can settle it.
* **unresolved** — no gazetteer entry carries the name at all.
* **rejected** — the string names no place: `"Unknown, Unknown"`,
  `"Unknown Arena, Unknown"`, `"Unknown Connecticut Venue, Unknown"`.

The last three keep **null coordinates**. They are counted in every card,
match, title and participant total; they simply never light the globe. Nothing
is snapped to 0,0 and nothing is dropped — a validator asserts both.

## Coordinate precision

| precision | places |
|---|---|
| city | 2,158 |
| venue | 0 |

Every plotted coordinate is a **city centroid**. The corpus names venues, and
137 reviewed venue rows are used to decide *which town* a venue sits in, but no
row claims a building. Supplying a venue coordinate would promote a row to
venue precision; none do. The UI says "city-level coordinate" on every card.

## What is still unresolved

The largest single unresolved location carries 22 cards. The full ledger ships
as `data/materialized/geo/unresolved.json` and is browsable in the GEO table's
`unplotted` tab.

| location | cards | verdict |
|---|---|---|
| `Unknown, Unknown` | 22 | rejected — names no place |
| `Studio One Events LLC, Highland Park` | 19 | ambiguous — IL / NJ / MI |
| `Koga Municipal Gymnasium, Koga` | 17 | ambiguous — Koga Ibaraki vs Koga Fukuoka |
| `Unknown Connecticut Venue, Unknown` | 15 | rejected |
| `Ultraviolent Underground, Townsend` | 13 | ambiguous — DE / GB / MT |
| `Unknown Arena, Unknown` | 13 | rejected |
| `Biki Messe Shimane, Biki` | 8 | unresolved — no gazetteer entry |
| `Minami Move On Arena, Minami` | 8 | ambiguous |

Resolving one means adding a row to `config/geo/venue-places.csv` or
`config/geo/location-overrides.csv` and re-running `pnpm geo:resolve`. The
review queue at `data/staging/geo-review.html` ranks every open case by the
number of cards riding on it and shows the candidates that were weighed.

## Known limitations

* **The prior can be wrong.** A promotion that toured somewhere unusual, at a
  city name that also exists in its home country, can resolve to the home
  country. Such a match is `probable`, is listed in the review queue, and the
  inspector shows its confidence and rung.
* **Alternate-name matches are weaker than they look.** GeoNames alternates
  carry real errors (see `GEO-ALGORITHMS.md`). They are penalised and can never
  be `confirmed`, but they are still used when nothing better matches.
* **City centroids are not venues.** Two shows in the same metropolitan area at
  different buildings plot at one dot.
* **The basemap is modern.** Borders, place names and coastlines are current;
  the records span 1947–2026. A 1970s card in a city that has since been
  renamed or re-bordered plots at the modern location of the same place.
* **Sub-city wards resolve to their parent city.** Hakata plots as Fukuoka,
  Kokura as Kitakyushu, Ybor City as Tampa where the parent is what the
  gazetteer carries at city level.
* **Coverage is card-weighted by design.** A promotion whose cards concentrate
  in unresolved locations will show worse coverage than the corpus average; the
  scope summary reports its own unplotted count rather than the global one.

## Reproducing these numbers

```
pnpm geo:gazetteer:fetch      # once, ~100 MB, gitignored
pnpm geo:doctor               # the surface audit + coverage curve
pnpm geo:resolve              # verdicts -> config/geo/resolved-places.json
pnpm geo:review               # data/staging/geo-review.html
pnpm geo:materialize          # data/materialized/geo/
pnpm geo:validate             # 34 checks; prints the coverage report
```
