# Geographic visual encodings

Every mark on the globe and what it is allowed to mean. Nothing here is
decorative; a size or colour that encodes nothing is a size or colour that
misleads.

## Palette

| mark | colour | meaning |
|---|---|---|
| beacon core | cool white-cyan | a documented card is playing here |
| ripple | blue | the same card, expanding — motion only |
| light column | blue | the same card, height by metric |
| **gold** core + ring | gold | **a documented title change on this card** |
| arc | dim slate | consecutive plotted records — a record sequence |
| heat | blue → red | accumulated weight at this place |
| selection | ember | the selected place |

Gold is reserved for evidence-backed title changes and nothing else. A card
gets gold treatment only when its `titleChangeCount > 0` in the canonical
corpus. The csv corpus carries no title-change flag at all, so csv-sourced
cards never receive gold — that is a source limitation, not a rendering choice,
and it is stated in the corpus documentation.

## Beacon energy

Beacon size and brightness encode the metric the reader chose (cards, matches,
wrestlers, title matches, title changes), never a random value. The legend in
the transport bar names the active encoding.

Energy is `min(1, sqrt(raw / 18))`. The square root is load-bearing: card sizes
are extremely long-tailed, and a linear ramp would make a 40-match supercard
enormous while leaving a 4-match house show invisible.

Repeat hits on one place while its beacon is still alight **re-energise the
existing beacon** rather than stacking a second identical dot on one pixel.

## Heat ramp

`heatColor(t)` interpolates blue → **red** over `sqrt(t)`. The high end is red
rather than amber deliberately: heat and title-change gold appear together
constantly, and an amber high end is close enough to gold that a dense city
reads as a title change. Gold has to stay the one thing that means a documented
title change.

The ramp is square-rooted for the same reason as beacon energy: Korakuen Hall
holds 2,402 cards while the median place holds four, so a linear ramp would
leave every place but a handful black.

A place in scope with **zero** weight still draws, faintly. That keeps it
clickable and shows the scope's reachable geography without claiming activity
there.

## Arcs mean one thing

An arc joins **consecutive plotted records in the selected scope**. It is not a
tour route, not a travel path, and not evidence that anyone went directly
between the two cities. The UI labels it "record sequence" wherever it appears.

Two safeguards are structural, not stylistic:

* cards sharing a date never join — the source records a date, not a show time,
  so ordering same-day cards would invent a journey out of a scheduling
  coincidence;
* the arc layer is capped and short-lived, so a long playback never leaves
  thousands of permanent lines behind.

## Afterglow

| mode | behaviour |
|---|---|
| none | no accumulation; the heat layer is hidden |
| short / long trail | beacons decay, nothing accumulates |
| accumulate | every processed card adds weight permanently |
| sliding window | weight is recomputed over the last N years of playback |

Accumulated weight comes from the scheduler's exact per-place counters, not
from what happened to be drawn.

## Labels

Priority order: the current event's location, then the selected place, then
pinned places, then the scope's heaviest places. The budget is small on purpose
(8–22 by quality tier). Labels fade with distance so the far side of the globe
does not show its names through the earth.

## Reduced motion

Reduced motion preserves every analytical function and removes only movement:

| normal | reduced |
|---|---|
| expanding ripple | none |
| rising light column | none |
| camera flight | instant `setView` step |
| beacon decay | halved duration |
| travelling arc | static, longer-lived |

Automatic camera follow is off by default in reduced motion, and the full card
readout, all counters and the inspector are unchanged. The
Playwright reduced-motion journey asserts that ripple and column counts are
exactly zero while the record still advances.

## Quality tiers

Tiers cap **visual budgets only**: active beacons, rings, columns, arcs,
labels, heat points, effect durations, atmosphere, resolution scale.

Analytical counts — cards processed, matches represented, unique places, title
changes — are computed by the scheduler, which never consults the tier. Lowering
quality can change how the globe looks; it can never change a number the
inspector reports.

| tier | beacons | rings | columns | arcs | labels | heat |
|---|---|---|---|---|---|---|
| high | 220 | 120 | 90 | 260 | 22 | 2,600 |
| medium | 130 | 60 | 48 | 150 | 14 | 1,600 |
| low | 70 | 0 | 0 | 70 | 8 | 900 |

If a scope's place count exceeds the heat cap, the densest places are drawn and
the remainder is reported as truncated rather than silently omitted.

## Basemap

Natural Earth II, bundled inside the `cesium` npm package, darkened through the
imagery layer's own colour controls (`brightness 0.32`, `saturation 0.22`,
`contrast 1.3`, `gamma 0.62`) into an archival register: dark oceans, land
present but subdued, nothing competing with the beacons.

No CDN, no API key, no Ion token, no metered tiles, no 3D buildings, no
photorealistic tiles, and no day/night terminator — these records span eighty
years, and lighting the globe by today's sun would dim half of them for no
reason.

Required attribution — Natural Earth II via CesiumJS, and GeoNames CC BY 4.0
for every plotted coordinate — is placed **on screen**, not folded into
Cesium's expandable lightbox.

## Layout

GEO carries more panels than the connectome (scope, range, playback, globe,
keyboard, match beats, footprint, comparison), so its rails scroll rather than
squashing a fixed-height flex column — squashing clipped the scope summary and
overlapped the globe controls. Place names are ellipsised rather than wrapped:
"Los Angeles, California, United States" over four lines makes a top-ten list
unreadable in a 250 px rail.

The lens switcher gained a third button, which pushed the topbar's nowrap
children past 1440 px and made the document wider than the viewport — that in
turn pushed the absolutely-positioned inspector off screen. The corpus counts
now hide below 1600 px, and `.app` clips horizontal overflow so no future
addition can do the same thing silently.
