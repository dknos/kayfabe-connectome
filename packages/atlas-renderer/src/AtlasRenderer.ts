import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { AtlasCameraController } from "./AtlasCameraController";
import { AtlasLabels, type LabelDensity } from "./AtlasLabels";
import { AtlasNodes } from "./AtlasNodes";
import { AtlasPaths } from "./AtlasPaths";
import { pickAt } from "./AtlasPicking";
import { AtlasPulses } from "./AtlasPulses";
import { AtlasRails } from "./AtlasRails";
import { AtlasTransition } from "./AtlasTransition";
import { A, rgb } from "./palette";
import type { AtlasPickResult, AtlasScene, RGB } from "./types";

/**
 * The ATLAS surface.
 *
 * Owns the GL context, the orthographic camera, the morph and the label layer.
 * It owns NO semantics: every world coordinate arrives in an AtlasScene that a
 * pure layout function computed, which is what lets the four semantic states
 * share one renderer and what lets the layouts be tested without a GPU.
 *
 * Restraint is deliberate. The connectome is an additive HDR field that has to
 * fight a white plateau; the atlas is a board you read, so blending is normal,
 * bloom is a whisper reserved for gold, and nothing is allowed to accumulate.
 */

export interface AtlasQuality {
  pixelRatioCap: number;
  bloom: boolean;
  labelDensityMax: LabelDensity;
}

export type AtlasTier = "high" | "medium" | "low";

export const ATLAS_TIERS: Record<AtlasTier, AtlasQuality> = {
  high: { pixelRatioCap: 2, bloom: true, labelDensityMax: "dense" },
  medium: { pixelRatioCap: 1.5, bloom: true, labelDensityMax: "normal" },
  low: { pixelRatioCap: 1, bloom: false, labelDensityMax: "sparse" },
};

export interface AtlasEmphasis {
  selected: string | null;
  hovered: string | null;
  /** Ids that stay lit as context — a promotion's titles, a wrestler's route. */
  members: string[];
  /** Ids the reader pinned. */
  pinned: string[];
}

export class AtlasRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: AtlasCameraController;
  readonly labels: AtlasLabels;

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private rails = new AtlasRails();
  private nodes = new AtlasNodes();
  private paths = new AtlasPaths();
  private pulses = new AtlasPulses();
  private transition = new AtlasTransition();

  private current: AtlasScene | null = null;
  private emphasis: AtlasEmphasis = { selected: null, hovered: null, members: [], pinned: [] };
  /** key -> remaining flash energy. Title changes flash the rail they happened
   *  on; the decay lives here so playback never allocates. */
  private flashes = new Map<string, number>();

  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private active = true;
  private contextLost = false;
  private labelDensity: LabelDensity = "normal";
  private tier: AtlasTier = "high";
  private reducedMotion = false;
  private frameEma = 16;
  private slowFrames = 0;
  private fastFrames = 0;

  onPick: ((hit: AtlasPickResult | null) => void) | null = null;
  onHover: ((id: string | null) => void) | null = null;
  onLabelReport: ((shown: number, wanted: number) => void) | null = null;
  onTierChange: ((t: AtlasTier) => void) | null = null;
  onCameraChange: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, labelHost: HTMLElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // screenshot support, as the connectome has
    });
    this.gl.setClearColor(A.bg, 1);

    this.scene.add(this.rails.mesh);
    this.scene.add(this.paths.mesh);
    this.scene.add(this.nodes.points);
    this.scene.add(this.pulses.points);
    // Draw order: rails behind, then routes, then entities, then pulses.
    this.rails.mesh.renderOrder = 0;
    this.paths.mesh.renderOrder = 1;
    this.nodes.points.renderOrder = 2;
    this.pulses.points.renderOrder = 3;

    this.cam = new AtlasCameraController(canvas);
    this.cam.onChange = () => this.onCameraChange?.();
    this.labels = new AtlasLabels(labelHost);
    this.labels.onPick = (id) => this.onPick?.({ id, kind: "quad" });
    this.labels.onHover = (id) => this.onHover?.(id);

    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.cam.camera));
    // A whisper, and only above the structural tier's brightness — gold should
    // glow, a lane platform should not.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.6, 0.82);
    this.composer.addPass(this.bloom);
    this.gl.toneMapping = THREE.NoToneMapping;
    this.composer.addPass(new OutputPass());

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("contextmenu", this.preventCtx);
    this.onVisibility = () => {
      if (document.hidden) this.stop();
      else this.start();
    };
    document.addEventListener("visibilitychange", this.onVisibility);

    this.resize();
    this.applyQuality();
  }

  private onVisibility: () => void;

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };
  private onContextRestored = (): void => {
    this.contextLost = false;
    if (this.current) this.setScene(this.current, true);
  };
  private preventCtx = (e: Event): void => e.preventDefault();

  /* ---------- scene ---------- */

  setScene(scene: AtlasScene, immediate = false): void {
    this.current = scene;
    if (immediate) this.transition.setReducedMotion(true);
    this.transition.setScene(scene, this.rails, this.nodes, this.clock.elapsedTime * 1000);
    if (immediate) this.transition.setReducedMotion(this.reducedMotion);
    this.paths.rebuild(scene.paths);
    // Pulse size follows the scene's own scale, so the 571-lane overview and a
    // single career route do not need separate tuning.
    const span = Math.max(1, scene.bounds.maxY - scene.bounds.minY);
    this.pulses.setWorldSize(Math.max(0.25, Math.min(6, span * 0.006)));
    this.applyEmphasis(this.emphasis);
  }

  get scene_(): AtlasScene | null {
    return this.current;
  }

  /* ---------- emphasis ---------- */

  applyEmphasis(em: AtlasEmphasis): void {
    this.emphasis = em;
    const anyFocus = em.selected !== null || em.members.length > 0;
    const member = new Set(em.members);
    const pinned = new Set(em.pinned);
    const t = this.transition;

    const factor = (pick: string | undefined): number => {
      if (!anyFocus) return 1;
      if (!pick) return 0.55; // structure stays legible, never disappears
      if (pick === em.selected) return 1.35;
      if (pick === em.hovered) return 1.2;
      if (member.has(pick) || pinned.has(pick)) return 1.05;
      return 0.3;
    };

    for (let i = 0; i < t.quadKeys.length; i++) {
      const pick = t.quadPick[i];
      let f = factor(pick);
      const flash = pick ? (this.flashes.get(pick) ?? 0) : 0;
      if (flash > 0) f += flash * 1.6;
      if (pick === em.hovered) f *= 1.15;
      t.quadEmph[i] = f;
    }
    for (let i = 0; i < t.dotKeys.length; i++) {
      const pick = t.dotPick[i];
      let f = factor(pick);
      const flash = pick ? (this.flashes.get(pick) ?? 0) : 0;
      if (flash > 0) f += flash * 1.6;
      t.dotEmph[i] = f;
    }
    if (!t.isRunning) t.refreshAlpha(this.rails, this.nodes);
  }

  /** Light an entity for a moment — a documented title change, a searched-for
   *  promotion, an event landing on a lane. */
  flash(id: string, strength = 1): void {
    this.flashes.set(id, Math.min(2.2, (this.flashes.get(id) ?? 0) + strength));
  }

  /** Send a record travelling between two entities. */
  pulseBetween(a: string, b: string, color: RGB): void {
    const anchors = this.current?.anchors;
    if (!anchors) return;
    const pa = anchors.get(a);
    const pb = anchors.get(b);
    if (!pa || !pb) return;
    this.pulses.spawn(pa, pb, color, this.clock.elapsedTime);
  }

  /** A record arriving somewhere with no counterpart — a card on a lane. */
  pulseAt(id: string, color: RGB, riseWorld = 1.6): void {
    const p = this.current?.anchors.get(id);
    if (!p) return;
    this.pulses.spawn([p[0], p[1] - riseWorld, p[2]], [p[0], p[1] + riseWorld, p[2]], color, this.clock.elapsedTime);
  }

  clearPulses(): void {
    this.pulses.clearAll();
    this.flashes.clear();
  }

  /* ---------- framing ---------- */

  fitScene(durationS = 0.7): void {
    // R frames EVERYTHING, including the parts the opening frame left out.
    if (this.current) this.cam.fit(this.current.bounds, 0.05, this.reducedMotion ? 0 : durationS);
  }

  focusEntity(id: string, half?: number): void {
    const p = this.current?.anchors.get(id);
    if (!p) return;
    this.cam.flyTo({ cx: p[0], cy: p[1], half }, this.reducedMotion ? 0 : 0.7);
  }

  /* ---------- interaction ---------- */

  /**
   * A selection needs a press AND a release on the board.
   *
   * Without the press half, any interaction that dismisses an overlay lands
   * its release on the canvas underneath — choosing from the search dropdown
   * fired a pick at whatever lane happened to be under the cursor, which then
   * silently replaced the entity the reader had just searched for.
   */
  private pressed = false;

  private onPointerDown = (): void => {
    this.pressed = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pressed) return;
    this.pressed = false;
    if (this.cam.wasDrag()) return; // a drag is a camera move, not a selection
    const rect = this.canvas.getBoundingClientRect();
    const hit = pickAt(
      this.cam,
      this.transition.pickRects,
      this.transition.pickDots,
      e.clientX - rect.left,
      e.clientY - rect.top,
      e.pointerType === "touch" ? 14 : 6,
    );
    this.onPick?.(hit);
  };

  private hoverPending = false;
  private onPointerMove = (e: PointerEvent): void => {
    if (this.hoverPending || e.buttons !== 0) return;
    this.hoverPending = true;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    requestAnimationFrame(() => {
      this.hoverPending = false;
      const hit = pickAt(this.cam, this.transition.pickRects, this.transition.pickDots, px, py, 6);
      this.canvas.style.cursor = hit ? "pointer" : "default";
      this.onHover?.(hit?.id ?? null);
    });
  };

  /* ---------- frame loop ---------- */

  setLabelDensity(d: LabelDensity): void {
    this.labelDensity = d;
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.transition.setReducedMotion(v);
    this.cam.reducedMotion = v;
    if (v) this.clearPulses();
  }

  setActive(v: boolean): void {
    if (this.active === v) return;
    this.active = v;
    if (v) this.start();
    else this.stop();
  }

  private effectiveDensity(): LabelDensity {
    const max = ATLAS_TIERS[this.tier].labelDensityMax;
    const order: LabelDensity[] = ["sparse", "normal", "dense"];
    return order[Math.min(order.indexOf(this.labelDensity), order.indexOf(max))]!;
  }

  private applyQuality(): void {
    const q = ATLAS_TIERS[this.tier];
    const pr = Math.min(devicePixelRatio || 1, q.pixelRatioCap);
    this.gl.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.bloom.enabled = q.bloom;
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.cam.setViewport(w, h);
  }

  start(): void {
    if (this.running || !this.active) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const t0 = performance.now();
      const dt = Math.min(0.1, this.clock.getDelta());
      const now = this.clock.elapsedTime;

      this.cam.update(dt);
      const pxPerWorld = this.canvas.clientHeight / Math.max(1e-6, this.cam.halfHeight * 2);
      this.rails.setPixelsPerWorld(pxPerWorld);
      this.nodes.setScale(pxPerWorld, this.gl.getPixelRatio());
      this.paths.setWorldPerPixel(this.cam.worldPerPixel);
      this.pulses.tick(now, pxPerWorld, this.gl.getPixelRatio());

      const morphing = this.transition.tick(performance.now(), this.rails, this.nodes);
      if (this.flashes.size) {
        const decay = Math.exp(-dt * 2.2);
        for (const [k, v] of this.flashes) {
          const n = v * decay;
          if (n < 0.02) this.flashes.delete(k);
          else this.flashes.set(k, n);
        }
        this.applyEmphasis(this.emphasis);
      } else if (!morphing) {
        // nothing animating the buffers this frame
      }

      if (this.current) {
        const r = this.labels.render(
          this.current.labels,
          this.cam,
          this.effectiveDensity(),
          this.canvas.clientWidth,
          this.canvas.clientHeight,
          this.cam.worldToScreen(this.current.axis.x0, 0).x,
        );
        this.onLabelReport?.(r.shown, r.wanted);
      }

      if (!this.contextLost) this.composer.render();
      this.governFrame(performance.now() - t0);
    };
    loop();
  }

  /** Same shape as the connectome's governor: step down fast, step up slowly,
   *  and never touch what is SELECTED — only caps. */
  private governFrame(ms: number): void {
    this.frameEma = this.frameEma * 0.95 + ms * 0.05;
    if (this.frameEma > 30) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (this.frameEma < 15) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
    if (this.slowFrames > 90 && this.tier !== "low") {
      this.tier = this.tier === "high" ? "medium" : "low";
      this.slowFrames = 0;
      this.applyQuality();
      this.onTierChange?.(this.tier);
    } else if (this.fastFrames > 600 && this.tier !== "high") {
      this.tier = this.tier === "low" ? "medium" : "high";
      this.fastFrames = 0;
      this.applyQuality();
      this.onTierChange?.(this.tier);
    }
  }

  get frameTimeMs(): number {
    return this.frameEma;
  }
  get qualityTier(): AtlasTier {
    return this.tier;
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  screenshot(): string {
    return this.canvas.toDataURL("image/png");
  }

  dispose(): void {
    this.active = false;
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("contextmenu", this.preventCtx);
    this.labels.dispose();
    this.transition.reset();
    this.rails.dispose();
    this.nodes.dispose();
    this.paths.dispose();
    this.pulses.dispose();
    this.cam.dispose();
    this.composer.dispose();
    this.gl.dispose();
  }
}

export { rgb };
