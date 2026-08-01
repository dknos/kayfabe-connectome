import type { AtlasDot, AtlasQuad, AtlasScene } from "./types";
import type { AtlasRails } from "./AtlasRails";
import type { AtlasNodes } from "./AtlasNodes";

/**
 * The morph.
 *
 * A state change in the atlas is not a cut. Clicking WWE has to LOOK like the
 * board reorganising around WWE, because that is the claim being made — the
 * same records, read a different way. So every entity that exists in both the
 * old scene and the new one keeps its identity and travels; only genuinely new
 * entities appear and genuinely absent ones leave.
 *
 * Identity is the scene's `key`, not a slot index. Slots are reassigned on
 * every scene change so that instances stay in LAYER order (the rails material
 * draws in buffer order — see AtlasRails), and the previous state is looked up
 * by key from a snapshot map rather than read out of the old buffer.
 *
 * Under prefers-reduced-motion nothing travels: the layout is applied
 * immediately and only opacity crossfades, because a reader who asked for less
 * motion should not have to watch 36,000 rectangles fly to understand that the
 * board changed.
 */

const DURATION_MS = 760;
const REDUCED_MS = 190;

interface Snap {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  a: number;
}

/** Quintic in-out. Leaves and arrives without a visible velocity step. */
function ease(t: number): number {
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

export class AtlasTransition {
  /** slot -> key, for emphasis and picking */
  quadKeys: string[] = [];
  quadPick: (string | undefined)[] = [];
  dotKeys: string[] = [];
  dotPick: (string | undefined)[] = [];

  /** Per-slot emphasis multipliers, written by the renderer. */
  quadEmph = new Float32Array(0);
  dotEmph = new Float32Array(0);

  private qFrom: Snap[] = [];
  private qTo: Snap[] = [];
  private dFrom: Snap[] = [];
  private dTo: Snap[] = [];
  private qLive = 0;
  private dLive = 0;

  private prevQuad = new Map<string, Snap>();
  private prevDot = new Map<string, Snap>();

  private startMs = 0;
  private durMs = 0;
  private reduced = false;
  private running = false;
  private firstScene = true;

  /** Static picking rectangles for the CURRENT target layout, in world space.
   *  Picking always tests the destination, never the in-flight position — a
   *  click during a morph should select what you aimed at. */
  pickRects: { id: string; x: number; y: number; w: number; h: number; z: number }[] = [];
  pickDots: { id: string; x: number; y: number; r: number; z: number }[] = [];

  setReducedMotion(v: boolean): void {
    this.reduced = v;
  }

  get isRunning(): boolean {
    return this.running;
  }

  setScene(scene: AtlasScene, rails: AtlasRails, nodes: AtlasNodes, nowMs: number): void {
    this.buildQuads(scene.quads, rails);
    this.buildDots(scene.dots, nodes);
    this.startMs = nowMs;
    // The first scene has nothing to travel from, so it fades in rather than
    // flying in from an arbitrary origin.
    this.durMs = this.reduced || this.firstScene ? REDUCED_MS : DURATION_MS;
    this.firstScene = false;
    this.running = true;
    this.tick(nowMs, rails, nodes);
  }

  private buildQuads(next: AtlasQuad[], rails: AtlasRails): void {
    const leaving: string[] = [];
    const nextKeys = new Set<string>();
    for (const q of next) nextKeys.add(q.key);
    for (const k of this.prevQuad.keys()) if (!nextKeys.has(k)) leaving.push(k);

    const total = next.length + leaving.length;
    rails.grow(total);
    this.qFrom.length = 0;
    this.qTo.length = 0;
    this.quadKeys.length = 0;
    this.quadPick.length = 0;
    if (this.quadEmph.length < total) this.quadEmph = new Float32Array(Math.max(4096, total * 2));
    this.quadEmph.fill(1, 0, total);
    this.pickRects.length = 0;

    for (let i = 0; i < next.length; i++) {
      const q = next[i]!;
      const to: Snap = { x: q.x, y: q.y, z: q.z, w: q.w, h: q.h, a: q.alpha };
      const prev = this.prevQuad.get(q.key);
      // Entering geometry grows out of its own lane rather than sliding in
      // from off-screen, so an appearing title rail reads as "this existed all
      // along, you just zoomed into it".
      const from: Snap = prev ?? { x: q.x, y: q.y, z: q.z, w: q.w, h: q.h * 0.12, a: 0 };
      this.qFrom.push(from);
      this.qTo.push(to);
      this.quadKeys.push(q.key);
      this.quadPick.push(q.pick);
      rails.color[i * 3] = q.color[0];
      rails.color[i * 3 + 1] = q.color[1];
      rails.color[i * 3 + 2] = q.color[2];
      rails.params[i * 4 + 1] = q.kind;
      rails.params[i * 4 + 2] = q.param ?? 1;
      if (q.pick) {
        this.pickRects.push({ id: q.pick, x: q.x, y: q.y, w: q.w, h: q.h, z: q.z });
      }
    }
    for (let j = 0; j < leaving.length; j++) {
      const i = next.length + j;
      const k = leaving[j]!;
      const prev = this.prevQuad.get(k)!;
      this.qFrom.push(prev);
      this.qTo.push({ ...prev, a: 0 });
      this.quadKeys.push(k);
      this.quadPick.push(undefined);
      rails.color[i * 3] = 0.35;
      rails.color[i * 3 + 1] = 0.4;
      rails.color[i * 3 + 2] = 0.5;
      rails.params[i * 4 + 1] = 8; // PLATE — leavers do not need a treatment
      rails.params[i * 4 + 2] = 1;
    }
    this.qLive = next.length;
    rails.setCount(total);
    rails.commitStatic();
    this.prevQuad = new Map(next.map((q) => [q.key, { x: q.x, y: q.y, z: q.z, w: q.w, h: q.h, a: q.alpha }]));
  }

  private buildDots(next: AtlasDot[], nodes: AtlasNodes): void {
    const leaving: string[] = [];
    const nextKeys = new Set<string>();
    for (const d of next) nextKeys.add(d.key);
    for (const k of this.prevDot.keys()) if (!nextKeys.has(k)) leaving.push(k);

    const total = next.length + leaving.length;
    nodes.grow(total);
    this.dFrom.length = 0;
    this.dTo.length = 0;
    this.dotKeys.length = 0;
    this.dotPick.length = 0;
    if (this.dotEmph.length < total) this.dotEmph = new Float32Array(Math.max(4096, total * 2));
    this.dotEmph.fill(1, 0, total);
    this.pickDots.length = 0;

    for (let i = 0; i < next.length; i++) {
      const d = next[i]!;
      const to: Snap = { x: d.x, y: d.y, z: d.z, w: d.size, h: d.size, a: d.alpha };
      const prev = this.prevDot.get(d.key);
      const from: Snap = prev ?? { x: d.x, y: d.y, z: d.z, w: d.size * 0.2, h: d.size * 0.2, a: 0 };
      this.dFrom.push(from);
      this.dTo.push(to);
      this.dotKeys.push(d.key);
      this.dotPick.push(d.pick);
      nodes.color[i * 3] = d.color[0];
      nodes.color[i * 3 + 1] = d.color[1];
      nodes.color[i * 3 + 2] = d.color[2];
      nodes.params[i * 2 + 1] = d.shape;
      if (d.pick) this.pickDots.push({ id: d.pick, x: d.x, y: d.y, r: d.size, z: d.z });
    }
    for (let j = 0; j < leaving.length; j++) {
      const i = next.length + j;
      const k = leaving[j]!;
      const prev = this.prevDot.get(k)!;
      this.dFrom.push(prev);
      this.dTo.push({ ...prev, a: 0 });
      this.dotKeys.push(k);
      this.dotPick.push(undefined);
      nodes.color[i * 3] = 0.4;
      nodes.color[i * 3 + 1] = 0.45;
      nodes.color[i * 3 + 2] = 0.55;
      nodes.params[i * 2 + 1] = 0;
    }
    this.dLive = next.length;
    nodes.setCount(total);
    this.prevDot = new Map(
      next.map((d) => [d.key, { x: d.x, y: d.y, z: d.z, w: d.size, h: d.size, a: d.alpha }]),
    );
  }

  /** Advance the morph. Returns true while still animating. */
  tick(nowMs: number, rails: AtlasRails, nodes: AtlasNodes): boolean {
    if (!this.running) return false;
    const raw = this.durMs <= 0 ? 1 : Math.min(1, (nowMs - this.startMs) / this.durMs);
    // Reduced motion: geometry is already where it belongs on frame one; only
    // the opacity crossfades.
    const k = this.reduced ? 1 : ease(raw);
    const fade = raw;

    const qn = this.qFrom.length;
    for (let i = 0; i < qn; i++) {
      const a = this.qFrom[i]!;
      const b = this.qTo[i]!;
      rails.pos[i * 3] = a.x + (b.x - a.x) * k;
      rails.pos[i * 3 + 1] = a.y + (b.y - a.y) * k;
      rails.pos[i * 3 + 2] = a.z + (b.z - a.z) * k;
      rails.size[i * 2] = a.w + (b.w - a.w) * k;
      rails.size[i * 2 + 1] = a.h + (b.h - a.h) * k;
      rails.params[i * 4] = (a.a + (b.a - a.a) * fade) * (this.quadEmph[i] ?? 1);
    }
    const dn = this.dFrom.length;
    for (let i = 0; i < dn; i++) {
      const a = this.dFrom[i]!;
      const b = this.dTo[i]!;
      nodes.pos[i * 3] = a.x + (b.x - a.x) * k;
      nodes.pos[i * 3 + 1] = a.y + (b.y - a.y) * k;
      nodes.pos[i * 3 + 2] = a.z + (b.z - a.z) * k;
      nodes.size[i] = a.w + (b.w - a.w) * k;
      nodes.params[i * 2] = (a.a + (b.a - a.a) * fade) * (this.dotEmph[i] ?? 1);
    }
    rails.commit();
    nodes.commit();

    if (raw >= 1) {
      this.running = false;
      // Drop the departed instances now that they have finished fading, so a
      // long session does not accumulate every scene it has ever shown.
      rails.setCount(this.qLive);
      nodes.setCount(this.dLive);
    }
    return this.running;
  }

  /** Re-apply emphasis multipliers without re-running the morph. */
  refreshAlpha(rails: AtlasRails, nodes: AtlasNodes): void {
    for (let i = 0; i < this.qTo.length; i++) {
      const t = this.qTo[i]!;
      rails.params[i * 4] = t.a * (this.quadEmph[i] ?? 1);
    }
    for (let i = 0; i < this.dTo.length; i++) {
      const t = this.dTo[i]!;
      nodes.params[i * 2] = t.a * (this.dotEmph[i] ?? 1);
    }
    rails.commit();
    nodes.commit();
  }

  /** Forget history — used when the lens unmounts. */
  reset(): void {
    this.prevQuad.clear();
    this.prevDot.clear();
    this.firstScene = true;
    this.running = false;
  }
}
