# Geographic performance

## Shape of the problem

54,138 cards, 2,158 places, 365,485 matches, eighty years, and playback speeds
up to 100 cards/second. The bottleneck is never arithmetic — it is allocation
and buffer churn.

## Everything visual is pooled

Beacon cores, ripples, light columns, arcs and labels are allocated **once**
into fixed-size Cesium primitive collections and recycled through free lists.
Retiring a beacon means setting its alpha to zero and returning its slot.

At 100 cards/second an entity-per-card design spends its whole frame budget in
allocation and leaks GPU buffers on every scrub. Pools also make the visual
budget a hard number rather than a hope.

Pools only ever grow to the highest tier's cap; lower tiers leave the tail idle
rather than resizing, because resizing is the churn the design exists to avoid.

## Render on demand

`requestRenderMode` is on. The globe renders when something changes — a pulse,
an arc, a camera move, a resize, a pick. A paused, settled GEO lens issues no
frames at all. The animation loop runs only while a pooled item is still alive
or the camera is still flying, then stops itself.

A `ResizeObserver` calls `viewer.resize()` explicitly, because in
`requestRenderMode` Cesium only reconciles its drawing buffer during a render.

## One WebGL context

The Three.js connectome renderer is **paused and hidden**, not disposed, while
the globe is up:

* pausing alone leaves its last frame painted under the globe — hiding the
  canvas is what actually clears it;
* keeping it mounted preserves its camera framing and GPU buffers, so switching
  back is instant.

`GeoReplayEngine.lifecycle()` counts viewers created and destroyed at module
scope. A Playwright journey switches lenses three times and asserts
`created - destroyed === 1`, which is what catches a leaked viewer.

## Data budget

| file | size |
|---|---|
| `cards.bin` | 1.7 MB |
| `cards-strings.json` | 2.0 MB |
| `source-location-map.json` | 2.1 MB (lazy) |
| `places.json` | 340 KB |
| `scopes/` | 10 MB (lazy, per kind; people sharded 256 ways) |
| total | ~16 MB |

Loaded on demand: the geographic projection is fetched only when the GEO lens
first opens, so a reader who never opens it pays nothing. Scope indices load
per kind, person scopes per shard. Cesium itself is a 4.8 MB dynamic chunk
imported at the same moment.

## Typed arrays and index lists

Card records are decoded from a `Uint32Array` on demand — there is no array of
54,138 objects. A scope is a `number[]` of indices into that one table, so
switching scope allocates one list rather than rebuilding a corpus.

Accumulated heat is a `Float64Array` indexed by place.

## Visual aggregation, never analytical

When several cards land on one place in one tick, the renderer folds them into
one beacon and reports `intentsGrouped`. The scheduler has already counted
every underlying card, so grouping changes the picture and never the
arithmetic. `intentsDropped` must stay **0**; the Playwright journeys assert it.

## Camera

Automatic follow is suppressed above four events per second — a flight cannot
finish before the next event arrives, so following would only show a blur of
half-completed movements. Smart follow additionally skips hops under 12°, where
the next city is already on screen and moving reads as drift.

Manual input suspends automatic camera control for six seconds. A camera that
fights the reader is worse than one that never moves.

## Instrumentation

`window.__kayfabeGeo.stats()` reports active beacons, rings, columns, arcs,
labels and heat points; viewers created and destroyed; live WebGL contexts;
intents received, grouped and dropped; frame time; and the current tier.

## Measured

Headless runs use a software rasteriser, so the governor settles at `medium` or
`low` where a real GPU would hold `high`. Observed during the WWF journey at 3
cards/second, 1920×1080, swiftshader: frame time 16–64 ms, 1 WebGL context, 288
heat points, 0 intents dropped, 25 basemap requests and **0 offsite requests**.
