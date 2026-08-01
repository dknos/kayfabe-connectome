import * as THREE from "three";

const POOL = 512;

/**
 * Bounded GPU pulse pool: record-driven signals traveling along fiber curves.
 * Ring buffer; when saturated, the oldest low-priority pulse is overwritten —
 * the caller pushes the currently-selected event LAST so it always survives.
 */
export class PulseSystem {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private p0: Float32Array;
  private pm: Float32Array;
  private p1: Float32Array;
  private start: Float32Array;
  private dur: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private head = 0;
  active = 0;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.p0 = new Float32Array(POOL * 3);
    this.pm = new Float32Array(POOL * 3);
    this.p1 = new Float32Array(POOL * 3);
    this.start = new Float32Array(POOL).fill(-1e9);
    this.dur = new Float32Array(POOL).fill(1);
    this.col = new Float32Array(POOL * 3);
    this.size = new Float32Array(POOL);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.p0, 3)); // real pos computed in shader
    this.geo.setAttribute("aMid", new THREE.BufferAttribute(this.pm, 3));
    this.geo.setAttribute("aEnd", new THREE.BufferAttribute(this.p1, 3));
    this.geo.setAttribute("aStart", new THREE.BufferAttribute(this.start, 1));
    this.geo.setAttribute("aDur", new THREE.BufferAttribute(this.dur, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aMid, aEnd, aColor;
        attribute float aStart, aDur, aSize;
        varying vec3 vColor;
        varying float vLife;
        uniform float uTime, uPixelRatio;
        void main() {
          float t = clamp((uTime - aStart) / aDur, 0.0, 1.0);
          vLife = (uTime >= aStart && uTime <= aStart + aDur) ? 1.0 : 0.0;
          vColor = aColor;
          float it = 1.0 - t;
          vec3 p = it*it*position + 2.0*it*t*aMid + t*t*aEnd;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float fade = sin(t * 3.14159); // swell mid-flight
          gl_PointSize = clamp(vLife * aSize * fade * 90.0 / max(0.35, -mv.z), 0.0, 30.0) * uPixelRatio;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vLife;
        void main() {
          if (vLife < 0.5) discard;
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r = length(uv);
          if (r > 1.0) discard;
          float g = exp(-3.0 * r);
          vec3 col = min(vColor * (0.5 + 1.4 * smoothstep(0.5, 0.0, r)), vec3(1.25));
          gl_FragColor = vec4(col, g * 0.8);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  spawn(
    from: [number, number, number],
    mid: [number, number, number],
    to: [number, number, number],
    color: THREE.Color,
    now: number,
    duration = 1.1,
    size = 3,
  ): void {
    const i = this.head;
    this.head = (this.head + 1) % POOL;
    this.p0.set(from, i * 3);
    this.pm.set(mid, i * 3);
    this.p1.set(to, i * 3);
    this.start[i] = now;
    this.dur[i] = duration;
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    for (const k of ["position", "aMid", "aEnd", "aStart", "aDur", "aColor", "aSize"] as const) {
      (this.geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;
    }
    this.active = Math.min(POOL, this.active + 1);
  }

  tick(time: number, pixelRatio: number): void {
    const u = (this.points.material as THREE.ShaderMaterial).uniforms;
    u.uTime!.value = time;
    u.uPixelRatio!.value = pixelRatio;
  }

  clearAll(now: number): void {
    this.start.fill(now - 1e9);
    (this.geo.getAttribute("aStart") as THREE.BufferAttribute).needsUpdate = true;
    this.active = 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
