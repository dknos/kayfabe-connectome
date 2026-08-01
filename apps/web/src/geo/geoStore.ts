import { create } from "zustand";
import type { AfterglowMode, CameraMode, GeoPlace, QualityTier } from "@kayfabe/geo-renderer";
import { clampToRange, loadGeo, readCard, resolveScope, type GeoData } from "./geoAdapter";
import { GeoScheduler, type GeoCounters } from "./GeoScheduler";
import type { ClockKind, GeoCard, GeoScope, HeatMetric, PlaybackUnit } from "./geoTypes";

/**
 * GEO lens state.
 *
 * Kept in its own store so the connectome lens is untouched by geographic
 * concerns, but the two share canonical ids: a person selected in the
 * connectome is the same `p:` id the geo scope takes, so switching lens
 * carries the selection rather than resetting it.
 */

export const CALENDAR_SPEEDS = [
  { label: "1 day/s", value: 1 },
  { label: "1 week/s", value: 7 },
  { label: "1 month/s", value: 30 },
  { label: "3 months/s", value: 91 },
  { label: "1 year/s", value: 365 },
  { label: "5 years/s", value: 1826 },
];
export const RECORD_SPEEDS = [
  { label: "1 card/s", value: 1 },
  { label: "3 cards/s", value: 3 },
  { label: "10 cards/s", value: 10 },
  { label: "30 cards/s", value: 30 },
  { label: "100 cards/s", value: 100 },
];

export interface GeoState {
  data: GeoData | null;
  loading: boolean;
  error: string | null;

  scope: GeoScope;
  scopeIndices: number[];
  scopePlaces: number[];
  scopeTotals: GeoCounters | null;

  dayMin: number;
  dayMax: number;

  playing: boolean;
  clock: ClockKind;
  speed: number;
  unit: PlaybackUnit;
  loop: boolean;

  camera: CameraMode;
  afterglow: AfterglowMode;
  windowYears: number;
  heatMetric: HeatMetric;
  showArcs: boolean;
  tier: QualityTier;

  cursor: number;
  counters: GeoCounters | null;
  currentCard: GeoCard | null;
  currentBatch: GeoCard[];
  selectedPlace: number;
  /** A card the user opened from a city list — pins the inspector. */
  openedCard: GeoCard | null;
  /** Set when the visual budget grouped beacons, so the UI can say so. */
  aggregated: number;

  boot(): Promise<void>;
  setScope(scope: GeoScope, pairCardIds?: string[]): Promise<void>;
  setRange(dayMin: number, dayMax: number): Promise<void>;
  setPlaying(v: boolean): void;
  setClock(clock: ClockKind, speed?: number): void;
  setSpeed(v: number): void;
  setUnit(u: PlaybackUnit): void;
  setLoop(v: boolean): void;
  setCamera(m: CameraMode): void;
  setAfterglow(m: AfterglowMode): void;
  setWindowYears(y: number): void;
  setHeatMetric(m: HeatMetric): void;
  setShowArcs(v: boolean): void;
  setTier(t: QualityTier): void;
  selectPlace(idx: number): void;
  openCard(card: GeoCard | null): void;
  syncFromScheduler(): void;
  restart(): void;
}

/** The scheduler is a plain object, not state — it mutates every frame and
 * putting it through zustand would re-render the tree at 60 Hz. */
export let scheduler: GeoScheduler | null = null;

export const useGeo = create<GeoState>((set, get) => ({
  data: null,
  loading: false,
  error: null,

  scope: { kind: "corpus", ids: [], label: "Entire filtered corpus" },
  scopeIndices: [],
  scopePlaces: [],
  scopeTotals: null,

  dayMin: 0,
  dayMax: 0,

  playing: false,
  clock: "record",
  speed: 3,
  unit: "card",
  loop: false,

  camera: "world",
  afterglow: "accumulate",
  windowYears: 5,
  heatMetric: "cards",
  showArcs: false,
  tier: "high",

  cursor: 0,
  counters: null,
  currentCard: null,
  currentBatch: [],
  selectedPlace: -1,
  openedCard: null,
  aggregated: 0,

  async boot() {
    if (get().data || get().loading) return;
    set({ loading: true, error: null });
    try {
      const data = await loadGeo();
      scheduler = new GeoScheduler(data);
      set({
        data,
        loading: false,
        dayMin: data.manifest.day_range[0],
        dayMax: data.manifest.day_range[1],
      });
      await get().setScope(get().scope);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  async setScope(scope, pairCardIds) {
    const { data, dayMin, dayMax } = get();
    if (!data || !scheduler) {
      set({ scope });
      return;
    }
    const all = await resolveScope(data, scope, pairCardIds);
    const indices = clampToRange(data, all, dayMin, dayMax);
    scheduler.setScope(indices);
    set({
      scope,
      scopeIndices: indices,
      scopePlaces: scheduler.scopePlaces(),
      scopeTotals: scheduler.scopeTotals(),
      cursor: 0,
      counters: { ...scheduler.counters },
      currentCard: null,
      currentBatch: [],
      openedCard: null,
      aggregated: 0,
    });
  },

  async setRange(dayMin, dayMax) {
    set({ dayMin, dayMax });
    await get().setScope(get().scope);
  },

  setPlaying(playing) {
    set({ playing });
  },

  setClock(clock, speed) {
    const next = speed ?? (clock === "calendar" ? 30 : 3);
    set({ clock, speed: next });
    scheduler?.setClock(clock, next);
  },

  setSpeed(speed) {
    set({ speed });
    scheduler?.setClock(get().clock, speed);
  },

  setUnit(unit) {
    set({ unit });
  },
  setLoop(loop) {
    set({ loop });
  },
  setCamera(camera) {
    set({ camera });
  },
  setAfterglow(afterglow) {
    set({ afterglow });
  },
  setWindowYears(windowYears) {
    set({ windowYears });
  },
  setHeatMetric(heatMetric) {
    set({ heatMetric });
  },
  setShowArcs(showArcs) {
    set({ showArcs });
  },
  setTier(tier) {
    set({ tier });
  },

  selectPlace(selectedPlace) {
    set({ selectedPlace, openedCard: null });
  },

  openCard(openedCard) {
    set({ openedCard });
  },

  /** Pull the scheduler's exact counters into React state. Called on batch
   * boundaries, not per frame. */
  syncFromScheduler() {
    if (!scheduler) return;
    set({
      cursor: scheduler.position,
      counters: { ...scheduler.counters },
      currentCard: scheduler.currentCard(),
      currentBatch: scheduler.currentBatch(),
    });
  },

  restart() {
    scheduler?.reset();
    set({ cursor: 0, counters: scheduler ? { ...scheduler.counters } : null,
          currentCard: null, currentBatch: [], aggregated: 0 });
  },
}));

/** Resolve a card's display strings without keeping them in the hot record. */
export function cardStrings(data: GeoData, card: GeoCard): {
  promotion: string; eventName: string; date: string;
} {
  return {
    promotion: data.strings.promotionNames[card.promotionIdx] ?? "—",
    eventName: data.strings.eventNames[card.eventNameIdx] ?? "",
    date: dayToIso(card.day),
  };
}

export function promotionIdOf(data: GeoData, card: GeoCard): string {
  return data.strings.promotionIds[card.promotionIdx] ?? "";
}

const EPOCH = Date.UTC(1900, 0, 1);
export function dayToIso(day: number): string {
  const d = new Date(EPOCH + Math.round(day) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function placeOf(data: GeoData, idx: number): GeoPlace | null {
  return idx >= 0 ? (data.places[idx] ?? null) : null;
}

export { readCard };
