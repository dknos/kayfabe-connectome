/**
 * The bowl: terraces behind the seated rows, an upper silhouette above them,
 * aisle cuts on the section boundaries, and the steel overhead.
 *
 * Two merged geometries rather than one, because they need different blending:
 * structure is lit, and the ribbon and marker lights are additive. Two draw
 * calls for the entire bowl.
 *
 * This is the part of the shell most able to do damage. A terrace tall enough
 * to sit in front of a card, or bright enough to compete with one, turns the
 * architecture into the subject. Everything here is therefore built BEHIND and
 * BELOW the seating it belongs to, and stays in the structural greys.
 */
import { BoxGeometry, BufferAttribute, BufferGeometry, PlaneGeometry } from "three";
import {
  SEAT_Z_SQUASH, SHELL, hash01, mergeColored, mergePositions, seatX, seatZ,
} from "./ArenaStadiumKit";
import {
  FLOOR_Y, SEAT_BASE_Y, SEAT_INNER_RADIUS, SEAT_TIER_RISE, SEAT_TIER_STEP,
  type ArenaSectionReport,
} from "./types";

const SEAT_ARC_HALF = 2.44;

export interface ArenaArchitectureOptions {
  extent: number;
  /** Deepest section, so the terraces reach exactly as far as the seating. */
  maxRows: number;
  sections: readonly ArenaSectionReport[];
  detail: "full" | "medium" | "simple";
}

export interface ArenaArchitectureResult {
  /** lit structure — terraces, aisles, truss, speakers. Short elements, so
   *  they are safe to render DoubleSide and be seen from inside the bowl. */
  structure: BufferGeometry;
  /** the tall enclosing silhouette, kept SEPARATE because it is the one piece
   *  that surrounds the camera and therefore must be rendered BackSide. */
  bowl: BufferGeometry | null;
  /** additive ribbon strips and distant marker lights, or null at low tier */
  lights: BufferGeometry | null;
}

/**
 * A quad spanning one arc segment, standing vertically, with its normal
 * pointing radially OUTWARD.
 *
 * The orientation is taken from the segment's midpoint radial direction, not
 * from its tangent. Deriving it from the tangent makes the facing depend on
 * which way the arc is traversed, and here that came out INWARD — so the
 * enclosing bowl rendered BackSide drew its near wall instead of culling it,
 * covering the entire arena with a near-black surface that read as a renderer
 * drawing nothing at all.
 *
 * Outward normals make the side semantics mean what they say: BackSide shows
 * the far wall from outside and the whole ring from inside, which is what a
 * stadium does.
 */
function arcPanel(a0: number, a1: number, radius: number, y: number, height: number): BufferGeometry | null {
  const x0 = seatX(a0, radius), z0 = seatZ(a0, radius);
  const x1 = seatX(a1, radius), z1 = seatZ(a1, radius);
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len < 1e-4) return null;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const geo = new PlaneGeometry(len * 1.02, height);
  // PlaneGeometry faces +Z; rotateY(t) sends +Z to (sin t, 0, cos t).
  geo.rotateY(Math.atan2(cx, cz));
  geo.translate(cx, y + height / 2, cz);
  return geo;
}

/** A flat annular segment: the surface a row of seats stands on. */
function arcTread(a0: number, a1: number, r0: number, r1: number, y: number): BufferGeometry | null {
  const p = [
    [seatX(a0, r0), seatZ(a0, r0)], [seatX(a1, r0), seatZ(a1, r0)],
    [seatX(a1, r1), seatZ(a1, r1)], [seatX(a0, r1), seatZ(a0, r1)],
  ];
  const geo = new BufferGeometry();
  const pos = new Float32Array(12);
  for (let i = 0; i < 4; i++) { pos[i * 3] = p[i]![0]!; pos[i * 3 + 1] = y; pos[i * 3 + 2] = p[i]![1]!; }
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const nrm = new Float32Array(12);
  for (let i = 0; i < 4; i++) nrm[i * 3 + 1] = 1;
  geo.setAttribute("normal", new BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  return geo;
}

export function buildArchitecture(options: ArenaArchitectureOptions): ArenaArchitectureResult {
  const structure: { geo: BufferGeometry; color: number }[] = [];
  const bowl: { geo: BufferGeometry; color: number }[] = [];
  const lights: BufferGeometry[] = [];
  const full = options.detail === "full";
  const simple = options.detail === "simple";
  const arcSegments = simple ? 20 : full ? 56 : 34;

  // --- lower bowl terraces ----------------------------------------------
  // A step is a RISER plus a TREAD, and the riser is ONE step tall.
  //
  // Built instead as a panel reaching from the floor up to each row's height,
  // the outermost row becomes a 12-unit wall wrapped around the entire bowl —
  // and since the shell is deliberately near-black, that wall standing between
  // the camera and the arena does not read as architecture. It reads as a
  // renderer drawing nothing. That is precisely what it did, at high and
  // medium tier only, because the low tier builds no upper bowl to notice.
  const rows = Math.max(1, options.maxRows);
  for (let row = 0; row < rows; row++) {
    const radius = SEAT_INNER_RADIUS + row * SEAT_TIER_STEP + 0.72;
    const topY = SEAT_BASE_Y + row * SEAT_TIER_RISE - 0.2;
    const riserH = row === 0 ? topY - FLOOR_Y : SEAT_TIER_RISE;
    if (riserH <= 0.05) continue;
    for (let i = 0; i < arcSegments; i++) {
      const a0 = -SEAT_ARC_HALF + (i / arcSegments) * SEAT_ARC_HALF * 2;
      const a1 = -SEAT_ARC_HALF + ((i + 1) / arcSegments) * SEAT_ARC_HALF * 2;
      const riser = arcPanel(a0, a1, radius, topY - riserH, riserH);
      if (!riser) continue;
      // Deterministic panel variation. Math.random() here would rebuild a
      // different bowl on every mount and break screenshot comparison.
      const shade = hash01(row * 97 + i, 11) < 0.5 ? SHELL.GRAPHITE : SHELL.CHARCOAL;
      structure.push({ geo: riser, color: shade });
      // The tread the next row stands on, laid flat between the two radii.
      // Dropped at the simple tier: treads are the largest horizontal fill in
      // the shell and the low tier is fill-bound before it is anything else.
      // Without them the bowl still steps correctly, it is just flatter.
      if (!simple) {
        const tread = arcTread(a0, a1, radius, radius + SEAT_TIER_STEP, topY);
        if (tread) structure.push({ geo: tread, color: SHELL.GRAPHITE });
      }
    }
  }

  // --- upper bowl silhouette --------------------------------------------
  // Read as distance, not as surface: darker than the lower bowl, set well
  // back, and with no detail that could be mistaken for occupancy. There are
  // deliberately no crowd models anywhere in this file — an invented audience
  // is an invented count, and the brief forbids fake crowd population.
  if (!simple) {
    const outer = SEAT_INNER_RADIUS + rows * SEAT_TIER_STEP + 3.4;
    const topY = SEAT_BASE_Y + rows * SEAT_TIER_RISE;
    const upperH = full ? 11 : 7.5;
    for (let i = 0; i < arcSegments; i++) {
      const a0 = -SEAT_ARC_HALF + (i / arcSegments) * SEAT_ARC_HALF * 2;
      const a1 = -SEAT_ARC_HALF + ((i + 1) / arcSegments) * SEAT_ARC_HALF * 2;
      const geo = arcPanel(a0, a1, outer, topY, upperH);
      if (geo) bowl.push({ geo, color: SHELL.CHARCOAL });
    }
  }

  // --- aisle cuts ---------------------------------------------------------
  // On the real section boundaries, so the vertical breaks in the bowl agree
  // with the semantic breaks in the seating instead of decorating over them.
  for (const section of options.sections) {
    if (!section.arc) continue;
    for (const angle of [section.arc.from, section.arc.to]) {
      const inner = SEAT_INNER_RADIUS - 0.6;
      const outerR = section.arc.outerRadius + 1.4;
      const len = outerR - inner;
      const geo = new BoxGeometry(0.34, 0.1, len);
      geo.rotateY(angle);
      geo.translate(
        seatX(angle, inner + len / 2),
        FLOOR_Y + 0.06,
        seatZ(angle, inner + len / 2),
      );
      structure.push({ geo, color: SHELL.NAVY });
    }
  }

  // --- overhead -----------------------------------------------------------
  if (!simple) {
    const trussY = 9.4;
    const span = 7.6;
    // A square lighting grid over the ring. Four beams; the scoreboard hangs
    // inside it and the light cones come off it.
    for (let i = 0; i < 4; i++) {
      const along = i % 2 === 0;
      const geo = new BoxGeometry(along ? span * 2 : 0.34, 0.34, along ? 0.34 : span * 2);
      geo.translate(
        along ? 0 : (i === 1 ? 1 : -1) * span,
        trussY,
        along ? (i === 0 ? -1 : 1) * span * SEAT_Z_SQUASH : 0,
      );
      // Charcoal, not steel: the truss is the highest and least important
      // surface in the room, and the bright structural grey made it compete
      // with the seating for attention.
      structure.push({ geo, color: SHELL.CHARCOAL });
    }
    if (full) {
      // Speaker arrays hung at the truss corners.
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -1 : 1;
        const sz = i < 2 ? -1 : 1;
        for (let cab = 0; cab < 3; cab++) {
          const geo = new BoxGeometry(1.05, 0.5, 0.72);
          geo.translate(sx * span * 0.82, trussY - 0.9 - cab * 0.54, sz * span * 0.82 * SEAT_Z_SQUASH);
          structure.push({ geo, color: SHELL.CHARCOAL });
        }
      }
    }
  }

  // --- ribbon and marker lights ------------------------------------------
  // Additive and bright, but deliberately NOT on BLOOM_LAYER. Bloom in this
  // renderer is a closed list (ArenaBloom) and it is fill-bound — measured at
  // ~89 ms a frame half-resolution on the software path. A ribbon that wrapped
  // the whole bowl on that layer would push the quality governor down a rung
  // for decoration. Additive geometry gets the look for one draw call.
  if (!simple) {
    const ribbonR = SEAT_INNER_RADIUS - 1.15;
    for (let i = 0; i < arcSegments; i++) {
      const a0 = -SEAT_ARC_HALF + (i / arcSegments) * SEAT_ARC_HALF * 2;
      const a1 = -SEAT_ARC_HALF + ((i + 1) / arcSegments) * SEAT_ARC_HALF * 2;
      const geo = arcPanel(a0, a1, ribbonR, FLOOR_Y + 0.66, 0.1);
      if (geo) lights.push(geo);
    }
    if (full) {
      // Distant structural lights high in the upper bowl. Small, sparse and
      // deterministically placed.
      const outer = SEAT_INNER_RADIUS + rows * SEAT_TIER_STEP + 3.2;
      const topY = SEAT_BASE_Y + rows * SEAT_TIER_RISE;
      for (let i = 0; i < 26; i++) {
        const a = -SEAT_ARC_HALF + hash01(i, 3) * SEAT_ARC_HALF * 2;
        const y = topY + 1.5 + hash01(i, 5) * 8.5;
        const geo = new PlaneGeometry(0.16, 0.16);
        geo.translate(seatX(a, outer - 0.3), y, seatZ(a, outer - 0.3));
        lights.push(geo);
      }
    }
  }

  return {
    structure: mergeColored(structure),
    bowl: bowl.length > 0 ? mergeColored(bowl) : null,
    lights: lights.length > 0 ? mergePositions(lights) : null,
  };
}
