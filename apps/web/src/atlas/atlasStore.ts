import { create } from "zustand";
import type { AtlasScene, AtlasTier } from "@kayfabe/atlas-renderer";
import type {
  AtlasPersonRoutes,
  AtlasPromotionDetail,
  ChampionshipsFile,
  PersonDossier,
} from "@kayfabe/graph-contract";
import { loadChampionships, loadPersonDossier } from "../data/loader";
import { EF } from "../graph/model";
import { useStore } from "../state/store";
import { loadAtlasCore, loadPersonRoutes, loadPromotionDetail, type AtlasData } from "./atlasLoader";
import { buildCareer } from "./layout/careerLayout";
import { buildOverview } from "./layout/overviewLayout";
import { buildPromotion, type RelSource } from "./layout/promotionLayout";
import { buildTitle, type LineageStats } from "./layout/titleLayout";
import { DEFAULT_CONTROLS, type AtlasControls } from "./layout/layoutTypes";

/**
 * ATLAS state.
 *
 * Its own store, like GEO's, so the connectome carries no knowledge of
 * chronological layout — but it OWNS almost nothing. The selected entity, the
 * date filters, the promotion filters, the timeline playhead, the playback
 * speed, the current event, the history trail and the reduced-motion
 * preference all live in the shared store and are read from there, which is
 * what makes switching lenses keep the reader's place instead of resetting it.
 *
 * What lives here is the stuff that is only meaningful in ATLAS: how the board
 * is grouped and sorted, what is shown, the built scene, and the camera.
 */

export type AtlasSemanticState = "overview" | "promotion" | "title" | "career";

export interface AtlasCameraState {
  cx: number;
  cy: number;
  half: number;
}

interface AtlasStore {
  data: AtlasData | null;
  loading: boolean;
  error: string | null;

  controls: AtlasControls;
  scene: AtlasScene | null;
  /** Set when the current scene is a championship lineage. */
  lineage: LineageStats | null;
  /** Detail currently laid out, for the inspector. */
  promotion: AtlasPromotionDetail | null;
  person: { routes: AtlasPersonRoutes | null; dossier: PersonDossier | null } | null;
  championships: ChampionshipsFile | null;

  /** A reign block or gap the reader clicked. Sub-entity, so it deliberately
   *  does NOT go through the shared selection. */
  reignFocus: string | null;

  building: boolean;
  labelShown: number;
  labelWanted: number;
  tier: AtlasTier;
  camera: AtlasCameraState | null;
  /** Bottom sheet on narrow viewports. Only one at a time. */
  sheet: "controls" | "inspector" | "hidden";
  /** Set by the URL restorer, applied once the scene exists. */
  pendingCamera: AtlasCameraState | null;
  /** Bumped whenever something asks the renderer to reframe. */
  fitToken: number;
  /** Entity the renderer should flash — search landing on a lane. */
  flashId: string | null;

  boot(): Promise<void>;
  setControls(patch: Partial<AtlasControls>): void;
  rebuild(): Promise<void>;
  setReignFocus(id: string | null): void;
  setLabelReport(shown: number, wanted: number): void;
  setTier(t: AtlasTier): void;
  setCamera(c: AtlasCameraState): void;
  setSheet(s: "controls" | "inspector" | "hidden"): void;
  requestFit(): void;
  flash(id: string | null): void;
  /** One semantic level up: title -> its promotion, promotion/career -> overview. */
  ascend(): void;
}

export const semanticStateOf = (id: string | null): AtlasSemanticState => {
  if (!id) return "overview";
  if (id.startsWith("pr:")) return "promotion";
  if (id.startsWith("t:")) return "title";
  if (id.startsWith("p:")) return "career";
  return "overview";
};

let buildToken = 0;

export const useAtlas = create<AtlasStore>((set, get) => ({
  data: null,
  loading: false,
  error: null,
  controls: { ...DEFAULT_CONTROLS },
  scene: null,
  lineage: null,
  promotion: null,
  person: null,
  championships: null,
  reignFocus: null,
  building: false,
  labelShown: 0,
  labelWanted: 0,
  tier: "high",
  camera: null,
  // Narrow viewports open on the inspector: the mobile flow is search, tap,
  // read, and the inspector is what answers "what did I just select".
  sheet: "inspector",
  pendingCamera: null,
  fitToken: 0,
  flashId: null,

  async boot() {
    if (get().data || get().loading) return;
    set({ loading: true, error: null });
    try {
      const data = await loadAtlasCore();
      set({ data, loading: false });
      await get().rebuild();
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setControls(patch) {
    set((s) => ({ controls: { ...s.controls, ...patch } }));
    void get().rebuild();
  },

  setReignFocus(reignFocus) {
    set({ reignFocus });
  },

  setLabelReport(labelShown, labelWanted) {
    if (get().labelShown === labelShown && get().labelWanted === labelWanted) return;
    set({ labelShown, labelWanted });
  },

  setTier(tier) {
    set({ tier });
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

  flash(flashId) {
    set({ flashId });
  },

  ascend() {
    const st = useStore.getState();
    const id = st.selection?.kind === "node" ? st.selection.id : null;
    const a = get();
    if (a.reignFocus) {
      a.setReignFocus(null);
      return;
    }
    if (!id) return;
    if (id.startsWith("t:")) {
      const ti = a.data?.titleIndex.get(id);
      const pr = ti !== undefined ? a.data!.titles.pr[ti]! : "";
      st.select(pr ? { kind: "node", id: pr } : null);
      return;
    }
    st.select(null);
  },

  /**
   * Rebuild the scene for the current shared selection.
   *
   * Every path is guarded by a token, because a reader clicking through three
   * promotions faster than a shard loads must end up looking at the third one
   * and not at whichever fetch happened to resolve last.
   */
  async rebuild() {
    const a = get();
    const data = a.data;
    if (!data) return;
    const token = ++buildToken;
    const main = useStore.getState();
    const id = main.selection?.kind === "node" ? main.selection.id : null;
    const state = semanticStateOf(id);
    const dayMin = data.manifest.day_range[0];
    const dayMax = data.manifest.day_range[1];
    const playheadDay = main.timeline.mode === "off" ? null : main.timeline.day;
    const hovered = main.hoverId;
    const promoAllow = allowedPromotions(data);

    set({ building: true });

    try {
      if (state === "promotion" && id) {
        const detail = await loadPromotionDetail(id);
        if (token !== buildToken) return;
        if (!detail) {
          // A promotion with no shard is a projection defect, not a blank
          // screen: fall back to the overview and say so.
          set({
            building: false,
            error: `No Atlas detail for ${id} — the projection is missing a shard.`,
          });
          return;
        }
        const scene = buildPromotion({
          data,
          detail,
          controls: a.controls,
          dayMin,
          dayMax,
          selected: id,
          hovered,
          playheadDay,
          rel: relSource(),
        });
        if (token !== buildToken) return;
        set({ scene, promotion: detail, person: null, lineage: null, building: false });
        return;
      }

      if (state === "title" && id) {
        const [champs, detail] = await Promise.all([
          loadChampionships().catch(() => null),
          (async () => {
            const ti = data.titleIndex.get(id);
            const pr = ti !== undefined ? data.titles.pr[ti]! : "";
            return pr ? loadPromotionDetail(pr) : null;
          })(),
        ]);
        if (token !== buildToken) return;
        const ti = data.titleIndex.get(id);
        const pr = ti !== undefined ? data.titles.pr[ti]! : "";
        const pIdx = pr ? data.promoIndex.get(pr) : undefined;
        const own = detail?.titles.find((t) => t.t === id) ?? null;
        const built = buildTitle({
          data,
          titleId: id,
          record: champs?.[id] ?? null,
          controls: a.controls,
          dayMin,
          dayMax,
          selected: a.reignFocus ?? id,
          hovered,
          playheadDay,
          siblings: (detail?.titles ?? []).map((t) => ({
            t: t.t,
            n: t.n,
            firstDay: t.firstDay,
            lastDay: t.lastDay,
            reigns: t.reigns,
          })),
          promotionName:
            pIdx !== undefined ? data.promotions.name[pIdx]! : "Unresolved / cross-promotion",
          nameOf,
          yearFrom: own?.yearFrom ?? 0,
          yearCounts: own?.yearCounts ?? [],
        });
        if (token !== buildToken) return;
        const { lineage, ...scene } = built;
        set({
          scene: scene as AtlasScene,
          lineage,
          championships: champs,
          promotion: detail,
          person: null,
          building: false,
        });
        return;
      }

      if (state === "career" && id) {
        const [routes, bucket] = await Promise.all([
          loadPersonRoutes(id).catch(() => null),
          loadPersonDossier(id).catch(() => null),
        ]);
        if (token !== buildToken) return;
        const dossier = bucket?.[id] ?? null;
        const scene = buildCareer({
          data,
          personId: id,
          routes,
          dossier,
          controls: a.controls,
          dayMin,
          dayMax,
          selected: id,
          hovered,
          playheadDay,
          nameOf,
          communityOf,
        });
        if (token !== buildToken) return;
        set({ scene, person: { routes, dossier }, promotion: null, lineage: null, building: false });
        return;
      }

      const scene = buildOverview({
        data,
        controls: a.controls,
        dayMin,
        dayMax,
        promoAllow,
        selected: id,
        hovered,
        playheadDay,
      });
      if (token !== buildToken) return;
      set({ scene, promotion: null, person: null, lineage: null, building: false });
    } catch (err) {
      if (token !== buildToken) return;
      set({ building: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

/* ---------- bridges to the shared corpus ---------- */

function nameOf(id: string): string | null {
  const m = useStore.getState().model;
  if (!m) return null;
  const i = m.indexOfId.get(id);
  if (i !== undefined) return m.nodes.name[i] ?? null;
  // Not every promotion or title is a graph node — 406 of 571 promotions are
  // not — so fall back to the promotion registry, which covers all of them.
  const core = useStore.getState().core;
  return core?.promotions[id]?.n ?? null;
}

function communityOf(id: string): number {
  const m = useStore.getState().model;
  const i = m?.indexOfId.get(id);
  return i !== undefined && m ? (m.nodes.community[i] ?? -1) : -1;
}

/** Adjacency over the encounter graph, for the promotion board's fibres. */
function relSource(): RelSource | null {
  const m = useStore.getState().model;
  if (!m) return null;
  return {
    neighbours(id) {
      const i = m.indexOfId.get(id);
      if (i === undefined) return [];
      return m.neighbors(i).map(({ node, edge }) => ({
        id: m.nodes.id[node]!,
        same: m.edgeField(edge, EF.same),
        opposed: m.edgeField(edge, EF.opposed),
        br: m.edgeField(edge, EF.br),
      }));
    },
    nameOf,
    communityOf,
  };
}

/**
 * The shared promotion filter, translated into ids.
 *
 * The connectome's filter is a bitmask over 30 named promotions plus one
 * shared "other" bit — so when the other bit is on, every promotion without
 * its own bit is admitted. Returning null (meaning "all") whenever the mask is
 * complete avoids building a 571-entry set on every rebuild.
 */
function allowedPromotions(data: AtlasData): Set<string> | null {
  const st = useStore.getState();
  const mask = st.filters.promoMask;
  const manifest = st.core?.manifest;
  if (!manifest) return null;
  const otherBit = manifest.promo_other_bit;
  const allBits = Object.values(manifest.promo_bits);
  const everyNamed = allBits.every((b) => (mask & (1 << b)) !== 0);
  const otherOn = otherBit === undefined || (mask & (1 << otherBit)) !== 0;
  if (everyNamed && otherOn) return null;
  const allow = new Set<string>();
  for (let i = 0; i < data.promotions.count; i++) {
    const bit = data.promotions.bit[i]!;
    const b = bit >= 0 ? bit : (otherBit ?? -1);
    if (b >= 0 && (mask & (1 << b)) !== 0) allow.add(data.promotions.id[i]!);
  }
  return allow;
}
