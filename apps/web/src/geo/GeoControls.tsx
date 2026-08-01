import { useStore } from "../state/store";
import { GeoShortcuts } from "./GeoAnnouncer";
import { GeoScopePicker } from "./GeoScopePicker";
import {
  CALENDAR_SPEEDS, RECORD_SPEEDS, dayToIso, scheduler, useGeo,
} from "./geoStore";
import type { AfterglowMode, CameraMode } from "@kayfabe/geo-renderer";
import type { ClockKind, HeatMetric, PlaybackUnit } from "./geoTypes";

const CAMERA_MODES: Array<[CameraMode, string]> = [
  ["world", "World overview"],
  ["smart", "Smart follow"],
  ["follow", "Follow event"],
  ["tour", "Tour"],
  ["free", "Free camera"],
];
const AFTERGLOW: Array<[AfterglowMode, string]> = [
  ["none", "None"],
  ["short", "Short trail"],
  ["long", "Long trail"],
  ["accumulate", "Accumulate"],
  ["window", "Sliding window"],
];
const METRICS: Array<[HeatMetric, string]> = [
  ["cards", "Cards"],
  ["matches", "Matches"],
  ["people", "Wrestlers"],
  ["titleMatches", "Title matches"],
  ["titleChanges", "Title changes"],
];

export function GeoControls() {
  const g = useGeo();
  const reducedMotion = useStore((s) => s.reducedMotion);
  const emit = (window as any).__kayfabeGeoEmit as ((i: any[]) => void) | undefined;

  const step = (fn: "stepCard" | "stepBatch" | "nextNewPlace" | "nextTitleChange") => {
    const b = scheduler?.[fn]();
    if (b) emit?.(b.intents);
    else useGeo.getState().syncFromScheduler();
  };

  const speeds = g.clock === "calendar" ? CALENDAR_SPEEDS : RECORD_SPEEDS;
  const range = g.data?.manifest.day_range ?? [0, 0];

  return (
    <aside className="rail left" aria-label="Geographic controls">
      <section className="panel">
        <h2>Scope <i className="line" /></h2>
        <GeoScopePicker />
      </section>

      <section className="panel">
        <h2>Date range <i className="line" /></h2>
        <div className="row">
          <label htmlFor="geo-dmin">From</label>
          <input
            id="geo-dmin" type="range" min={range[0]} max={range[1]} value={g.dayMin}
            onChange={(e) => void g.setRange(Number(e.target.value), g.dayMax)}
          />
          <span className="num micro">{dayToIso(g.dayMin)}</span>
        </div>
        <div className="row">
          <label htmlFor="geo-dmax">To</label>
          <input
            id="geo-dmax" type="range" min={range[0]} max={range[1]} value={g.dayMax}
            onChange={(e) => void g.setRange(g.dayMin, Number(e.target.value))}
          />
          <span className="num micro">{dayToIso(g.dayMax)}</span>
        </div>
      </section>

      <section className="panel">
        <h2>Playback <i className="line" /></h2>
        <div className="row">
          <button
            aria-label={g.playing ? "Pause" : "Play"}
            className={g.playing ? "active" : ""}
            onClick={() => g.setPlaying(!g.playing)}
            disabled={!g.scopeIndices.length}
          >
            {g.playing ? "Pause" : "Play"}
          </button>
          <button aria-label="Previous card" onClick={() => {
            scheduler?.seek(Math.max(0, g.cursor - 1));
            useGeo.getState().syncFromScheduler();
          }}>◀ card</button>
          <button aria-label="Next card" onClick={() => step("stepCard")}>card ▶</button>
          <button aria-label="Next date batch" onClick={() => step("stepBatch")}>date ▶▶</button>
        </div>
        <div className="row">
          <button aria-label="Jump to next new city" onClick={() => step("nextNewPlace")}>
            next new city
          </button>
          <button aria-label="Jump to next title change" onClick={() => step("nextTitleChange")}>
            next title change
          </button>
          <button aria-label="Restart scope" onClick={() => { g.restart();
            (window as any).__kayfabeGeo?.clearTransient();
            (window as any).__kayfabeGeo?.resetHeat(); }}>restart</button>
        </div>
        <div className="row">
          <label htmlFor="geo-clock">Clock</label>
          <select
            id="geo-clock" value={g.clock}
            onChange={(e) => g.setClock(e.target.value as ClockKind)}
          >
            <option value="calendar">Calendar time</option>
            <option value="record">Record time</option>
          </select>
        </div>
        <div className="row">
          <label htmlFor="geo-speed">Speed</label>
          <select
            id="geo-speed" value={g.speed}
            onChange={(e) => g.setSpeed(Number(e.target.value))}
          >
            {speeds.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        <div className="row">
          <label htmlFor="geo-unit">Granularity</label>
          <select
            id="geo-unit" value={g.unit}
            onChange={(e) => g.setUnit(e.target.value as PlaybackUnit)}
          >
            <option value="card">Cards / shows</option>
            <option value="match">Match beats</option>
            <option value="day">Daily batches</option>
          </select>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={g.loop} onChange={(e) => g.setLoop(e.target.checked)} />{" "}
            Loop
          </label>
        </div>
        {g.clock === "record" && (
          <p className="derivation-note micro">
            Same-day ordering follows source record order — the corpus records a date for each
            card, not a show time.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Globe <i className="line" /></h2>
        <div className="row">
          <label htmlFor="geo-camera">Camera</label>
          <select
            id="geo-camera" value={g.camera}
            onChange={(e) => g.setCamera(e.target.value as CameraMode)}
          >
            {CAMERA_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="row">
          <button onClick={() => (window as any).__kayfabeGeo?.worldView()}>Return to world</button>
          <button onClick={() => (window as any).__kayfabeGeo?.fitPlaces(g.scopePlaces)}>
            Fit active
          </button>
          {g.selectedPlace >= 0 && (
            <button onClick={() => (window as any).__kayfabeGeo?.focusPlace(g.selectedPlace)}>
              Focus city
            </button>
          )}
        </div>
        <div className="row">
          <label htmlFor="geo-afterglow">Afterglow</label>
          <select
            id="geo-afterglow" value={g.afterglow}
            onChange={(e) => g.setAfterglow(e.target.value as AfterglowMode)}
          >
            {AFTERGLOW.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {g.afterglow === "window" && (
          <div className="row">
            <label htmlFor="geo-window">Window</label>
            <input
              id="geo-window" type="range" min={1} max={25} value={g.windowYears}
              onChange={(e) => g.setWindowYears(Number(e.target.value))}
            />
            <span className="num micro">{g.windowYears}y</span>
          </div>
        )}
        <div className="row">
          <label htmlFor="geo-metric">Metric</label>
          <select
            id="geo-metric" value={g.heatMetric}
            onChange={(e) => g.setHeatMetric(e.target.value as HeatMetric)}
          >
            {METRICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox" checked={g.showArcs}
              onChange={(e) => g.setShowArcs(e.target.checked)}
            />{" "}
            Chronological record arcs
          </label>
        </div>
        {g.showArcs && (
          <p className="derivation-note micro">
            An arc joins consecutive plotted records in this scope. It is a record sequence, not a
            travel route — same-day cards are never joined.
            {g.clock === "record" && g.speed > 12
              ? " Suppressed above 12 cards/s: one arc per card at that rate is a mesh, not an annotation."
              : ""}
          </p>
        )}
        {reducedMotion && (
          <p className="derivation-note micro">
            Reduced motion is on: ripples, arcs in flight and camera flights are replaced by
            instant highlights. Every count and readout stays available.
          </p>
        )}
      </section>

      <GeoShortcuts />
    </aside>
  );
}
