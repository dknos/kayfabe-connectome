import * as THREE from "three";

/**
 * Selected/path fibers as camera-facing ribbons (two triangles per segment,
 * widened in the vertex shader in screen space). Only ever holds the focused
 * few hundred fibers, so geometry churn is cheap.
 */
export class RibbonHighlight {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uAspect: { value: 1 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 aNext;
        attribute float aSide, aWidth, aT;
        attribute vec3 aColor;
        varying vec3 vColor;
        varying float vT, vSide;
        uniform float uAspect;
        void main() {
          vColor = aColor; vT = aT; vSide = aSide;
          vec4 cur = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 nxt = projectionMatrix * modelViewMatrix * vec4(aNext, 1.0);
          vec2 dir = normalize((nxt.xy / max(0.0001, nxt.w) - cur.xy / max(0.0001, cur.w)) * vec2(uAspect, 1.0));
          vec2 normal = vec2(-dir.y, dir.x) / vec2(uAspect, 1.0);
          cur.xy += normal * aSide * aWidth * cur.w;
          gl_Position = cur;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vT, vSide;
        uniform float uTime;
        void main() {
          float edgeFade = 1.0 - abs(vSide);                    // bright spine, soft edges
          float strand = 0.75 + 0.25 * sin(vT * 90.0 + vSide * 3.0); // internal fiber texture
          float travel = 0.85 + 0.15 * sin(uTime * 2.2 - vT * 24.0); // slow signal shimmer
          gl_FragColor = vec4(vColor * (0.6 + 1.1 * edgeFade) * strand * travel, edgeFade * 0.9);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** fibers: list of {points sampled along the curve, color, width} */
  rebuild(fibers: { curve: THREE.Vector3[]; color: THREE.Color; width: number }[]): void {
    const segTotal = fibers.reduce((n, f) => n + (f.curve.length - 1), 0);
    const vcount = segTotal * 6;
    const pos = new Float32Array(vcount * 3);
    const next = new Float32Array(vcount * 3);
    const side = new Float32Array(vcount);
    const width = new Float32Array(vcount);
    const tArr = new Float32Array(vcount);
    const col = new Float32Array(vcount * 3);
    let v = 0;
    for (const f of fibers) {
      const n = f.curve.length;
      for (let s = 0; s < n - 1; s++) {
        const a = f.curve[s]!;
        const b = f.curve[s + 1]!;
        const t0 = s / (n - 1);
        const t1 = (s + 1) / (n - 1);
        // two triangles: (a-,a+,b+) (a-,b+,b-)
        const quad: [THREE.Vector3, THREE.Vector3, number, number][] = [
          [a, b, -1, t0], [a, b, 1, t0], [b, a, 1, t1],
          [a, b, -1, t0], [b, a, 1, t1], [b, a, -1, t1],
        ];
        for (const [p, q, sd, tt] of quad) {
          pos.set([p.x, p.y, p.z], v * 3);
          next.set([q.x, q.y, q.z], v * 3);
          side[v] = sd * (q === a ? -1 : 1); // keep normal orientation consistent
          width[v] = f.width;
          tArr[v] = tt;
          col.set([f.color.r, f.color.g, f.color.b], v * 3);
          v++;
        }
      }
    }
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aNext", new THREE.BufferAttribute(next, 3));
    this.geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    this.geo.setAttribute("aWidth", new THREE.BufferAttribute(width, 1));
    this.geo.setAttribute("aT", new THREE.BufferAttribute(tArr, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    this.geo.setDrawRange(0, v);
  }

  clear(): void {
    this.geo.setDrawRange(0, 0);
  }

  tick(time: number, aspect: number): void {
    const u = (this.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uTime!.value = time;
    u.uAspect!.value = aspect;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
