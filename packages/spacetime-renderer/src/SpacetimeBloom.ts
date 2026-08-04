/**
 * Selective emphasis, the arena recipe unchanged in structure: a layer bit
 * selects what may glow, the bloom composer renders only that at half
 * resolution, a final composer adds it over the full-res frame.
 *
 * The closed list for this lens: title-change caustics, the active geodesic
 * packet stream, and the selection halo. Worldlines, beads, labels, sectors
 * and the bubble shell may NOT bloom — the scene must read as finished with
 * this off, which is exactly what the low tier ships.
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

export const BLOOM_LAYER = 1;
const BLOOM_SCALE = 0.5;

export class SpacetimeBloom {
  private readonly bloomComposer: EffectComposer;
  private readonly finalComposer: EffectComposer;
  private readonly bloomPass: UnrealBloomPass;
  readonly halo: Mesh;
  enabled = true;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: Camera,
  ) {
    this.halo = new Mesh(
      new RingGeometry(0.62, 0.68, 48),
      new MeshBasicMaterial({
        color: 0x8fd8ff, transparent: true, opacity: 0.45,
        blending: AdditiveBlending, depthWrite: false,
      }),
    );
    this.halo.visible = false;
    this.halo.frustumCulled = false;
    this.halo.layers.set(BLOOM_LAYER);
    scene.add(this.halo);

    this.bloomComposer = new EffectComposer(renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(scene, camera));
    this.bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.34, 0.24, 0.5);
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
    this.finalComposer.setSize(width, height);
    const w = Math.max(1, Math.floor(width * BLOOM_SCALE));
    const h = Math.max(1, Math.floor(height * BLOOM_SCALE));
    this.bloomComposer.setSize(w, h);
    this.bloomPass.setSize(w, h);
  }

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
