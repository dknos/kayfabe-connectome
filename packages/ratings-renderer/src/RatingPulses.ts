import * as THREE from "three";
import { hexRgb, RATING_PALETTE } from "./palette";

const CAPACITY = 64;

export type RatingPulseKind = "ordinary" | "high" | "ppv" | "title-change";

export class RatingPulses {
  readonly points: THREE.Points;
  private positions = new Float32Array(CAPACITY * 3);
  private life = new Float32Array(CAPACITY);
  private tone = new Float32Array(CAPACITY * 3);
  private born = new Float64Array(CAPACITY);
  private cursor = 0;
  private geometry = new THREE.BufferGeometry();
  private material: THREE.ShaderMaterial;

  constructor() {
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aLife", new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aTone", new THREE.BufferAttribute(this.tone, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aLife;
        attribute vec3 aTone;
        uniform float uPixelRatio;
        varying float vLife;
        varying vec3 vTone;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (10.0 + aLife * 18.0) * uPixelRatio;
          vLife = aLife;
          vTone = aTone;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying float vLife;
        varying vec3 vTone;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float ring = smoothstep(0.50, 0.40, d) * smoothstep(0.25, 0.34, d);
          float core = smoothstep(0.18, 0.0, d) * 0.24;
          float alpha = (ring + core) * (1.0 - vLife);
          if (alpha < 0.006) discard;
          gl_FragColor = vec4(vTone, alpha);
        }
      `,
      uniforms: { uPixelRatio: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
  }

  emit(position: readonly [number, number, number], kind: RatingPulseKind, now = performance.now()): void {
    const i = this.cursor++ % CAPACITY;
    this.positions.set(position, i * 3);
    const color = hexRgb(
      kind === "title-change" || kind === "high"
        ? RATING_PALETTE.datum
        : kind === "ppv"
          ? RATING_PALETTE.ratedHot
          : RATING_PALETTE.paper,
    );
    this.tone.set(color, i * 3);
    this.life[i] = 0;
    this.born[i] = now;
    this.commit();
  }

  tick(now: number): void {
    let dirty = false;
    for (let i = 0; i < CAPACITY; i++) {
      if (this.born[i]! <= 0) continue;
      const p = Math.min(1, (now - this.born[i]!) / 850);
      if (p !== this.life[i]) {
        this.life[i] = p;
        dirty = true;
      }
      if (p >= 1) this.born[i] = 0;
    }
    if (dirty) (this.geometry.getAttribute("aLife") as THREE.BufferAttribute).needsUpdate = true;
  }

  setPixelRatio(v: number): void {
    this.material.uniforms.uPixelRatio!.value = v;
  }

  clear(): void {
    this.life.fill(1);
    this.born.fill(0);
    (this.geometry.getAttribute("aLife") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private commit(): void {
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aTone") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("aLife") as THREE.BufferAttribute).needsUpdate = true;
  }
}
