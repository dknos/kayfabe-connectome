import { registerMorphUrl, useStore, writeUrl } from "../state/store";
import { DEFAULT_MORPH_CONTROLS, type LoomSort, type BankGroup } from "./layouts/layoutTypes";
import { morphModeFor, useMorph, type MorphModeOverride } from "./morphStore";

/**
 * Morph Lab URL state. Key namespace "mo*" — the shared fragment reader
 * ignores unknown keys, and no shared/geo/atlas key starts with "mo".
 * Serialization is diff-vs-default: defaults never appear in the fragment.
 * The camera is serialized only after the USER moves it — a programmatic fit
 * in a link would restore the wrong region after any layout change.
 */

const SORTS: LoomSort[] = ["strength", "first", "latest", "median", "alpha"];
const GROUPS: BankGroup[] = ["decade", "activity", "alpha", "champ"];
const MODES: MorphModeOverride[] = ["auto", "organic", "loom", "motherboard", "career", "lineage", "h2h", "rack"];

let cameraTouched = false;
export function markMorphCameraTouched(v: boolean): void {
  cameraTouched = v;
}

function serializeMorph(): Record<string, string | number | null> {
  const s = useMorph.getState();
  const out: Record<string, string | number | null> = {};
  if (s.modeOverride !== "auto") out.mom = s.modeOverride;
  if (s.tissue) out.mot = 1;
  if (s.controls.sort !== DEFAULT_MORPH_CONTROLS.sort) out.mos = s.controls.sort;
  if (s.controls.group !== DEFAULT_MORPH_CONTROLS.group) out.mog = s.controls.group;
  if (s.controls.timeAxis) out.mox = 1;
  if (cameraTouched && s.camera) {
    out.mocx = Math.round(s.camera.cx * 100) / 100;
    out.mocy = Math.round(s.camera.cy * 100) / 100;
    out.moch = Math.round(s.camera.half * 100) / 100;
  }
  return out;
}

let pending: Map<string, string> | null = null;

function restore(kv: Map<string, string>): void {
  for (const k of kv.keys()) {
    if (k.startsWith("mo") && k.length > 2) {
      pending = kv;
      return;
    }
  }
}

/** called by MorphLab after boot — the deep-link contract */
export function applyPendingMorphUrl(): void {
  if (!pending) return;
  const kv = pending;
  pending = null;
  const patch: Partial<typeof DEFAULT_MORPH_CONTROLS> = {};
  const sort = kv.get("mos");
  if (sort && (SORTS as string[]).includes(sort)) patch.sort = sort as LoomSort;
  const group = kv.get("mog");
  if (group && (GROUPS as string[]).includes(group)) patch.group = group as BankGroup;
  if (kv.get("mox") === "1") patch.timeAxis = true;

  const mode = kv.get("mom");
  const st = useMorph.getState();
  if (mode && (MODES as string[]).includes(mode)) {
    useMorph.setState({ modeOverride: mode as MorphModeOverride });
  }
  if (kv.get("mot") === "1") useMorph.setState({ tissue: true });

  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const f = Number(v);
    return Number.isFinite(f) ? f : null;
  };
  const cx = num("mocx");
  const cy = num("mocy");
  const half = num("moch");
  if (cx !== null && cy !== null && half !== null && half > 0) {
    useMorph.setState({ pendingCamera: { cx, cy, half } });
    cameraTouched = true;
  }

  if (Object.keys(patch).length > 0) st.setControls(patch);
  else void st.rebuild();
}

/** current auto/explicit mode, for UI display */
export function currentMorphMode(): string {
  const main = useStore.getState();
  const s = useMorph.getState();
  const id = main.selection?.kind === "node" ? main.selection.id : null;
  return morphModeFor(id, s.modeOverride, s.tissue);
}

let installed = false;
export function installMorphUrl(): void {
  if (installed) return;
  installed = true;
  registerMorphUrl(serializeMorph, restore);
  useMorph.subscribe(() => writeUrl());
}
