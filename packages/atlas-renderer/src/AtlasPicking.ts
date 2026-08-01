import type { AtlasCameraController } from "./AtlasCameraController";
import type { AtlasPickResult } from "./types";

/**
 * CPU picking against the TARGET layout.
 *
 * Exact rather than sampled: every selectable thing in the atlas is an
 * axis-aligned rectangle or a disc in a plane of constant z, so a ray/plane
 * intersection answers the question outright, and it stays exact when the
 * board is tilted (which a screen-space rectangle test would not, because the
 * rectangles shear).
 *
 * Two rules that are easy to get wrong and very visible when you do:
 *   - Thin geometry gets a pixel-sized slop so a 2 px title rail is reachable
 *     on a touch screen without making a 40 px platform greedy.
 *   - Ties resolve to the SMALLER target. A title rail lying on its
 *     promotion's platform must win, or no title in the overview is clickable.
 */

export interface PickRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}
export interface PickDot {
  id: string;
  x: number;
  y: number;
  r: number;
  z: number;
}

export function pickAt(
  cam: AtlasCameraController,
  rects: PickRect[],
  dots: PickDot[],
  px: number,
  py: number,
  slopPx = 6,
): AtlasPickResult | null {
  const wpp = cam.worldPerPixel;
  const slop = slopPx * wpp;

  // Dots first: a holder node sits ON its reign block, and the node is the
  // more specific answer.
  let bestDot: { id: string; d: number } | null = null;
  for (const d of dots) {
    const p = cam.screenToPlane(px, py, d.z);
    const dx = p[0] - d.x;
    const dy = p[1] - d.y;
    const r = Math.max(d.r * 0.5, slop);
    const dist = Math.hypot(dx, dy);
    if (dist > r) continue;
    if (!bestDot || dist < bestDot.d) bestDot = { id: d.id, d: dist };
  }
  if (bestDot) return { id: bestDot.id, kind: "dot" };

  let best: { id: string; area: number } | null = null;
  for (const r of rects) {
    const p = cam.screenToPlane(px, py, r.z);
    const hw = Math.max(r.w / 2, slop * 0.5);
    const hh = Math.max(r.h / 2, slop * 0.5);
    if (Math.abs(p[0] - r.x) > hw || Math.abs(p[1] - r.y) > hh) continue;
    const area = r.w * r.h;
    if (!best || area < best.area) best = { id: r.id, area };
  }
  return best ? { id: best.id, kind: "quad" } : null;
}
