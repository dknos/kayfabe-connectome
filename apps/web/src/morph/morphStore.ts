import { create } from "zustand";
import type { ChampionshipsFile, PersonDossier } from "@kayfabe/graph-contract";
import {
  MORPH_TIERS,
  type MorphLayoutResult,
  type MorphMode,
  type MorphTier,
  type MorphView,
} from "@kayfabe/morph-renderer";
import { loadChampionships, loadEvidenceForPair, loadPersonDossier } from "../data/loader";
import { pairKey } from "@kayfabe/graph-contract";
import { loadAtlasCore, loadPersonRoutes, loadPromotionDetail, type AtlasData } from "../atlas/atlasLoader";
import type { AtlasPersonRoutes, AtlasPromotionDetail } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
import { buildMorphData, type MorphData } from "./morphAdapter";
import { buildLoom } from "./layouts/relationshipLoom";
import { buildOrganic } from "./layouts/organicLayout";
import { buildMotherboard } from "./layouts/promotionMotherboard";
import { buildCareer } from "./layouts/careerCircuit";
import { buildLineage } from "./layouts/championshipLineage";
import { buildHeadToHead } from "./layouts/headToHead";
import { DEFAULT_MORPH_CONTROLS, type MorphControlsState } from "./layouts/layoutTypes";

/**
 * MORPH LAB state.
 *
 * Like GEO and ATLAS it owns almost nothing: the selected entity, history,
 * pins, path endpoints, filters, timeline and reduced-motion all live in the
 * shared store — that is what makes lens switches keep the reader's place.
 * What lives here: which topology is showing, how it is sorted, the built
 * layout, and the camera.
 */

export type MorphModeOverride = "auto" | MorphMode;

/** the two people head-to-head would compare, if the reader has chosen them */
export const h2hPair = (): [string, string] | null => {
  const s = useStore.getState();
  const a = s.pathA;
  const b = s.pathB;
  if (a?.startsWith("p:") && b?.startsWith("p:") && a !== b) return [a, b];
  const sel = s.selection?.kind === "node" ? s.selection.id : null;
  const pin = s.pinned.find((p) => p.startsWith("p:") && p !== sel);
  if (sel?.startsWith("p:") && pin) return [sel, pin];
  return null;
};

export const morphModeFor = (
  id: string | null,
  override: MorphModeOverride,
  tissue: boolean,
): MorphMode => {
  if (tissue) return "organic";
  if (override !== "auto") {
    const ok =
      (override === "loom" && id?.startsWith("p:")) ||
      (override === "career" && id?.startsWith("p:")) ||
      (override === "motherboard" && id?.startsWith("pr:")) ||
      (override === "lineage" && id?.startsWith("t:")) ||
      (override === "h2h" && h2hPair() !== null) ||
      override === "organic";
    if (ok) return override;
  }
  if (!id) return "organic";
  if (id.startsWith("p:")) return "loom";
  if (id.startsWith("pr:")) return "motherboard";
  if (id.startsWith("t:")) return "lineage";
  return "organic";
};

interface MorphStore {
  data: MorphData | null;
  atlas: AtlasData | null;
  loading: boolean;
  error: string | null;

  controls: MorphControlsState;
  modeOverride: MorphModeOverride;
  /** Return-to-tissue: organic positions with the selection retained */
  tissue: boolean;

  layout: MorphLayoutResult | null;
  building: boolean;

  /** detail currently laid out, for the inspector */
  dossier: PersonDossier | null;
  promotion: AtlasPromotionDetail | null;
  personRoutes: AtlasPersonRoutes | null;
  championships: ChampionshipsFile | null;

  labelShown: number;
  labelWanted: number;
  tier: MorphTier;
  camera: MorphView | null;
  pendingCamera: MorphView | null;
  sheet: "controls" | "inspector" | "hidden";
  fitToken: number;

  boot(): Promise<void>;
  rebuild(): Promise<void>;
  setControls(patch: Partial<MorphControlsState>): void;
  setModeOverride(m: MorphModeOverride): void;
  returnToTissue(): void;
  leaveTissue(): void;
  setLabelReport(shown: number, wanted: number): void;
  setTier(t: MorphTier): void;
  setCamera(v: MorphView): void;
  setSheet(s: "controls" | "inspector" | "hidden"): void;
  requestFit(): void;
  /** one semantic level up: title → its promotion, anything else → tissue */
  ascend(): void;
}

let buildToken = 0;

export const useMorph = create<MorphStore>((set, get) => ({
  data: null,
  atlas: null,
  loading: false,
  error: null,
  controls: { ...DEFAULT_MORPH_CONTROLS },
  modeOverride: "auto",
  tissue: false,
  layout: null,
  building: false,
  dossier: null,
  promotion: null,
  personRoutes: null,
  championships: null,
  labelShown: 0,
  labelWanted: 0,
  tier: "high",
  camera: null,
  pendingCamera: null,
  sheet: "inspector",
  fitToken: 0,

  async boot() {
    if (get().data || get().loading) return;
    const main = useStore.getState();
    if (!main.model || !main.core) return;
    set({ loading: true, error: null });
    try {
      const data = buildMorphData(main.model, main.core);
      let atlas: AtlasData | null = null;
      try {
        atlas = await loadAtlasCore();
      } catch {
        // names of node-less titles degrade to ids; the lens still works
      }
      set({ data, atlas, loading: false });
      await get().rebuild();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setControls(patch) {
    set((s) => ({ controls: { ...s.controls, ...patch } }));
    void get().rebuild();
  },

  setModeOverride(modeOverride) {
    set({ modeOverride, tissue: false });
    void get().rebuild();
  },

  returnToTissue() {
    set({ tissue: true, modeOverride: "auto" });
    void get().rebuild();
  },

  leaveTissue() {
    if (get().tissue) set({ tissue: false });
  },

  setLabelReport(labelShown, labelWanted) {
    if (get().labelShown === labelShown && get().labelWanted === labelWanted) return;
    set({ labelShown, labelWanted });
  },

  setTier(tier) {
    const prev = get().tier;
    if (prev === tier) return;
    set({ tier });
    // Rebuild only when stepping DOWN (the trace budget shrank). An upstep
    // rebuild replays a full 920 ms morph of an unchanged board, and that
    // morph is itself the expensive event that re-triggers the downstep —
    // borderline hardware would oscillate forever.
    const order = ["low", "medium", "high"] as const;
    if (order.indexOf(tier) < order.indexOf(prev)) void get().rebuild();
  },

  setCamera(camera) {
    set({ camera });
  },

  setSheet(sheet) {
    set({ sheet });
  },

  requestFit() {
    set((s) => ({ fitToken: s.fitToken + 1 }));
  },

  ascend() {
    const main = useStore.getState();
    const id = main.selection?.kind === "node" ? main.selection.id : null;
    if (!id) {
      if (!get().tissue) get().returnToTissue();
      return;
    }
    if (id.startsWith("t:")) {
      const a = get().atlas;
      const ti = a?.titleIndex.get(id);
      const pr = ti !== undefined ? a!.titles.pr[ti]! : "";
      main.select(pr ? { kind: "node", id: pr } : null);
      return;
    }
    main.select(null);
  },

  /**
   * Rebuild the layout for the current shared selection. Token-guarded:
   * clicking through three wrestlers faster than a shard loads must land on
   * the third, not on whichever fetch resolved last.
   */
  async rebuild() {
    const s = get();
    const data = s.data;
    if (!data) return;
    const token = ++buildToken;
    const main = useStore.getState();
    const id = main.selection?.kind === "node" ? main.selection.id : null;
    const mode = morphModeFor(id, s.modeOverride, s.tissue);
    const traceCap = MORPH_TIERS[s.tier].traceCap;

    // A selectable person is not always a corpus node (a csv-belt holder can
    // be picked from a lineage board): person boards need a node, and the
    // honest fallback is the organic reading with the selection retained —
    // never the boot-error screen.
    const personBoard = (mode === "loom" || mode === "career" || mode === "h2h") && id?.startsWith("p:");
    const hasNode = id ? data.indexOf(id) !== undefined : false;
    const effMode = personBoard && !hasNode ? "organic" : mode;

    set({ building: true, error: null });
    try {
      if (effMode === "loom" && id) {
        const bucket = await loadPersonDossier(id).catch(() => null);
        if (token !== buildToken) return;
        const dossier = bucket?.[id] ?? null;
        const atlas = s.atlas;
        const layout = buildLoom(
          data,
          id,
          dossier,
          (t) => {
            const ti = atlas?.titleIndex.get(t);
            return ti !== undefined ? (atlas!.titles.name[ti] ?? null) : null;
          },
          s.controls,
          Math.max(60, traceCap - 60),
        );
        if (token !== buildToken) return;
        set({ layout, dossier, promotion: null, personRoutes: null, building: false });
        return;
      }

      if (effMode === "motherboard" && id) {
        // a failed fetch and a still-loading shard are different truths —
        // "loading…" forever on a 404 is a lying label
        let detail: AtlasPromotionDetail | null = null;
        let shardFailed = false;
        try {
          detail = await loadPromotionDetail(id);
        } catch {
          shardFailed = true;
        }
        if (token !== buildToken) return;
        const layout = buildMotherboard(data, id, detail, s.atlas, s.controls, shardFailed);
        if (token !== buildToken) return;
        set({ layout, promotion: detail, dossier: null, personRoutes: null, building: false });
        return;
      }

      if (effMode === "career" && id) {
        const [routes, bucket] = await Promise.all([
          loadPersonRoutes(id).catch(() => null),
          loadPersonDossier(id).catch(() => null),
        ]);
        if (token !== buildToken) return;
        const dossier = bucket?.[id] ?? null;
        const layout = buildCareer(data, id, routes, dossier, s.atlas, s.controls);
        if (token !== buildToken) return;
        set({ layout, dossier, personRoutes: routes, promotion: null, building: false });
        return;
      }

      if (effMode === "h2h") {
        const pair = h2hPair();
        if (pair) {
          const key = pairKey(pair[0], pair[1]);
          const bucket = await loadEvidenceForPair(key).catch(() => null);
          if (token !== buildToken) return;
          const layout = buildHeadToHead(data, pair[0], pair[1], bucket?.[key] ?? []);
          if (token !== buildToken) return;
          set({ layout, dossier: null, promotion: null, personRoutes: null, building: false });
          return;
        }
      }

      if (effMode === "lineage" && id) {
        const champs = await loadChampionships().catch(() => null);
        if (token !== buildToken) return;
        const layout = buildLineage(data, id, champs?.[id] ?? null, s.atlas);
        if (token !== buildToken) return;
        set({ layout, championships: champs, dossier: null, promotion: null, personRoutes: null, building: false });
        return;
      }

      // organic (also the honest fallback for selections with no mode)
      const lit = main.members.ids;
      const layout = buildOrganic(data, id, lit, Math.min(traceCap, 1200));
      if (token !== buildToken) return;
      set({ layout, building: false });
    } catch (err) {
      if (token !== buildToken) return;
      set({ building: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
