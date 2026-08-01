import * as THREE from "three";

/**
 * Every rectangle in the atlas, in one instanced draw call.
 *
 * Promotion platforms, span rails, gold title rails, reign blocks, activity
 * bars, year ticks, era dividers and lineage gaps are all axis-aligned quads
 * that differ only in treatment, so `kind` selects a branch in the fragment
 * shader rather than a new mesh. At overview scale this corpus emits ~36,000
 * of them (571 promotions, 4,389 championships, and one bar per
 * promotion-year with records) — as separate objects that would be 36,000
 * draw calls and an unusable frame.
 *
 * Painter's ordering, not the depth buffer: the quads are translucent and
 * overlapping (a title rail sits on its promotion's platform), and translucent
 * geometry needs back-to-front draw order, which the depth buffer cannot give.
 * The transition writes instances in layer order and this material draws them
 * in that order with depth testing off.
 */

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec3 iColor;
attribute vec4 iParams;   // x alpha, y kind, z param, w reserved

uniform float uPxPerWorld;

varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParams;
varying vec2 vSizePx;

void main() {
  vUv = position.xy + 0.5;
  vColor = iColor;
  vParams = iParams;
  vSizePx = max(abs(iSize) * uPxPerWorld, vec2(0.0001));
  vec3 p = vec3(position.xy * iSize, 0.0) + iPos;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParams;
varying vec2 vSizePx;

const float K_PLATFORM   = 0.0;
const float K_RAIL       = 1.0;
const float K_TITLE      = 2.0;
const float K_REIGN      = 3.0;
const float K_REIGN_OPEN = 4.0;
const float K_TICK       = 5.0;
const float K_DIVIDER    = 6.0;
const float K_GAP        = 7.0;
const float K_PLATE      = 8.0;

/** Capsule coverage in local quad space, antialiased against pixel size. */
float capsule(vec2 uv, vec2 sizePx) {
  float aspect = sizePx.x / sizePx.y;
  vec2 q = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
  float r = 0.5;
  float halfLen = max(0.0, aspect * 0.5 - r);
  float d = length(vec2(max(abs(q.x) - halfLen, 0.0), q.y)) - r;
  // one device pixel of feather, expressed in the same local units as d
  float aa = max(1.0 / sizePx.y, 0.0015);
  return 1.0 - smoothstep(-aa, aa, d);
}

void main() {
  float alpha = vParams.x;
  float kind  = vParams.y;
  float param = vParams.z;
  vec3  col   = vColor;
  float cov   = 1.0;

  if (kind < K_RAIL - 0.5) {
    // PLATFORM — a lit top edge and a falling gradient read as an extruded
    // slab under the tilted camera without any real geometry behind it.
    cov = 1.0;
    float grad = mix(0.55, 1.0, pow(vUv.y, 0.7));
    col *= grad;
    float lip = smoothstep(1.0 - 2.2 / vSizePx.y, 1.0, vUv.y);
    col += vColor * lip * 1.5;
  } else if (kind < K_TITLE - 0.5) {
    // RAIL — the promotion's documented span.
    cov = capsule(vUv, vSizePx);
    col *= mix(0.78, 1.18, vUv.y);
  } else if (kind < K_REIGN - 0.5) {
    // TITLE — gold, with a sheen band so a belt reads as metal rather than as
    // a yellow line. iParams.z is the sheen strength.
    cov = capsule(vUv, vSizePx);
    float sheen = exp(-pow((vUv.y - 0.68) * 4.2, 2.0));
    col = col * mix(0.72, 1.06, vUv.y) + col * sheen * (0.55 * param);
  } else if (kind < K_REIGN_OPEN - 0.5) {
    // REIGN — a closed reign. The left edge is the documented title change,
    // so it is the brightest thing in the block.
    cov = capsule(vUv, vSizePx);
    float lead = smoothstep(0.10, 0.0, vUv.x);
    col = col * mix(0.80, 1.05, vUv.y) + vec3(1.0, 0.92, 0.72) * lead * 0.55;
  } else if (kind < K_TICK - 0.5) {
    // REIGN_OPEN — open at the corpus edge. The right end DISSOLVES instead of
    // ending, because what stops there is the record, not the reign.
    cov = capsule(vUv, vSizePx);
    float lead = smoothstep(0.10, 0.0, vUv.x);
    col = col * mix(0.80, 1.05, vUv.y) + vec3(1.0, 0.92, 0.72) * lead * 0.55;
    float tail = smoothstep(0.55, 1.0, vUv.x);
    cov *= 1.0 - tail * 0.92;
    // dashes only over the dissolving part, so "open" is legible when still
    float dash = step(0.45, fract(vUv.x * vSizePx.x / 7.0));
    cov *= mix(1.0, dash, tail);
  } else if (kind < K_DIVIDER - 0.5) {
    // TICK — hard rectangle. Activity bars and the playhead.
    cov = 1.0;
  } else if (kind < K_GAP - 0.5) {
    // DIVIDER — fades out at both ends so an era boundary suggests rather than
    // fences.
    cov = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
    cov *= mix(0.35, 1.0, vUv.y);
  } else if (kind < K_PLATE - 0.5) {
    // GAP — an unrecorded interval. Hatched, and never coloured like a reign,
    // because the corpus does not say the belt was vacant. It says nothing.
    float h = fract((vUv.x * vSizePx.x + vUv.y * vSizePx.y) / 9.0);
    cov = step(0.55, h) * 0.85;
  } else {
    // PLATE — flat fill: zone backings, selection halos.
    cov = 1.0;
  }

  float a = alpha * cov;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class AtlasRails {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private capacity = 0;

  pos!: Float32Array;
  size!: Float32Array;
  color!: Float32Array;
  params!: Float32Array;

  private aPos!: THREE.InstancedBufferAttribute;
  private aSize!: THREE.InstancedBufferAttribute;
  private aColor!: THREE.InstancedBufferAttribute;
  private aParams!: THREE.InstancedBufferAttribute;

  constructor() {
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]);
    this.geo.setAttribute("position", new THREE.BufferAttribute(quad, 3));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPxPerWorld: { value: 1 } },
      transparent: true,
      // Painter's order — see the note at the top of this file.
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.grow(4096);
  }

  get count(): number {
    return this.geo.instanceCount;
  }

  /** Ensure room for `n` instances, growing geometrically. */
  grow(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(4096, 1 << Math.ceil(Math.log2(n)));
    this.pos = new Float32Array(cap * 3);
    this.size = new Float32Array(cap * 2);
    this.color = new Float32Array(cap * 3);
    this.params = new Float32Array(cap * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3);
    this.aSize = new THREE.InstancedBufferAttribute(this.size, 2);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 3);
    this.aParams = new THREE.InstancedBufferAttribute(this.params, 4);
    for (const a of [this.aPos, this.aSize, this.aColor, this.aParams]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("iPos", this.aPos);
    this.geo.setAttribute("iSize", this.aSize);
    this.geo.setAttribute("iColor", this.aColor);
    this.geo.setAttribute("iParams", this.aParams);
    this.capacity = cap;
  }

  setCount(n: number): void {
    this.geo.instanceCount = Math.min(n, this.capacity);
  }

  /** Mark the buffers dirty. Called once per frame during a morph, and once
   *  per scene change otherwise — never per instance. */
  commit(): void {
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aParams.needsUpdate = true;
  }

  /** Static attributes only — colour and kind do not animate. */
  commitStatic(): void {
    this.aColor.needsUpdate = true;
    this.aParams.needsUpdate = true;
  }

  setPixelsPerWorld(v: number): void {
    this.mat.uniforms.uPxPerWorld!.value = v;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
