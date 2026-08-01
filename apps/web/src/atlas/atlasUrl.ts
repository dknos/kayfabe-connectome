import { registerAtlasUrl, writeUrl } from "../state/store";
import { useAtlas, type AtlasCameraState } from "./atlasStore";
import { DEFAULT_CONTROLS, type GroupMode, type SortMode } from "./layout/layoutTypes";

/**
 * ATLAS deep links.
 *
 * The selected entity, the date range and the timeline already ride in the
 * shared fragment, so what is added here is only what ATLAS itself owns:
 * grouping, sorting, thresholds, visibility, label density, camera mode and —
 * when it is stable — the framing.
 *
 * Keys are namespaced with a leading `a`. The fragment reader ignores keys it
 * does not know, so old connectome and geo links keep working and no version
 * bump is needed.
 *
 * The camera is written only when the reader has actually moved it. Recording
 * a fit-all framing would make every shared link pin a viewport that was never
 * a decision, and a later layout change would then restore the wrong region.
 */

const GROUPS: GroupMode[] = ["decade", "alpha", "tier", "firstYear"];
const SORTS: SortMode[] = ["volume", "first", "last", "alpha", "span"];
const DENSITIES = ["sparse", "normal", "dense"] as const;

/** Set once the reader pans or zooms; cleared on a programmatic fit. */
let cameraTouched = false;
export function markCameraTouched(v: boolean): void {
  cameraTouched = v;
}

/** Longhand rather than a conditional object literal: a dozen ternaries in one
 *  expression is unreadable, and this is the thing a shared link depends on. */
function serializeAtlas(): Record<string, string | number | null> {
  const a = useAtlas.getState();
  const c = a.controls;
  const d = DEFAULT_CONTROLS;
  const out: Record<string, string | number | null> = {};
  if (c.group !== d.group) out.ag = c.group;
  if (c.sort !== d.sort) out.aso = c.sort;
  if (c.minActivity !== d.minActivity) out.ama = c.minActivity;
  if (c.relThreshold !== d.relThreshold) out.art = c.relThreshold;
  if (c.showTitles !== d.showTitles) out.att = c.showTitles ? 1 : 0;
  if (c.showWrestlers !== d.showWrestlers) out.awr = c.showWrestlers ? 1 : 0;
  if (c.showBundles !== d.showBundles) out.abu = c.showBundles ? 1 : 0;
  if (c.labels !== d.labels) out.ald = c.labels;
  if (c.tilted !== d.tilted) out.ati = 1;
  if (a.reignFocus) out.arf = a.reignFocus;
  if (cameraTouched && a.camera) {
    out.acx = round(a.camera.cx);
    out.acy = round(a.camera.cy);
    out.ach = round(a.camera.half);
  }
  return out;
}

const round = (v: number): number => Math.round(v * 100) / 100;

let pending: Map<string, string> | null = null;

function restore(kv: Map<string, string>): void {
  if (![...kv.keys()].some((k) => k.startsWith("a") && k.length > 1)) return;
  pending = kv;
}

/**
 * Replay a restored link once the projection has loaded.
 *
 * Deferred for the same reason GEO defers: restore runs during boot, while the
 * atlas data may still be in flight, and dropping the state on the floor makes
 * every shared link silently open the default board.
 */
export function applyPendingAtlasUrl(): void {
  const kv = pending;
  if (!kv) return;
  pending = null;
  const a = useAtlas.getState();

  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const patch: Partial<typeof a.controls> = {};
  const g = kv.get("ag");
  if (g && (GROUPS as string[]).includes(g)) patch.group = g as GroupMode;
  const so = kv.get("aso");
  if (so && (SORTS as string[]).includes(so)) patch.sort = so as SortMode;
  const ma = num("ama");
  if (ma !== null && ma >= 0) patch.minActivity = ma;
  const rt = num("art");
  if (rt !== null && rt >= 1) patch.relThreshold = rt;
  if (kv.has("att")) patch.showTitles = kv.get("att") === "1";
  if (kv.has("awr")) patch.showWrestlers = kv.get("awr") === "1";
  if (kv.has("abu")) patch.showBundles = kv.get("abu") === "1";
  const ld = kv.get("ald");
  if (ld && (DENSITIES as readonly string[]).includes(ld)) {
    patch.labels = ld as (typeof DENSITIES)[number];
  }
  if (kv.get("ati") === "1") patch.tilted = true;

  const rf = kv.get("arf");
  if (rf) useAtlas.setState({ reignFocus: rf });

  const cx = num("acx");
  const cy = num("acy");
  const ch = num("ach");
  if (cx !== null && cy !== null && ch !== null && ch > 0) {
    const cam: AtlasCameraState = { cx, cy, half: ch };
    cameraTouched = true;
    useAtlas.setState({ pendingCamera: cam });
  }

  if (Object.keys(patch).length) a.setControls(patch);
  else void a.rebuild();
}

let installed = false;
export function installAtlasUrl(): void {
  if (installed) return;
  installed = true;
  registerAtlasUrl(serializeAtlas, restore);
  useAtlas.subscribe(() => writeUrl());
}
