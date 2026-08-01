import * as THREE from "three";
import { TRACE_SAMPLES, easeQuintic, elementProgress } from "./types";

/**
 * Active traces — organic fibers that become routed board traces.
 *
 * Every trace is sampled at exactly TRACE_SAMPLES cross-sections; the organic
 * curve and the routed schematic are the SAME vertices with two homes, so the
 * fiber untangles into a trace continuously instead of being swapped. Ribbon
 * width is in pixels (expanded in the vertex shader), which keeps traces
 * crisp at any zoom without geometry rebuilds.
 *
 * Slots are fixed-size (TRACE_SAMPLES*2 vertices each) and recycled by key.
 */

const VERTS = TRACE_SAMPLES * 2;
const SEGS = TRACE_SAMPLES - 1;
const IDX = SEGS * 6;

const GLSL_PROGRESS = /* glsl */ `
  const float WINDOW = 0.62;
  float elementP(float raw, float delay) {
    return clamp((raw - delay * (1.0 - WINDOW)) / WINDOW, 0.0, 1.0);
  }
  float easeQ(float t) {
    return t < 0.5 ? 16.0 * t * t * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 5.0) / 2.0;
  }
`;

export class MorphTraces {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;

  from: Float32Array; // centreline sample per vertex (both sides share it)
  to: Float32Array;
  normFrom: Float32Array; // 2D extrusion normal per vertex, from-shape
  normTo: Float32Array;
  side: Float32Array; // ±1
  along: Float32Array; // 0..1 along trace
  color: Float32Array;
  width: Float32Array; // px
  alphaFrom: Float32Array;
  alphaTo: Float32Array;
  kind: Float32Array;
  delay: Float32Array;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private liveCount = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    const nv = capacity * VERTS;
    this.from = new Float32Array(nv * 3);
    this.to = new Float32Array(nv * 3);
    this.normFrom = new Float32Array(nv * 2);
    this.normTo = new Float32Array(nv * 2);
    this.side = new Float32Array(nv);
    this.along = new Float32Array(nv);
    this.color = new Float32Array(nv * 3);
    this.width = new Float32Array(nv);
    this.alphaFrom = new Float32Array(nv);
    this.alphaTo = new Float32Array(nv);
    this.kind = new Float32Array(nv);
    this.delay = new Float32Array(nv);

    const index = new Uint32Array(capacity * IDX);
    for (let t = 0; t < capacity; t++) {
      const v0 = t * VERTS;
      for (let s = 0; s < SEGS; s++) {
        const o = t * IDX + s * 6;
        const a = v0 + s * 2;
        index[o] = a;
        index[o + 1] = a + 1;
        index[o + 2] = a + 2;
        index[o + 3] = a + 1;
        index[o + 4] = a + 3;
        index[o + 5] = a + 2;
      }
    }

    this.geo = new THREE.BufferGeometry();
    const dyn = (arr: Float32Array, itemSize: number) => {
      const a = new THREE.BufferAttribute(arr, itemSize);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.setAttribute("position", dyn(this.from, 3));
    this.geo.setAttribute("aTo", dyn(this.to, 3));
    this.geo.setAttribute("aNormFrom", dyn(this.normFrom, 2));
    this.geo.setAttribute("aNormTo", dyn(this.normTo, 2));
    this.geo.setAttribute("aSide", dyn(this.side, 1));
    this.geo.setAttribute("aAlong", dyn(this.along, 1));
    this.geo.setAttribute("aColor", dyn(this.color, 3));
    this.geo.setAttribute("aWidth", dyn(this.width, 1));
    this.geo.setAttribute("aAlphaFrom", dyn(this.alphaFrom, 1));
    this.geo.setAttribute("aAlphaTo", dyn(this.alphaTo, 1));
    this.geo.setAttribute("aKind", dyn(this.kind, 1));
    this.geo.setAttribute("aDelay", dyn(this.delay, 1));

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // ribbon winding flips with travel direction — single-sided culling
      // silently erases every upward segment
      side: THREE.DoubleSide,
      uniforms: {
        uMorph: { value: 1 },
        uWorldPerPixel: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aTo;
        attribute vec2 aNormFrom, aNormTo;
        attribute float aSide, aAlong, aWidth, aAlphaFrom, aAlphaTo, aKind, aDelay;
        attribute vec3 aColor;
        uniform float uMorph, uWorldPerPixel;
        varying vec3 vColor;
        varying float vAlpha, vSide, vAlong, vKind;
        ${GLSL_PROGRESS}
        void main() {
          float p = elementP(uMorph, aDelay);
          float e = easeQ(p);
          vec3 centre = mix(position, aTo, e);
          vec2 n = normalize(mix(aNormFrom, aNormTo, e) + vec2(1e-6));
          centre.xy += n * aSide * aWidth * uWorldPerPixel * 0.5;
          vColor = aColor;
          vAlpha = mix(aAlphaFrom, aAlphaTo, p);
          vSide = aSide;
          vAlong = aAlong;
          vKind = aKind;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(centre, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vAlpha, vSide, vAlong, vKind;
        void main() {
          float edge = 1.0 - smoothstep(0.62, 1.0, abs(vSide));
          float a = vAlpha * edge;
          // contextual links are dashed — they must never read as match fibers
          if (vKind > 0.5 && vKind < 2.5) {
            float dash = step(0.38, fract(vAlong * 26.0));
            a *= mix(0.12, 1.0, dash);
          }
          if (a < 0.004) discard;
          // gentle port glow at both ends of an organized trace
          float port = smoothstep(0.05, 0.0, vAlong) + smoothstep(0.95, 1.0, vAlong);
          gl_FragColor = vec4(vColor + vec3(0.5) * port * 0.25, a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.geo.setDrawRange(0, 0);
  }

  setMorph(raw: number): void {
    this.mat.uniforms.uMorph!.value = raw;
  }
  setWorldPerPixel(v: number): void {
    this.mat.uniforms.uWorldPerPixel!.value = v;
  }

  setLiveCount(n: number): void {
    this.liveCount = n;
    this.geo.setDrawRange(0, n * IDX);
  }
  get live(): number {
    return this.liveCount;
  }

  /**
   * Write one trace slot: centreline samples for both homes, plus per-shape
   * extrusion normals. `fromPts`/`toPts` are flat xyz, TRACE_SAMPLES each.
   */
  writeSlot(
    slot: number,
    fromPts: Float32Array,
    toPts: Float32Array,
    color: [number, number, number],
    widthPx: number,
    alphaFrom: number,
    alphaTo: number,
    kind: number,
    delay: number,
  ): void {
    const v0 = slot * VERTS;
    for (let s = 0; s < TRACE_SAMPLES; s++) {
      const nFrom = normalAt(fromPts, s);
      const nTo = normalAt(toPts, s);
      for (let sideI = 0; sideI < 2; sideI++) {
        const v = v0 + s * 2 + sideI;
        const v3 = v * 3;
        const v2 = v * 2;
        this.from[v3] = fromPts[s * 3]!;
        this.from[v3 + 1] = fromPts[s * 3 + 1]!;
        this.from[v3 + 2] = fromPts[s * 3 + 2]!;
        this.to[v3] = toPts[s * 3]!;
        this.to[v3 + 1] = toPts[s * 3 + 1]!;
        this.to[v3 + 2] = toPts[s * 3 + 2]!;
        this.normFrom[v2] = nFrom[0];
        this.normFrom[v2 + 1] = nFrom[1];
        this.normTo[v2] = nTo[0];
        this.normTo[v2 + 1] = nTo[1];
        this.side[v] = sideI === 0 ? -1 : 1;
        this.along[v] = s / SEGS;
        this.color[v3] = color[0];
        this.color[v3 + 1] = color[1];
        this.color[v3 + 2] = color[2];
        this.width[v] = widthPx;
        this.alphaFrom[v] = alphaFrom;
        this.alphaTo[v] = alphaTo;
        this.kind[v] = kind;
        this.delay[v] = delay;
      }
    }
  }

  /** Fold current interpolation into from-state for one slot. */
  captureSlot(slot: number, raw: number): void {
    const v0 = slot * VERTS;
    for (let v = v0; v < v0 + VERTS; v++) {
      const p = elementProgress(raw, this.delay[v]!);
      const e = easeQuintic(p);
      const v3 = v * 3;
      const v2 = v * 2;
      this.from[v3] = this.from[v3]! + (this.to[v3]! - this.from[v3]!) * e;
      this.from[v3 + 1] = this.from[v3 + 1]! + (this.to[v3 + 1]! - this.from[v3 + 1]!) * e;
      this.from[v3 + 2] = this.from[v3 + 2]! + (this.to[v3 + 2]! - this.from[v3 + 2]!) * e;
      this.normFrom[v2] = this.normFrom[v2]! + (this.normTo[v2]! - this.normFrom[v2]!) * e;
      this.normFrom[v2 + 1] = this.normFrom[v2 + 1]! + (this.normTo[v2 + 1]! - this.normFrom[v2 + 1]!) * e;
      this.alphaFrom[v] = this.alphaFrom[v]! + (this.alphaTo[v]! - this.alphaFrom[v]!) * p;
    }
  }

  /** Current centreline of a slot (for pulses riding a trace). */
  currentCentreline(slot: number, raw: number, out: Float32Array): void {
    const v0 = slot * VERTS;
    for (let s = 0; s < TRACE_SAMPLES; s++) {
      const v = v0 + s * 2;
      const p = elementProgress(raw, this.delay[v]!);
      const e = easeQuintic(p);
      const v3 = v * 3;
      out[s * 3] = this.from[v3]! + (this.to[v3]! - this.from[v3]!) * e;
      out[s * 3 + 1] = this.from[v3 + 1]! + (this.to[v3 + 1]! - this.from[v3 + 1]!) * e;
      out[s * 3 + 2] = this.from[v3 + 2]! + (this.to[v3 + 2]! - this.from[v3 + 2]!) * e;
    }
  }

  commit(): void {
    for (const name of [
      "position", "aTo", "aNormFrom", "aNormTo", "aSide", "aAlong",
      "aColor", "aWidth", "aAlphaFrom", "aAlphaTo", "aKind", "aDelay",
    ]) {
      (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/** 2D extrusion normal for sample s — perpendicular of the local tangent. */
function normalAt(pts: Float32Array, s: number): [number, number] {
  const i0 = Math.max(0, s - 1) * 3;
  const i1 = Math.min(TRACE_SAMPLES - 1, s + 1) * 3;
  const dx = pts[i1]! - pts[i0]!;
  const dy = pts[i1 + 1]! - pts[i0 + 1]!;
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}
