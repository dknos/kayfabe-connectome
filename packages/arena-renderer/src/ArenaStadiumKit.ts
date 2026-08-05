/**
 * Shared vocabulary for the stadium shell.
 *
 * The architecture is deliberately SUBORDINATE to the data. Every colour here
 * is structural — graphite, charcoal, steel, desaturated navy — because the
 * saturated end of the palette is spoken for and means something:
 *
 *   gold   championship / title activity   (the rail, the selection halo)
 *   cyan   same-side, documented tag partnership
 *   ember  documented opposition
 *
 * A stadium that tinted its seating amber would be making a championship claim
 * about a bank of chairs. So the shell stays in the greys and the one blue that
 * cannot be mistaken for a relationship, and light — not hue — carries the
 * spectacle.
 */
import {
  BufferAttribute, BufferGeometry, type TypedArray,
} from "three";

/** Structural palette. Nothing here may collide with a semantic colour. */
export const SHELL = {
  /** the floor, darkest thing in the room */
  FLOOR: 0x080a0e,
  /** lower bowl terraces */
  GRAPHITE: 0x11151c,
  /** upper bowl silhouette, read as distance rather than surface */
  CHARCOAL: 0x0d1116,
  /** truss, barricade rails, structural steel */
  STEEL: 0x2a313c,
  /** aisle cuts and section dividers */
  NAVY: 0x161f2c,
  /** the ring canvas — lighter, because it is the lit centre of the room */
  CANVAS: 0x1d242e,
  /** ring ropes and apron trim */
  TRIM: 0x39424f,
} as const;

/**
 * Deterministic per-instance variation.
 *
 * `Math.random()` is forbidden in every builder here. Panel jitter, distant
 * light placement and dust seeding all look like harmless decoration and all
 * would make the same scope build a different stadium on each mount — which
 * breaks byte-identical formation output, screenshot comparison and URL
 * restore at once. A hash of the instance index gives the same variation for
 * free and stays reproducible.
 */
export function hash01(index: number, salt: number): number {
  let h = (Math.imul(index + 1, 374761393) + Math.imul(salt + 1, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Signed variation in [-1, 1]. */
export function hashSigned(index: number, salt: number): number {
  return hash01(index, salt) * 2 - 1;
}

/**
 * The seating is an ELLIPSE, not a circle.
 *
 * `layoutArena` seats every card at `cos(angle) * radius * 0.82`
 * (ArenaLayouts.ts). Anything placed on an unsquashed circle — a terrace, a
 * divider, a section sign — drifts off the arc it is supposed to belong to,
 * worst at the flanks where the error is largest. One shared constant so the
 * shell and the seating can never disagree.
 */
export const SEAT_Z_SQUASH = 0.82;

/** Where a seat at this angle and radius actually sits. */
export function seatX(angle: number, radius: number): number {
  return Math.sin(angle) * radius;
}
export function seatZ(angle: number, radius: number): number {
  return Math.cos(angle) * radius * SEAT_Z_SQUASH;
}

/**
 * Concatenate geometries that share an attribute layout into one buffer.
 *
 * three ships `BufferGeometryUtils.mergeGeometries`, but it is an examples
 * module and pulling it in for position/normal-only shells costs more than the
 * forty lines it replaces. Merging is not an optimisation here, it is the
 * budget: an un-merged bowl is one draw call per terrace, and the whole
 * environment has to fit inside 24 at high tier and 6 at low.
 *
 * Inputs are disposed as they are consumed — they are scratch, and a builder
 * that forgot to free them would leak a full shell on every rebuild.
 */
/**
 * Merge parts that differ only in colour into one geometry with a colour
 * attribute.
 *
 * The alternative is a material per surface, and a material per surface is a
 * draw call per surface: floor, ring canvas, apron, ropes, ramp and barricades
 * would be six before a single terrace exists. Baking the structural colour
 * into the vertices costs three floats a vertex and collapses the whole stage
 * into one `MeshStandardMaterial({ vertexColors: true })`.
 *
 * The colours are structural greys by construction — see SHELL — so this is
 * not a route for data colour to leak into the architecture.
 */
export function mergeColored(parts: { geo: BufferGeometry; color: number }[]): BufferGeometry {
  const geos = parts.map((p) => p.geo);
  let vertices = 0;
  for (const geo of geos) {
    const pos = geo.getAttribute("position");
    vertices += pos ? pos.count : 0;
  }
  const color = new Float32Array(vertices * 3);
  let off = 0;
  for (const part of parts) {
    const pos = part.geo.getAttribute("position");
    if (!pos) continue;
    // sRGB hex to the linear-space values the renderer's colour management
    // expects. Assigning the hex bytes straight in makes every structural grey
    // read roughly twice as bright as intended and the shell stops being
    // subordinate to the cards.
    const r = ((part.color >> 16) & 255) / 255;
    const g = ((part.color >> 8) & 255) / 255;
    const b = (part.color & 255) / 255;
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    for (let i = 0; i < pos.count; i++) {
      color[(off + i) * 3] = lr;
      color[(off + i) * 3 + 1] = lg;
      color[(off + i) * 3 + 2] = lb;
    }
    off += pos.count;
  }
  const out = mergePositions(geos);
  out.setAttribute("color", new BufferAttribute(color, 3));
  return out;
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

export function mergePositions(parts: BufferGeometry[]): BufferGeometry {
  let vertices = 0;
  let indices = 0;
  let hasNormal = true;
  let hasUv = true;
  for (const part of parts) {
    const pos = part.getAttribute("position");
    vertices += pos ? pos.count : 0;
    indices += part.index ? part.index.count : pos ? pos.count : 0;
    if (!part.getAttribute("normal")) hasNormal = false;
    if (!part.getAttribute("uv")) hasUv = false;
  }
  const position = new Float32Array(vertices * 3);
  const normal = hasNormal ? new Float32Array(vertices * 3) : null;
  const uv = hasUv ? new Float32Array(vertices * 2) : null;
  // A 16-bit index silently wraps past 65,535 vertices, which shows up as
  // geometry folding back through the middle of the room rather than as an
  // error. Pick the width from the actual count.
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  let vOff = 0;
  let iOff = 0;
  for (const part of parts) {
    const pos = part.getAttribute("position");
    if (!pos) continue;
    position.set(pos.array as TypedArray, vOff * 3);
    if (normal) {
      const n = part.getAttribute("normal");
      if (n) normal.set(n.array as TypedArray, vOff * 3);
    }
    if (uv) {
      const t = part.getAttribute("uv");
      if (t) uv.set(t.array as TypedArray, vOff * 2);
    }
    if (part.index) {
      const src = part.index.array;
      for (let i = 0; i < src.length; i++) index[iOff + i] = (src[i] as number) + vOff;
      iOff += src.length;
    } else {
      for (let i = 0; i < pos.count; i++) index[iOff + i] = vOff + i;
      iOff += pos.count;
    }
    vOff += pos.count;
    part.dispose();
  }

  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(position, 3));
  if (normal) out.setAttribute("normal", new BufferAttribute(normal, 3));
  if (uv) out.setAttribute("uv", new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(index, 1));
  return out;
}
