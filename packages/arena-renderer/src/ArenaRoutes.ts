/**
 * Evidence routes.
 *
 * Curved fat lines from the subject to the cards it has documented evidence
 * with. Adapted from webgl_lines_fat (screen-space width lives in a uniform)
 * and webgl_buffergeometry_drawrange (prefix reveal), with one correction the
 * spike had to find: `setDrawRange` is inert on `Line2`, because a fat line is
 * an instanced quad expansion rather than a line list. The working lever is
 * `geometry.instanceCount`, which `LineSegmentsGeometry` inherits from
 * `InstancedBufferGeometry` and the renderer honours at `WebGLRenderer.js:1317`.
 * Measured monotonic: reveal 0 / .25 / .5 / 1 → 0 / 6 / 12 / 23 segments.
 *
 * Routes are deliberately sparse, and that is a cost model rather than a
 * preference: fat routes do NOT batch. SPIKE 3 measured one draw call each, so
 * 100 routes is 101 draw calls against the entire card field's one.
 *
 * Two settings are load-bearing:
 *   resolution   must be CSS pixels, never drawing-buffer pixels. `linewidth`
 *                is a CSS-pixel width and the shader divides by this, so
 *                feeding it w*devicePixelRatio halves apparent width at dpr 2.
 *                Rendering self-corrects via onBeforeRender; raycasting reads
 *                this value directly and does not.
 *   params.Line2 must be created explicitly on the raycaster or the hover
 *                threshold silently falls back to 0. Measured: 90% hit-rate
 *                5 px off a route with the bucket, 60% without.
 */
import { Scene, Vector3 } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ArenaTransition, SlotPool } from "./ArenaTransition";
import { AB, CS, type ArenaCard } from "./types";

const SAMPLES = 24;

interface RouteSlot {
  line: Line2;
  geo: LineGeometry;
  points: Float32Array;
  key: string;
  active: boolean;
}

export class ArenaRoutes {
  private readonly slots: RouteSlot[] = [];
  private readonly materials: Record<"opposed" | "same" | "mixed", LineMaterial>;
  private readonly ctrl = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private liveCount = 0;
  /** 0..1 progressive draw-in, applied to every live route. */
  private reveal = 1;

  constructor(scene: Scene, readonly capacity: number) {
    const shared = { linewidth: 2.4, transparent: true, opacity: 0.7, dashed: false };
    this.materials = {
      opposed: new LineMaterial({ ...shared, color: 0xff7a4d }),
      same: new LineMaterial({ ...shared, color: 0x49d7ff }),
      mixed: new LineMaterial({ ...shared, color: 0xe8dfcf, linewidth: 2.8, opacity: 0.78 }),
    };
    for (let i = 0; i < capacity; i++) {
      const geo = new LineGeometry();
      const points = new Float32Array(SAMPLES * 3);
      geo.setPositions(points);
      const line = new Line2(geo, this.materials.opposed);
      line.computeLineDistances();
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.slots.push({ line, geo, points, key: "", active: false });
    }
  }

  get count(): number {
    return this.liveCount;
  }

  /** CSS pixels. See the class comment: this is what raycasting reads. */
  setResolution(cssWidth: number, cssHeight: number): void {
    for (const m of Object.values(this.materials)) m.resolution.set(cssWidth, cssHeight);
  }

  setReveal(reveal: number): void {
    this.reveal = Math.min(1, Math.max(0, reveal));
    const segments = SAMPLES - 1;
    for (let i = 0; i < this.liveCount; i++) {
      this.slots[i]!.geo.instanceCount = Math.ceil(segments * this.reveal);
    }
  }

  /** Objects a raycaster should test for route hover. */
  pickTargets(): Line2[] {
    const out: Line2[] = [];
    for (let i = 0; i < this.liveCount; i++) out.push(this.slots[i]!.line);
    return out;
  }

  keyOf(line: object): string | null {
    for (let i = 0; i < this.liveCount; i++) if (this.slots[i]!.line === line) return this.slots[i]!.key;
    return null;
  }

  /**
   * Default route policy, from the brief: selected subject to its direct
   * documented relationships, and nothing else. No all-to-all spaghetti, and
   * aggregate cards get no route because a summary is not an encounter.
   */
  build(
    transition: ArenaTransition, pool: SlotPool,
    cards: readonly ArenaCard[], anchorId: string, budget: number,
  ): void {
    for (const slot of this.slots) { slot.active = false; slot.line.visible = false; }
    this.liveCount = 0;
    const anchorSlot = pool.slotOf(anchorId);
    if (anchorSlot === undefined || budget <= 0) return;
    const a3 = anchorSlot * 3;

    const cap = Math.min(budget, this.capacity);
    for (const card of cards) {
      if (this.liveCount >= cap) break;
      if (card.id === anchorId || card.bank === AB.AGGREGATE) continue;
      const slot = pool.slotOf(card.id);
      if (slot === undefined || transition.state[slot] === CS.ABSENT) continue;
      const route = this.slots[this.liveCount]!;
      const b3 = slot * 3;
      this.fill(
        route,
        transition.posCur[a3]!, transition.posCur[a3 + 1]!, transition.posCur[a3 + 2]!,
        transition.posCur[b3]!, transition.posCur[b3 + 1]!, transition.posCur[b3 + 2]!,
      );
      route.line.material = card.bank === AB.SAME ? this.materials.same
        : card.bank === AB.MIXED ? this.materials.mixed
        : this.materials.opposed;
      route.key = `${anchorId}~${card.id}`;
      route.active = true;
      route.line.visible = true;
      this.liveCount++;
    }
    this.setReveal(this.reveal);
  }

  /** Refresh geometry against current card positions, so routes stay attached
   *  while the formation is still travelling. */
  follow(transition: ArenaTransition, pool: SlotPool, anchorId: string): void {
    const anchorSlot = pool.slotOf(anchorId);
    if (anchorSlot === undefined) return;
    const a3 = anchorSlot * 3;
    for (let i = 0; i < this.liveCount; i++) {
      const route = this.slots[i]!;
      const otherId = route.key.slice(route.key.indexOf("~") + 1);
      const slot = pool.slotOf(otherId);
      if (slot === undefined) continue;
      const b3 = slot * 3;
      this.fill(
        route,
        transition.posCur[a3]!, transition.posCur[a3 + 1]!, transition.posCur[a3 + 2]!,
        transition.posCur[b3]!, transition.posCur[b3 + 1]!, transition.posCur[b3 + 2]!,
      );
    }
  }

  /** A route bows BENEATH the seating rather than cutting across the cards,
   *  which is the brief's "curve beneath or behind cards" as geometry rather
   *  than as a hope. */
  private fill(
    route: RouteSlot,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): void {
    this.from.set(ax, ay, az);
    this.to.set(bx, by, bz);
    this.ctrl.addVectors(this.from, this.to).multiplyScalar(0.5);
    this.ctrl.y -= 2.2 + this.from.distanceTo(this.to) * 0.16;
    for (let s = 0; s < SAMPLES; s++) {
      const t = s / (SAMPLES - 1);
      const u = 1 - t;
      route.points[s * 3] = u * u * ax + 2 * u * t * this.ctrl.x + t * t * bx;
      route.points[s * 3 + 1] = u * u * ay + 2 * u * t * this.ctrl.y + t * t * by;
      route.points[s * 3 + 2] = u * u * az + 2 * u * t * this.ctrl.z + t * t * bz;
    }
    route.geo.setPositions(route.points);
    route.line.computeLineDistances();
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.line.removeFromParent();
      slot.geo.dispose();
    }
    for (const m of Object.values(this.materials)) m.dispose();
    this.slots.length = 0;
    this.liveCount = 0;
  }
}
