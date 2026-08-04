/**
 * Evidence pulses.
 *
 * A bright packet travels along an existing route while the timeline plays.
 * The route itself never moves and never changes colour, which matters: an
 * animation that reshaped the route would imply a direction the evidence does
 * not support. A pulse says only "something documented happened along here",
 * which is exactly as much as the corpus knows.
 *
 * One InstancedMesh for every pulse, on the bloom layer, so the whole effect is
 * one draw call and is the only thing in the scene allowed to glow. SPIKE 3
 * measured 16 pulses moving the render-submission time by noise, against fat
 * routes which cost a draw call each.
 */
import {
  AdditiveBlending, DynamicDrawUsage, InstancedMesh,
  PlaneGeometry, ShaderMaterial, type Scene,
} from "three";
import type { ArenaRoutes } from "./ArenaRoutes";
import { BLOOM_LAYER } from "./ArenaBloom";

const SIZE = 0.22;

/**
 * The stretch of a fibre a packet is actually visible on.
 *
 * Every fibre starts at the subject, so the first fifth of all of them occupies
 * the same small volume. Packets drawn there stack additively into a glare that
 * washed out the subject's own card and the names around it — the one part of
 * the arena a reader is most likely to be looking at. A packet now emerges once
 * it is clear of the convergence and fades as it arrives.
 */
const RUN_IN = 0.3;
const RUN_OUT = 0.94;

export class ArenaPulses {
  readonly mesh: InstancedMesh;
  private readonly matrices: Float32Array;
  private readonly phase: Float32Array;
  /** Which route each packet rides, and how fast. Both come from the evidence
   *  rather than from the packet's index. */
  private readonly route: Int32Array;
  private readonly speed: Float32Array;
  private live = 0;
  private focused = -1;

  constructor(scene: Scene, readonly capacity: number) {
    const geometry = new PlaneGeometry(SIZE, SIZE);
    // A camera-facing spark with a soft radial falloff and a short trailing
    // tail, not an axis-aligned quad. A flat square sliding along a curve reads
    // as a sliding square; a billboarded point with a falloff reads as
    // something travelling.
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: [0.95, 0.79, 0.5] } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 d = vUv - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          // Hot core, soft halo: the falloff is squared so the packet has a
          // definite centre instead of reading as a smudge.
          float core = pow(1.0 - r, 2.6);
          float halo = pow(1.0 - r, 0.9) * 0.28;
          gl_FragColor = vec4(uColor * (core + halo), core + halo);
        }`,
    });
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.layers.set(BLOOM_LAYER);
    scene.add(this.mesh);
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
    this.phase = new Float32Array(capacity);
    this.route = new Int32Array(capacity);
    this.speed = new Float32Array(capacity);
  }

  get count(): number {
    return this.live;
  }

  /**
   * Point every packet at the one fibre the reader is looking at.
   *
   * Nothing pulses on its own. The reading is per-relationship — "how much did
   * these two actually meet" — and a field of packets on every fibre at once
   * answered that question for nobody while stacking additively into a glare
   * over the subject's own card. Hovering or selecting a rectangle draws its
   * wire and runs its evidence along it: more documented encounters means more
   * packets, moving faster.
   */
  focus(index: number, encounters: number, budget: number): void {
    if (index < 0 || encounters <= 0) {
      this.live = 0;
      this.mesh.count = 0;
      this.focused = -1;
      return;
    }
    // Square-rooted, because encounters run from 1 to several hundred and a
    // linear count would make a heavy pair a solid bar of light while a single
    // documented meeting showed nothing at all.
    const n = Math.max(2, Math.min(budget, this.capacity, Math.round(Math.sqrt(encounters) * 2.2)));
    this.live = n;
    this.mesh.count = n;
    this.focused = index;
    const speed = 0.3 + Math.min(1, Math.sqrt(encounters) / 12) * 0.55;
    for (let i = 0; i < n; i++) {
      this.route[i] = index;
      this.speed[i] = speed;
      // Evenly spaced along the run, so the packets read as a stream on one
      // path rather than as a clump that happens to be moving.
      this.phase[i] = i / n;
    }
  }

  /** The fibre the packets are riding, or -1. */
  get focusedRoute(): number {
    return this.focused;
  }

  /**
   * Advance and park each packet on its route. Packets ride the routes that
   * exist; if the route budget shrinks with the quality tier, the pulses follow
   * it rather than pointing at nothing.
   */
  update(dt: number, routes: ArenaRoutes, speed = 1): void {
    if (this.live === 0) return;
    const routeCount = routes.count;
    if (routeCount === 0) {
      this.mesh.count = 0;
      return;
    }
    // The route set is rebuilt on every formation change; a packet still
    // pointing at a route that no longer exists would ride nothing.
    if (this.focused >= routeCount) {
      this.live = 0;
      this.mesh.count = 0;
      return;
    }
    this.mesh.count = this.live;
    for (let i = 0; i < this.live; i++) {
      this.phase[i] = (this.phase[i]! + dt * speed * (this.speed[i] || 0.3)) % 1;
      const t = this.phase[i]!;
      const m = i * 16;
      // Fade in and out at the ends of the run so a packet arrives and departs
      // rather than popping into existence at the subject and vanishing at the
      // far card.
      const fade = Math.max(
        0,
        Math.min(1, (t - RUN_IN) * 7, (RUN_OUT - t) * 7),
      );
      for (let k = 0; k < 16; k++) this.matrices[m + k] = k % 5 === 0 ? fade : 0;
      this.matrices[m + 15] = 1;
      const r = this.route[i]!;
      const point = routes.samplePoint(r < routeCount ? r : i % routeCount, t);
      if (!point) {
        this.matrices[m] = 0;
        this.matrices[m + 5] = 0;
        this.matrices[m + 10] = 0;
        continue;
      }
      this.matrices[m + 12] = point.x;
      this.matrices[m + 13] = point.y;
      this.matrices[m + 14] = point.z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as ShaderMaterial).dispose();
    this.mesh.dispose();
  }
}
