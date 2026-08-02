import type { GroupKey, MemberResult } from "./members";

/**
 * Canonical semantic emphasis, expressed only in stable corpus ids.
 *
 * Lenses may map these ids to their own GPU slots, but they must not derive a
 * different semantic population from layout roles or a drawn-edge subset.
 * Priority is part of the contract: selected > hovered > path > members >
 * anchors > ambient. Pinned is retained as a durable reader annotation and is
 * applied below path emphasis without masking semantic membership.
 */
export interface SemanticEmphasis {
  selected: string | null;
  hovered: string | null;
  members: readonly string[];
  anchors: readonly string[];
  pinned: readonly string[];
  pathNodes: readonly string[];
  memberGroup: GroupKey;
  basis: string;
  caveat: string | null;
  coverageWarnings: readonly string[];
  isolate: boolean;
}

export interface SemanticEmphasisSource {
  selection: { kind: "node"; id: string } | { kind: "edge"; edge: number } | null;
  hoverId: string | null;
  members: MemberResult;
  memberGroup: GroupKey;
  isolate: boolean;
  pinned: string[];
  pathResult: { nodes: string[]; edges: number[] } | null;
}

const EMPTY_IDS: readonly string[] = Object.freeze([] as string[]);

/** The one AppState -> semantic contract selector consumed by every lens. */
export function selectSemanticEmphasis(source: SemanticEmphasisSource): SemanticEmphasis {
  return {
    selected: source.selection?.kind === "node" ? source.selection.id : null,
    hovered: source.hoverId,
    members: source.members.ids,
    anchors: source.members.anchors ?? EMPTY_IDS,
    pinned: source.pinned,
    pathNodes: source.pathResult?.nodes ?? EMPTY_IDS,
    memberGroup: source.memberGroup,
    basis: source.members.basis,
    caveat: source.members.caveat ?? null,
    coverageWarnings: source.members.coverageWarnings ?? EMPTY_IDS,
    isolate: source.isolate,
  };
}

/** Cheap subscription guard; every referenced collection is immutable in the
 * shared store, so reference changes are the canonical semantic update. */
export function semanticEmphasisChanged(
  next: SemanticEmphasisSource,
  prev: SemanticEmphasisSource,
): boolean {
  return (
    next.selection !== prev.selection ||
    next.hoverId !== prev.hoverId ||
    next.members !== prev.members ||
    next.memberGroup !== prev.memberGroup ||
    next.isolate !== prev.isolate ||
    next.pinned !== prev.pinned ||
    next.pathResult !== prev.pathResult
  );
}
