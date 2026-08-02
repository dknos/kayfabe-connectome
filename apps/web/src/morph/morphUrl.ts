import type { MorphView } from "@kayfabe/morph-renderer";
import { registerMorphUrl, useStore, writeUrl } from "../state/store";
import { DEFAULT_MORPH_CONTROLS, type LoomSort, type BankGroup } from "./layouts/layoutTypes";
import { morphModeFor, useMorph, type MorphModeOverride } from "./morphStore";

/**
 * Morph Lab URL state. Key namespace "mo*" — the shared fragment reader
 * ignores unknown keys, and no other shared or lens key starts with "mo".
 * Serialization is diff-vs-default: defaults never appear in the fragment.
 * The camera is serialized only after the USER moves it — a programmatic fit
 * in a link would restore the wrong region after any layout change.
 */

const SORTS: LoomSort[] = ["strength", "first", "latest", "median", "alpha"];
const GROUPS: BankGroup[] = ["decade", "activity", "alpha", "champ"];
const MODES: MorphModeOverride[] = ["auto", "organic", "loom", "orbit", "motherboard", "career", "lineage", "h2h", "rack"];

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
  if (s.controls.context === false) out.moct = 0;
  if (cameraTouched && s.camera) {
    out.mocx = Math.round(s.camera.cx * 100) / 100;
    out.mocy = Math.round(s.camera.cy * 100) / 100;
    out.mocz = Math.round(s.camera.cz * 100) / 100;
    out.mod = Math.round(s.camera.distance * 100) / 100;
    out.moth = Math.round(s.camera.theta * 10000) / 10000;
    out.moph = Math.round(s.camera.phi * 10000) / 10000;
  }
  return out;
}

let pending: Map<string, string> | null = null;

function restore(kv: Map<string, string>): void {
  const lens = kv.get("lens");
  const morphLink =
    lens === "morph" ||
    lens === "atlas" ||
    [...kv.keys()].some((k) => k.startsWith("mo") && k.length > 2);
  pending = morphLink ? kv : null;
}

/** called by MorphLab after boot — the deep-link contract */
export async function applyPendingMorphUrl(): Promise<void> {
  if (!pending) return;
  const kv = pending;
  pending = null;
  const controls = { ...DEFAULT_MORPH_CONTROLS };
  const sort = kv.get("mos");
  if (sort && (SORTS as string[]).includes(sort)) controls.sort = sort as LoomSort;
  const group = kv.get("mog");
  if (group && (GROUPS as string[]).includes(group)) controls.group = group as BankGroup;
  controls.timeAxis = kv.get("mox") === "1";
  controls.context = kv.get("moct") !== "0";

  const mode = kv.get("mom");
  const modeOverride = mode && (MODES as string[]).includes(mode)
    ? mode as MorphModeOverride
    : "auto";
  const tissue = kv.get("mot") === "1";

  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const f = Number(v);
    return Number.isFinite(f) ? f : null;
  };
  const cx = num("mocx");
  const cy = num("mocy");
  const cz = num("mocz");
  const distance = num("mod");
  const theta = num("moth");
  const phi = num("moph");
  let pendingCamera: MorphView | null = null;
  if (cx !== null && cy !== null && distance !== null && distance > 0 && theta !== null && phi !== null) {
    pendingCamera = { cx, cy, cz: cz ?? 0, distance, theta, phi };
    cameraTouched = true;
  } else {
    // Safe migration for old orthographic Morph links. Preserve their target
    // and approximate their visible vertical span under the new 50deg lens.
    const half = num("moch");
    if (cx !== null && cy !== null && half !== null && half > 0) {
      pendingCamera = {
        cx,
        cy,
        cz: 0,
        distance: half / Math.tan((50 * Math.PI) / 360),
        theta: (29 * Math.PI) / 180,
        phi: (68 * Math.PI) / 180,
      };
      cameraTouched = true;
    } else {
      cameraTouched = false;
    }
  }

  useMorph.setState({ controls, modeOverride, tissue, pendingCamera });
  await useMorph.getState().rebuild();
  if (!pendingCamera) useMorph.getState().requestFit();
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
