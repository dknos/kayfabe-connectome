import * as THREE from "three";

/**
 * Signal pulses — playback particles that ride a cubic bezier between two
 * board points (usually sampled off a live trace). Fixed pool, oldest-wins;
 * the vertex shader walks the curve from spawn time so the CPU writes each
 * pulse exactly once. The one additive sparkle in the lens.
 */

const CAP = 256;
const LIFE = 1.4;

export class MorphPulses {
  readonly points: THREE.Points;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private p0 = new Float32Array(CAP * 3);
  private p1 = new Float32Array(CAP * 3);
  private p2 = new Float32Array(CAP * 3);
  private p3 = new Float32Array(CAP * 3);
  private color = new Float32Array(CAP * 3);
  private spawn = new Float32Array(CAP).fill(-1e9);
  private life = new Float32Array(CAP).fill(LIFE);
  private cursor = 0;
  private dirty = false;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    const dyn = (arr: Float32Array, n: number) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute("position", dyn(this.p0, 3));
    this.geo.setAttribute("aP1", dyn(this.p1, 3));
    this.geo.setAttribute("aP2", dyn(this.p2, 3));
    this.geo.setAttribute("aP3", dyn(this.p3, 3));
    this.geo.setAttribute("aColor", dyn(this.color, 3));
    this.geo.setAttribute("aSpawn", dyn(this.spawn, 1));
    this.geo.setAttribute("aLife", dyn(this.life, 1));

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPxPerWorld: { value: 1 },
        uPixelRatio: { value: 1 },
        uWorldSize: { value: 3 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aP1, aP2, aP3, aColor;
        attribute float aSpawn, aLife;
        uniform float uTime, uPxPerWorld, uPixelRatio, uWorldSize;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          float age = (uTime - aSpawn) / aLife;
          if (age < 0.0 || age > 1.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vFade = 0.0;
            vColor = vec3(0.0);
            return;
          }
          float k = 1.0 - pow(1.0 - age, 2.2); // arrives, not passes through
          vec3 a = mix(position, aP1, k);
          vec3 b = mix(aP1, aP2, k);
          vec3 c = mix(aP2, aP3, k);
          vec3 ab = mix(a, b, k);
          vec3 bc = mix(b, c, k);
          vec3 p = mix(ab, bc, k);
          vColor = aColor;
          vFade = sin(age * 3.14159);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(uWorldSize * uPxPerWorld * uPixelRatio, 2.0, 26.0 * uPixelRatio);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vFade;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float cov = 1.0 - smoothstep(0.12, 0.5, d);
          if (cov * vFade < 0.01) discard;
          gl_FragColor = vec4(vColor + vec3(0.6) * (1.0 - d * 2.0), cov * vFade);
        }
      `,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.geo.setDrawRange(0, CAP);
  }

  /** ctrl is 4 xyz control points (flat, length 12). */
  spawnCurve(ctrl: Float32Array, color: [number, number, number], now: number, life = LIFE): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % CAP;
    const i3 = i * 3;
    for (let k = 0; k < 3; k++) {
      this.p0[i3 + k] = ctrl[k]!;
      this.p1[i3 + k] = ctrl[3 + k]!;
      this.p2[i3 + k] = ctrl[6 + k]!;
      this.p3[i3 + k] = ctrl[9 + k]!;
      this.color[i3 + k] = color[k]!;
    }
    this.spawn[i] = now;
    this.life[i] = life;
    this.dirty = true;
  }

  clearAll(): void {
    this.spawn.fill(-1e9);
    this.dirty = true;
  }

  tick(now: number, pxPerWorld: number, pixelRatio: number): void {
    this.mat.uniforms.uTime!.value = now;
    this.mat.uniforms.uPxPerWorld!.value = pxPerWorld;
    this.mat.uniforms.uPixelRatio!.value = pixelRatio;
    if (this.dirty) {
      this.dirty = false;
      for (const n of ["position", "aP1", "aP2", "aP3", "aColor", "aSpawn", "aLife"]) {
        (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  }

  setWorldSize(v: number): void {
    this.mat.uniforms.uWorldSize!.value = v;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
