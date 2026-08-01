import type { MorphCamera } from "./MorphCamera";
import type { MorphNodes } from "./MorphNodes";
import type { MorphRegion, MorphPickResult } from "./types";

/**
 * CPU picking. Nodes are tested against their DESTINATION — a click during a
 * morph selects what the reader aimed at, not the in-flight position (the
 * atlas invariant). Nodes win outright over regions; region ties resolve to
 * the smallest area so a module on a backplate stays clickable.
 */
export function pickAt(
  cam: MorphCamera,
  nodes: MorphNodes,
  corpusCount: number,
  idOfSlot: (slot: number) => string | null,
  regions: MorphRegion[],
  px: number,
  py: number,
  slopPx = 8,
): MorphPickResult | null {
  // nearest node within slop, screen-space, destination positions
  let bestSlot = -1;
  let bestD = slopPx;
  for (let i = 0; i < nodes.total; i++) {
    if (nodes.alphaTo[i]! < 0.02) continue;
    const p = cam.worldToScreen(nodes.to[i * 3]!, nodes.to[i * 3 + 1]!, nodes.to[i * 3 + 2]!);
    if (!p.front) continue;
    const d = Math.hypot(p.x - px, p.y - py);
    // generous slop for emphasized chips, tight for background dust
    const allow = nodes.alphaTo[i]! > 0.5 ? slopPx * 1.6 : slopPx;
    if (d < Math.min(bestD, allow)) {
      bestD = d;
      bestSlot = i;
    }
  }
  if (bestSlot >= 0) {
    const id = idOfSlot(bestSlot);
    if (id) return { id, kind: bestSlot >= corpusCount ? "virtual" : "node" };
  }

  // regions — world-plane AABB test at each region's z
  const halfSlop = (slopPx * cam.worldPerPixel) / 2;
  let best: MorphRegion | null = null;
  let bestArea = Infinity;
  for (const r of regions) {
    if (!r.pick) continue;
    const [wx, wy] = cam.screenToPlane(px, py, r.z);
    const hw = Math.max(r.w / 2, halfSlop);
    const hh = Math.max(r.h / 2, halfSlop);
    if (Math.abs(wx - r.x) <= hw && Math.abs(wy - r.y) <= hh) {
      const area = r.w * r.h;
      if (area < bestArea) {
        bestArea = area;
        best = r;
      }
    }
  }
  return best ? { id: best.pick!, kind: "region" } : null;
}
