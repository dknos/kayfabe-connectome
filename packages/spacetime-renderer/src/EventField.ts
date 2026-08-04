/**
 * Exact documented matches: one InstancedMesh of camera-facing beads.
 *
 * Positions are composed on the CPU — through the SAME timeAxisX / warp
 * twins the shaders use — because picking raycasts the instance matrices, and
 * a bead positioned in a shader is a bead the raycaster cannot see. ~1k
 * matrix writes per playhead move measure well under the arena's 640-card
 * budget.
 *
 * Gold discipline (docs/GEO-VISUAL-ENCODINGS.md): bright gold is reserved for
 * evidence-backed TITLE CHANGES. A title match that did not change hands
 * carries a muted brass ring instead — visibly championship, never a change
 * claim. Title-change beads also seed the caustic mesh on the bloom layer.
 */
import {
  AdditiveBlending, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedMesh, Matrix4, PlaneGeometry, Quaternion, ShaderMaterial, Vector3,
} from "three";
import type { Camera } from "three";
import { SR, type SpacetimeEvent, type TimeAxis } from "./types";
import { timeAxisX } from "./types";
import { warpPosition, type WarpLookup } from "./WarpLookup";
import { BLOOM_LAYER } from "./SpacetimeBloom";

const BEAD = 0.46;

export class EventField {
  readonly mesh: InstancedMesh;
  /** additive caustic sprites for title changes only — the closed bloom list */
  readonly caustics: InstancedMesh;
  private readonly geometry: PlaneGeometry;
  private readonly material: ShaderMaterial;
  private readonly causticMaterial: ShaderMaterial;
  readonly aTitle: InstancedBufferAttribute;
  readonly aResult: InstancedBufferAttribute;
  readonly aPersona: InstancedBufferAttribute;
  readonly aApx: InstancedBufferAttribute;
  readonly aDay: InstancedBufferAttribute;
  readonly aEmph: InstancedBufferAttribute;
  readonly aHalo: InstancedBufferAttribute;

  private events: SpacetimeEvent[] = [];
  private causticIndex: number[] = [];
  private readonly m4 = new Matrix4();
  private readonly quat = new Quaternion();
  private readonly pos = new Vector3();
  private readonly scale = new Vector3();
  private readonly warpOut = { x: 0, y: 0, z: 0, delta: 1, mag: 1, vis: 1 };

  constructor(private readonly lut: WarpLookup, readonly capacity: number) {
    this.geometry = new PlaneGeometry(1, 1);
    const mk = (n: number): InstancedBufferAttribute => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.aTitle = mk(1);
    this.aResult = mk(1);
    this.aPersona = mk(1);
    this.aApx = mk(1);
    this.aDay = mk(1);
    this.aEmph = mk(1);
    /** x = delta (halo temperature), y = vis — CPU warp writes these */
    this.aHalo = mk(2);
    this.geometry.setAttribute("aTitle", this.aTitle);
    this.geometry.setAttribute("aResult", this.aResult);
    this.geometry.setAttribute("aPersona", this.aPersona);
    this.geometry.setAttribute("aApx", this.aApx);
    this.geometry.setAttribute("aDay", this.aDay);
    this.geometry.setAttribute("aEmph", this.aEmph);
    this.geometry.setAttribute("aHalo", this.aHalo);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uPlayhead: { value: 0 },
        uWindowDays: { value: 548 },
        uWarpMix: { value: 0 },
        uGold: { value: [1.0, 0.82, 0.40] },
        uBrass: { value: [0.62, 0.50, 0.30] },
      },
      vertexShader: /* glsl */ `
        attribute float aTitle; attribute float aResult; attribute float aPersona;
        attribute float aApx; attribute float aDay; attribute float aEmph;
        attribute vec2 aHalo;
        varying vec2 vUv; varying float vTitle; varying float vResult;
        varying float vPersona; varying float vApx; varying float vNear;
        varying float vEmph; varying vec2 vHalo;
        uniform float uPlayhead; uniform float uWindowDays;
        void main() {
          vUv = uv; vTitle = aTitle; vResult = aResult; vPersona = aPersona;
          vApx = aApx; vEmph = aEmph; vHalo = aHalo;
          vNear = 1.0 - smoothstep(0.0, uWindowDays, abs(aDay - uPlayhead));
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uGold; uniform vec3 uBrass; uniform float uWarpMix;
        varying vec2 vUv; varying float vTitle; varying float vResult;
        varying float vPersona; varying float vApx; varying float vNear;
        varying float vEmph; varying vec2 vHalo;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          // Crisp point-source core, restrained falloff — the paper's whole
          // point about stars: no streaks, no soup.
          float core = smoothstep(0.34, 0.10, r);
          float haloBand = smoothstep(1.0, 0.42, r) - core;
          // The halo carries the frequency shift; the core stays document-white.
          vec3 haloCol = vHalo.x > 1.0
            ? mix(vec3(0.65, 0.78, 1.0), vec3(0.45, 0.62, 1.0), min(1.0, (vHalo.x - 1.0) * 0.4))
            : mix(vec3(1.0, 0.72, 0.55), vec3(1.0, 0.45, 0.30), min(1.0, (1.0 - vHalo.x) * 1.6));
          vec3 col = vec3(0.92, 0.96, 1.0) * core + haloCol * haloBand * 0.55;
          // Championship rings: brass for a title match, gold ONLY for a
          // documented change of hands.
          float ring = smoothstep(0.075, 0.02, abs(r - 0.72));
          if (vTitle > 1.5)      col += uGold * ring * 1.15;
          else if (vTitle > 0.5) col += uBrass * ring * 0.8;
          // An approximate date must not read as exact: the ring breaks up.
          if (vApx > 0.5) {
            float a = atan(d.y, d.x);
            col *= 1.0 - ring * step(0.5, fract(a * 1.909859)) * 0.55;
          }
          float alpha = (core + haloBand * 0.7) * vHalo.y
                      * (0.38 + vNear * 0.42 + vEmph * 0.35);
          // In flight the whole future stacks at the forward convergence
          // point; distant records dim to sparks so the tunnel stays legible
          // and the local window carries the reading.
          alpha *= mix(1.0, 0.08 + 0.92 * vNear, uWarpMix);
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(col, alpha);
        }`,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    this.causticMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: { uGold: { value: [1.0, 0.82, 0.40] } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uGold; varying vec2 vUv;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float rim = smoothstep(0.16, 0.0, abs(r - 0.55));
          gl_FragColor = vec4(uGold, rim * 0.8);
        }`,
    });
    this.caustics = new InstancedMesh(this.geometry, this.causticMaterial, 64);
    this.caustics.instanceMatrix.setUsage(DynamicDrawUsage);
    this.caustics.frustumCulled = false;
    this.caustics.layers.set(BLOOM_LAYER);
  }

  setEvents(events: SpacetimeEvent[]): void {
    this.events = events.slice(0, this.capacity);
    this.causticIndex = [];
    const title = this.aTitle.array as Float32Array;
    const result = this.aResult.array as Float32Array;
    const persona = this.aPersona.array as Float32Array;
    const apx = this.aApx.array as Float32Array;
    const day = this.aDay.array as Float32Array;
    const emph = this.aEmph.array as Float32Array;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      title[i] = e.titleChange ? 2 : e.titleMatch ? 1 : 0;
      result[i] = e.result;
      persona[i] = e.persona;
      apx[i] = e.apx ? 1 : 0;
      day[i] = e.day;
      emph[i] = 0;
      if (e.titleChange && this.causticIndex.length < 64) this.causticIndex.push(i);
    }
    this.mesh.count = this.events.length;
    this.caustics.count = this.causticIndex.length;
    for (const a of [this.aTitle, this.aResult, this.aPersona, this.aApx, this.aDay, this.aEmph]) {
      a.needsUpdate = true;
    }
  }

  setEmphasis(index: number, value: number): void {
    if (index < 0 || index >= this.events.length) return;
    (this.aEmph.array as Float32Array)[index] = value;
    this.aEmph.needsUpdate = true;
  }
  clearEmphasis(): void {
    (this.aEmph.array as Float32Array).fill(0);
    this.aEmph.needsUpdate = true;
  }

  /**
   * Re-place every bead for the current playhead / warp state, facing the
   * camera. Positions run through the SAME TS lens the picker reads, which is
   * the whole reason this is CPU work.
   */
  sync(
    axis: TimeAxis, camera: Camera,
    warp: { v: number; mix: number; ox: number; oy: number; oz: number; nearRadius: number },
  ): void {
    this.quat.copy((camera as unknown as { quaternion: Quaternion }).quaternion);
    const halo = this.aHalo.array as Float32Array;
    const matrices = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      const x = timeAxisX(e.day, axis);
      let px = x, py = 0, pz = 0, delta = 1, mag = 1, vis = 1;
      if (warp.mix > 0) {
        warpPosition(this.lut, x, 0, 0, warp.ox, warp.oy, warp.oz,
          warp.v, warp.mix, warp.nearRadius, this.warpOut);
        px = this.warpOut.x; py = this.warpOut.y; pz = this.warpOut.z;
        delta = this.warpOut.delta; mag = this.warpOut.mag; vis = this.warpOut.vis;
      }
      halo[i * 2] = delta;
      halo[i * 2 + 1] = vis;
      const s = BEAD * (e.titleMatch ? 1.35 : 1) * Math.sqrt(Math.max(0.2, Math.min(6, mag)));
      this.pos.set(px, py, pz);
      this.scale.setScalar(s);
      this.m4.compose(this.pos, this.quat, this.scale);
      this.m4.toArray(matrices, i * 16);
    }
    this.aHalo.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;

    const cm = this.caustics.instanceMatrix.array as Float32Array;
    for (let k = 0; k < this.causticIndex.length; k++) {
      const i = this.causticIndex[k]!;
      this.m4.fromArray(matrices, i * 16);
      this.m4.scale(this.scale.setScalar(2.6));
      this.m4.toArray(cm, k * 16);
    }
    this.caustics.instanceMatrix.needsUpdate = true;
  }

  setPlayhead(day: number): void {
    this.material.uniforms.uPlayhead!.value = day;
  }

  setWarpMix(mix: number): void {
    this.material.uniforms.uWarpMix!.value = mix;
  }

  eventAt(index: number): SpacetimeEvent | null {
    return this.events[index] ?? null;
  }
  get count(): number {
    return this.events.length;
  }

  /** Win/loss/draw copy for the inspector — data, not judgement. */
  static resultLabel(code: number): string {
    return code === SR.WIN ? "won" : code === SR.LOSS ? "lost" : code === SR.DRAW ? "draw" : "no result recorded";
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.causticMaterial.dispose();
    this.mesh.dispose();
    this.caustics.dispose();
  }
}
