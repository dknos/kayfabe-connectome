/**
 * The floor, the ring, the entrance and the barricade line.
 *
 * Everything here is one merged geometry behind one `vertexColors` material,
 * so the whole stage is a single draw call. That is a budget decision rather
 * than a micro-optimisation: the environment has to fit inside 24 draw calls
 * at high tier and 6 at low, and a material per surface would spend six of
 * them before a terrace exists.
 *
 * Placement is derived, never guessed. The horseshoe seats cards across
 * angles -2.44..2.44 (ArenaLayouts.personSections / eraSections), which leaves
 * an ~80-degree gap centred on -Z. That gap is where an entrance belongs, so
 * the ramp and tunnel are built into it rather than through the seating.
 */
import { BoxGeometry, CircleGeometry, CylinderGeometry, type BufferGeometry } from "three";
import { SEAT_Z_SQUASH, SHELL, mergeColored, seatX, seatZ } from "./ArenaStadiumKit";
import { FLOOR_Y, SEAT_INNER_RADIUS } from "./types";

/** The seated arc, and therefore the gap the entrance occupies. */
const SEAT_ARC_HALF = 2.44;

const RING_HALF = 3.0;
const APRON_Y = -1.55;
const APRON_TOP = -1.38;
const CANVAS_Y = -1.33;
const POST_H = 1.2;

export interface ArenaStageOptions {
  /** Half-extent of the seated field, so the floor reaches past the bowl. */
  extent: number;
  /** Low tier drops the ring furniture and the entrance; the floor, the mat
   *  and the barricade line are what make the room read as a room. */
  detail: "full" | "simple";
}

/**
 * Build the stage as one geometry.
 *
 * Returns geometry only. Ownership of the mesh, its material and its disposal
 * belongs to ArenaEnvironment, which is also what decides when a rebuild is
 * actually necessary.
 */
export function buildStage(options: ArenaStageOptions): BufferGeometry {
  const parts: { geo: BufferGeometry; color: number }[] = [];
  const full = options.detail === "full";

  // --- floor -------------------------------------------------------------
  // Squashed on Z by the same factor the seating uses, so the floor is an
  // ellipse under an elliptical bowl rather than a circle poking out of it.
  // The floor is the single largest fill surface in the scene, and most of it
  // sits outside the framing anyway. The simple tier keeps it just past the
  // seating rather than sweeping the whole room.
  const floorR = full
    ? Math.max(options.extent * 1.55, 26)
    : Math.max(options.extent * 1.08, 15);
  const floor = new CircleGeometry(floorR, full ? 72 : 40);
  floor.rotateX(-Math.PI / 2);
  floor.scale(1, 1, SEAT_Z_SQUASH);
  floor.translate(0, FLOOR_Y, 0);
  parts.push({ geo: floor, color: SHELL.FLOOR });

  // --- ring --------------------------------------------------------------
  // A skirted apron with an inset canvas. The canvas is the lightest surface
  // in the room because it is the lit centre of it; everything structural
  // stays darker so the cards keep the reader's eye.
  const skirt = new BoxGeometry(RING_HALF * 2 + 0.5, 0.5, RING_HALF * 2 + 0.5);
  skirt.translate(0, FLOOR_Y + 0.25, 0);
  parts.push({ geo: skirt, color: SHELL.GRAPHITE });

  const apron = new BoxGeometry(RING_HALF * 2 + 0.34, APRON_TOP - APRON_Y + 0.17, RING_HALF * 2 + 0.34);
  apron.translate(0, APRON_Y, 0);
  parts.push({ geo: apron, color: SHELL.TRIM });

  const canvas = new BoxGeometry(RING_HALF * 2, 0.09, RING_HALF * 2);
  canvas.translate(0, CANVAS_Y, 0);
  parts.push({ geo: canvas, color: SHELL.CANVAS });

  if (full) {
    // Four posts and three ropes a side. The ropes are what make the shape
    // unmistakably a wrestling ring rather than a plinth, and at 0.04 units
    // thick they cost almost nothing once merged.
    for (let i = 0; i < 4; i++) {
      const sx = i === 0 || i === 3 ? -1 : 1;
      const sz = i < 2 ? -1 : 1;
      const post = new CylinderGeometry(0.1, 0.11, POST_H, 8);
      post.translate(sx * RING_HALF, CANVAS_Y + POST_H / 2, sz * RING_HALF);
      parts.push({ geo: post, color: SHELL.STEEL });
    }
    for (let rope = 0; rope < 3; rope++) {
      const y = CANVAS_Y + 0.34 + rope * 0.32;
      for (let side = 0; side < 4; side++) {
        const along = side % 2 === 0;
        const geo = new BoxGeometry(along ? RING_HALF * 2 : 0.045, 0.045, along ? 0.045 : RING_HALF * 2);
        geo.translate(
          along ? 0 : (side === 1 ? 1 : -1) * RING_HALF,
          y,
          along ? (side === 0 ? -1 : 1) * RING_HALF : 0,
        );
        parts.push({ geo, color: SHELL.TRIM });
      }
    }

    // --- entrance ------------------------------------------------------
    // Straight down -Z, through the gap the seating leaves. Building it
    // anywhere else would drive a ramp through occupied rows.
    const mouthZ = -(SEAT_INNER_RADIUS * SEAT_Z_SQUASH + 6.5);
    const rampFrom = -RING_HALF - 0.4;
    const rampLen = Math.abs(mouthZ - rampFrom);
    const ramp = new BoxGeometry(2.9, 0.3, rampLen);
    ramp.translate(0, FLOOR_Y + 0.15, rampFrom - rampLen / 2);
    parts.push({ geo: ramp, color: SHELL.GRAPHITE });
    for (const sx of [-1, 1]) {
      const kerb = new BoxGeometry(0.16, 0.5, rampLen);
      kerb.translate(sx * 1.53, FLOOR_Y + 0.25, rampFrom - rampLen / 2);
      parts.push({ geo: kerb, color: SHELL.STEEL });
    }
    // Tunnel: two uprights and a lintel. A portal, not a room — the corpus
    // documents no backstage, so there is nothing behind it to show.
    for (const sx of [-1, 1]) {
      const jamb = new BoxGeometry(0.55, 4.4, 0.7);
      jamb.translate(sx * 2.1, FLOOR_Y + 2.2, mouthZ);
      parts.push({ geo: jamb, color: SHELL.CHARCOAL });
    }
    const lintel = new BoxGeometry(4.75, 0.8, 0.7);
    lintel.translate(0, FLOOR_Y + 4.8, mouthZ);
    parts.push({ geo: lintel, color: SHELL.CHARCOAL });
  }

  // --- barricade ---------------------------------------------------------
  // A low line just inside the first seated row, following the same squashed
  // arc the seats do. This is the element that separates "floor" from
  // "seating" and makes the bowl read as containing something.
  const barricadeR = SEAT_INNER_RADIUS - 1.15;
  const segments = full ? 48 : 24;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a0 = -SEAT_ARC_HALF + t0 * SEAT_ARC_HALF * 2;
    const a1 = -SEAT_ARC_HALF + t1 * SEAT_ARC_HALF * 2;
    const x0 = seatX(a0, barricadeR), z0 = seatZ(a0, barricadeR);
    const x1 = seatX(a1, barricadeR), z1 = seatZ(a1, barricadeR);
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    const panel = new BoxGeometry(len * 1.02, 0.62, 0.12);
    panel.rotateY(Math.atan2(dx, dz) + Math.PI / 2);
    panel.translate((x0 + x1) / 2, FLOOR_Y + 0.31, (z0 + z1) / 2);
    parts.push({ geo: panel, color: i % 4 === 0 ? SHELL.STEEL : SHELL.NAVY });
  }

  return mergeColored(parts);
}
