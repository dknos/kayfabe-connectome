import {
  MR,
  hash01,
  type LayoutBounds,
  type MorphLabel,
  type MorphRegion,
} from "@kayfabe/morph-renderer";
import type { MorphData } from "../morphAdapter";
import { RACK, growBounds } from "./layoutTypes";

/**
 * Put non-participating corpus nodes into a distant volumetric context shell.
 *
 * This is intentionally not a second diagram. It preserves identity and a
 * sense of the full corpus while the active structure remains readable. The
 * shell is deterministic, community-banded and extremely low exposure; when
 * context is hidden its alpha also falls below the pick threshold.
 */
export function packBackground(
  data: MorphData,
  exclude: Set<number>,
  board: LayoutBounds,
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
  bounds: LayoutBounds,
  contextVisible = true,
): { regions: MorphRegion[]; labels: MorphLabel[] } {
  const labels: MorphLabel[] = [];
  const model = data.model;
  const cx = finiteMid(board.minX, board.maxX);
  const cy = finiteMid(board.minY, board.maxY);
  const span = Math.max(520, board.maxX - board.minX, board.maxY - board.minY);
  const baseRadius = span * 0.82 + RACK.margin;
  const alpha = contextVisible ? RACK.dimAlpha : 0.001;
  let ambientCount = 0;

  // Golden-angle distribution avoids rows and keeps stable ids stable. A
  // community phase makes related ambient people read as faint tissue bands.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < data.count; i++) {
    if (exclude.has(i)) continue;
    const type = model.nodes.type[i]!;
    const comm = Math.max(0, model.nodes.community[i]!);
    const h0 = hash01(i * 17 + 11);
    const h1 = hash01(i * 29 + 23);
    const band = ((comm % 19) - 9) / 9;
    const yUnit = Math.max(-0.94, Math.min(0.94, band * 0.72 + (h0 - 0.5) * 0.22));
    const radial = Math.sqrt(Math.max(0.001, 1 - yUnit * yUnit));
    const angle = i * golden + (comm % 31) * 0.17;
    const radius = baseRadius * (0.92 + h1 * 0.34);

    let x = cx + Math.cos(angle) * radial * radius;
    let y = cy + yUnit * radius * 0.72;
    let z = Math.sin(angle) * radial * radius;
    let a = alpha;
    let s: number = RACK.scale;

    // Ambient entity types retain their silhouette and semantic strata, but
    // remain subordinate to active promotion/title anchors.
    if (type === 1) {
      y = cy + radius * 0.55 + (h0 - 0.5) * 100;
      z -= radius * 0.22;
      a = contextVisible ? 0.052 : 0.001;
      s = 2.4;
    } else if (type === 2) {
      y = cy + radius * 0.34 + (h0 - 0.5) * 120;
      z += radius * 0.28;
      a = contextVisible ? 0.044 : 0.001;
      s = 1.8;
    }

    const i3 = i * 3;
    targets[i3] = x;
    targets[i3 + 1] = y;
    targets[i3 + 2] = z;
    opacity[i] = a;
    scale[i] = s;
    role[i] = MR.BACKGROUND;
    delay[i] = 0.35 + hash01(i) * 0.65;
    growBounds(bounds, x, y);
    ambientCount++;
  }

  void ambientCount;

  // Regions are deliberately absent: a giant backplate would flatten the
  // shell and reintroduce the motherboard silhouette.
  return { regions: [], labels };
}

function finiteMid(a: number, b: number): number {
  return Number.isFinite(a) && Number.isFinite(b) ? (a + b) * 0.5 : 0;
}
