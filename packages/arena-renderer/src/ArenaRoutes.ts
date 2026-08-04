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

/**
 * How present a route is when nothing is picked out.
 *
 * Routes converge on one subject, so at full strength a few dozen of them read
 * as a hairball over the near seating rather than as evidence. They are a
 * field you read one strand of at a time: quiet by default, and unmistakable
 * for whichever card the reader is actually pointing at.
 */
/**
 * A fibre is drawn only when the reader is pointing at its card.
 *
 * Forty faint curves all converging on one subject told a reader nothing they
 * could not already see from the seating: that these people are connected to
 * the subject is the premise of the whole formation. What the fibre is FOR is
 * answering "which one is Kenny Omega's" — so it appears for exactly that
 * card, and the evidence it carries is read from the packet travelling it
 * rather than from the line itself. The curve still exists on every
 * relationship; it is a path for the pulse, and paths are not scenery.
 */
const EMPHASIS_OPACITY = 0.95;

interface RouteSlot {
  line: Line2;
  geo: LineGeometry;
  points: Float32Array;
  key: string;
  /** The card this route ends at, and the material it wears when the reader is
   *  not pointing at it. */
  otherId: string;
  base: LineMaterial | null;
  /** Documented encounters behind this relationship, normalised against the
   *  strongest one on screen, and the raw count it came from. The pulse reads
   *  both: how many packets, and how fast. */
  strength: number;
  encounters: number;
  /** Resolved once at build time. Re-deriving it from `key` every frame cost a
   *  string allocation per route per frame — 100 a frame at the high tier,
   *  which is exactly the per-frame allocation this renderer forbids. */
  otherSlot: number;
  active: boolean;
  /** The interleaved buffer behind instanceStart/instanceEnd, cached so
   *  per-frame updates write into it instead of rebuilding it. */
  interleaved: { array: Float32Array; needsUpdate: boolean } | null;
}

export class ArenaRoutes {
  private readonly slots: RouteSlot[] = [];
  private readonly materials: Record<"opposed" | "same" | "mixed", LineMaterial>;
  private readonly highlight: LineMaterial;
  /** Which card's route is lifted, and the material its route came from. */
  private emphasisId: string | null = null;
  /** The live index of the drawn fibre, or -1. The pulse rides this one. */
  private emphasisIndex = -1;
  private readonly ctrl = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private liveCount = 0;
  /** 0..1 progressive draw-in, applied to every live route. */
  private reveal = 1;
  /** How many cards could have carried a route, against how many did. A
   *  budget that silently truncates reads as "these are all of them". */
  wanted = 0;

  constructor(scene: Scene, readonly capacity: number) {
    // The bank materials survive because the highlighted fibre takes its colour
    // from whichever one its card belongs to: opposition reads ember, tag
    // partnership reads cyan, and a pair carrying both reads as neither.
    const shared = { linewidth: 1.1, transparent: true, opacity: 0, dashed: false };
    this.materials = {
      opposed: new LineMaterial({ ...shared, color: 0xff7a4d }),
      same: new LineMaterial({ ...shared, color: 0x49d7ff }),
      mixed: new LineMaterial({ ...shared, color: 0xe8dfcf }),
    };
    // The one fibre that is drawn gets its own material, because a fat line's
    // width and alpha both live in material uniforms shared by every route.
    this.highlight = new LineMaterial({
      linewidth: 2.4, transparent: true, opacity: EMPHASIS_OPACITY, dashed: false, color: 0xffffff,
    });
    for (let i = 0; i < capacity; i++) {
      const geo = new LineGeometry();
      const points = new Float32Array(SAMPLES * 3);
      // Seed with a degenerate but non-zero polyline so the addon builds its
      // interleaved buffer once here. Every later update writes into that
      // buffer; setPositions is never called again, because it allocates a new
      // Float32Array AND a new InstancedInterleavedBuffer on every call and
      // doing that per route per formation change stalled a frame long enough
      // to swallow most of a transition.
      for (let s = 0; s < SAMPLES; s++) points[s * 3] = s * 0.001;
      geo.setPositions(points);
      const line = new Line2(geo, this.materials.opposed);
      line.computeLineDistances();
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      const attr = geo.getAttribute("instanceStart") as { data?: { array: Float32Array; needsUpdate: boolean } };
      this.slots.push({
        line, geo, points, key: "", otherId: "", base: null, strength: 0, encounters: 0,
        otherSlot: -1, active: false,
        interleaved: attr?.data ?? null,
      });
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

  /** Position along a live route, t in 0..1. Reads the same cached samples the
   *  geometry uses, so a packet cannot drift off the line it is riding. */
  samplePoint(index: number, t: number): { x: number; y: number; z: number } | null {
    if (index < 0 || index >= this.liveCount) return null;
    const pts = this.slots[index]!.points;
    const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const f = clamped * (SAMPLES - 1);
    const s0 = Math.min(SAMPLES - 1, Math.floor(f));
    const s1 = Math.min(SAMPLES - 1, s0 + 1);
    const k = f - s0;
    return {
      x: pts[s0 * 3]! + (pts[s1 * 3]! - pts[s0 * 3]!) * k,
      y: pts[s0 * 3 + 1]! + (pts[s1 * 3 + 1]! - pts[s0 * 3 + 1]!) * k,
      z: pts[s0 * 3 + 2]! + (pts[s1 * 3 + 2]! - pts[s0 * 3 + 2]!) * k,
    };
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
    this.emphasisIndex = -1;
    // The route set is new, so nothing is emphasised on it yet. Without this a
    // reader whose pointer never left a card keeps an id that no longer maps to
    // a drawn fibre, and hovering it again is a no-op.
    this.emphasisId = null;
    const anchorSlot = pool.slotOf(anchorId);
    if (anchorSlot === undefined || budget <= 0) return;
    const a3 = anchorSlot * 3;

    const cap = Math.min(budget, this.capacity);
    this.wanted = 0;
    let strongest = 0;
    for (const card of cards) {
      if (card.id === anchorId || card.bank === AB.AGGREGATE) continue;
      this.wanted++;
      if (card.strength > strongest) strongest = card.strength;
    }
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
        true,
      );
      route.line.material = card.bank === AB.SAME ? this.materials.same
        : card.bank === AB.MIXED ? this.materials.mixed
        : this.materials.opposed;
      route.key = `${anchorId}~${card.id}`;
      route.otherId = card.id;
      route.base = route.line.material as LineMaterial;
      route.strength = strongest > 0 ? card.strength / strongest : 0;
      route.encounters = card.strength;
      route.otherSlot = slot;
      route.active = true;
      // Invisible until pointed at. The geometry is live either way: the pulse
      // samples it every frame.
      route.line.visible = false;
      this.liveCount++;
    }
    this.setReveal(this.reveal);
  }

  /** Refresh geometry against current card positions, so routes stay attached
   *  while the formation is still travelling. */
  follow(transition: ArenaTransition, pool: SlotPool, anchorId: string): void {
    if (this.liveCount === 0) return;
    const anchorSlot = pool.slotOf(anchorId);
    if (anchorSlot === undefined) return;
    const a3 = anchorSlot * 3;
    for (let i = 0; i < this.liveCount; i++) {
      const route = this.slots[i]!;
      const slot = route.otherSlot;
      if (slot < 0) continue;
      const b3 = slot * 3;
      this.fill(
        route,
        transition.posCur[a3]!, transition.posCur[a3 + 1]!, transition.posCur[a3 + 2]!,
        transition.posCur[b3]!, transition.posCur[b3 + 1]!, transition.posCur[b3 + 2]!,
      );
    }
  }

  /**
   * A route bows BENEATH the seating rather than cutting across the cards,
   * which is the brief's "curve beneath or behind cards" as geometry rather
   * than as a hope.
   *
   * `initial` runs the addon's own setPositions once, to build the interleaved
   * buffer. Every later update writes THAT buffer in place.
   * LineGeometry.setPositions allocates a fresh Float32Array and a fresh
   * InstancedInterleavedBuffer on every call, so calling it per route per frame
   * stalled a single frame long enough to swallow half a formation change —
   * measured on hardware, not just on the software path.
   */
  private fill(
    route: RouteSlot,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    initial = false,
  ): void {
    this.from.set(ax, ay, az);
    this.to.set(bx, by, bz);
    this.ctrl.addVectors(this.from, this.to).multiplyScalar(0.5);
    this.ctrl.y -= 2.2 + this.from.distanceTo(this.to) * 0.16;
    const pts = route.points;
    for (let s = 0; s < SAMPLES; s++) {
      const t = s / (SAMPLES - 1);
      const u = 1 - t;
      pts[s * 3] = u * u * ax + 2 * u * t * this.ctrl.x + t * t * bx;
      pts[s * 3 + 1] = u * u * ay + 2 * u * t * this.ctrl.y + t * t * by;
      pts[s * 3 + 2] = u * u * az + 2 * u * t * this.ctrl.z + t * t * bz;
    }
    void initial;
    if (!route.interleaved) return;
    // Segment s occupies [startXYZ, endXYZ] at stride 6.
    const buf = route.interleaved.array;
    for (let s = 0; s < SAMPLES - 1; s++) {
      const o = s * 6;
      const a = s * 3;
      buf[o] = pts[a]!;
      buf[o + 1] = pts[a + 1]!;
      buf[o + 2] = pts[a + 2]!;
      buf[o + 3] = pts[a + 3]!;
      buf[o + 4] = pts[a + 4]!;
      buf[o + 5] = pts[a + 5]!;
    }
    route.interleaved.needsUpdate = true;
  }

  /**
   * Lift one card's route out of the field, and let the rest recede.
   *
   * Dimming is one uniform write per shared material rather than per route, so
   * pointing at a card costs the same whether 8 routes are live or 100.
   */
  setEmphasis(id: string | null): void {
    if (this.emphasisId === id) return;
    this.emphasisId = id;
    this.emphasisIndex = -1;
    for (let i = 0; i < this.liveCount; i++) {
      const route = this.slots[i]!;
      if (id && route.otherId === id) {
        this.emphasisIndex = i;
        this.highlight.color.copy((route.base ?? this.materials.mixed).color);
        route.line.material = this.highlight;
        route.line.visible = true;
      } else if (route.line.visible) {
        if (route.base) route.line.material = route.base;
        route.line.visible = false;
      }
    }
  }

  /** How much documented evidence route `i` carries, 0..1 against the strongest
   *  on screen. */
  strengthOf(i: number): number {
    return i >= 0 && i < this.liveCount ? this.slots[i]!.strength : 0;
  }

  /** The fibre currently drawn, and the evidence behind it. Null when the
   *  reader is not pointing at anything, which is also when nothing pulses. */
  emphasis(): { index: number; strength: number; encounters: number } | null {
    const i = this.emphasisIndex;
    if (i < 0 || i >= this.liveCount) return null;
    const route = this.slots[i]!;
    return { index: i, strength: route.strength, encounters: route.encounters };
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.line.removeFromParent();
      slot.geo.dispose();
    }
    for (const m of Object.values(this.materials)) m.dispose();
    this.highlight.dispose();
    this.slots.length = 0;
    this.liveCount = 0;
  }
}
