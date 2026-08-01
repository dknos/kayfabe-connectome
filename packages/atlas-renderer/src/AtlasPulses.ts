import * as THREE from "three";
import type { RGB } from "./types";

/**
 * Match records travelling through the structure during playback.
 *
 * A pulse is a point that walks from one world anchor to another over a fixed
 * life. The GPU owns the walk — spawn time and endpoints go in once and the
 * vertex shader interpolates — so playing a busy year is not a per-frame
 * JavaScript loop over hundreds of live pulses.
 *
 * The pool is fixed and oldest-wins. Playback at four years a second can
 * request pulses faster than any of them can finish, and an unbounded pool is
 * how a legible board becomes a wall of light.
 */

const CAP = 512;
const LIFE = 1.5;

const VERT = /* glsl */ `
attribute vec3 aFrom;
attribute vec3 aTo;
attribute vec3 aColor;
attribute vec2 aParams;   // x spawn time, y life

uniform float uTime;
uniform float uPxPerWorld;
uniform float uPixelRatio;
uniform float uSize;

varying vec3 vColor;
varying float vFade;

void main() {
  float age = (uTime - aParams.x) / max(0.0001, aParams.y);
  if (age < 0.0 || age > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-clip: costs one vertex
    gl_PointSize = 0.0;
    vFade = 0.0;
    return;
  }
  // Ease-out travel: a record arrives rather than passing through.
  float k = 1.0 - pow(1.0 - age, 2.2);
  vec3 p = mix(aFrom, aTo, k);
  vColor = aColor;
  vFade = sin(age * 3.14159);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(uSize * uPxPerWorld * uPixelRatio, 3.0 * uPixelRatio, 26.0 * uPixelRatio);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = vFade * (1.0 - smoothstep(0.1, 1.0, d));
  if (a <= 0.01) discard;
  gl_FragColor = vec4(vColor + vColor * (1.0 - d) * 0.9, a);
}
`;

export class AtlasPulses {
  readonly points: THREE.Points;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private from = new Float32Array(CAP * 3);
  private to = new Float32Array(CAP * 3);
  private color = new Float32Array(CAP * 3);
  private params = new Float32Array(CAP * 2);
  private aFrom: THREE.BufferAttribute;
  private aTo: THREE.BufferAttribute;
  private aColor: THREE.BufferAttribute;
  private aParams: THREE.BufferAttribute;
  private cursor = 0;
  private dirty = false;
  private worldSize = 0.6;

  constructor() {
    this.aFrom = new THREE.BufferAttribute(this.from, 3).setUsage(THREE.DynamicDrawUsage);
    this.aTo = new THREE.BufferAttribute(this.to, 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.BufferAttribute(this.params, 2).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(CAP * 3), 3));
    this.geo.setAttribute("aFrom", this.aFrom);
    this.geo.setAttribute("aTo", this.aTo);
    this.geo.setAttribute("aColor", this.aColor);
    this.geo.setAttribute("aParams", this.aParams);
    this.params.fill(-1e9);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uPxPerWorld: { value: 1 },
        uPixelRatio: { value: 1 },
        uSize: { value: this.worldSize },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
  }

  spawn(from: [number, number, number], to: [number, number, number], color: RGB, now: number, life = LIFE): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % CAP;
    this.from.set(from, i * 3);
    this.to.set(to, i * 3);
    this.color.set(color, i * 3);
    this.params[i * 2] = now;
    this.params[i * 2 + 1] = life;
    this.dirty = true;
  }

  clearAll(): void {
    this.params.fill(-1e9);
    this.dirty = true;
  }

  tick(now: number, pxPerWorld: number, pixelRatio: number): void {
    this.mat.uniforms.uTime!.value = now;
    this.mat.uniforms.uPxPerWorld!.value = pxPerWorld;
    this.mat.uniforms.uPixelRatio!.value = pixelRatio;
    if (this.dirty) {
      this.aFrom.needsUpdate = true;
      this.aTo.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aParams.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Pulse size follows the scene's own scale so a career route and the whole
   *  571-lane overview do not need different tuning. */
  setWorldSize(v: number): void {
    this.worldSize = v;
    this.mat.uniforms.uSize!.value = v;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
