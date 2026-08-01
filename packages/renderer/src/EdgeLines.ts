import * as THREE from "three";

const SEGMENTS = 4; // per fiber: sampled quadratic bezier

/**
 * The global fiber field: every visible relationship as a slightly-bowed
 * polyline in ONE non-indexed LineSegments batch. Curvature is deterministic
 * (seeded per edge, bowed toward community mass) so fibers between the same
 * regions bundle visually and never flip between reloads.
 */
export class EdgeLines {
  readonly lines: THREE.LineSegments;
  private geo: THREE.BufferGeometry;
  private capacityEdges = 0;
  private posArr = new Float32Array(0);
  private colArr = new Float32Array(0);
  private alphaArr = new Float32Array(0);
  /** midpoint per edge slot — pulse system samples these for travel curves */
  readonly midpoints = new Map<number, [number, number, number]>();

  constructor() {
    this.geo = new THREE.BufferGeometry();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uGlobalAlpha: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDepth;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        varying float vDepth;
        uniform float uGlobalAlpha;
        void main() {
          float depthFade = smoothstep(11.0, 2.0, vDepth); // distant fibers sink into haze
          gl_FragColor = vec4(vColor, vAlpha * uGlobalAlpha * mix(0.45, 1.0, depthFade));
        }`,
    });
    this.lines = new THREE.LineSegments(this.geo, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -1;
  }

  private ensureCapacity(edges: number): void {
    if (edges <= this.capacityEdges) return;
    const cap = Math.ceil(edges * 1.3);
    const verts = cap * SEGMENTS * 2;
    this.posArr = new Float32Array(verts * 3);
    this.colArr = new Float32Array(verts * 3);
    this.alphaArr = new Float32Array(verts);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.posArr, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(this.colArr, 3));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alphaArr, 1));
    this.capacityEdges = cap;
  }

  /**
   * Rebuild the batch. For each edge i: endpoints pa/pb, deterministic bow `mid`,
   * color, and alpha (already emphasis-scaled by the caller).
   */
  rebuild(
    edgeSlots: number[],
    endpoint: (edge: number) => [Float32Array, number, number], // (positions, ia, ib)
    bow: (edge: number, pa: THREE.Vector3, pb: THREE.Vector3) => THREE.Vector3,
    color: (edge: number) => [number, number, number],
    alpha: (edge: number) => number,
  ): void {
    this.ensureCapacity(edgeSlots.length);
    this.midpoints.clear();
    const pa = new THREE.Vector3();
    const pb = new THREE.Vector3();
    const pm = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    const prev = new THREE.Vector3();
    let v = 0;

    for (const e of edgeSlots) {
      const [pos, ia, ib] = endpoint(e);
      pa.fromArray(pos, ia * 3);
      pb.fromArray(pos, ib * 3);
      pm.copy(bow(e, pa, pb));
      this.midpoints.set(e, [pm.x, pm.y, pm.z]);
      const [r, g, b] = color(e);
      const a = alpha(e);
      prev.copy(pa);
      for (let s = 1; s <= SEGMENTS; s++) {
        const t = s / SEGMENTS;
        // quadratic bezier
        tmp.set(
          (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * pm.x + t * t * pb.x,
          (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * pm.y + t * t * pb.y,
          (1 - t) * (1 - t) * pa.z + 2 * (1 - t) * t * pm.z + t * t * pb.z,
        );
        this.posArr.set([prev.x, prev.y, prev.z, tmp.x, tmp.y, tmp.z], v * 3);
        this.colArr.set([r, g, b, r, g, b], v * 3);
        this.alphaArr[v] = a;
        this.alphaArr[v + 1] = a;
        v += 2;
        prev.copy(tmp);
      }
    }
    this.geo.setDrawRange(0, v);
    for (const key of ["position", "aColor", "aAlpha"] as const) {
      (this.geo.getAttribute(key) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Cheap per-frame emphasis without full rebuild: scale the global alpha. */
  setGlobalAlpha(a: number): void {
    (this.lines.material as THREE.ShaderMaterial).uniforms.uGlobalAlpha!.value = a;
  }

  dispose(): void {
    this.geo.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
