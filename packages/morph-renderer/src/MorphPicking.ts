import type { MorphCamera, MorphScreenPoint } from "./MorphCamera";
import type { MorphNodes } from "./MorphNodes";
import { easeQuintic, elementProgress, type MorphRegion, type MorphPickResult } from "./types";

/**
 * Current-position picking. CPU work stays allocation-free and uses the exact
 * from/to/delay interpolation that the GPU node shader uses. Ambient context
 * below the visibility threshold is intentionally not pickable; every active
 * or emphasized corpus/virtual node remains eligible throughout a morph.
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
  slopPx = 8,
): MorphPickResult | null {
  let bestSlot = -1;
  let bestD2 = (slopPx * 2.1) ** 2;
  const projected: MorphScreenPoint = { x: 0, y: 0, front: false, depth: 0 };

  for (let i = 0; i < nodes.total; i++) {
    const p = elementProgress(raw, nodes.delay[i]!);
    const alpha = nodes.alphaFrom[i]! + (nodes.alphaTo[i]! - nodes.alphaFrom[i]!) * p;
    if (alpha < 0.012) continue;
    const e = easeQuintic(p);
    const i3 = i * 3;
    const x = nodes.from[i3]! + (nodes.to[i3]! - nodes.from[i3]!) * e;
    const y = nodes.from[i3 + 1]! + (nodes.to[i3 + 1]! - nodes.from[i3 + 1]!) * e;
    const z = nodes.from[i3 + 2]! + (nodes.to[i3 + 2]! - nodes.from[i3 + 2]!) * e;
    cam.projectInto(x, y, z, projected);
    if (!projected.front) continue;
    const dx = projected.x - px;
    const dy = projected.y - py;
    const d2 = dx * dx + dy * dy;
    const scale = nodes.scaleFrom[i]! + (nodes.scaleTo[i]! - nodes.scaleFrom[i]!) * e;
    const semantic = nodes.semantic?.[i] ?? 0;
    const allow = alpha > 0.45
      ? Math.max(slopPx * 1.55, Math.min(22, scale * 0.55 + semantic * 1.2))
      : slopPx;
    if (d2 <= allow * allow && d2 < bestD2) {
      bestD2 = d2;
      bestSlot = i;
    }
  }
  if (bestSlot >= 0) {
    const id = idOfSlot(bestSlot);
    if (id) return { id, kind: bestSlot >= corpusCount ? "virtual" : "node" };
  }

  // Bounded organized furniture remains pickable on its actual z plane.
  const halfSlop = (slopPx * cam.worldPerPixel) / 2;
  let best: MorphRegion | null = null;
  let bestArea = Infinity;
  for (const region of regions) {
    if (!region.pick) continue;
    const [wx, wy] = cam.screenToPlane(px, py, region.z);
    const hw = Math.max(region.w / 2, halfSlop);
    const hh = Math.max(region.h / 2, halfSlop);
    if (Math.abs(wx - region.x) <= hw && Math.abs(wy - region.y) <= hh) {
      const area = region.w * region.h;
      if (area < bestArea) {
        bestArea = area;
        best = region;
      }
    }
  }
  return best ? { id: best.pick!, kind: "region" } : null;
}
