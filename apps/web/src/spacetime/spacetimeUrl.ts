import { registerSpacetimeUrl } from "../state/store";
import type { SpacetimeMode } from "@kayfabe/spacetime-renderer";

/**
 * Spacetime URL state. Key namespace "sp*" — no shared key and no other lens
 * prefix collides with it. Diff-vs-default: a default view contributes
 * nothing. The playhead itself is NOT serialized here — it is the shared
 * timeline's `td`, and duplicating it would let two keys disagree.
 *
 * The quality tier is deliberately not serialized (device property, and the
 * governor may have chosen it — the arena precedent).
 */
let mode: SpacetimeMode = "exterior";
let inspectedEvent: string | null = null;
let inspectedPerson: string | null = null;
let pending: Map<string, string> | null = null;

export function setSpacetimeUrlState(next: {
  mode: SpacetimeMode;
  inspectedEvent: string | null;
  inspectedPerson: string | null;
}): void {
  mode = next.mode;
  inspectedEvent = next.inspectedEvent;
  inspectedPerson = next.inspectedPerson;
}

function serialize(): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (mode === "bridge") out.spm = "b";
  if (inspectedEvent) out.spe = inspectedEvent;
  if (inspectedPerson) out.spp = inspectedPerson;
  return out;
}

let listener: (() => void) | null = null;

/** Back is a same-document navigation into an already-mounted lens; the lens
 *  asks to hear about it (the arena precedent, verbatim). */
export function onSpacetimeUrlRestore(cb: (() => void) | null): void {
  listener = cb;
}

function restore(kv: Map<string, string>): void {
  pending = new Map(kv);
  listener?.();
}

export function takePendingSpacetimeUrl():
  | { mode: SpacetimeMode; inspectedEvent: string | null; inspectedPerson: string | null; sel: string | null }
  | null {
  if (!pending) return null;
  const kv = pending;
  pending = null;
  return {
    mode: kv.get("spm") === "b" ? "bridge" : "exterior",
    inspectedEvent: kv.get("spe") ?? null,
    inspectedPerson: kv.get("spp") ?? null,
    sel: kv.get("sel") ?? null,
  };
}

// Registered at MODULE LOAD, not on mount — restoreFromUrl() runs during boot,
// long before the lens component exists (the arena lesson).
registerSpacetimeUrl(serialize, restore);
