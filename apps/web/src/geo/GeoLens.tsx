import { useCallback, useEffect, useRef } from "react";
import type { ArcSpec, BeaconSpec, GeoReplayEngine, GeoPulseIntent } from "@kayfabe/geo-renderer";
import { useStore } from "../state/store";
import { scheduler, useGeo } from "./geoStore";
import type { GeoData } from "./geoAdapter";

/**
 * The globe surface. Owns the Cesium engine's lifetime and translates the
 * scheduler's semantic intents into beacons, arcs and camera moves.
 *
 * The Three.js connectome renderer is PAUSED (not disposed) while this lens is
 * mounted: two full-screen WebGL loops running at once is the one thing that
 * makes both feel broken, and pausing keeps the connectome's camera framing so
 * switching back is instant.
 */

/** Playback rate above which chronological arcs are suppressed. */
const ARC_MAX_RATE = 12;

/** Place rows for a set of indices, skipping any the projection does not
 * carry — a scope can never plot a place the places table lacks. */
function placesFor(data: GeoData, indices: number[]) {
  const out = [];
  for (const i of indices) {
    const p = data.places[i];
    if (p) out.push(p);
  }
  return out;
}

/** Beacon energy from the active metric, normalised against a soft ceiling.
 * Square-rooted because card sizes are long-tailed — a 40-match supercard
 * should read as bigger than a 4-match house show without making the house
 * show invisible. */
function energyOf(intent: GeoPulseIntent, metric: string): number {
  const raw =
    metric === "matches" ? intent.matchCount
      : metric === "people" ? intent.personCount
        : metric === "titleMatches" ? intent.titleMatchCount * 4
          : metric === "titleChanges" ? intent.titleChangeCount * 8
            : intent.matchCount;
  return Math.min(1, Math.sqrt(raw / 18));
}

export function GeoLens() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GeoReplayEngine | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  /** Last plotted place + batch, for chronological record arcs. */
  const lastArc = useRef<{ placeIdx: number; batchId: number } | null>(null);

  const data = useGeo((s) => s.data);
  const loading = useGeo((s) => s.loading);
  const error = useGeo((s) => s.error);
  const scopePlaces = useGeo((s) => s.scopePlaces);
  const playing = useGeo((s) => s.playing);
  const camera = useGeo((s) => s.camera);
  const afterglow = useGeo((s) => s.afterglow);
  const tier = useGeo((s) => s.tier);
  const selectedPlace = useGeo((s) => s.selectedPlace);
  const reducedMotion = useStore((s) => s.reducedMotion);

  useEffect(() => {
    void useGeo.getState().boot();
  }, []);

  // ---------- engine lifetime ----------
  useEffect(() => {
    const host = hostRef.current;
    if (!host || engineRef.current) return;
    let cancelled = false;
    let created: GeoReplayEngine | null = null;
    void (async () => {
      const { GeoReplayEngine: Engine } = await import("@kayfabe/geo-renderer");
      if (cancelled) return;
      created = await Engine.create(host, {
        reducedMotion: useStore.getState().reducedMotion,
        tier: useGeo.getState().tier,
        onPick: (placeIdx) => useGeo.getState().selectPlace(placeIdx ?? -1),
        onTierChange: (t) => useGeo.getState().setTier(t),
      });
      if (cancelled) {
        created.destroy();
        return;
      }
      engineRef.current = created;
      (window as { __kayfabeGeo?: GeoReplayEngine }).__kayfabeGeo = created; // QA seam
      const st = useGeo.getState();
      if (st.data) created.setPlaces(placesFor(st.data, st.scopePlaces));
    })();
    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
      created?.destroy();
      delete (window as { __kayfabeGeo?: GeoReplayEngine }).__kayfabeGeo;
    };
  }, []);

  // Suspend the connectome's render loop for as long as the globe is up.
  useEffect(() => {
    const three = (window as { __kayfabeRenderer?: { stop(): void; start(): void } })
      .__kayfabeRenderer;
    three?.stop();
    return () => three?.start();
  }, []);

  // ---------- scope -> places ----------
  useEffect(() => {
    const e = engineRef.current;
    if (!e || !data) return;
    e.setPlaces(placesFor(data, scopePlaces));
    lastArc.current = null;
    // World overview means the camera holds still while locations light
    // globally — auto-framing the new scope would contradict the mode the user
    // chose. "Fit active" is the explicit way to reframe.
    const mode = useGeo.getState().camera;
    if (mode !== "free" && mode !== "world") e.fitPlaces(scopePlaces.slice(0, 4000));
  }, [data, scopePlaces]);

  useEffect(() => {
    engineRef.current?.setCameraMode(camera);
  }, [camera]);
  useEffect(() => {
    engineRef.current?.setTier(tier);
  }, [tier]);
  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);
  useEffect(() => {
    engineRef.current?.selectPlace(selectedPlace);
    if (selectedPlace >= 0 && useGeo.getState().camera !== "free") {
      engineRef.current?.focusPlace(selectedPlace);
    }
  }, [selectedPlace]);
  useEffect(() => {
    // Switching afterglow mode must not leave the previous mode's glow behind.
    if (afterglow === "none") engineRef.current?.resetHeat();
    engineRef.current?.setHeatVisible(afterglow !== "none");
  }, [afterglow]);

  // ---------- emit one batch ----------
  const emit = useCallback((intents: GeoPulseIntent[], data_: GeoData) => {
    const e = engineRef.current;
    if (!e) return;
    const st = useGeo.getState();
    const specs: BeaconSpec[] = [];
    for (const it of intents) {
      if (it.placeIdx < 0) continue; // unresolved: counted upstream, never plotted
      const p = data_.places[it.placeIdx];
      if (!p) continue;
      specs.push({
        placeIdx: it.placeIdx,
        latitude: p.latitude,
        longitude: p.longitude,
        energy: energyOf(it, st.heatMetric),
        gold: it.titleChangeCount > 0,
        cardCount: 1,
        label: p.city ?? p.displayName,
      });
    }
    if (specs.length) e.pulse(specs);

    // Above this rate an arc per card is a mesh, not an annotation: at 100
    // cards/second a 2.6s arc life saturates the pool instantly and the globe
    // turns into spaghetti that communicates nothing. Beacons and the
    // accumulating footprint carry high-speed playback instead.
    const rate = st.clock === "record" ? st.speed : intents.length * 2;
    if (st.showArcs && rate <= ARC_MAX_RATE) {
      for (const it of intents) {
        if (it.placeIdx < 0) continue;
        const prev = lastArc.current;
        // Never connect two cards that share a date: the source records no
        // show times, so ordering them into a route would invent a journey.
        if (prev && prev.batchId !== it.batchId && prev.placeIdx !== it.placeIdx) {
          const a = data_.places[prev.placeIdx];
          const b = data_.places[it.placeIdx];
          if (a && b) {
            const arc: ArcSpec = {
              fromLat: a.latitude, fromLon: a.longitude,
              toLat: b.latitude, toLon: b.longitude,
              strength: 0.7,
            };
            e.addArc(arc);
          }
        }
        lastArc.current = { placeIdx: it.placeIdx, batchId: it.batchId };
      }
    }

    const last = intents[intents.length - 1];
    if (last && last.placeIdx >= 0) {
      const perSecond = st.clock === "record" ? st.speed : intents.length * 2;
      e.followEvent(last.placeIdx, perSecond);
      const p = data_.places[last.placeIdx];
      if (p) {
        const sel = st.selectedPlace >= 0 ? data_.places[st.selectedPlace] : undefined;
        e.setLabels([
          { placeIdx: last.placeIdx, latitude: p.latitude, longitude: p.longitude,
            text: p.city ?? p.displayName, priority: 100, gold: last.titleChangeCount > 0 },
          ...(sel && st.selectedPlace !== last.placeIdx
            ? [{
                placeIdx: st.selectedPlace,
                latitude: sel.latitude,
                longitude: sel.longitude,
                text: sel.city ?? sel.displayName,
                priority: 90,
              }]
            : []),
        ]);
      }
    }
    useGeo.getState().syncFromScheduler();
  }, []);

  // Expose the emitter so the controls can step without duplicating the
  // intent-to-visual translation.
  useEffect(() => {
    (window as any).__kayfabeGeoEmit = (intents: GeoPulseIntent[]) => {
      const d = useGeo.getState().data;
      if (d) emit(intents, d);
    };
    return () => { delete (window as any).__kayfabeGeoEmit; };
  }, [emit]);

  // ---------- playback loop ----------
  useEffect(() => {
    if (!playing || !data || !scheduler) return;
    lastRef.current = performance.now();
    const step = () => {
      const now = performance.now();
      const dt = Math.min(0.25, (now - lastRef.current) / 1000);
      lastRef.current = now;
      const batch = scheduler!.advance(dt);
      if (batch) emit(batch.intents, data);
      if (scheduler!.done) {
        const st = useGeo.getState();
        if (st.loop) {
          scheduler!.reset();
          engineRef.current?.clearTransient();
          if (st.afterglow !== "accumulate") engineRef.current?.resetHeat();
          lastArc.current = null;
        } else {
          st.setPlaying(false);
          return;
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, data, emit]);

  // Sliding window retires old heat; accumulate keeps it.
  useEffect(() => {
    if (afterglow !== "window" || !data || !scheduler) return;
    const id = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      const st = useGeo.getState();
      const cutoff = scheduler!.day - st.windowYears * 365.25;
      const w = new Float64Array(data.places.length);
      for (const idx of scheduler!.scopeIndices()) {
        const b = idx * data.stride;
        const day = data.cards[b] ?? 0;
        const place = (data.cards[b + 2] ?? 0) - 1;
        if (place >= 0 && day >= cutoff && day <= scheduler!.day) w[place]! += 1;
      }
      e.setHeatWeights(w);
    }, 400);
    return () => clearInterval(id);
  }, [afterglow, data]);

  return (
    <>
      <div ref={hostRef} className="geo-globe" data-testid="geo-globe" />
      {(loading || !data) && !error && (
        <div className="geo-boot micro" role="status">loading geographic projection…</div>
      )}
      {error && (
        <div className="geo-boot error-note" role="alert">
          {error}
          <div className="micro">run `pnpm geo:materialize` to build the geographic projection.</div>
        </div>
      )}
    </>
  );
}
