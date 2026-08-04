/**
 * Selective emphasis.
 *
 * Adapted from webgl_postprocessing_unreal_bloom_selective: a layer bit
 * selects what glows, a bloom composer renders only that, and a final composer
 * adds the result over the ordinary frame.
 *
 * One deliberate departure from the example. It masks non-bloom objects by
 * swapping in a darkened material; here the entire card population is ONE
 * InstancedMesh, so a material swap would blanket every card at once rather
 * than exempting them individually. Non-bloom objects are hidden for the bloom
 * pass instead, which is exact and costs a visibility flag.
 *
 * What may bloom is a closed list — the selection halo and nothing else by
 * default. The brief is explicit that cards, labels, section text, background
 * and inactive context must not, and a closed list is the only way that stays
 * true as the lens grows. Measured in SPIKE 4: +0.29 ms submission and 4 render
 * targets.
 *
 * The scene must read as finished with this switched off. Bloom is emphasis on
 * top of a composition, never a substitute for one.
 */
import {
  AdditiveBlending, Mesh, MeshBasicMaterial, RingGeometry,
  Scene, ShaderMaterial, Vector2,
  type Camera, type WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/** Only objects on this layer are ever allowed to bloom. */
export const BLOOM_LAYER = 1;
/** Resolution scale for the glow pass. See setSize. */
const BLOOM_SCALE = 0.5;

export class ArenaBloom {
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  /** The selection halo: a thin ring behind the selected card. It is a real
   *  object with a real transform, so it survives bloom being switched off. */
  readonly halo: Mesh;
  enabled = true;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    // A thin, dim ring. The brief forbids selection turning into a giant glow,
    // and an additive ring at 0.9 opacity behind a bloom pass does exactly
    // that — the first screenshot that actually captured the halo showed it
    // blowing out into an amber wash across the whole arena.
    this.halo = new Mesh(
      new RingGeometry(0.66, 0.70, 64),
      new MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false }),
    );
    this.halo.visible = false;
    this.halo.frustumCulled = false;
    this.halo.layers.set(BLOOM_LAYER);
    scene.add(this.halo);

    this.bloomComposer = new EffectComposer(renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(scene, camera));
    // strength, radius, threshold. A 0.15 threshold blooms anything faintly
    // bright and a 0.6 radius smears it across the frame; emphasis wants a
    // tight halo that says "this one", not a light source.
    this.bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.32, 0.22, 0.55);
    this.bloomComposer.addPass(this.bloomPass);

    this.finalComposer = new EffectComposer(renderer);
    this.finalComposer.addPass(new RenderPass(scene, camera));
    const combine = new ShaderPass(new ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;
        void main(){ gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv); }`,
    }), "baseTexture");
    combine.needsSwap = true;
    this.finalComposer.addPass(combine);
    this.finalComposer.addPass(new OutputPass());
  }

  /**
   * The glow renders at HALF resolution.
   *
   * Measured at 1920x1080: full-resolution bloom cost ~135 ms per frame against
   * ~18 ms with it off — a formation change ran at 12 frames instead of 72,
   * which is a slideshow, not emphasis. A blur has no high-frequency detail to
   * lose, so half resolution is free visually and quarters the fill cost of the
   * mip chain. The final composite stays at full resolution, so cards and text
   * are never resampled.
   */
  setSize(width: number, height: number): void {
    this.finalComposer.setSize(width, height);
    const w = Math.max(1, Math.floor(width * BLOOM_SCALE));
    const h = Math.max(1, Math.floor(height * BLOOM_SCALE));
    this.bloomComposer.setSize(w, h);
    this.bloomPass.setSize(w, h);
  }

  /** Park the halo on a card, or hide it. */
  showHaloAt(x: number, y: number, z: number, scale: number): void {
    this.halo.position.set(x, y, z);
    this.halo.scale.setScalar(scale);
    this.halo.visible = true;
  }
  hideHalo(): void {
    this.halo.visible = false;
  }

  render(): void {
    if (!this.enabled) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // Restrict the CAMERA to the bloom layer rather than hiding every other
    // object. Three then builds a render list containing only the glow, so the
    // pass costs one small ring instead of a traverse over the whole scene plus
    // a visibility flip on every card and route.
    const mask = this.camera.layers.mask;
    this.camera.layers.set(BLOOM_LAYER);
    this.bloomComposer.render();
    this.camera.layers.mask = mask;
    this.finalComposer.render();
  }

  dispose(): void {
    this.halo.removeFromParent();
    this.halo.geometry.dispose();
    (this.halo.material as MeshBasicMaterial).dispose();
    this.bloomComposer.dispose();
    this.finalComposer.dispose();
    this.bloomPass.dispose();
  }
}
