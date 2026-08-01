import * as THREE from "three";

/**
 * Point entities: wrestlers on a promotion board, holders on a lineage rail,
 * event markers on a spine.
 *
 * A separate mesh from the rails because points need round/diamond shapes and
 * a screen-space size clamp, not a quad treatment — and because a wrestler
 * zone can hold thousands of them, so they must instance too.
 *
 * The size clamp is load-bearing. Unclamped gl_PointSize is how the connectome
 * once produced supernovas during playback; the same arithmetic applies here
 * the moment a reader zooms into a single reign.
 */

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute float iSize;
attribute vec3 iColor;
attribute vec2 iParams;   // x alpha, y shape

uniform float uPxPerWorld;
uniform float uPixelRatio;
uniform float uMaxPx;

varying vec3 vColor;
varying vec2 vParams;

void main() {
  vColor = iColor;
  vParams = iParams;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(iSize * uPxPerWorld * uPixelRatio, 2.0 * uPixelRatio, uMaxPx);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying vec2 vParams;

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float shape = vParams.y;
  float d;
  if (shape > 1.5 && shape < 2.5) {
    // TITLE — a diamond, matching the connectome's championship glyph.
    d = (abs(p.x) + abs(p.y)) * 1.42;
  } else if (shape > 0.5 && shape < 1.5) {
    // PROMOTION — a ring, so an anchor never reads as a person.
    float r = length(p) * 2.0;
    float ring = 1.0 - smoothstep(0.62, 0.98, abs(r - 0.72) * 3.4);
    float a = vParams.x * ring;
    if (a <= 0.01) discard;
    gl_FragColor = vec4(vColor, a);
    return;
  } else {
    d = length(p) * 2.0;
  }
  float a = vParams.x * (1.0 - smoothstep(0.72, 1.0, d));
  // A hot core keeps a 3px dot legible against a lit platform.
  vec3 col = vColor + vColor * (1.0 - smoothstep(0.0, 0.45, d)) * 0.6;
  if (a <= 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class AtlasNodes {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private capacity = 0;

  pos!: Float32Array;
  size!: Float32Array;
  color!: Float32Array;
  params!: Float32Array;

  private aPos!: THREE.BufferAttribute;
  private aSize!: THREE.BufferAttribute;
  private aColor!: THREE.BufferAttribute;
  private aParams!: THREE.BufferAttribute;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uPxPerWorld: { value: 1 },
        uPixelRatio: { value: 1 },
        uMaxPx: { value: 40 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.grow(4096);
  }

  grow(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(4096, 1 << Math.ceil(Math.log2(n)));
    this.pos = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.color = new Float32Array(cap * 3);
    this.params = new Float32Array(cap * 2);
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aSize = new THREE.BufferAttribute(this.size, 1);
    this.aColor = new THREE.BufferAttribute(this.color, 3);
    this.aParams = new THREE.BufferAttribute(this.params, 2);
    for (const a of [this.aPos, this.aSize, this.aColor, this.aParams]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("iPos", this.aPos);
    this.geo.setAttribute("iSize", this.aSize);
    this.geo.setAttribute("iColor", this.aColor);
    this.geo.setAttribute("iParams", this.aParams);
    this.capacity = cap;
  }

  setCount(n: number): void {
    this.geo.setDrawRange(0, Math.min(n, this.capacity));
  }

  commit(): void {
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aParams.needsUpdate = true;
  }

  setScale(pxPerWorld: number, pixelRatio: number): void {
    this.mat.uniforms.uPxPerWorld!.value = pxPerWorld;
    this.mat.uniforms.uPixelRatio!.value = pixelRatio;
    this.mat.uniforms.uMaxPx!.value = 34 * pixelRatio;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
