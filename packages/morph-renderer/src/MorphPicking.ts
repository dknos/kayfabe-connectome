import type { MorphCamera, MorphScreenPoint } from "./MorphCamera";
import type { MorphNodes } from "./MorphNodes";
import {
  ME,
  MR,
  easeQuintic,
  elementProgress,
  type MorphPickDiagnostic,
  type MorphPickResult,
  type MorphPickSource,
  type MorphRegion,
} from "./types";

export interface MorphProjectedPickCandidate {
  id: string;
  kind: "node" | "virtual";
  slot: number;
  normalizedDistance: number;
  depth: number;
  semanticPriority: number;
  layoutRole: number;
  opacity: number;
}

export interface MorphPickOptions {
  slopPx?: number;
  source?: MorphPickSource;
  stickyId?: string | null;
  activeSlots?: Int32Array;
  activeSlotCount?: number;
  roles?: Uint8Array;
  diagnostic?: MorphPickDiagnostic;
}

/** CSS-pixel hit radius shared by the picker and synthetic input tests. */
export function morphPickHitRadius(pointSizePx: number, slopPx: number): number {
  const point = Number.isFinite(pointSizePx) ? Math.max(0, pointSizePx) : 0;
  const slop = Number.isFinite(slopPx) ? Math.max(0, slopPx) : 0;
  return Math.max(slop, point * 0.55 + 2);
}

const EMPTY_DIAGNOSTIC: MorphPickDiagnostic = {
  id: null,
  source: "programmatic",
  candidateCount: 0,
  durationMs: 0,
  normalizedDistance: Infinity,
  depth: Infinity,
  semanticPriority: ME.AMBIENT,
  layoutRole: MR.BACKGROUND,
};

/**
 * Deterministic comparator exposed for synthetic overlap tests. Distance is
 * normalized by each node's visible hit radius. A meaningful distance lead
 * wins outright; near-ties use front depth, semantic priority, active role,
 * opacity, stickiness and finally stable slot order.
 */
export function selectBestMorphPickCandidate(
  candidates: readonly MorphProjectedPickCandidate[],
  stickyId: string | null = null,
): MorphProjectedPickCandidate | null {
  let best: MorphProjectedPickCandidate | null = null;
  for (const candidate of candidates) {
    if (!eligible(candidate)) continue;
    if (!best || candidateBeats(candidate, best, stickyId)) best = candidate;
  }
  return best;
}

/**
 * Current-position picking. It mirrors shader interpolation and scans a
 * compact active set in organized modes. No candidate arrays or per-pointer
 * sort are created.
 */
export function pickAt(
  cam: MorphCamera,
  nodes: MorphNodes,
  corpusCount: number,
  idOfSlot: (slot: number) => string | null,
  regions: MorphRegion[],
  raw: number,
  px: number,
  py: number,
  options: MorphPickOptions = {},
): MorphPickResult | null {
  const started = performance.now();
  const slopPx = options.slopPx ?? 8;
  const roles = options.roles;
  const diagnostic = options.diagnostic;
  let candidateCount = 0;
  const projected: MorphScreenPoint = { x: 0, y: 0, front: false, depth: 0 };
  let hasBest = false;
  // One scratch candidate is mutated for the duration of the scan. A winning
  // candidate is copied into scalar fields so the scratch can be reused.
  const scratch: MorphProjectedPickCandidate = {
    id: "", kind: "node", slot: -1, normalizedDistance: Infinity, depth: Infinity,
    semanticPriority: ME.AMBIENT, layoutRole: MR.BACKGROUND, opacity: 0,
  };
  const bestCopy: MorphProjectedPickCandidate = { ...scratch };

  const scanSlot = (i: number, ambientOnly: boolean): void => {
    if (i < 0 || i >= nodes.total) return;
    const role = roles?.[i] ?? MR.BACKGROUND;
    const semantic = nodes.semantic?.[i] ?? ME.AMBIENT;
    if (ambientOnly && (role !== MR.BACKGROUND || semantic !== ME.AMBIENT)) return;
    candidateCount++;
    const p = elementProgress(raw, nodes.delay[i]!);
    const alpha = nodes.alphaFrom[i]! + (nodes.alphaTo[i]! - nodes.alphaFrom[i]!) * p;
    if (!Number.isFinite(alpha) || alpha < 0.03) return;
    const e = easeQuintic(p);
    const i3 = i * 3;
    const x = nodes.from[i3]! + (nodes.to[i3]! - nodes.from[i3]!) * e;
    const y = nodes.from[i3 + 1]! + (nodes.to[i3 + 1]! - nodes.from[i3 + 1]!) * e;
    const z = nodes.from[i3 + 2]! + (nodes.to[i3 + 2]! - nodes.from[i3 + 2]!) * e;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    cam.projectInto(x, y, z, projected);
    if (!projected.front || !Number.isFinite(projected.depth) || projected.depth <= 1e-6) return;
    const scale = nodes.scaleFrom[i]! + (nodes.scaleTo[i]! - nodes.scaleFrom[i]!) * e;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const semanticBoost = semantic >= ME.SELECTED ? 0.42
      : semantic >= ME.HOVERED ? 0.34
      : semantic >= ME.PATH ? 0.24
      : semantic >= ME.MEMBER ? 0.18
      : semantic >= ME.PINNED ? 0.08
      : semantic >= ME.ANCHOR ? 0.05 : 0;
    const boost = 1 + Math.max(0, nodes.emph[i]! - 1) * 0.4 + semanticBoost + nodes.glow[i]! * 0.8;
    const pointSize = Math.max(1.15, Math.min(30,
      scale * cam.camera.projectionMatrix.elements[5]! * Math.max(2, cam.viewportHeight) * 0.5 /
      projected.depth * boost));
    const radius = morphPickHitRadius(pointSize, slopPx);
    const dx = projected.x - px;
    const dy = projected.y - py;
    const normalizedDistance = Math.hypot(dx, dy) / radius;
    if (!Number.isFinite(normalizedDistance) || normalizedDistance > 1) return;
    const id = idOfSlot(i);
    if (!id) return;
    scratch.id = id;
    scratch.kind = i >= corpusCount ? "virtual" : "node";
    scratch.slot = i;
    scratch.normalizedDistance = normalizedDistance;
    scratch.depth = projected.depth;
    scratch.semanticPriority = semantic;
    scratch.layoutRole = role;
    scratch.opacity = alpha;
    if (!hasBest || candidateBeats(scratch, bestCopy, options.stickyId ?? null)) {
      Object.assign(bestCopy, scratch);
      hasBest = true;
    }
  };

  const activeCount = Math.min(options.activeSlotCount ?? 0, options.activeSlots?.length ?? 0);
  if (options.activeSlots) {
    for (let j = 0; j < activeCount; j++) scanSlot(options.activeSlots[j]!, false);
  } else {
    for (let i = 0; i < nodes.total; i++) scanSlot(i, false);
  }

  // In organized modes the compact list deliberately excludes the ambient
  // rack. Context stays visible but cannot steal hover or force a full-corpus
  // scan for every empty pointer position. Organic includes all useful slots.
  if (hasBest) {
    finishDiagnostic(diagnostic, started, options.source, candidateCount, bestCopy);
    return { id: bestCopy.id, kind: bestCopy.kind };
  }

  // Bounded organized furniture is considered only after eligible entities.
  const halfSlop = (slopPx * cam.worldPerPixel) / 2;
  let bestRegion: MorphRegion | null = null;
  let bestArea = Infinity;
  for (const region of regions) {
    if (!region.pick || region.alpha < 0.03) continue;
    candidateCount++;
    const [wx, wy] = cam.screenToPlane(px, py, region.z);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
    const hw = Math.max(region.w / 2, halfSlop);
    const hh = Math.max(region.h / 2, halfSlop);
    if (Math.abs(wx - region.x) <= hw && Math.abs(wy - region.y) <= hh) {
      const area = Math.abs(region.w * region.h);
      if (area < bestArea || (area === bestArea && region.key < (bestRegion?.key ?? "\uffff"))) {
        bestArea = area;
        bestRegion = region;
      }
    }
  }
  if (bestRegion) {
    const centre = cam.worldToScreen(bestRegion.x, bestRegion.y, bestRegion.z);
    finishDiagnostic(diagnostic, started, options.source, candidateCount, {
      id: bestRegion.pick!, kind: "node", slot: -1, normalizedDistance: 0,
      depth: Number.isFinite(centre.depth) ? centre.depth : Infinity,
      semanticPriority: ME.AMBIENT, layoutRole: MR.BACKGROUND, opacity: bestRegion.alpha,
    });
    return { id: bestRegion.pick!, kind: "region" };
  }
  finishDiagnostic(diagnostic, started, options.source, candidateCount, null);
  return null;
}

function eligible(candidate: MorphProjectedPickCandidate): boolean {
  return !!candidate.id && Number.isFinite(candidate.normalizedDistance) && candidate.normalizedDistance <= 1 &&
    Number.isFinite(candidate.depth) && candidate.depth > 1e-6 &&
    Number.isFinite(candidate.opacity) && candidate.opacity >= 0.03;
}

function candidateBeats(
  candidate: MorphProjectedPickCandidate,
  best: MorphProjectedPickCandidate,
  stickyId: string | null,
): boolean {
  const distanceLead = best.normalizedDistance - candidate.normalizedDistance;
  // A 0.15 normalized-radius lead is visually material. Keeping that cutoff
  // below the depth tie-band also makes the exact center of a selected core
  // reacquirable when perspective projects a nearer lane almost on top of it.
  if (Math.abs(distanceLead) > 0.15) return distanceLead > 0;
  const relativeDepth = candidate.depth / Math.max(1e-6, best.depth);
  if (relativeDepth < 0.92) return true;
  if (relativeDepth > 1.08) return false;
  if (candidate.semanticPriority !== best.semanticPriority) return candidate.semanticPriority > best.semanticPriority;
  const candidateActive = candidate.layoutRole === MR.BACKGROUND ? 0 : 1;
  const bestActive = best.layoutRole === MR.BACKGROUND ? 0 : 1;
  if (candidateActive !== bestActive) return candidateActive > bestActive;
  if (Math.abs(candidate.opacity - best.opacity) > 0.15) return candidate.opacity > best.opacity;
  if (stickyId) {
    const candidateSticky = candidate.id === stickyId;
    const bestSticky = best.id === stickyId;
    if (candidateSticky !== bestSticky) return candidateSticky;
  }
  if (candidate.normalizedDistance !== best.normalizedDistance) return candidate.normalizedDistance < best.normalizedDistance;
  return candidate.slot < best.slot || (candidate.slot === best.slot && candidate.id < best.id);
}

function finishDiagnostic(
  out: MorphPickDiagnostic | undefined,
  started: number,
  source: MorphPickSource | undefined,
  candidateCount: number,
  best: MorphProjectedPickCandidate | null,
): void {
  if (!out) return;
  Object.assign(out, EMPTY_DIAGNOSTIC);
  out.id = best?.id ?? null;
  out.source = source ?? "programmatic";
  out.candidateCount = candidateCount;
  out.durationMs = Math.max(0, performance.now() - started);
  if (best) {
    out.normalizedDistance = best.normalizedDistance;
    out.depth = best.depth;
    out.semanticPriority = best.semanticPriority;
    out.layoutRole = best.layoutRole;
  }
}
