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
import {
  DynamicDrawUsage, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial, type Scene,
} from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { GLYPH_GLSL } from "./ArenaCards";

const SAMPLES = 2; // a rail segment is a straight run of documented years

/** Marker size as a fraction of the rail's half-width, so the belts hold the
 *  same proportion whether the arena is a 31-card scope or a 600-card one. */
const MARKER_W = 0.055;
const MARKER_ASPECT = 0.62;
/** The quad's span in the glyph's own units (see ArenaCards GLYPH_GLSL). The
 *  belt is 0.25 wide and 0.112 tall there, so this leaves a small margin. */
const MARKER_SPAN_X = 0.30;
const MARKER_SPAN_Y = 0.186;

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

  /**
   * A belt on each documented run.
   *
   * The rail's gold already says "championships", but only if you have been
   * told so; the belt says it without a legend, and it is the same mark the
   * cards print for a title, so the two readings agree. One per SEGMENT rather
   * than per year: a segment is one unbroken run of documented title activity,
   * which is the unit the rail draws and the unit the gaps separate.
   */
  private readonly markers: InstancedMesh;
  private readonly markerGeo: PlaneGeometry;
  private readonly markerMat: ShaderMaterial;
  private readonly markerMatrix = new Matrix4();
  private markerLive = 0;
  /** World x of each placed marker, for the collision rule below. */
  private readonly markerX: Float64Array;
  /** Which segment each marker belongs to, so the chronological reveal brings
   *  a belt in with its own run rather than with a fixed fraction. */
  private readonly markerSegment: Int32Array;
  /** Segments that got no belt because one was already drawn within a marker's
   *  width. The runs are all still on the rail; only the mark is suppressed. */
  private markersSuppressed = 0;

  constructor(scene: Scene, readonly capacity: number) {
    this.material = new LineMaterial({
      color: 0xffd479, linewidth: 4.2, transparent: true, opacity: 0.85, dashed: false,
    });
    this.markerX = new Float64Array(capacity);
    this.markerSegment = new Int32Array(capacity);
    this.markerGeo = new PlaneGeometry(1, 1);
    this.markerMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          // Billboarded: the rail lies flat across the front of the arena and
          // the camera orbits it, so a mark fixed to that plane would thin to
          // an edge exactly when the reader turns to look along the rail.
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sx = length(instanceMatrix[0].xyz);
          float sy = length(instanceMatrix[1].xyz);
          mv.xy += vec2(position.x * sx, position.y * sy);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uGold;
        varying vec2 vUv;
        ${GLYPH_GLSL}
        void main() {
          vec2 g = (vUv - 0.5) * vec2(${MARKER_SPAN_X.toFixed(3)}, ${MARKER_SPAN_Y.toFixed(3)});
          float d = sdBelt(g, 0.0);
          float aa = max(fwidth(g.x), 0.0006) * 1.2;
          float a = smoothstep(aa, -aa, d);
          if (a <= 0.004) discard;
          gl_FragColor = vec4(uGold, a);
        }`,
      uniforms: {
        uGold: { value: [1.0, 0.83, 0.47] },
      },
    });
    this.markers = new InstancedMesh(this.markerGeo, this.markerMat, capacity);
    this.markers.instanceMatrix.setUsage(DynamicDrawUsage);
    this.markers.frustumCulled = false;
    this.markers.count = 0;
    scene.add(this.markers);
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
    this.markerLive = 0;
    this.markersSuppressed = 0;
    this.markers.count = 0;
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

      // One belt per run, centred on it and riding just above the wire. A
      // marker is skipped when the previous one is still within a marker width:
      // a promotion documenting alternate years produces runs closer together
      // than the mark is wide, and a row of overlapping belts reads as a solid
      // gold smear rather than as marked runs.
      const width = halfWidth * MARKER_W;
      const mid = (x0 + x1) * 0.5;
      if (this.markerLive === 0 || mid - this.markerX[this.markerLive - 1]! >= width) {
        this.markerMatrix.makeScale(width, width * MARKER_ASPECT, 1);
        // Above the wire, not on it: the run itself is the reading, and a mark
        // sitting on the line would break the very continuity it is marking.
        this.markerMatrix.setPosition(mid, y + width * 0.78, z);
        this.markers.setMatrixAt(this.markerLive, this.markerMatrix);
        this.markerX[this.markerLive] = mid;
        this.markerSegment[this.markerLive] = this.live;
        this.markerLive++;
      } else {
        this.markersSuppressed++;
      }
      this.live++;
    }
    this.markers.instanceMatrix.needsUpdate = true;
    this.setReveal(this.reveal);
  }

  /** Runs the rail drew without a belt because the mark would have collided
   *  with its neighbour. Never a dropped segment — only a dropped mark. */
  get suppressedMarkers(): number {
    return this.markersSuppressed;
  }

  /** Left-to-right chronological reveal: segments appear in time order. */
  setReveal(reveal: number): void {
    this.reveal = Math.min(1, Math.max(0, reveal));
    const shown = Math.round(this.live * this.reveal);
    for (let i = 0; i < this.live; i++) this.slots[i]!.line.visible = i < shown;
    // Markers are ordered by segment, so the revealed run is a prefix here too.
    let markers = 0;
    while (markers < this.markerLive && this.markerSegment[markers]! < shown) markers++;
    this.markers.count = markers;
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.line.removeFromParent();
      slot.geo.dispose();
    }
    this.material.dispose();
    this.markers.removeFromParent();
    this.markerGeo.dispose();
    this.markerMat.dispose();
    this.markers.dispose();
    this.slots.length = 0;
    this.live = 0;
    this.markerLive = 0;
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
