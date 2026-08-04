/**
 * The championship rail.
 *
 * A gold chronology laid across the front of the arena, revealing left to
 * right. Each segment is a year in which the corpus documents title activity;
 * a year with none is left EMPTY, because an unbroken rail would claim a
 * continuity the evidence does not have. That is the whole point of drawing it
 * this way rather than as a single bar with a gradient.
 *
 * Built from fat lines for the same reason routes are: a 1-pixel core line is
 * capped by drivers and cannot carry a readable weight. Segments are pooled and
 * the reveal runs on `geometry.instanceCount`, the same mechanism the routes
 * use, because `setDrawRange` is inert on `Line2`.
 */
import type { Scene } from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

const SAMPLES = 2; // a rail segment is a straight run of documented years

export interface RailSegment {
  fromYear: number;
  toYear: number;
  /** documented title matches in this run, for weight */
  weight: number;
}

interface RailSlot {
  line: Line2;
  geo: LineGeometry;
  points: Float32Array;
  interleaved: { array: Float32Array; needsUpdate: boolean } | null;
}

export class ArenaRail {
  private readonly slots: RailSlot[] = [];
  private readonly material: LineMaterial;
  private live = 0;
  private reveal = 1;
  span: [number, number] | null = null;

  constructor(scene: Scene, readonly capacity: number) {
    this.material = new LineMaterial({
      color: 0xffd479, linewidth: 4.2, transparent: true, opacity: 0.85, dashed: false,
    });
    for (let i = 0; i < capacity; i++) {
      const geo = new LineGeometry();
      const points = new Float32Array(SAMPLES * 3);
      for (let s = 0; s < SAMPLES; s++) points[s * 3] = s * 0.001;
      geo.setPositions(points);
      const line = new Line2(geo, this.material);
      line.computeLineDistances();
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      const attr = geo.getAttribute("instanceStart") as { data?: { array: Float32Array; needsUpdate: boolean } };
      this.slots.push({ line, geo, points, interleaved: attr?.data ?? null });
    }
  }

  get count(): number {
    return this.live;
  }

  setResolution(cssWidth: number, cssHeight: number): void {
    this.material.resolution.set(cssWidth, cssHeight);
  }

  /**
   * Lay documented runs across a fixed width in front of the seating. Year is
   * mapped linearly across the full scope span, so a gap is proportional to the
   * silence it represents rather than being squeezed out by the runs either
   * side of it.
   */
  build(segments: readonly RailSegment[], spanFrom: number, spanTo: number, halfWidth: number, z: number, y: number): void {
    for (const slot of this.slots) slot.line.visible = false;
    this.live = 0;
    this.span = null;
    if (segments.length === 0 || spanTo <= spanFrom) return;
    this.span = [spanFrom, spanTo];
    const range = spanTo - spanFrom;
    const at = (year: number): number => ((year - spanFrom) / range) * 2 * halfWidth - halfWidth;
    for (const seg of segments) {
      if (this.live >= this.capacity) break;
      const slot = this.slots[this.live]!;
      const x0 = at(seg.fromYear);
      // A single documented year still needs a visible run, so it gets a
      // minimum width rather than collapsing to a zero-length line.
      const x1 = Math.max(at(seg.toYear + 1), x0 + halfWidth * 0.006);
      slot.points[0] = x0; slot.points[1] = y; slot.points[2] = z;
      slot.points[3] = x1; slot.points[4] = y; slot.points[5] = z;
      if (slot.interleaved) {
        const buf = slot.interleaved.array;
        buf[0] = x0; buf[1] = y; buf[2] = z;
        buf[3] = x1; buf[4] = y; buf[5] = z;
        slot.interleaved.needsUpdate = true;
      }
      slot.line.visible = true;
      this.live++;
    }
    this.setReveal(this.reveal);
  }

  /** Left-to-right chronological reveal: segments appear in time order. */
  setReveal(reveal: number): void {
    this.reveal = Math.min(1, Math.max(0, reveal));
    const shown = Math.round(this.live * this.reveal);
    for (let i = 0; i < this.live; i++) this.slots[i]!.line.visible = i < shown;
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.line.removeFromParent();
      slot.geo.dispose();
    }
    this.material.dispose();
    this.slots.length = 0;
    this.live = 0;
  }
}

/**
 * Collapse a year->count map into contiguous documented runs. Consecutive
 * documented years merge into one segment; a year with nothing stays out, and
 * that absence is what the rail draws as a gap.
 */
export function railSegmentsFromYears(yearFrom: number, counts: readonly number[]): RailSegment[] {
  const out: RailSegment[] = [];
  let start = -1;
  let weight = 0;
  for (let i = 0; i <= counts.length; i++) {
    const c = i < counts.length ? (counts[i] ?? 0) : 0;
    if (c > 0) {
      if (start < 0) { start = yearFrom + i; weight = 0; }
      weight += c;
    } else if (start >= 0) {
      out.push({ fromYear: start, toYear: yearFrom + i - 1, weight });
      start = -1;
    }
  }
  return out;
}
