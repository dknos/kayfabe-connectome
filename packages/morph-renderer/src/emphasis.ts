import { ME, type MorphEmphasis } from "./types";

export interface MorphEmphasisBuffers {
  emph: Float32Array;
  semantic: Float32Array;
}

/**
 * Populate renderer buffers from semantic state in one bounded pass.
 *
 * Role-based context dimming happens first. Every semantic class is then
 * raised independently, so a late membership update or a mid-flight retarget
 * cannot be hidden by stale outgoing role data.
 */
export function writeMorphEmphasis(
  target: MorphEmphasisBuffers,
  emphasis: MorphEmphasis,
  roles: Uint8Array,
  corpusCount: number,
  virtualSlotOf: (id: string) => number | null,
): void {
  const n = target.emph.length;
  target.semantic.fill(ME.AMBIENT);
  const hasSemanticFocus = emphasis.dimBackground && (
    emphasis.selected >= 0 ||
    emphasis.selectedId !== null ||
    emphasis.hovered >= 0 ||
    emphasis.hoveredId !== null ||
    emphasis.pathNodes.length > 0 ||
    emphasis.members.length > 0 ||
    emphasis.virtualMembers.length > 0
  );

  for (let i = 0; i < corpusCount; i++) {
    target.emph[i] = roles[i] === 0 && hasSemanticFocus ? 0.26 : 1;
  }
  for (let i = corpusCount; i < n; i++) target.emph[i] = 1;

  const raise = (slot: number | null, strength: number, level: number) => {
    if (slot === null || slot < 0 || slot >= n) return;
    target.emph[slot] = Math.max(target.emph[slot]!, strength);
    target.semantic[slot] = Math.max(target.semantic[slot]!, level);
  };
  const raiseSlots = (slots: readonly number[], strength: number, level: number) => {
    for (const slot of slots) raise(slot, strength, level);
  };
  const raiseVirtuals = (ids: readonly string[], strength: number, level: number) => {
    for (const id of ids) raise(virtualSlotOf(id), strength, level);
  };

  // Required visual order: selected > hovered > path > members > anchors >
  // ambient. A pin is a durable reader annotation below semantic membership.
  raiseSlots(emphasis.anchors, 1.12, ME.ANCHOR);
  raiseVirtuals(emphasis.virtualAnchors, 1.12, ME.ANCHOR);
  raiseSlots(emphasis.pinned, 1.2, ME.PINNED);
  raiseSlots(emphasis.members, 1.42, ME.MEMBER);
  raiseVirtuals(emphasis.virtualMembers, 1.42, ME.MEMBER);
  raiseSlots(emphasis.hoverMembers ?? [], 1.62, ME.PATH);
  raiseSlots(emphasis.pathNodes, 1.58, ME.PATH);
  raise(emphasis.hovered, 1.78, ME.HOVERED);
  raise(emphasis.hoveredId ? virtualSlotOf(emphasis.hoveredId) : null, 1.78, ME.HOVERED);
  raise(emphasis.selected, 2, ME.SELECTED);
  raise(emphasis.selectedId ? virtualSlotOf(emphasis.selectedId) : null, 2, ME.SELECTED);
}
