import type { ArenaFormation, ArenaQualityTier } from "@kayfabe/arena-renderer";
import { registerArenaUrl } from "../state/store";

/**
 * Arena Array URL state. Key namespace "ar*" — the shared fragment reader
 * ignores unknown keys, and no other shared or lens key starts with "ar".
 * Serialization is diff-vs-default, so a default view contributes nothing to
 * the fragment and a shared link stays short.
 *
 * The quality tier is deliberately NOT serialized. It is a property of the
 * device that rendered the view, not of the view itself, and the renderer's
 * governor may have chosen it without the reader ever asking — restoring one
 * machine's tier onto another would be restoring the wrong thing.
 */
const FORMATIONS: ArenaFormation[] = ["echo", "arena", "index"];

let formation: ArenaFormation = "arena";
let opened: string[] = [];
let pending: Map<string, string> | null = null;

export function setArenaUrlState(next: { formation: ArenaFormation; opened: string[] }): void {
  formation = next.formation;
  opened = next.opened;
}

function serialize(): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (formation !== "arena") out.arf = formation;
  // Which era summaries the reader opened: a drill-down is part of what they
  // are looking at, so a shared link that loses it shares a different view.
  if (opened.length > 0) out.aro = opened.join(",");
  return out;
}

let listener: (() => void) | null = null;

/**
 * The mounted lens asks to be told when a fragment arrives.
 *
 * A cold boot is not the only restore: pressing Back is a same-document
 * navigation into an already-mounted lens. Without this the lens only ever
 * consumed a fragment when its underlying scope changed, so stepping back to
 * the SAME subject with a different drill-down restored nothing at all.
 */
export function onArenaUrlRestore(cb: (() => void) | null): void {
  listener = cb;
}

function restore(kv: Map<string, string>): void {
  pending = new Map(kv);
  listener?.();
}

/** Consumed by the lens once it has a scope; a cold link can arrive before the
 *  chronology projection has loaded. `sel` rides along so the lens can hold the
 *  restore until its anchor has caught up, rather than applying a drill-down
 *  belonging to a subject it has not built yet. */
export function takePendingArenaUrl():
  | { formation: ArenaFormation; opened: string[]; sel: string | null }
  | null {
  if (!pending) return null;
  const kv = pending;
  pending = null;
  const f = kv.get("arf");
  const o = kv.get("aro");
  return {
    formation: FORMATIONS.includes(f as ArenaFormation) ? (f as ArenaFormation) : "arena",
    opened: o ? o.split(",").filter(Boolean) : [],
    sel: kv.get("sel") ?? null,
  };
}

// Registered at MODULE LOAD, not on mount. restoreFromUrl() runs during boot,
// long before the lens component exists — registering from a mount effect
// meant a cold shared link had nothing listening and silently lost its
// formation while still restoring the lens and subject, which is worse than
// losing all of it because it looks like it worked.
registerArenaUrl(serialize, restore);

export type { ArenaQualityTier };
