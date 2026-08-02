import * as THREE from "three";
import { RATING_PALETTE } from "./palette";
import type { RatingCoverageCell, RatingLaneVisual } from "./types";

function pushQuad(
  positions: number[],
  colors: number[],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
  color: THREE.Color,
  alpha: number,
): void {
  const vertices = [
    x0, y, z0, x1, y, z0, x1, y, z1,
    x0, y, z0, x1, y, z1, x0, y, z1,
  ];
  positions.push(...vertices);
  for (let i = 0; i < 6; i++) colors.push(color.r, color.g, color.b, alpha);
}

/** One batched rail mesh: gray denominator underneath, warm numerator above. */
export class RatingCoverageRails {
  readonly mesh: THREE.Mesh;
  private geometry = new THREE.BufferGeometry();
  private material = new THREE.ShaderMaterial({
    vertexShader: `
      attribute vec4 color;
      varying vec4 vColor;
      void main() { vColor = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      varying vec4 vColor;
      uniform float uOpacity;
      void main() { if (vColor.a * uOpacity < 0.006) discard; gl_FragColor = vec4(vColor.rgb, vColor.a * uOpacity); }
    `,
    uniforms: { uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  constructor() {
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  setCells(cells: RatingCoverageCell[], lanes: RatingLaneVisual[], xRange: readonly [number, number]): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const gray = new THREE.Color(RATING_PALETTE.rail);
    const dark = new THREE.Color(RATING_PALETTE.railDark);
    const warm = new THREE.Color(RATING_PALETTE.ratedWarm);
    // A continuous quiet bed makes a truly empty interval visible as a gap in
    // density, rather than silently removing the global/focused rail itself.
    for (const lane of lanes) {
      pushQuad(positions, colors, xRange[0], xRange[1], lane.z - 3.0, lane.z + 3.0, -1.3, dark, 0.32);
    }
    for (const c of cells) {
      if (c.totalCount <= 0 || c.opacity <= 0) continue;
      const density = Math.sqrt(c.totalCount / Math.max(1, c.maxTotalInLane));
      const x0 = c.x - c.width * 0.49;
      const x1 = c.x + c.width * 0.49;
      pushQuad(positions, colors, x0, x1, c.z - 2.55, c.z + 2.55, -1.0, gray, (0.16 + density * 0.5) * c.opacity);
      if (c.ratedCount > 0) {
        const share = Math.min(1, c.ratedCount / c.totalCount);
        pushQuad(positions, colors, x0, x1, c.z - 1.12, c.z + 1.12, -0.45, warm, (0.4 + share * 0.58) * c.opacity);
      }
    }
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.Float32BufferAttribute(positions.length ? positions : [0, 0, 0], 3));
    next.setAttribute("color", new THREE.Float32BufferAttribute(colors.length ? colors : [0, 0, 0, 0], 4));
    this.geometry.dispose();
    this.geometry = next;
    this.mesh.geometry = next;
  }

  setOpacity(v: number): void {
    this.material.uniforms.uOpacity!.value = v;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
