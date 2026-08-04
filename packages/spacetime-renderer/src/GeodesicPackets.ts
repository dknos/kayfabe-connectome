/**
 * Evidence packets: a bounded instanced stream riding ONE relationship's
 * worldline — the hovered or selected one, never the whole corpus. Packet
 * count derives from that pair's documented encounters (sqrt-scaled, tier
 * capped); the stream lives on the bloom layer, which is what makes emphasis
 * read without any global glow.
 *
 * Path samples arrive in (day, y, z) space and are mapped through the SAME
 * TS lens as the beads each frame, so packets stay glued to their ribbon
 * while the bubble travels.
 */
import {
  AdditiveBlending, DoubleSide, DynamicDrawUsage, InstancedMesh, Matrix4,
  PlaneGeometry, Quaternion, ShaderMaterial, Vector3, type Camera,
} from "three";
import { SAMPLE_STRIDE, type WorldlinePath } from "./SpacetimeLayout";
import { DAYS_PER_YEAR, focusF, timeAxisX, type TimeAxis } from "./types";
import { BLOOM_LAYER } from "./SpacetimeBloom";

export class GeodesicPackets {
  readonly mesh: InstancedMesh;
  private readonly material: ShaderMaterial;
  private path: WorldlinePath | null = null;
  private live = 0;
  private phase = 0;
  private readonly m4 = new Matrix4();
  private readonly quat = new Quaternion();
  private readonly pos = new Vector3();
  private readonly scale = new Vector3(0.16, 0.16, 0.16);

  constructor(readonly capacity: number) {
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: { uColor: { value: [0.55, 0.85, 1.0] } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor; varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          if (r > 1.0) discard;
          float a = smoothstep(1.0, 0.0, r);
          gl_FragColor = vec4(uColor, a * a * 0.85);
        }`,
    });
    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(BLOOM_LAYER);
    this.mesh.count = 0;
  }

  /** Point the stream at one relationship's path, sized by its evidence. */
  focus(path: WorldlinePath | null, encounters: number, budget: number, color: [number, number, number]): void {
    this.path = path;
    this.live = path === null ? 0
      : Math.max(4, Math.min(budget, Math.round(Math.sqrt(encounters) * 4)));
    (this.material.uniforms.uColor!.value as number[]).splice(0, 3, ...color);
    if (this.live === 0) this.mesh.count = 0;
  }

  get count(): number {
    return this.mesh.count;
  }

  update(dt: number, axis: TimeAxis, camera: Camera): void {
    if (!this.path || this.live === 0) {
      this.mesh.count = 0;
      return;
    }
    const s = this.path.samples;
    const n = s.length / SAMPLE_STRIDE;
    if (n < 2) {
      this.mesh.count = 0;
      return;
    }
    this.phase = (this.phase + dt * 0.11) % 1;
    this.quat.copy((camera as unknown as { quaternion: Quaternion }).quaternion);
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.live; i++) {
      const t = ((i / this.live) + this.phase) % 1;
      const f = t * (n - 1);
      const k = Math.min(n - 2, Math.floor(f));
      const w = f - k;
      const o = k * SAMPLE_STRIDE, oN = (k + 1) * SAMPLE_STRIDE;
      const day = s[o]! * (1 - w) + s[oN]! * w;
      const yC = s[o + 1]! * (1 - w) + s[oN + 1]! * w;
      const zC = s[o + 2]! * (1 - w) + s[oN + 2]! * w;
      const fade = s[o + 3]! * (1 - w) + s[oN + 3]! * w;
      const yR = s[o + 6]! * (1 - w) + s[oN + 6]! * w;
      const zR = s[o + 7]! * (1 - w) + s[oN + 7]! * w;
      // Same focus blend as the ribbon shader — packets must ride the drawn
      // fibre, not the fully-converged geometry that only exists in the bubble.
      const conv = focusF((day - axis.playheadDay) / DAYS_PER_YEAR, axis.bubbleR, axis.bubbleSigma);
      this.pos.set(timeAxisX(day, axis), yR + (yC - yR) * conv, zR + (zC - zR) * conv);
      // Packets vanish across dissolved gaps with their ribbon.
      this.scale.setScalar(0.16 * Math.max(0.001, fade));
      this.m4.compose(this.pos, this.quat, this.scale);
      this.m4.toArray(matrices, i * 16);
    }
    this.mesh.count = this.live;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
