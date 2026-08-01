import { create } from "zustand";
import { dayToDate, isoToDay } from "@kayfabe/graph-contract";
import type { TimelineEvent } from "@kayfabe/graph-contract";
import { loadCore, loadYear, type CoreData } from "../data/loader";
import type { Tissue } from "@kayfabe/renderer";
import { GraphModel, type FilteredView, type Filters } from "../graph/model";

export type Lens = "connectome" | "table" | "geo" | "geoTable";
export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; edge: number }
  | null;
export type TimelineMode = "off" | "snapshot" | "accumulate" | "window" | "playback";
export type PathMode = "fewest" | "strongest" | "partners" | "opponents";

export interface TimelineState {
  mode: TimelineMode;
  day: number;
  windowDays: number;
  playing: boolean;
  speed: number; // days per second
}

interface AppState {
  core: CoreData | null;
  model: GraphModel | null;
  bootProgress: number;
  bootWhat: string;
  bootError: string | null;

  lens: Lens;
  filters: Filters;
  view: FilteredView | null;
  viewPending: boolean;

  selection: Selection;
  focusId: string | null;
  hoverId: string | null;
  pinned: string[];
  pathA: string | null;
  pathB: string | null;
  pathMode: PathMode;
  pathResult: { nodes: string[]; edges: number[] } | null;

  timeline: TimelineState;
  currentEvent: TimelineEvent | null;

  reducedMotion: boolean;
  announcement: string;
  /** Tissue treatment — a reading of the corpus, not a theme. */
  tissue: Tissue;
  showHaze: boolean;
  showLabels: boolean;

  boot(): Promise<void>;
  setLens(l: Lens): void;
  setFilters(patch: Partial<Filters>): void;
  applyView(): Promise<void>;
  select(s: Selection): void;
  focus(id: string | null): void;
  hover(id: string | null): void;
  togglePin(id: string): void;
  setPathEndpoint(which: "a" | "b", id: string | null): void;
  setPathMode(m: PathMode): void;
  runPath(): void;
  clearPath(): void;
  setTimeline(patch: Partial<TimelineState>): void;
  setCurrentEvent(ev: TimelineEvent | null): void;
  setReducedMotion(v: boolean): void;
  setTissue(t: Tissue): void;
  setShowHaze(v: boolean): void;
  setShowLabels(v: boolean): void;
  announce(msg: string): void;
}

const prefersReduced =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** all promotion bits set (named bits 0-29 + other bit 30; bit 31 unused to
 * stay positive in JS int32 bitwise ops) */
export const PROMO_ALL = 0x7fffffff;

let recomputeToken = 0;

export const useStore = create<AppState>((set, get) => ({
  core: null,
  model: null,
  bootProgress: 0,
  bootWhat: "",
  bootError: null,

  lens: "connectome",
  filters: {
    dayMin: 0,
    dayMax: 0,
    promoMask: PROMO_ALL,
    formMask: 0xff,
    showSame: true,
    showOpposed: true,
    showBr: true,
    minEncounters: 5,
  },
  view: null,
  viewPending: false,

  selection: null,
  focusId: null,
  hoverId: null,
  pinned: [],
  pathA: null,
  pathB: null,
  pathMode: "fewest",
  pathResult: null,

  timeline: { mode: "off", day: 0, windowDays: 365, playing: false, speed: 120 },
  currentEvent: null,

  reducedMotion: prefersReduced,
  announcement: "",
  tissue: "cortex",
  showHaze: true,
  showLabels: true,

  async boot() {
    try {
      const core = await loadCore((frac, what) =>
        set({ bootProgress: frac, bootWhat: what }),
      );
      const model = new GraphModel(core.nodes, core.edges, core.manifest);
      const [d0, d1] = model.fullDayRange;
      set((s) => ({
        core,
        model,
        filters: { ...s.filters, dayMin: d0, dayMax: d1 },
        timeline: { ...s.timeline, day: d1 },
      }));
      restoreFromUrl();
      await get().applyView();
      get().announce(
        `Loaded ${core.manifest.counts.people} people and ${core.manifest.counts.edges} relationships, ${core.manifest.date_range[0]} to ${core.manifest.date_range[1]}.`,
      );
    } catch (err) {
      set({ bootError: err instanceof Error ? err.message : String(err) });
    }
  },

  setLens(lens) {
    set({ lens });
    writeUrl();
    get().announce(
      lens === "table"
        ? "Accessible table view"
        : lens === "geo"
          ? "Geo Replay — territory globe"
          : lens === "geoTable"
            ? "Geo table view"
            : "Connectome view",
    );
  },

  setFilters(patch) {
    set((s) => ({ filters: { ...s.filters, ...patch } }));
    void get().applyView();
    writeUrl();
  },

  async applyView() {
    const { model, filters } = get();
    if (!model) return;
    const token = ++recomputeToken;
    if (model.isFullRange(filters)) {
      const view = model.filterAggregate(filters);
      if (token === recomputeToken) set({ view, viewPending: false });
      return;
    }
    set({ viewPending: true });
    const y0 = dayToDate(filters.dayMin).getUTCFullYear();
    const y1 = dayToDate(filters.dayMax).getUTCFullYear();
    const years: Promise<TimelineEvent[]>[] = [];
    for (let y = y0; y <= y1; y++) years.push(loadYear(y));
    const events = (await Promise.all(years)).flat();
    if (token !== recomputeToken) return;
    const view = model.filterFromRecords(filters, events);
    set({ view, viewPending: false });
    const g = get();
    g.announce(`${view.visibleNodeCount} entities, ${view.visible.length} relationships in range.`);
    if (g.pathResult) g.runPath();
  },

  select(selection) {
    set({ selection });
    writeUrl();
    const { model } = get();
    if (selection?.kind === "node" && model) {
      const i = model.indexOfId.get(selection.id);
      if (i !== undefined) get().announce(`Selected ${model.nodes.name[i]}`);
    } else if (selection?.kind === "edge" && model) {
      const a = model.nodes.name[model.edgeField(selection.edge, 0)];
      const b = model.nodes.name[model.edgeField(selection.edge, 1)];
      get().announce(`Selected relationship ${a} — ${b}`);
    }
  },

  focus(focusId) {
    set({ focusId });
    if (focusId) set({ selection: { kind: "node", id: focusId } });
    writeUrl();
  },

  hover(hoverId) {
    set({ hoverId });
  },

  togglePin(id) {
    set((s) => ({
      pinned: s.pinned.includes(id) ? s.pinned.filter((p) => p !== id) : [...s.pinned, id],
    }));
  },

  setPathEndpoint(which, id) {
    set(which === "a" ? { pathA: id } : { pathB: id });
    writeUrl();
  },

  setPathMode(pathMode) {
    set({ pathMode });
    if (get().pathResult) get().runPath();
  },

  runPath() {
    const { model, view, pathA, pathB, pathMode } = get();
    if (!model || !view || !pathA || !pathB) return;
    const pathResult = model.shortestPath(pathA, pathB, view, pathMode);
    set({ pathResult });
    get().announce(
      pathResult
        ? `Path found: ${pathResult.nodes.length - 1} hops — ${pathResult.nodes
            .map((id) => model.nodes.name[model.indexOfId.get(id) ?? -1] ?? id)
            .join(" → ")}`
        : "No path under the current filters.",
    );
  },

  clearPath() {
    set({ pathA: null, pathB: null, pathResult: null });
    writeUrl();
  },

  setTimeline(patch) {
    set((s) => ({ timeline: { ...s.timeline, ...patch } }));
    writeUrl();
  },

  setCurrentEvent(currentEvent) {
    set({ currentEvent });
  },

  setReducedMotion(reducedMotion) {
    set({ reducedMotion });
  },

  setTissue(tissue) {
    set({ tissue });
    writeUrl();
  },
  setShowHaze(showHaze) {
    set({ showHaze });
  },
  setShowLabels(showLabels) {
    set({ showLabels });
  },

  announce(announcement) {
    set({ announcement });
  },
}));

/* ---------- URL state (versioned, stable IDs) ---------- */

/** The GEO lens registers its own serialiser here rather than this module
 * importing geo state — the connectome must not depend on the globe. */
let geoUrlState: (() => Record<string, string | number | null>) | null = null;
let geoUrlRestore: ((kv: Map<string, string>) => void) | null = null;
export function registerGeoUrl(
  serialize: () => Record<string, string | number | null>,
  restore: (kv: Map<string, string>) => void,
): void {
  geoUrlState = serialize;
  geoUrlRestore = restore;
}

// v2: day numbers re-based to the 1900 epoch, promo bits widened — old
// v1 fragments are ignored safely rather than restored wrong.
const URL_VERSION = "2";
let urlWriteTimer: ReturnType<typeof setTimeout> | null = null;

export function writeUrl(): void {
  if (urlWriteTimer) clearTimeout(urlWriteTimer);
  urlWriteTimer = setTimeout(() => {
    const s = useStore.getState();
    if (!s.model) return;
    const p: string[] = [URL_VERSION];
    const push = (k: string, v: string | number | null | undefined) => {
      if (v !== null && v !== undefined && v !== "") p.push(`${k}=${encodeURIComponent(String(v))}`);
    };
    push("lens", s.lens !== "connectome" ? s.lens : null);
    push("tis", s.tissue !== "cortex" ? s.tissue : null);
    if (s.lens === "geo" || s.lens === "geoTable") {
      const g = geoUrlState?.();
      if (g) for (const [k, v] of Object.entries(g)) push(k, v);
    }
    push("focus", s.focusId);
    if (s.selection?.kind === "node") push("sel", s.selection.id);
    if (s.selection?.kind === "edge") push("sele", s.selection.edge);
    push("a", s.pathA);
    push("b", s.pathB);
    if (s.pathA && s.pathB) push("pm", s.pathMode);
    const [d0, d1] = s.model.fullDayRange;
    if (s.filters.dayMin !== d0) push("dmin", s.filters.dayMin);
    if (s.filters.dayMax !== d1) push("dmax", s.filters.dayMax);
    if (s.filters.promoMask !== PROMO_ALL) push("pr", s.filters.promoMask);
    if (s.filters.formMask !== 0xff) push("fm", s.filters.formMask);
    const rel = (s.filters.showSame ? 1 : 0) | (s.filters.showOpposed ? 2 : 0) | (s.filters.showBr ? 4 : 0);
    if (rel !== 7) push("rel", rel);
    if (s.filters.minEncounters !== 5) push("minE", s.filters.minEncounters);
    if (s.timeline.mode !== "off") {
      push("tm", s.timeline.mode);
      push("td", s.timeline.day);
      if (s.timeline.mode === "window") push("tw", s.timeline.windowDays);
    }
    history.replaceState(null, "", `#${p.join("/")}`);
  }, 150);
}

export function restoreFromUrl(): void {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return;
  const parts = hash.split("/");
  if (parts[0] !== URL_VERSION) return; // unknown version: ignore safely
  const kv = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) kv.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
  }
  const s = useStore.getState();
  const model = s.model;
  if (!model) return;
  const valid = (id: string | undefined): string | null =>
    id && model.indexOfId.has(id) ? id : null;

  const patch: Partial<Filters> = {};
  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const dmin = num("dmin");
  const dmax = num("dmax");
  if (dmin !== null) patch.dayMin = dmin;
  if (dmax !== null) patch.dayMax = dmax;
  const pr = num("pr");
  if (pr !== null) patch.promoMask = pr;
  const fm = num("fm");
  if (fm !== null) patch.formMask = fm;
  const rel = num("rel");
  if (rel !== null) {
    patch.showSame = !!(rel & 1);
    patch.showOpposed = !!(rel & 2);
    patch.showBr = !!(rel & 4);
  }
  const minE = num("minE");
  if (minE !== null) patch.minEncounters = minE;

  const lensParam = kv.get("lens");
  geoUrlRestore?.(kv);
  useStore.setState((prev) => ({
    lens:
      lensParam === "table" || lensParam === "geo" || lensParam === "geoTable"
        ? (lensParam as Lens)
        : "connectome",
    focusId: valid(kv.get("focus")),
    selection: valid(kv.get("sel"))
      ? { kind: "node", id: kv.get("sel")! }
      : num("sele") !== null && num("sele")! < model.edgeCount
        ? { kind: "edge", edge: num("sele")! }
        : null,
    pathA: valid(kv.get("a")),
    pathB: valid(kv.get("b")),
    pathMode: ["fewest", "strongest", "partners", "opponents"].includes(kv.get("pm") ?? "")
      ? (kv.get("pm") as PathMode)
      : prev.pathMode,
    tissue: ["cortex", "myelin", "deep"].includes(kv.get("tis") ?? "")
      ? (kv.get("tis") as Tissue)
      : prev.tissue,
    filters: { ...prev.filters, ...patch },
    timeline: {
      ...prev.timeline,
      mode: ["snapshot", "accumulate", "window", "playback"].includes(kv.get("tm") ?? "")
        ? (kv.get("tm") as TimelineMode)
        : "off",
      day: num("td") ?? prev.timeline.day,
      windowDays: num("tw") ?? prev.timeline.windowDays,
    },
  }));
}

export const fmtDay = (day: number): string => {
  const d = dayToDate(day);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};
export { isoToDay };
