import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { MorphCamera } from "./MorphCamera";
import { MorphLabels, type MorphLabelReport } from "./MorphLabels";
import { MorphNodes } from "./MorphNodes";
import { pickAt } from "./MorphPicking";
import { MorphPulses } from "./MorphPulses";
import { MorphRegions } from "./MorphRegions";
import { MorphTraces } from "./MorphTraces";
import { MorphTransition } from "./MorphTransition";
import { M, rgb, type RGB } from "./palette";
import {
  MORPH_TIERS,
  TRACE_SAMPLES,
  type MorphEmphasis,
  type MorphGraphInput,
  type MorphLayoutResult,
  type MorphMode,
  type MorphPickResult,
  type MorphTier,
} from "./types";

const VIRTUAL_CAP = 768;

/**
 * Morph Lab renderer — its own canvas, its own WebGL context, its own rAF.
 * Completely isolated from the ConnectomeRenderer: it reads the organic
 * positions once as plain numbers and never touches the connectome's buffers,
 * camera or loop. setActive(false) parks it (the app calls this on lens exit,
 * mirroring the connectome's own suspension contract).
 */
export class MorphRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly cam: MorphCamera;
  readonly labels: MorphLabels;

  onPick: ((hit: MorphPickResult | null) => void) | null = null;
  onHover: ((id: string | null) => void) | null = null;
  onLabelReport: ((r: MorphLabelReport) => void) | null = null;
  onTierChange: ((t: MorphTier) => void) | null = null;
  onCameraChange: (() => void) | null = null;

  /** QA seams */
  mode: MorphMode = "organic";
  frameTimeMs = 0;

  private nodes!: MorphNodes;
  private traces = new MorphTraces(MORPH_TIERS.high.traceCap);
  private regions = new MorphRegions();
  private pulses = new MorphPulses();
  private transition!: MorphTransition;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private playhead: THREE.Mesh;

  private corpusCount = 0;
  private idOfSlot: (slot: number) => string | null = () => null;
  private layout: MorphLayoutResult | null = null;
  private labelReport: MorphLabelReport = { shown: 0, wanted: 0 };

  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private active = true;
  private disposed = false;
  private reducedMotion = false;
  private contextLost = false;

  private tier: MorphTier = "high";
  private ema = 16;
  private slowFrames = 0;
  private fastFrames = 0;

  private glowHot = new Set<number>();
  private emphasis: MorphEmphasis = {
    selected: -1,
    hovered: -1,
    selectedId: null,
    hoveredId: null,
    pinned: [],
    pathNodes: [],
    dimBackground: false,
  };

  constructor(canvas: HTMLCanvasElement, labelHost: HTMLElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.gl.setClearColor(M.bg, 1);
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.cam = new MorphCamera(canvas);
    this.cam.onChange = () => this.onCameraChange?.();
    this.labels = new MorphLabels(labelHost);
    this.labels.onPick = (id) => this.onPick?.({ id, kind: "node" });
    this.labels.onHover = (id) => this.onHover?.(id);

    this.scene.add(this.regions.mesh);
    this.scene.add(this.traces.mesh);
    this.scene.add(this.pulses.points);

    this.playhead = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: M.text, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }),
    );
    this.playhead.renderOrder = 4;
    this.playhead.visible = false;
    this.scene.add(this.playhead);

    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.cam.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
  }

  /** Bake the corpus once. `organic` is copied, never retained. */
  setGraph(input: MorphGraphInput, idOfSlot: (slot: number) => string | null): void {
    this.corpusCount = input.count;
    this.idOfSlot = (slot) => {
      if (slot < this.corpusCount) return idOfSlot(slot);
      for (const [id, s] of this.transition.virtualIds()) {
        if (this.corpusCount + s === slot) return id;
      }
      return null;
    };
    if (this.nodes) {
      this.scene.remove(this.nodes.points);
      this.nodes.dispose();
    }
    this.nodes = new MorphNodes(input.count, VIRTUAL_CAP);
    this.transition = new MorphTransition(input.count, VIRTUAL_CAP);
    const nd = this.nodes;
    nd.from.set(input.organic, 0);
    nd.to.set(input.organic, 0);
    for (let i = 0; i < input.count; i++) {
      nd.color[i * 3] = input.color[i * 3]!;
      nd.color[i * 3 + 1] = input.color[i * 3 + 1]!;
      nd.color[i * 3 + 2] = input.color[i * 3 + 2]!;
      nd.shape[i] = input.type[i]!;
      nd.scaleFrom[i] = nd.scaleTo[i] = input.organicScale[i]!;
      nd.alphaFrom[i] = nd.alphaTo[i] = input.organicOpacity[i]!;
    }
    nd.commitMotion();
    nd.commitStatic();
    this.scene.add(nd.points);
  }

  setLayout(layout: MorphLayoutResult, immediate = false): void {
    if (!this.nodes) return;
    this.mode = layout.mode;
    this.layout = layout;
    this.transition.reducedMotion = this.reducedMotion;
    this.transition.apply(layout, this.nodes, this.traces, this.regions, performance.now(), immediate);
    const span = Math.max(
      layout.bounds.maxX - layout.bounds.minX,
      layout.bounds.maxY - layout.bounds.minY,
    );
    this.pulses.setWorldSize(Math.min(8, Math.max(1.6, span * 0.004)));
    this.applyEmphasis(this.emphasis);
  }

  get morphProgress(): number {
    return this.transition?.progress ?? 1;
  }
  get morphing(): boolean {
    return this.transition?.animating ?? false;
  }
  get currentLayout(): MorphLayoutResult | null {
    return this.layout;
  }
  get qualityTier(): MorphTier {
    return this.tier;
  }
  get traceLive(): number {
    return this.transition?.liveTraceCount ?? 0;
  }
  get lastLabelReport(): MorphLabelReport {
    return this.labelReport;
  }

  /** live interpolated world position of a corpus slot (QA + selected card) */
  currentPositionOf(slot: number): [number, number, number] | null {
    if (!this.nodes || slot < 0 || slot >= this.nodes.total) return null;
    return this.nodes.currentPosition(slot, this.transition.progress);
  }
  projectSlot(slot: number): { x: number; y: number; front: boolean } | null {
    const p = this.currentPositionOf(slot);
    return p ? this.cam.worldToScreen(p[0], p[1], p[2]) : null;
  }
  virtualSlotOf(id: string): number | null {
    const s = this.transition?.virtualSlotOf(id);
    return s === undefined ? null : this.corpusCount + s;
  }

  applyEmphasis(em: MorphEmphasis): void {
    this.emphasis = em;
    if (!this.nodes || !this.layout) return;
    const nd = this.nodes;
    const roles = this.layout.nodeRole;
    const anyFocus = (em.selected >= 0 || em.selectedId !== null || em.pathNodes.length > 0) && em.dimBackground;
    for (let i = 0; i < this.corpusCount; i++) {
      nd.emph[i] = roles[i] === 0 && anyFocus ? 0.3 : 1;
    }
    for (let i = this.corpusCount; i < nd.total; i++) nd.emph[i] = 1;
    for (const i of em.pathNodes) if (i >= 0) nd.emph[i] = 1.45;
    for (const i of em.pinned) if (i >= 0) nd.emph[i] = Math.max(nd.emph[i]!, 1.15);
    if (em.hovered >= 0) nd.emph[em.hovered] = Math.max(nd.emph[em.hovered]!, 1.3);
    if (em.selected >= 0) nd.emph[em.selected] = 1.6;
    const vSel = em.selectedId ? this.virtualSlotOf(em.selectedId) : null;
    if (vSel !== null) nd.emph[vSel] = 1.6;
    const vHov = em.hoveredId ? this.virtualSlotOf(em.hoveredId) : null;
    if (vHov !== null) nd.emph[vHov] = Math.max(nd.emph[vHov]!, 1.3);
    nd.commitEmphasis();
  }

  igniteSlot(slot: number): void {
    if (!this.nodes || slot < 0 || slot >= this.nodes.total) return;
    this.nodes.glow[slot] = 1;
    this.glowHot.add(slot);
    this.nodes.commitGlow();
  }

  /** pulse riding the live geometry of a trace; false when no such trace */
  pulseTrace(key: string, color: RGB): boolean {
    const slot = this.transition?.traceSlotOf(key);
    if (slot === undefined) return false;
    const line = new Float32Array(TRACE_SAMPLES * 3);
    this.traces.currentCentreline(slot, this.transition.progress, line);
    const ctrl = new Float32Array(12);
    const at = (t: number, o: number) => {
      const s = Math.round(t * (TRACE_SAMPLES - 1)) * 3;
      ctrl[o] = line[s]!;
      ctrl[o + 1] = line[s + 1]!;
      ctrl[o + 2] = line[s + 2]!;
    };
    at(0, 0);
    at(0.33, 3);
    at(0.66, 6);
    at(1, 9);
    this.pulses.spawnCurve(ctrl, color, this.clock.elapsedTime);
    return true;
  }

  pulseBetween(slotA: number, slotB: number, color: RGB): void {
    if (!this.nodes) return;
    const a = this.currentPositionOf(slotA);
    const b = this.currentPositionOf(slotB);
    if (!a || !b) return;
    const lift = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.12;
    const ctrl = new Float32Array([
      a[0], a[1], a[2],
      a[0] + (b[0] - a[0]) * 0.33, a[1] + (b[1] - a[1]) * 0.33 + lift, a[2],
      a[0] + (b[0] - a[0]) * 0.66, a[1] + (b[1] - a[1]) * 0.66 + lift, b[2],
      b[0], b[1], b[2],
    ]);
    this.pulses.spawnCurve(ctrl, color, this.clock.elapsedTime);
  }

  pulseGoldAt(slot: number): void {
    const p = this.currentPositionOf(slot);
    if (!p) return;
    const rise = 14;
    const ctrl = new Float32Array([
      p[0], p[1], p[2],
      p[0], p[1] + rise * 0.4, p[2],
      p[0], p[1] + rise * 0.8, p[2],
      p[0], p[1] + rise, p[2],
    ]);
    this.pulses.spawnCurve(ctrl, rgb(M.gold), this.clock.elapsedTime);
  }

  clearPulses(): void {
    this.pulses.clearAll();
  }

  setPlayhead(x: number | null, y0 = -300, y1 = 300): void {
    if (x === null) {
      this.playhead.visible = false;
      return;
    }
    this.playhead.visible = true;
    this.playhead.position.set(x, (y0 + y1) / 2, 30);
    this.playhead.scale.set(Math.max(0.75, this.cam.worldPerPixel * 1.5), y1 - y0, 1);
  }

  pick(px: number, py: number, slopPx = 8): MorphPickResult | null {
    if (!this.nodes || !this.layout) return null;
    return pickAt(this.cam, this.nodes, this.corpusCount, this.idOfSlot, this.layout.regions, px, py, slopPx);
  }

  fitLayout(durationS = 0.8): void {
    if (!this.layout) return;
    this.cam.fit(this.layout.fitBounds ?? this.layout.bounds, 0.07, this.reducedMotion ? 0 : durationS);
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.cam.reducedMotion = v;
    if (this.transition) this.transition.reducedMotion = v;
    if (v) this.pulses.clearAll();
  }

  setActive(v: boolean): void {
    this.active = v;
    if (!v) this.stop();
    else this.start();
  }
  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (!this.active || this.running || this.disposed) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    const w = this.canvas.clientWidth || 2;
    const h = this.canvas.clientHeight || 2;
    const pr = Math.min(window.devicePixelRatio || 1, MORPH_TIERS[this.tier].pixelRatioCap);
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.cam.setViewport(w, h);
  }

  screenshot(): string {
    return this.canvas.toDataURL("image/png");
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.labels.clear();
    this.cam.dispose();
    this.nodes?.dispose();
    this.traces.dispose();
    this.regions.dispose();
    this.pulses.dispose();
    (this.playhead.geometry as THREE.BufferGeometry).dispose();
    (this.playhead.material as THREE.Material).dispose();
    this.composer.dispose();
    this.gl.dispose();
  }

  private frame(): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, this.clock.getDelta());
    this.cam.update(dt);

    if (this.transition && this.nodes) {
      this.transition.tick(t0, this.nodes, this.traces, this.regions);
    }

    const pxPerWorld = (this.canvas.clientHeight || 2) / (this.cam.halfHeight * 2);
    const pr = Math.min(window.devicePixelRatio || 1, MORPH_TIERS[this.tier].pixelRatioCap);
    this.nodes?.setScale(pxPerWorld, pr);
    this.regions.setPixelsPerWorld(pxPerWorld);
    this.traces.setWorldPerPixel(this.cam.worldPerPixel);
    this.pulses.tick(this.clock.elapsedTime, pxPerWorld, pr);

    // glow decay — bounded hot set
    if (this.glowHot.size > 0 && this.nodes) {
      const decay = Math.exp(-dt * 2.6);
      for (const i of this.glowHot) {
        const v = this.nodes.glow[i]! * decay;
        this.nodes.glow[i] = v;
        if (v < 0.02) {
          this.nodes.glow[i] = 0;
          this.glowHot.delete(i);
        }
      }
      this.nodes.commitGlow();
    }

    // labels — candidates from the layout, projected every frame
    if (this.layout) {
      const raw = this.transition.progress;
      const opacity = this.reducedMotion || raw >= 1 ? 1 : Math.max(0, Math.min(1, (raw - 0.5) / 0.4));
      const cap = MORPH_TIERS[this.tier].labelCap;
      const report = this.labels.render(
        this.layout.labels,
        this.cam,
        cap,
        this.canvas.clientWidth || 2,
        this.canvas.clientHeight || 2,
        opacity,
      );
      if (report.shown !== this.labelReport.shown || report.wanted !== this.labelReport.wanted) {
        this.labelReport = report;
        this.onLabelReport?.(report);
      }
    }

    if (!this.contextLost) this.composer.render();

    // frame governor — never touches what is selected, only caps
    const elapsed = performance.now() - t0;
    this.ema = this.ema * 0.95 + elapsed * 0.05;
    this.frameTimeMs = this.ema;
    if (this.ema > 30) {
      this.fastFrames = 0;
      if (++this.slowFrames > 90) {
        this.slowFrames = 0;
        this.stepTier(-1);
      }
    } else if (this.ema < 15) {
      this.slowFrames = 0;
      if (++this.fastFrames > 600) {
        this.fastFrames = 0;
        this.stepTier(1);
      }
    }
  }

  private stepTier(dir: 1 | -1): void {
    const order: MorphTier[] = ["low", "medium", "high"];
    const i = order.indexOf(this.tier) + dir;
    if (i < 0 || i >= order.length) return;
    this.tier = order[i]!;
    this.bloom.enabled = MORPH_TIERS[this.tier].bloom;
    this.resize();
    this.onTierChange?.(this.tier);
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };
  private onContextRestored = (): void => {
    this.contextLost = false;
    if (this.layout) this.setLayout(this.layout, true);
  };
  private onVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };
}
