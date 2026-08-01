import * as THREE from "three";
import type { AtlasPath } from "./types";

/**
 * Polylines: career route spines, lineage connectors, relationship tracts.
 *
 * Built as expanded ribbons rather than `LineSegments`, because `lineWidth`
 * is silently 1 on every browser that matters and a career route drawn one
 * pixel wide disappears under the rails it connects.
 *
 * Width is applied in the VERTEX SHADER from a world-per-pixel uniform, so a
 * route stays the same thickness at every zoom without rebuilding geometry —
 * which matters because zoom changes continuously and the geometry does not.
 */

const VERT = /* glsl */ `
attribute vec2 aNormal;
attribute float aSide;
attribute float aWidth;
attribute vec3 aColor;
attribute float aAlpha;

uniform float uWorldPerPixel;

varying vec3 vColor;
varying float vAlpha;
varying float vSide;

void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vSide = aSide;
  vec3 p = position + vec3(aNormal * aSide * aWidth * uWorldPerPixel * 0.5, 0.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
varying float vSide;
void main() {
  // Soft edges: a hard-edged 2px ribbon crawls with aliasing when it is not
  // axis-aligned, and almost none of these are.
  float edge = 1.0 - smoothstep(0.45, 1.0, abs(vSide));
  float a = vAlpha * edge;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

export class AtlasPaths {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  /** Draw-order index -> path key, for picking. */
  private keys: string[] = [];

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uWorldPerPixel: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  rebuild(paths: AtlasPath[]): void {
    let segs = 0;
    for (const p of paths) segs += Math.max(0, p.points.length / 3 - 1);
    const verts = segs * 4;
    const idx = segs * 6;
    const pos = new Float32Array(verts * 3);
    const nrm = new Float32Array(verts * 2);
    const side = new Float32Array(verts);
    const width = new Float32Array(verts);
    const color = new Float32Array(verts * 3);
    const alpha = new Float32Array(verts);
    const index = new Uint32Array(idx);

    this.keys = [];
    let v = 0;
    let ii = 0;
    for (const p of paths) {
      const n = p.points.length / 3;
      for (let s = 0; s < n - 1; s++) {
        const ax = p.points[s * 3]!;
        const ay = p.points[s * 3 + 1]!;
        const az = p.points[s * 3 + 2]!;
        const bx = p.points[(s + 1) * 3]!;
        const by = p.points[(s + 1) * 3 + 1]!;
        const bz = p.points[(s + 1) * 3 + 2]!;
        let dx = bx - ax;
        let dy = by - ay;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        // perpendicular in the board plane
        const nx = -dy;
        const ny = dx;
        const quad = [
          [ax, ay, az, -1],
          [ax, ay, az, 1],
          [bx, by, bz, 1],
          [bx, by, bz, -1],
        ] as const;
        const base = v;
        for (const [x, y, z, sd] of quad) {
          pos[v * 3] = x;
          pos[v * 3 + 1] = y;
          pos[v * 3 + 2] = z;
          nrm[v * 2] = nx;
          nrm[v * 2 + 1] = ny;
          side[v] = sd;
          width[v] = p.width;
          color[v * 3] = p.color[0];
          color[v * 3 + 1] = p.color[1];
          color[v * 3 + 2] = p.color[2];
          alpha[v] = p.alpha;
          v++;
        }
        index[ii++] = base;
        index[ii++] = base + 1;
        index[ii++] = base + 2;
        index[ii++] = base;
        index[ii++] = base + 2;
        index[ii++] = base + 3;
        this.keys.push(p.key);
      }
    }

    this.geo.dispose();
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute("aNormal", new THREE.BufferAttribute(nrm, 2));
    this.geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    this.geo.setAttribute("aWidth", new THREE.BufferAttribute(width, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    this.geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.mesh.geometry = this.geo;
  }

  setWorldPerPixel(v: number): void {
    this.mat.uniforms.uWorldPerPixel!.value = v;
  }

  get segmentKeys(): string[] {
    return this.keys;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
