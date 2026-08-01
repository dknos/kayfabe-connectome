import { TRACE_SAMPLES, hash01 } from "@kayfabe/morph-renderer";

/**
 * Trace geometry: organic bows and routed schematic traces, both emitted as
 * exactly TRACE_SAMPLES points so corresponding vertices interpolate.
 */

/**
 * Connectome-flavoured organic fiber between two ORGANIC positions: a
 * quadratic bezier whose midpoint bows away from the core, with a small
 * deterministic jitter per key so bundles read as tissue, not wires.
 */
export function sampleOrganicBow(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  seed: number,
): Float32Array {
  const out = new Float32Array(TRACE_SAMPLES * 3);
  let mx = (ax + bx) / 2;
  let my = (ay + by) / 2;
  let mz = (az + bz) / 2;
  // hollow-core pushout, scaled to organic world units
  const r = Math.hypot(mx, my, mz);
  const minR = 105;
  if (r < minR && r > 1e-6) {
    const k = ((minR - r) * 0.85) / r;
    mx += mx * k;
    my += my * k;
    mz += mz * k;
  }
  mx += (hash01(seed) - 0.5) * 16;
  my += (hash01(seed + 7919) - 0.5) * 16;
  mz += (hash01(seed + 104729) - 0.5) * 16;
  for (let s = 0; s < TRACE_SAMPLES; s++) {
    const t = s / (TRACE_SAMPLES - 1);
    const u = 1 - t;
    out[s * 3] = u * u * ax + 2 * u * t * mx + t * t * bx;
    out[s * 3 + 1] = u * u * ay + 2 * u * t * my + t * t * by;
    out[s * 3 + 2] = u * u * az + 2 * u * t * mz + t * t * bz;
  }
  return out;
}

/**
 * Resample an arbitrary polyline to exactly TRACE_SAMPLES points, evenly by
 * arc length — every routed trace has the same vertex budget as its organic
 * ancestor, which is what makes the two interpolable.
 */
export function resample(points: number[], z: number): Float32Array {
  const n = points.length / 2;
  const out = new Float32Array(TRACE_SAMPLES * 3);
  const cum: number[] = [0];
  for (let i = 1; i < n; i++) {
    const dx = points[i * 2]! - points[(i - 1) * 2]!;
    const dy = points[i * 2 + 1]! - points[(i - 1) * 2 + 1]!;
    cum.push(cum[i - 1]! + Math.hypot(dx, dy));
  }
  const total = cum[n - 1]! || 1;
  let seg = 0;
  for (let s = 0; s < TRACE_SAMPLES; s++) {
    const target = (s / (TRACE_SAMPLES - 1)) * total;
    while (seg < n - 2 && cum[seg + 1]! < target) seg++;
    const span = cum[seg + 1]! - cum[seg]! || 1;
    const t = (target - cum[seg]!) / span;
    out[s * 3] = points[seg * 2]! + (points[(seg + 1) * 2]! - points[seg * 2]!) * t;
    out[s * 3 + 1] = points[seg * 2 + 1]! + (points[(seg + 1) * 2 + 1]! - points[seg * 2 + 1]!) * t;
    out[s * 3 + 2] = z;
  }
  return out;
}

/**
 * Orthogonal schematic route with rounded corners: exit port horizontally,
 * run along an assigned vertical lane, enter the destination port
 * horizontally. `lane` staggers parallel traces so a bundle reads as a bus.
 */
export function routeOrtho(
  fromX: number, fromY: number,
  toX: number, toY: number,
  laneX: number,
  z: number,
  cornerR = 7,
): Float32Array {
  const pts: number[] = [];
  const push = (x: number, y: number) => pts.push(x, y);
  push(fromX, fromY);
  if (Math.abs(fromY - toY) < 1e-3) {
    push(toX, toY);
  } else {
    corner(pts, fromX, fromY, laneX, fromY, laneX, toY, cornerR);
    corner(pts, laneX, fromY, laneX, toY, toX, toY, cornerR);
    push(toX, toY);
  }
  return resample(pts, z);
}

/** vertical bus route: exit vertically to a horizontal lane, run, drop in */
export function routeOrthoV(
  fromX: number, fromY: number,
  toX: number, toY: number,
  laneY: number,
  z: number,
  cornerR = 7,
): Float32Array {
  const pts: number[] = [];
  pts.push(fromX, fromY);
  if (Math.abs(fromX - toX) < 1e-3) {
    pts.push(toX, toY);
  } else {
    corner(pts, fromX, fromY, fromX, laneY, toX, laneY, cornerR);
    corner(pts, fromX, laneY, toX, laneY, toX, toY, cornerR);
    pts.push(toX, toY);
  }
  return resample(pts, z);
}

/** append the two blend points of a rounded corner at (cx, cy) */
function corner(
  pts: number[],
  px: number, py: number,
  cx: number, cy: number,
  nx: number, ny: number,
  r: number,
): void {
  const d1 = Math.hypot(cx - px, cy - py);
  const d2 = Math.hypot(nx - cx, ny - cy);
  const rr = Math.min(r, d1 / 2, d2 / 2);
  if (rr < 0.5) {
    pts.push(cx, cy);
    return;
  }
  const inX = cx - ((cx - px) / (d1 || 1)) * rr;
  const inY = cy - ((cy - py) / (d1 || 1)) * rr;
  const outX = cx + ((nx - cx) / (d2 || 1)) * rr;
  const outY = cy + ((ny - cy) / (d2 || 1)) * rr;
  // quadratic corner approximated with 4 points
  for (let k = 0; k <= 3; k++) {
    const t = k / 3;
    const u = 1 - t;
    pts.push(
      u * u * inX + 2 * u * t * cx + t * t * outX,
      u * u * inY + 2 * u * t * cy + t * t * outY,
    );
  }
}
