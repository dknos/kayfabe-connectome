import type { MorphView } from "@kayfabe/morph-renderer";
import { registerRatingsUrl, useStore, writeUrl } from "../state/store";
import { DEFAULT_RATING_CONTROLS, type RatingControlsState, type RatingLaneOrder } from "./layouts";
import { useRatings, type RatingsSheet } from "./ratingsStore";

const URL_VERSION = "1";
const LANE_ORDERS: RatingLaneOrder[] = ["stable", "rated", "total", "coverage", "median", "mean", "fourPlus", "fivePlus", "maximum", "alphabetical"];
const SHEETS: RatingsSheet[] = ["controls", "inspector", "map"];
let pending: Map<string, string> | null = null;
let installed = false;

function serialize(): Record<string, string | number | null> {
  const s = useRatings.getState();
  const c = s.controls;
  const f = c.filters;
  const out: Record<string, string | number | null> = { rtv: URL_VERSION };
  if (s.scope.mode !== "promotions") out.rtm = s.scope.mode;
  if (s.scope.id) out.rts = s.scope.id;
  if (s.selectedMatchId) out.rtid = s.selectedMatchId;
  if (f.ratingMin !== DEFAULT_RATING_CONTROLS.filters.ratingMin) out.rtmin = f.ratingMin;
  if (f.ratingMax !== DEFAULT_RATING_CONTROLS.filters.ratingMax) out.rtmax = f.ratingMax;
  if (c.threshold !== 5) out.rtth = c.threshold;
  if (c.laneOrder !== "stable") out.rtord = c.laneOrder;
  if (f.coverageMinimum > 0) out.rtcov = Math.round(f.coverageMinimum * 1000) / 1000;
  if (!c.showTrend) out.rttr = 0;
  if (!c.showAggregates) out.rtag = 0;
  if (!c.showExact) out.rtex = 0;
  if (c.context !== DEFAULT_RATING_CONTROLS.context) out.rtctx = Math.round(c.context * 1000) / 1000;
  if (f.promotionId) out.rtpr = f.promotionId;
  if (f.form !== "all") out.rtform = f.form;
  if (f.ppvOnly) out.rtppv = 1;
  if (f.titleMatchOnly) out.rttm = 1;
  if (f.titleChangeOnly) out.rttc = 1;
  if (!f.includeExactDates) out.rtexd = 0;
  if (!f.includeApproximateDates) out.rtapx = 0;
  if (s.compareA) out.rta = s.compareA;
  if (s.compareB) out.rtb = s.compareB;
  if (s.sheet !== "map") out.rtsheet = s.sheet;
  if (s.cameraTouched && s.camera) {
    const camera = s.camera;
    out.rtcx = round(camera.cx, 2);
    out.rtcy = round(camera.cy, 2);
    out.rtcz = round(camera.cz, 2);
    out.rtd = round(camera.distance, 2);
    out.rtaz = round(camera.theta, 4);
    out.rtel = round(camera.phi, 4);
  }
  return out;
}

function restore(kv: Map<string, string>): void {
  const ratingsLink = kv.get("lens") === "ratings" || [...kv.keys()].some((key) => key.startsWith("rt"));
  pending = ratingsLink && kv.get("rtv") === URL_VERSION ? kv : null;
}

export async function applyPendingRatingsUrl(): Promise<void> {
  if (!pending) return;
  const kv = pending;
  pending = null;
  const state = useRatings.getState();
  const data = state.data;
  if (!data) {
    pending = kv;
    return;
  }
  const actualMin = Math.min(...data.exact.rating);
  const actualMax = Math.max(...data.exact.rating);
  const number = (key: string): number | null => {
    const raw = kv.get(key);
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const validEntity = (id: string | undefined): string | null => {
    if (!id) return null;
    return data.participantIndexById.has(id) || data.promotionIndexById.has(id) || data.titleIndexById.has(id) ? id : null;
  };
  const controls: RatingControlsState = {
    ...DEFAULT_RATING_CONTROLS,
    filters: { ...DEFAULT_RATING_CONTROLS.filters, ratingMin: actualMin, ratingMax: actualMax },
  };
  const min = number("rtmin");
  const max = number("rtmax");
  if (min !== null) controls.filters.ratingMin = Math.max(actualMin, Math.min(actualMax, min));
  if (max !== null) controls.filters.ratingMax = Math.max(controls.filters.ratingMin, Math.min(actualMax, max));
  const threshold = number("rtth");
  if (threshold !== null) controls.threshold = Math.max(actualMin, Math.min(8, threshold));
  const laneOrder = kv.get("rtord");
  if (laneOrder && LANE_ORDERS.includes(laneOrder as RatingLaneOrder)) controls.laneOrder = laneOrder as RatingLaneOrder;
  const coverage = number("rtcov");
  if (coverage !== null) controls.filters.coverageMinimum = Math.max(0, Math.min(1, coverage));
  controls.showTrend = kv.get("rttr") !== "0";
  controls.showAggregates = kv.get("rtag") !== "0";
  controls.showExact = kv.get("rtex") !== "0";
  const context = number("rtctx");
  if (context !== null) controls.context = Math.max(0, Math.min(1, context));
  const promotion = kv.get("rtpr");
  controls.filters.promotionId = promotion && data.promotionIndexById.has(promotion) ? promotion : null;
  const form = kv.get("rtform");
  if (form && (form === "all" || data.dictionaries.forms.includes(form))) controls.filters.form = form as RatingControlsState["filters"]["form"];
  controls.filters.ppvOnly = kv.get("rtppv") === "1";
  controls.filters.titleMatchOnly = kv.get("rttm") === "1";
  controls.filters.titleChangeOnly = kv.get("rttc") === "1";
  controls.filters.includeExactDates = kv.get("rtexd") !== "0";
  controls.filters.includeApproximateDates = kv.get("rtapx") !== "0";

  const compareA = validEntity(kv.get("rta"));
  const compareB = validEntity(kv.get("rtb"));
  const rawMode = kv.get("rtm");
  const scopeId = validEntity(kv.get("rts"));
  let scope = state.scope;
  if (rawMode === "compare" && compareA && compareB && compareA !== compareB) scope = { mode: "compare" as const, id: null, compareA, compareB };
  else if (rawMode === "promotion" && scopeId?.startsWith("pr:")) scope = { mode: "promotion" as const, id: scopeId };
  else if (rawMode === "career" && scopeId?.startsWith("p:")) scope = { mode: "career" as const, id: scopeId };
  else if (rawMode === "title" && scopeId?.startsWith("t:")) scope = { mode: "title" as const, id: scopeId };
  else if (!rawMode || rawMode === "promotions") scope = { mode: "promotions" as const, id: null };

  const selected = kv.get("rtid");
  const selectedMatchId = selected && data.exactIndexById.has(selected) ? selected : null;
  const sheetRaw = kv.get("rtsheet");
  const sheet = sheetRaw && SHEETS.includes(sheetRaw as RatingsSheet) ? sheetRaw as RatingsSheet : "map";
  const pendingCamera = decodeCamera(number);
  useRatings.setState({ controls, compareA, compareB, scope, sheet, pendingCamera, cameraTouched: !!pendingCamera });
  if (scope.id) {
    useStore.setState({ selection: { kind: "node", id: scope.id } });
    void useStore.getState().resolveSelectionMembers();
  }
  if (selectedMatchId) state.selectMatch(selectedMatchId);
  else {
    // Warm navigation is a complete restore, not a merge with the previously
    // open ratings URL. A link without rtid must release an old locked match.
    useRatings.setState({ selectedMatchId: null, selectedExact: null, selectedDetail: null, detailLoading: false });
    await useRatings.getState().rebuild();
  }
}

export function installRatingsUrl(): void {
  if (installed) return;
  installed = true;
  registerRatingsUrl(serialize, restore);
  useRatings.subscribe((state, previous) => {
    if (
      state.scope !== previous.scope ||
      state.controls !== previous.controls ||
      state.selectedMatchId !== previous.selectedMatchId ||
      state.compareA !== previous.compareA ||
      state.compareB !== previous.compareB ||
      state.sheet !== previous.sheet ||
      state.camera !== previous.camera ||
      state.cameraTouched !== previous.cameraTouched
    ) writeUrl();
  });
}

function decodeCamera(number: (key: string) => number | null): MorphView | null {
  const cx = number("rtcx");
  const cy = number("rtcy");
  const cz = number("rtcz");
  const distance = number("rtd");
  const theta = number("rtaz");
  const phi = number("rtel");
  if (cx === null || cy === null || cz === null || distance === null || theta === null || phi === null) return null;
  if (Math.abs(cx) > 10_000 || Math.abs(cy) > 10_000 || Math.abs(cz) > 10_000 || distance < 30 || distance > 7_200 || Math.abs(theta) > 100 || phi <= 0.02 || phi >= Math.PI - 0.02) return null;
  return { cx, cy, cz, distance, theta, phi };
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
