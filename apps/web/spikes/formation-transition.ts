/**
 * SPIKE 1 — the formation morph under test.
 *
 * This is the measurement instrument for the one decision the whole lens
 * rests on: can one persistent card set travel between precomputed target
 * formations, interruptibly, without a per-card animation object and without
 * per-frame allocation?
 *
 * css3d_periodictable proves the *idea* (precomputed `targets` arrays plus an
 * interpolate step) and simultaneously demonstrates everything that cannot be
 * shipped: one TWEEN object per card per property, `Math.random() * duration +
 * duration` timing, and `Math.random() * 4000 - 2000` source positions. All
 * three are load-bearing to that demo and fatal here — random durations make
 * the settle time unpredictable, per-card tweens allocate proportional to the
 * population, and random sources destroy the reading that the entrance is a
 * *compression of the connectome*.
 *
 * The structure below is instead a sibling of the repository's proven
 * MorphTransition: one shared raw clock, a per-element semantic delay band, a
 * capture-current-on-retarget rule, and stable slot pooling. Everything lands
 * together at raw progress 1 because delays consume only 1 - MORPH_WINDOW of
 * the timeline, which is what makes "once settled, everything becomes still"
 * true by construction rather than by tuning.
 */

/** Mirrors packages/morph-renderer MORPH_WINDOW: elements animate over this
 *  fraction of the clock and semantic delays occupy the rest, so the whole
 *  formation settles on the same frame. */
export const FORMATION_WINDOW = 0.62;
export const FORMATION_DELAY_MAX = 1 - FORMATION_WINDOW;
export const FORMATION_MS = 1400; // spec: the assembly reads at 1.2–1.6 s
export const FORMATION_REDUCED_MS = 190;

/** quintic in-out — must match any GLSL copy exactly. */
export const easeQuintic = (t: number): number =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

export const elementProgress = (raw: number, delay: number): number => {
  const t = (raw - delay * FORMATION_DELAY_MAX) / FORMATION_WINDOW;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
};

/** Entering and leaving are different from retained travel: a retained card
 *  must stay trackable, an entering card may dissolve in, a leaving card must
 *  not simply vanish mid-flight. */
export const CS = { ABSENT: 0, ENTER: 1, RETAIN: 2, LEAVE: 3 } as const;

/**
 * Deterministic transition ordering, straight from the spec's list. This is
 * the "semantic stagger, not random stagger" rule expressed as a number: a
 * band index, normalized to 0..1, which becomes the element's delay.
 */
export const BAND = {
  CENTER: 0,      // the selected card
  SPINE: 1,       // section spines and headings
  DIRECT: 2,      // direct relationship cards
  CONTEXT: 3,     // promotion and championship context
  AGGREGATE: 4,   // aggregate cards read as summaries, so they arrive late
  ROUTE: 5,       // evidence routes resolve after cards settle
  AMBIENT: 6,     // ambient context last
} as const;
export const BAND_COUNT = 7;
export const bandDelay = (band: number): number => band / (BAND_COUNT - 1);

/**
 * A stable entity→instance mapping. Reusing the same instance for the same
 * wrestler across formations is what makes "follow one named card from Arena
 * to Index" true; a rebuilt mapping would teleport cards even with perfect
 * interpolation.
 */
export class SlotPool {
  private readonly byId = new Map<string, number>();
  private readonly idBySlot: (string | null)[];
  private readonly free: number[] = [];

  constructor(readonly capacity: number) {
    this.idBySlot = new Array<string | null>(capacity).fill(null);
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
  }

  slotOf(id: string): number | undefined {
    return this.byId.get(id);
  }

  idOf(slot: number): string | null {
    return this.idBySlot[slot] ?? null;
  }

  /** Returns -1 when the pool is exhausted; callers surface that as a budget
   *  note rather than silently dropping a card. */
  acquire(id: string): number {
    const existing = this.byId.get(id);
    if (existing !== undefined) return existing;
    const slot = this.free.pop();
    if (slot === undefined) return -1;
    this.byId.set(id, slot);
    this.idBySlot[slot] = id;
    return slot;
  }

  release(id: string): void {
    const slot = this.byId.get(id);
    if (slot === undefined) return;
    this.byId.delete(id);
    this.idBySlot[slot] = null;
    this.free.push(slot);
  }

  get liveCount(): number {
    return this.byId.size;
  }
}

export interface FormationStats {
  layoutMs: number;
  retargetMs: number;
  entering: number;
  retaining: number;
  leaving: number;
  dropped: number;
}

export class FormationTransition {
  readonly posFrom: Float32Array;
  readonly posCur: Float32Array;
  readonly posTo: Float32Array;
  readonly quatFrom: Float32Array;
  readonly quatCur: Float32Array;
  readonly quatTo: Float32Array;
  readonly scaleFrom: Float32Array;
  readonly scaleCur: Float32Array;
  readonly scaleTo: Float32Array;
  readonly delay: Float32Array;
  readonly state: Uint8Array;
  /** per-instance transition progress, for a shader dissolve on enter/leave */
  readonly progress: Float32Array;
  /** written by the layout each retarget: 1 = present in the next formation */
  readonly present: Uint8Array;

  private raw = 1;
  private startMs = 0;
  private durMs = FORMATION_MS;
  private firstFormation = true;
  reducedMotion = false;

  constructor(readonly capacity: number) {
    this.posFrom = new Float32Array(capacity * 3);
    this.posCur = new Float32Array(capacity * 3);
    this.posTo = new Float32Array(capacity * 3);
    this.quatFrom = new Float32Array(capacity * 4);
    this.quatCur = new Float32Array(capacity * 4);
    this.quatTo = new Float32Array(capacity * 4);
    this.scaleFrom = new Float32Array(capacity * 3);
    this.scaleCur = new Float32Array(capacity * 3);
    this.scaleTo = new Float32Array(capacity * 3);
    this.delay = new Float32Array(capacity);
    this.state = new Uint8Array(capacity);
    this.progress = new Float32Array(capacity);
    this.present = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.quatFrom[i * 4 + 3] = 1;
      this.quatCur[i * 4 + 3] = 1;
      this.quatTo[i * 4 + 3] = 1;
    }
  }

  get progressRaw(): number {
    return this.raw;
  }
  get animating(): boolean {
    return this.raw < 1;
  }

  /**
   * Capture what is on screen. A layout change midway through a transition
   * must retarget from the card's CURRENT transform — retargeting from the
   * previous source is the bug that makes an interrupted morph snap backwards.
   */
  captureCurrent(): void {
    if (this.firstFormation) return;
    this.posFrom.set(this.posCur);
    this.quatFrom.set(this.quatCur);
    this.scaleFrom.set(this.scaleCur);
  }

  /**
   * Classify slots against the freshly written `present` mask and start the
   * clock. Entering cards begin at their target with zero progress so the
   * shader can dissolve them in; leaving cards keep their captured transform
   * and fade where they stand rather than flying to an arbitrary exit.
   */
  commit(nowMs: number, immediate = false): FormationStats {
    const t0 = performance.now();
    const snap = immediate || this.firstFormation;
    let entering = 0;
    let retaining = 0;
    let leaving = 0;

    for (let i = 0; i < this.capacity; i++) {
      const wasLive = this.state[i] === CS.RETAIN || this.state[i] === CS.ENTER;
      const nowLive = this.present[i] === 1;
      if (nowLive && !wasLive) {
        this.state[i] = CS.ENTER;
        entering++;
        const i3 = i * 3;
        const i4 = i * 4;
        // enter from the target transform, scaled down — no random source
        this.posFrom[i3] = this.posTo[i3]!;
        this.posFrom[i3 + 1] = this.posTo[i3 + 1]!;
        this.posFrom[i3 + 2] = this.posTo[i3 + 2]!;
        this.scaleFrom[i3] = this.scaleTo[i3]! * 0.55;
        this.scaleFrom[i3 + 1] = this.scaleTo[i3 + 1]! * 0.55;
        this.scaleFrom[i3 + 2] = this.scaleTo[i3 + 2]!;
        this.quatFrom[i4] = this.quatTo[i4]!;
        this.quatFrom[i4 + 1] = this.quatTo[i4 + 1]!;
        this.quatFrom[i4 + 2] = this.quatTo[i4 + 2]!;
        this.quatFrom[i4 + 3] = this.quatTo[i4 + 3]!;
      } else if (nowLive) {
        this.state[i] = CS.RETAIN;
        retaining++;
      } else if (wasLive) {
        this.state[i] = CS.LEAVE;
        leaving++;
        const i3 = i * 3;
        const i4 = i * 4;
        this.posTo[i3] = this.posFrom[i3]!;
        this.posTo[i3 + 1] = this.posFrom[i3 + 1]!;
        this.posTo[i3 + 2] = this.posFrom[i3 + 2]!;
        this.scaleTo[i3] = this.scaleFrom[i3]! * 0.7;
        this.scaleTo[i3 + 1] = this.scaleFrom[i3 + 1]! * 0.7;
        this.scaleTo[i3 + 2] = this.scaleFrom[i3 + 2]!;
        this.quatTo[i4] = this.quatFrom[i4]!;
        this.quatTo[i4 + 1] = this.quatFrom[i4 + 1]!;
        this.quatTo[i4 + 2] = this.quatFrom[i4 + 2]!;
        this.quatTo[i4 + 3] = this.quatFrom[i4 + 3]!;
        this.delay[i] = 0; // leaving cards clear immediately, they do not linger
      } else {
        this.state[i] = CS.ABSENT;
      }
    }

    // A snap means "land now" — first formation, or a context restore. Playing
    // 190 ms from stale from-buffers is exactly the motion reduced-motion asks
    // to remove, so snap wins over the preference.
    this.durMs = snap ? 0 : this.reducedMotion ? FORMATION_REDUCED_MS : FORMATION_MS;
    if (this.reducedMotion && !snap) {
      this.posFrom.set(this.posTo);
      this.quatFrom.set(this.quatTo);
      this.scaleFrom.set(this.scaleTo);
    }
    this.startMs = nowMs;
    this.raw = this.durMs === 0 ? 1 : 0;
    this.firstFormation = false;
    this.tick(nowMs);
    return {
      layoutMs: 0,
      retargetMs: performance.now() - t0,
      entering,
      retaining,
      leaving,
      dropped: 0,
    };
  }

  /** Advance and recompose every live slot. Returns true while animating. */
  tick(nowMs: number): boolean {
    this.raw = this.durMs <= 0 ? 1 : Math.min(1, (nowMs - this.startMs) / this.durMs);
    const raw = this.raw;
    for (let i = 0; i < this.capacity; i++) {
      if (this.state[i] === CS.ABSENT) continue;
      const p = elementProgress(raw, this.delay[i]!);
      const e = easeQuintic(p);
      this.progress[i] = p;
      const i3 = i * 3;
      this.posCur[i3] = this.posFrom[i3]! + (this.posTo[i3]! - this.posFrom[i3]!) * e;
      this.posCur[i3 + 1] = this.posFrom[i3 + 1]! + (this.posTo[i3 + 1]! - this.posFrom[i3 + 1]!) * e;
      this.posCur[i3 + 2] = this.posFrom[i3 + 2]! + (this.posTo[i3 + 2]! - this.posFrom[i3 + 2]!) * e;
      this.scaleCur[i3] = this.scaleFrom[i3]! + (this.scaleTo[i3]! - this.scaleFrom[i3]!) * e;
      this.scaleCur[i3 + 1] = this.scaleFrom[i3 + 1]! + (this.scaleTo[i3 + 1]! - this.scaleFrom[i3 + 1]!) * e;
      this.scaleCur[i3 + 2] = this.scaleFrom[i3 + 2]! + (this.scaleTo[i3 + 2]! - this.scaleFrom[i3 + 2]!) * e;
      slerpInto(this.quatCur, i * 4, this.quatFrom, i * 4, this.quatTo, i * 4, e);
    }
    return raw < 1;
  }

  /**
   * Compose straight into an InstancedMesh's instanceMatrix array.
   *
   * This deliberately never calls getMatrixAt/decompose/setMatrixAt and never
   * touches a Matrix4, Vector3 or Quaternion object: the authoritative state
   * is the typed arrays above and the matrix is a pure function of them, so
   * the per-frame allocation count is exactly zero.
   */
  writeMatrices(out: Float32Array): void {
    for (let i = 0; i < this.capacity; i++) {
      const m = i * 16;
      if (this.state[i] === CS.ABSENT) {
        // collapse absent slots rather than leaving stale geometry on screen
        out[m + 0] = 0; out[m + 5] = 0; out[m + 10] = 0; out[m + 15] = 1;
        continue;
      }
      const i3 = i * 3;
      const i4 = i * 4;
      const x = this.quatCur[i4]!, y = this.quatCur[i4 + 1]!, z = this.quatCur[i4 + 2]!, w = this.quatCur[i4 + 3]!;
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      const sx = this.scaleCur[i3]!, sy = this.scaleCur[i3 + 1]!, sz = this.scaleCur[i3 + 2]!;
      out[m + 0] = (1 - (yy + zz)) * sx;
      out[m + 1] = (xy + wz) * sx;
      out[m + 2] = (xz - wy) * sx;
      out[m + 3] = 0;
      out[m + 4] = (xy - wz) * sy;
      out[m + 5] = (1 - (xx + zz)) * sy;
      out[m + 6] = (yz + wx) * sy;
      out[m + 7] = 0;
      out[m + 8] = (xz + wy) * sz;
      out[m + 9] = (yz - wx) * sz;
      out[m + 10] = (1 - (xx + yy)) * sz;
      out[m + 11] = 0;
      out[m + 12] = this.posCur[i3]!;
      out[m + 13] = this.posCur[i3 + 1]!;
      out[m + 14] = this.posCur[i3 + 2]!;
      out[m + 15] = 1;
    }
  }
}

/** Shortest-arc slerp between two flat-array quaternions, allocation-free. */
export function slerpInto(
  out: Float32Array, oo: number,
  a: Float32Array, ao: number,
  b: Float32Array, bo: number,
  t: number,
): void {
  const ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  let bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  if (t <= 0) { out[oo] = ax; out[oo + 1] = ay; out[oo + 2] = az; out[oo + 3] = aw; return; }
  if (t >= 1) { out[oo] = bx; out[oo + 1] = by; out[oo + 2] = bz; out[oo + 3] = bw; return; }
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  const nx = s0 * ax + s1 * bx;
  const ny = s0 * ay + s1 * by;
  const nz = s0 * az + s1 * bz;
  const nw = s0 * aw + s1 * bw;
  const len = Math.hypot(nx, ny, nz, nw) || 1;
  out[oo] = nx / len;
  out[oo + 1] = ny / len;
  out[oo + 2] = nz / len;
  out[oo + 3] = nw / len;
}
