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
  AdditiveBlending, Layers, Mesh, MeshBasicMaterial, RingGeometry,
  Scene, ShaderMaterial, Vector2,
  type Camera, type Object3D, type WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

/** Only objects on this layer are ever allowed to bloom. */
export const BLOOM_LAYER = 1;

export class ArenaBloom {
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  private readonly bloomLayers = new Layers();
  private readonly hidden: Object3D[] = [];
  /** The selection halo: a thin ring behind the selected card. It is a real
   *  object with a real transform, so it survives bloom being switched off. */
  readonly halo: Mesh;
  enabled = true;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    this.bloomLayers.set(BLOOM_LAYER);

    this.halo = new Mesh(
      new RingGeometry(0.62, 0.72, 48),
      new MeshBasicMaterial({ color: 0xffd479, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false }),
    );
    this.halo.visible = false;
    this.halo.frustumCulled = false;
    this.halo.layers.set(BLOOM_LAYER);
    scene.add(this.halo);

    this.bloomComposer = new EffectComposer(renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(scene, camera));
    this.bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.55, 0.6, 0.15);
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

  setSize(width: number, height: number): void {
    this.bloomComposer.setSize(width, height);
    this.finalComposer.setSize(width, height);
    this.bloomPass.setSize(width, height);
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
    // Hide everything that is not on the bloom layer, render the glow, restore.
    this.hidden.length = 0;
    this.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh && !(object as { isLine2?: boolean }).isLine2) return;
      if (object.layers.test(this.bloomLayers)) return;
      if (!object.visible) return;
      object.visible = false;
      this.hidden.push(object);
    });
    this.bloomComposer.render();
    for (const object of this.hidden) object.visible = true;
    this.hidden.length = 0;
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
