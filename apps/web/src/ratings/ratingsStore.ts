import type { MorphView } from "@kayfabe/morph-renderer";
import type { RatingLayout, RatingPickResult, RatingQualityOverride, RatingTier } from "@kayfabe/ratings-renderer";
import type { TimelineEvent } from "@kayfabe/graph-contract";
import { create } from "zustand";
import { loadYear } from "../data/loader";
import { useStore } from "../state/store";
import { exactRecord, type RatingExactRecord } from "./ratingsAdapter";
import { buildRatingLayout, DEFAULT_RATING_CONTROLS, type RatingControlsState, type RatingScope, type RatingStats } from "./layouts";
import { loadRatings, type RatingsData } from "./ratingsLoader";

export type RatingsSheet = "controls" | "inspector" | "map";
export type RatingListSort = "date" | "rating" | "promotion" | "event";

interface RatingsState {
  data: RatingsData | null;
  loading: boolean;
  progress: number;
  loadingWhat: string;
  error: string | null;
  layout: RatingLayout | null;
  stats: RatingStats | null;
  scope: RatingScope;
  scopeLabel: string;
  controls: RatingControlsState;
  tier: RatingTier;
  qualityOverride: RatingQualityOverride;
  selectedMatchId: string | null;
  selectedExact: RatingExactRecord | null;
  selectedDetail: TimelineEvent | null;
  detailLoading: boolean;
  hovered: RatingPickResult | null;
  currentMatchId: string | null;
  pinnedMatchIds: string[];
  compareA: string | null;
  compareB: string | null;
  visibleExactIndices: number[];
  scopeExactIndices: number[];
  scopeExactIndexSet: ReadonlySet<number>;
  sheet: RatingsSheet;
  listSort: RatingListSort;
  camera: MorphView | null;
  pendingCamera: MorphView | null;
  cameraTouched: boolean;
  fitToken: number;
  focusToken: number;
  building: boolean;
  layoutBuildDurationMs: number;
  decodeDurationMs: number;
  shownLabels: number;
  wantedLabels: number;

  boot(): Promise<void>;
  rebuild(): Promise<void>;
  syncSharedSelection(id: string | null): void;
  setScope(scope: RatingScope): void;
  returnGlobal(): void;
  setControls(patch: Partial<RatingControlsState>): void;
  setFilters(patch: Partial<RatingControlsState["filters"]>): void;
  resetControls(): void;
  setTier(tier: RatingTier): void;
  setQualityOverride(value: RatingQualityOverride): void;
  selectMatch(id: string | null): void;
  setHovered(hit: RatingPickResult | null): void;
  setCurrentMatch(id: string | null): void;
  togglePinMatch(id: string): void;
  setCompare(which: "a" | "b", id: string | null): void;
  activateCompare(): void;
  setSheet(sheet: RatingsSheet): void;
  setListSort(sort: RatingListSort): void;
  setCamera(camera: MorphView, touched?: boolean): void;
  requestFit(): void;
  requestFocus(): void;
  setLabelReport(shown: number, wanted: number): void;
}

let buildToken = 0;
let detailToken = 0;

export const useRatings = create<RatingsState>((set, get) => ({
  data: null,
  loading: false,
  progress: 0,
  loadingWhat: "",
  error: null,
  layout: null,
  stats: null,
  scope: { mode: "promotions", id: null },
  scopeLabel: "All rated promotions",
  controls: DEFAULT_RATING_CONTROLS,
  tier: "high",
  qualityOverride: "auto",
  selectedMatchId: null,
  selectedExact: null,
  selectedDetail: null,
  detailLoading: false,
  hovered: null,
  currentMatchId: null,
  pinnedMatchIds: [],
  compareA: null,
  compareB: null,
  visibleExactIndices: [],
  scopeExactIndices: [],
  scopeExactIndexSet: new Set<number>(),
  sheet: "map",
  listSort: "date",
  camera: null,
  pendingCamera: null,
  cameraTouched: false,
  fitToken: 0,
  focusToken: 0,
  building: false,
  layoutBuildDurationMs: 0,
  decodeDurationMs: 0,
  shownLabels: 0,
  wantedLabels: 0,

  async boot() {
    if (get().data || get().loading) return;
    set({ loading: true, error: null, progress: 0, loadingWhat: "opening ratings projection" });
    try {
      const data = await loadRatings((progress, loadingWhat) => set({ progress, loadingWhat }));
      let min = Infinity;
      let max = -Infinity;
      for (const rating of data.exact.rating) {
        min = Math.min(min, rating);
        max = Math.max(max, rating);
      }
      set((state) => ({
        data,
        loading: false,
        progress: 1,
        loadingWhat: "ready",
        decodeDurationMs: data.decodeDurationMs,
        controls: {
          ...state.controls,
          filters: { ...state.controls.filters, ratingMin: min, ratingMax: max },
        },
      }));
      const selection = useStore.getState().selection;
      get().syncSharedSelection(selection?.kind === "node" ? selection.id : null);
      await get().rebuild();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  async rebuild() {
    const state = get();
    if (!state.data) return;
    const token = ++buildToken;
    const start = performance.now();
    set({ building: true });
    // Yield once so a five-scope rapid retarget can invalidate stale work
    // before it starts a full exact-set scan.
    await Promise.resolve();
    if (token !== buildToken) return;
    const shared = useStore.getState();
    const promotionOfMatch = (id: string | null): string => {
      if (!id) return "";
      const index = state.data!.exactIndexById.get(id);
      return index === undefined ? "" : state.data!.dictionaries.promotions.id[state.data!.exact.promotion[index]!]!;
    };
    const result = buildRatingLayout({
      data: state.data,
      scope: { ...state.scope, compareA: state.compareA, compareB: state.compareB },
      controls: state.controls,
      dayMin: shared.filters.dayMin,
      dayMax: shared.filters.dayMax,
      tier: state.tier,
      selectedMatchId: state.selectedMatchId,
      hoveredMatchId: state.hovered?.kind === "match" ? state.hovered.id : null,
      currentMatchId: state.currentMatchId,
      pinnedMatchIds: state.pinnedMatchIds,
      requiredPromotionIds: [
        state.scope.id?.startsWith("pr:") ? state.scope.id : "",
        state.compareA?.startsWith("pr:") ? state.compareA : "",
        state.compareB?.startsWith("pr:") ? state.compareB : "",
        promotionOfMatch(state.selectedMatchId),
        promotionOfMatch(state.currentMatchId),
        ...state.pinnedMatchIds.map(promotionOfMatch),
      ].filter(Boolean),
      generation: (state.layout?.generation ?? 0) + 1,
    });
    if (token !== buildToken) return;
    set({
      layout: result.layout,
      stats: result.stats,
      visibleExactIndices: result.visibleExactIndices,
      scopeExactIndices: result.scopeExactIndices,
      scopeExactIndexSet: new Set(result.scopeExactIndices),
      scopeLabel: result.scopeLabel,
      layoutBuildDurationMs: performance.now() - start,
      building: false,
    });
  },

  syncSharedSelection(id) {
    const data = get().data;
    if (!data) return;
    let scope: RatingScope;
    if (id?.startsWith("pr:") && data.promotionIndexById.has(id)) scope = { mode: "promotion", id };
    else if (id?.startsWith("p:") && data.participantIndexById.has(id)) scope = { mode: "career", id };
    else if (id?.startsWith("t:") && data.titleIndexById.has(id)) scope = { mode: "title", id };
    else scope = { mode: "promotions", id: null };
    const current = get().scope;
    if (current.mode === scope.mode && current.id === scope.id) return;
    set({ scope });
    void get().rebuild();
  },

  setScope(scope) {
    set({ scope });
    void get().rebuild();
  },

  returnGlobal() {
    set({ scope: { mode: "promotions", id: null }, hovered: null });
    useStore.getState().select(null);
    void get().rebuild();
  },

  setControls(patch) {
    set((state) => ({ controls: { ...state.controls, ...patch } }));
    void get().rebuild();
  },

  setFilters(patch) {
    set((state) => ({ controls: { ...state.controls, filters: { ...state.controls.filters, ...patch } } }));
    void get().rebuild();
  },

  resetControls() {
    const data = get().data;
    let min = -1;
    let max = 7;
    if (data) {
      min = Math.min(...data.exact.rating);
      max = Math.max(...data.exact.rating);
    }
    set({ controls: { ...DEFAULT_RATING_CONTROLS, filters: { ...DEFAULT_RATING_CONTROLS.filters, ratingMin: min, ratingMax: max } } });
    void get().rebuild();
  },

  setTier(tier) {
    if (get().tier === tier) return;
    set({ tier });
    void get().rebuild();
  },

  setQualityOverride(qualityOverride) {
    set({ qualityOverride });
  },

  selectMatch(selectedMatchId) {
    const data = get().data;
    const valid = selectedMatchId && data?.exactIndexById.has(selectedMatchId) ? selectedMatchId : null;
    const index = valid && data ? data.exactIndexById.get(valid)! : -1;
    const selectedExact = index >= 0 && data ? exactRecord(data, index) : null;
    const token = ++detailToken;
    set({ selectedMatchId: valid, selectedExact, selectedDetail: null, detailLoading: !!selectedExact });
    void get().rebuild();
    if (!selectedExact) return;
    const year = Number(selectedExact.date.slice(0, 4));
    void loadYear(year).then((records) => {
      if (token !== detailToken || get().selectedMatchId !== valid) return;
      set({ selectedDetail: records.find((record) => record.m === valid) ?? null, detailLoading: false });
    }).catch(() => {
      if (token === detailToken) set({ detailLoading: false });
    });
  },

  setHovered(hovered) {
    set({ hovered });
  },

  setCurrentMatch(currentMatchId) {
    set({ currentMatchId });
  },

  togglePinMatch(id) {
    set((state) => ({ pinnedMatchIds: state.pinnedMatchIds.includes(id) ? state.pinnedMatchIds.filter((item) => item !== id) : [...state.pinnedMatchIds, id] }));
    void get().rebuild();
  },

  setCompare(which, id) {
    set(which === "a" ? { compareA: id } : { compareB: id });
  },

  activateCompare() {
    const { compareA, compareB } = get();
    if (!compareA || !compareB || compareA === compareB) return;
    set({ scope: { mode: "compare", id: null, compareA, compareB } });
    void get().rebuild();
  },

  setSheet(sheet) { set({ sheet }); },
  setListSort(listSort) { set({ listSort }); },
  setCamera(camera, touched = true) { set({ camera, cameraTouched: touched }); },
  requestFit() { set((state) => ({ fitToken: state.fitToken + 1 })); },
  requestFocus() { set((state) => ({ focusToken: state.focusToken + 1 })); },
  setLabelReport(shownLabels, wantedLabels) { set({ shownLabels, wantedLabels }); },
}));

export function ratingsScopeForSelection(id: string | null): RatingScope {
  if (id?.startsWith("pr:")) return { mode: "promotion", id };
  if (id?.startsWith("p:")) return { mode: "career", id };
  if (id?.startsWith("t:")) return { mode: "title", id };
  return { mode: "promotions", id: null };
}
