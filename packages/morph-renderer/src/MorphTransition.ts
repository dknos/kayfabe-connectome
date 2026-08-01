import type { MorphNodes } from "./MorphNodes";
import type { MorphRegions } from "./MorphRegions";
import type { MorphTraces } from "./MorphTraces";
import {
  MORPH_MS,
  MORPH_REDUCED_MS,
  TRACE_SAMPLES,
  type MorphLayoutResult,
  type MorphRoute,
} from "./types";

/**
 * The staged semantic transition.
 *
 * One shared raw clock; every element owns a delay so the anchor settles
 * first, the neighbourhood reorganises, the background compresses, traces
 * re-route and labels arrive last — the spec's phases A–E expressed as delay
 * bands rather than five separate clocks.
 *
 * A retarget mid-flight captures the interpolated state into the from-buffers
 * (nodes, live traces, regions) and restarts the clock — travel continues
 * from exactly what is on screen, never from the abandoned source.
 */

interface TraceSlotState {
  key: string;
  route: MorphRoute | null; // null = exiting
}

export class MorphTransition {
  private startMs = 0;
  private durMs = MORPH_MS;
  private raw = 1;
  private firstLayout = true;
  reducedMotion = false;

  /** live + exiting trace slots; index = slot */
  private traceSlots: TraceSlotState[] = [];
  private traceByKey = new Map<string, number>();

  /** virtual chip slot assignment (corpus-count offset applied by caller) */
  private virtualByKey = new Map<string, number>();
  private virtualFree: number[] = [];

  private cleanupPending = false;

  constructor(
    private corpusCount: number,
    private virtualCap: number,
  ) {
    for (let i = 0; i < virtualCap; i++) this.virtualFree.push(virtualCap - 1 - i);
  }

  get progress(): number {
    return this.raw;
  }
  get animating(): boolean {
    return this.raw < 1;
  }
  get liveTraceCount(): number {
    return this.traceSlots.length;
  }

  virtualSlotOf(id: string): number | undefined {
    return this.virtualByKey.get(id);
  }
  traceSlotOf(key: string): number | undefined {
    return this.traceByKey.get(key);
  }
  virtualIds(): Map<string, number> {
    return this.virtualByKey;
  }

  reset(): void {
    this.firstLayout = true;
    this.raw = 1;
    this.traceSlots = [];
    this.traceByKey.clear();
    this.virtualByKey.clear();
    this.virtualFree = [];
    for (let i = 0; i < this.virtualCap; i++) this.virtualFree.push(this.virtualCap - 1 - i);
  }

  apply(
    layout: MorphLayoutResult,
    nodes: MorphNodes,
    traces: MorphTraces,
    regions: MorphRegions,
    nowMs: number,
    immediate = false,
  ): void {
    const snap = immediate || this.firstLayout;
    const raw = this.raw;

    // ---- capture what is on screen ----
    if (!snap) {
      nodes.captureCurrent(raw);
      for (let s = 0; s < this.traceSlots.length; s++) traces.captureSlot(s, raw);
    }

    // ---- corpus nodes ----
    const n = this.corpusCount;
    nodes.to.set(layout.nodeTargets.subarray(0, n * 3));
    nodes.scaleTo.set(layout.nodeScale.subarray(0, n));
    nodes.alphaTo.set(layout.nodeOpacity.subarray(0, n));
    nodes.delay.set(layout.nodeDelay.subarray(0, n));

    // ---- virtual chips ----
    const nextVirtualKeys = new Set<string>();
    for (const v of layout.virtuals) nextVirtualKeys.add(v.id);
    // free slots whose chip is gone (fade where they stand)
    for (const [id, slot] of [...this.virtualByKey]) {
      if (!nextVirtualKeys.has(id)) {
        const g = n + slot;
        nodes.alphaTo[g] = 0;
        nodes.to[g * 3] = nodes.from[g * 3]!;
        nodes.to[g * 3 + 1] = nodes.from[g * 3 + 1]!;
        nodes.to[g * 3 + 2] = nodes.from[g * 3 + 2]!;
        nodes.scaleTo[g] = nodes.scaleFrom[g]! * 0.7;
        nodes.delay[g] = 0;
        this.virtualByKey.delete(id);
        this.virtualFree.push(slot);
      }
    }
    for (const v of layout.virtuals) {
      let slot = this.virtualByKey.get(v.id);
      const fresh = slot === undefined;
      if (slot === undefined) {
        slot = this.virtualFree.pop();
        if (slot === undefined) continue; // cap reached — layouts surface this in notes
        this.virtualByKey.set(v.id, slot);
      }
      const g = n + slot;
      const g3 = g * 3;
      if (fresh || snap) {
        nodes.from[g3] = v.x;
        nodes.from[g3 + 1] = v.y;
        nodes.from[g3 + 2] = v.z;
        nodes.alphaFrom[g] = 0;
        nodes.scaleFrom[g] = v.scale * 0.4;
      }
      nodes.to[g3] = v.x;
      nodes.to[g3 + 1] = v.y;
      nodes.to[g3 + 2] = v.z;
      nodes.alphaTo[g] = v.opacity;
      nodes.scaleTo[g] = v.scale;
      nodes.delay[g] = 0.35;
      nodes.color[g3] = v.color[0];
      nodes.color[g3 + 1] = v.color[1];
      nodes.color[g3 + 2] = v.color[2];
      nodes.shape[g] = v.id.startsWith("t:") ? 2 : v.id.startsWith("pr:") ? 1 : 0;
    }

    // ---- traces ----
    const nextByKey = new Map<string, MorphRoute>();
    for (const r of layout.routes) nextByKey.set(r.key, r);

    // exits: keep captured geometry, fade out early in the window
    for (let s = 0; s < this.traceSlots.length; s++) {
      const st = this.traceSlots[s]!;
      if (!nextByKey.has(st.key)) {
        st.route = null;
        this.traceByKey.delete(st.key);
        fadeOutSlot(traces, s);
      }
    }

    // updates + entries
    const scratch = new Float32Array(TRACE_SAMPLES * 3);
    for (const route of layout.routes) {
      let slot = this.traceByKey.get(route.key);
      if (slot === undefined) {
        // reuse an exiting slot or append
        slot = this.traceSlots.findIndex((t) => t.route === null);
        if (slot === -1) {
          if (this.traceSlots.length >= traces.capacity) continue; // cap surfaced by layout notes
          slot = this.traceSlots.length;
          this.traceSlots.push({ key: route.key, route });
        } else {
          this.traceSlots[slot] = { key: route.key, route };
        }
        this.traceByKey.set(route.key, slot);
        const fromPts = route.fromPoints ?? deriveFromLine(route, nodes, n, scratch);
        traces.writeSlot(slot, fromPts, route.points, route.color, route.width, 0, route.alpha, route.kind, 0.3);
        if (snap) {
          // land instantly: from := to
          copySlotFromTo(traces, slot, route.alpha);
        }
      } else {
        const st = this.traceSlots[slot]!;
        st.route = route;
        // captured from-state already holds current shape; write new target
        overwriteSlotTarget(traces, slot, route);
      }
    }

    // ---- regions (fade generations under the shared clock) ----
    // the outgoing generation starts from the opacity it had reached
    regions.setRegions(layout.regions, snap ? 1 : raw);

    // ---- clock ----
    // snap wins over reduced motion: a snap means "land now" (first layout,
    // context restore) and animating 190 ms from stale from-buffers is the
    // exact motion the preference asks to remove
    this.durMs = snap ? 0 : this.reducedMotion ? MORPH_REDUCED_MS : MORPH_MS;
    if (this.reducedMotion && !snap) {
      // geometry lands at once; only light crossfades
      nodes.from.set(nodes.to);
      nodes.scaleFrom.set(nodes.scaleTo);
      traces.from.set(traces.to);
      traces.normFrom.set(traces.normTo);
    }
    this.startMs = nowMs;
    this.raw = this.durMs === 0 ? 1 : 0;
    this.firstLayout = false;
    this.cleanupPending = true;

    traces.setLiveCount(this.traceSlots.length);
    nodes.commitMotion();
    nodes.commitStatic();
    traces.commit();
    nodes.setMorph(this.raw);
    traces.setMorph(this.raw);
    regions.setMorph(this.raw);
  }

  /** advance; returns true while animating */
  tick(nowMs: number, nodes: MorphNodes, traces: MorphTraces, regions: MorphRegions): boolean {
    if (this.raw >= 1) {
      if (this.cleanupPending) this.cleanup(traces, regions);
      return false;
    }
    this.raw = this.durMs <= 0 ? 1 : Math.min(1, (nowMs - this.startMs) / this.durMs);
    nodes.setMorph(this.raw);
    traces.setMorph(this.raw);
    regions.setMorph(this.raw);
    if (this.raw >= 1 && this.cleanupPending) this.cleanup(traces, regions);
    return this.raw < 1;
  }

  private cleanup(traces: MorphTraces, regions: MorphRegions): void {
    this.cleanupPending = false;
    // drop trailing exited slots; interior exited slots stay parked (alpha 0)
    while (this.traceSlots.length > 0 && this.traceSlots[this.traceSlots.length - 1]!.route === null) {
      this.traceSlots.pop();
    }
    traces.setLiveCount(this.traceSlots.length);
    regions.truncateToCurrent();
  }
}

function fadeOutSlot(traces: MorphTraces, slot: number): void {
  const v0 = slot * TRACE_SAMPLES * 2;
  for (let v = v0; v < v0 + TRACE_SAMPLES * 2; v++) {
    const v3 = v * 3;
    traces.to[v3] = traces.from[v3]!;
    traces.to[v3 + 1] = traces.from[v3 + 1]!;
    traces.to[v3 + 2] = traces.from[v3 + 2]!;
    traces.normTo[v * 2] = traces.normFrom[v * 2]!;
    traces.normTo[v * 2 + 1] = traces.normFrom[v * 2 + 1]!;
    traces.alphaTo[v] = 0;
    traces.delay[v] = 0;
  }
}

function overwriteSlotTarget(traces: MorphTraces, slot: number, route: MorphRoute): void {
  const v0 = slot * TRACE_SAMPLES * 2;
  const pts = route.points;
  for (let s = 0; s < TRACE_SAMPLES; s++) {
    const i0 = Math.max(0, s - 1) * 3;
    const i1 = Math.min(TRACE_SAMPLES - 1, s + 1) * 3;
    const dx = pts[i1]! - pts[i0]!;
    const dy = pts[i1 + 1]! - pts[i0 + 1]!;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    for (let sideI = 0; sideI < 2; sideI++) {
      const v = v0 + s * 2 + sideI;
      const v3 = v * 3;
      traces.to[v3] = pts[s * 3]!;
      traces.to[v3 + 1] = pts[s * 3 + 1]!;
      traces.to[v3 + 2] = pts[s * 3 + 2]!;
      traces.normTo[v * 2] = nx;
      traces.normTo[v * 2 + 1] = ny;
      traces.alphaTo[v] = route.alpha;
      traces.color[v3] = route.color[0];
      traces.color[v3 + 1] = route.color[1];
      traces.color[v3 + 2] = route.color[2];
      traces.width[v] = route.width;
      traces.kind[v] = route.kind;
      traces.delay[v] = 0.3;
    }
  }
}

function copySlotFromTo(traces: MorphTraces, slot: number, alpha: number): void {
  const v0 = slot * TRACE_SAMPLES * 2;
  for (let v = v0; v < v0 + TRACE_SAMPLES * 2; v++) {
    const v3 = v * 3;
    traces.from[v3] = traces.to[v3]!;
    traces.from[v3 + 1] = traces.to[v3 + 1]!;
    traces.from[v3 + 2] = traces.to[v3 + 2]!;
    traces.normFrom[v * 2] = traces.normTo[v * 2]!;
    traces.normFrom[v * 2 + 1] = traces.normTo[v * 2 + 1]!;
    traces.alphaFrom[v] = alpha;
  }
}

/**
 * A fresh trace with no organic ancestor starts as a gentle bow between its
 * endpoints' CURRENT from-positions, so it fades in already travelling with
 * its nodes instead of materialising fully-routed.
 */
function deriveFromLine(
  route: MorphRoute,
  nodes: MorphNodes,
  corpusCount: number,
  scratch: Float32Array,
): Float32Array {
  const out = new Float32Array(TRACE_SAMPLES * 3);
  void scratch;
  const a = route.a >= 0 && route.a < nodes.total ? route.a : -1;
  const b = route.b >= 0 && route.b < nodes.total ? route.b : -1;
  void corpusCount;
  const ax = a >= 0 ? nodes.from[a * 3]! : route.points[0]!;
  const ay = a >= 0 ? nodes.from[a * 3 + 1]! : route.points[1]!;
  const az = a >= 0 ? nodes.from[a * 3 + 2]! : route.points[2]!;
  const bi = (TRACE_SAMPLES - 1) * 3;
  const bx = b >= 0 ? nodes.from[b * 3]! : route.points[bi]!;
  const by = b >= 0 ? nodes.from[b * 3 + 1]! : route.points[bi + 1]!;
  const bz = b >= 0 ? nodes.from[b * 3 + 2]! : route.points[bi + 2]!;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2 + Math.hypot(bx - ax, by - ay) * 0.06;
  const mz = (az + bz) / 2;
  for (let s = 0; s < TRACE_SAMPLES; s++) {
    const t = s / (TRACE_SAMPLES - 1);
    const u = 1 - t;
    out[s * 3] = u * u * ax + 2 * u * t * mx + t * t * bx;
    out[s * 3 + 1] = u * u * ay + 2 * u * t * my + t * t * by;
    out[s * 3 + 2] = u * u * az + 2 * u * t * mz + t * t * bz;
  }
  return out;
}
