import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { MorphCamera } from "./MorphCamera";
import { writeMorphEmphasis } from "./emphasis";
import { MorphHoverController, type MorphHoverSnapshot } from "./MorphHoverController";
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
  ME,
  MR,
  TK,
  TRACE_SAMPLES,
  easeQuintic,
  elementProgress,
  type MorphEmphasis,
  type MorphGraphInput,
  type MorphLabel,
  type MorphLayoutResult,
  type MorphMode,
  type MorphPickResult,
  type MorphPickDiagnostic,
  type MorphPickSource,
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
  readonly hover = new MorphHoverController();

  onPick: ((hit: MorphPickResult | null) => void) | null = null;
  onHover: ((id: string | null) => void) | null = null;
  onHoverState: ((state: MorphHoverSnapshot) => void) | null = null;
  onLabelReport: ((r: MorphLabelReport) => void) | null = null;
  onTierChange: ((t: MorphTier) => void) | null = null;
  onCameraChange: (() => void) | null = null;
  onContextState: ((state: "ready" | "lost" | "restored") => void) | null = null;

  /** QA seams */
  mode: MorphMode = "organic";
  frameTimeMs = 0;
  readonly lastPickDiagnostic: MorphPickDiagnostic = {
    id: null,
    source: "programmatic",
    candidateCount: 0,
    durationMs: 0,
    normalizedDistance: Infinity,
    depth: Infinity,
    semanticPriority: ME.AMBIENT,
    layoutRole: MR.BACKGROUND,
  };

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
  private slotById = new Map<string, number>();
  private layout: MorphLayoutResult | null = null;
  private labelWork: MorphLabel[] = [];
  private labelSlots = new Int32Array(0);
  private labelByPick = new Map<string, number>();
  private hoveredLabelIndex = -1;
  private labelReport: MorphLabelReport = { shown: 0, wanted: 0 };
  private pickRoles = new Uint8Array(0);
  private activePickSlots = new Int32Array(0);
  private activePickCount = 0;
  private lastHoverId: string | null = null;
  private hoverPickRaf = 0;
  private hoverPointerX = Number.NaN;
  private hoverPointerY = Number.NaN;
  private hoverPointerType: "mouse" | "pen" | "touch" = "mouse";

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
    members: [],
    anchors: [],
    virtualMembers: [],
    virtualAnchors: [],
    memberGroup: "all",
    basis: "",
    caveat: null,
    coverageWarnings: [],
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
    this.cam.onDragChange = (dragging) => {
      this.hover.setDragging(dragging);
      if (dragging) {
        if (this.hoverPickRaf) cancelAnimationFrame(this.hoverPickRaf);
        this.hoverPickRaf = 0;
      } else if (Number.isFinite(this.hoverPointerX) && Number.isFinite(this.hoverPointerY)) {
        this.requestHoverPick(this.hoverPointerX, this.hoverPointerY, this.hoverPointerType);
      }
    };
    this.labels = new MorphLabels(labelHost);
    this.labels.onPick = (id) => this.onPick?.({ id, kind: "node" });
    this.labels.onHoverSurface = (id, source, phase) => {
      if (phase === "enter") {
        if (source === "label") this.hover.setTouchActive(false);
        this.hover.enterSurface(source, id);
      }
      else this.hover.leaveSurface(source, id);
    };
    this.labels.onTouch = () => this.hover.setTouchActive(true);
    this.hover.onChange = (state) => {
      this.onHoverState?.(state);
      if (state.id === this.lastHoverId) return;
      this.lastHoverId = state.id;
      this.onHover?.(state.id);
    };

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
    // Semantic membranes and crisp node halos carry emphasis. Whole-scene
    // bloom destroys dense-network contrast, so the pass stays disabled.
    this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onWindowBlur);
    this.resize();
  }

  /** Bake the corpus once. `organic` is copied, never retained. */
  setGraph(input: MorphGraphInput, idOfSlot: (slot: number) => string | null): void {
    this.corpusCount = input.count;
    this.slotById.clear();
    for (let i = 0; i < input.count; i++) {
      const id = idOfSlot(i);
      if (id) this.slotById.set(id, i);
    }
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
    this.pickRoles = new Uint8Array(this.nodes.total);
    this.activePickSlots = new Int32Array(this.nodes.total);
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
    assertFiniteLayout(layout, this.corpusCount);
    this.mode = layout.mode;
    this.layout = layout;
    this.transition.reducedMotion = this.reducedMotion;
    this.transition.apply(layout, this.nodes, this.traces, this.regions, performance.now(), immediate);
    this.pickRoles.fill(MR.BACKGROUND);
    this.pickRoles.set(layout.nodeRole, 0);
    for (const virtual of layout.virtuals) {
      const slot = this.virtualSlotOf(virtual.id);
      if (slot !== null) this.pickRoles[slot] = virtual.role;
    }
    this.labelWork = layout.labels.map((label) => ({ ...label }));
    this.labels.setLayoutKeys(layout.labels);
    this.labelSlots = new Int32Array(layout.labels.length).fill(-1);
    this.labelByPick.clear();
    this.hoveredLabelIndex = -1;
    for (let i = 0; i < layout.labels.length; i++) {
      const label = layout.labels[i]!;
      if (label.pick && !this.labelByPick.has(label.pick)) this.labelByPick.set(label.pick, i);
      if (!label.pick || (label.key !== `n:${label.pick}` && !label.force)) continue;
      this.labelSlots[i] = this.slotOfId(label.pick) ?? -1;
    }
    const span = Math.max(
      layout.bounds.maxX - layout.bounds.minX,
      layout.bounds.maxY - layout.bounds.minY,
    );
    this.pulses.setWorldSize(Math.min(8, Math.max(1.6, span * 0.004)));
    this.applyEmphasis(this.emphasis);
    this.hover.layoutChanged((id) => {
      const slot = this.slotOfId(id);
      if (slot !== null && this.nodes.alphaTo[slot]! >= 0.03) return true;
      return layout.labels.some((label) => label.pick === id) || layout.regions.some((region) => region.pick === id);
    });
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
  get corpusSlotCount(): number {
    return this.corpusCount;
  }
  idAtSlot(slot: number): string | null {
    return this.idOfSlot(slot);
  }

  /** live interpolated world position of a corpus slot (QA + selected card) */
  currentPositionOf(slot: number): [number, number, number] | null {
    if (!this.nodes || slot < 0 || slot >= this.nodes.total) return null;
    return this.nodes.currentPosition(slot, this.transition.progress);
  }
  projectSlot(slot: number): { x: number; y: number; front: boolean; depth: number } | null {
    const p = this.currentPositionOf(slot);
    return p ? this.cam.worldToScreen(p[0], p[1], p[2]) : null;
  }
  /** Current projected entity anchor, including keyed virtual nodes. */
  projectId(id: string): { x: number; y: number; front: boolean; depth: number } | null {
    const slot = this.slotOfId(id);
    return slot === null ? null : this.projectSlot(slot);
  }
  projectedNodeMetrics(slot: number): { x: number; y: number; depth: number; pointSizePx: number } | null {
    if (!this.nodes || slot < 0 || slot >= this.nodes.total) return null;
    const projected = this.projectSlot(slot);
    if (!projected?.front || projected.depth <= 0) return null;
    const p = elementProgress(this.transition.progress, this.nodes.delay[slot]!);
    const e = easeQuintic(p);
    const scale = THREE.MathUtils.lerp(this.nodes.scaleFrom[slot]!, this.nodes.scaleTo[slot]!, e);
    const semantic = this.nodes.semantic[slot]!;
    const semanticBoost = semantic >= 6 ? 0.42 : semantic >= 5 ? 0.34 : semantic >= 4 ? 0.24 : semantic >= 3 ? 0.18 : semantic >= 2 ? 0.08 : semantic >= 1 ? 0.05 : 0;
    const boost = 1 + Math.max(0, this.nodes.emph[slot]! - 1) * 0.4 + semanticBoost + this.nodes.glow[slot]! * 0.8;
    // gl_PointSize is multiplied by device pixel ratio in the shader. Cards
    // and picking operate in CSS pixels, so expose the pre-ratio size here.
    const raw = scale * this.cam.camera.projectionMatrix.elements[5]! * (this.canvas.clientHeight || 2) * 0.5 / projected.depth * boost;
    return {
      x: projected.x,
      y: projected.y,
      depth: projected.depth,
      pointSizePx: THREE.MathUtils.clamp(raw, 1.15, 30),
    };
  }
  projectedNodeMetricsById(id: string): { x: number; y: number; depth: number; pointSizePx: number } | null {
    const slot = this.slotOfId(id);
    return slot === null ? null : this.projectedNodeMetrics(slot);
  }
  virtualSlotOf(id: string): number | null {
    const s = this.transition?.virtualSlotOf(id);
    return s === undefined ? null : this.corpusCount + s;
  }

  slotOfId(id: string): number | null {
    const corpus = this.slotById.get(id);
    return corpus === undefined ? this.virtualSlotOf(id) : corpus;
  }

  /** Camera focus stays entirely inside Morph; it never mutates Connectome. */
  focusId(id: string, durationS = 0.55): boolean {
    const slot = this.slotOfId(id);
    if (slot === null) return false;
    const p = this.currentPositionOf(slot);
    if (!p) return false;
    const base = Math.max(this.nodes.scaleFrom[slot]!, this.nodes.scaleTo[slot]!, 5);
    this.cam.focus(p[0], p[1], p[2], base, this.reducedMotion ? 0 : durationS);
    return true;
  }

  focusSelection(durationS = 0.55): boolean {
    const id = this.emphasis.selectedId ?? this.idOfSlot(this.emphasis.selected);
    return id ? this.focusId(id, durationS) : false;
  }

  /** Read-only QA snapshot for semantic population assertions. */
  emphasisSnapshot(): { members: number; anchors: number; selected: number; hovered: number } {
    return {
      members: this.emphasis.members.length + this.emphasis.virtualMembers.length,
      anchors: this.emphasis.anchors.length + this.emphasis.virtualAnchors.length,
      selected: this.emphasis.selected,
      hovered: this.emphasis.hovered,
    };
  }

  applyEmphasis(em: MorphEmphasis): void {
    this.emphasis = em;
    if (!this.nodes || !this.layout) return;
    writeMorphEmphasis(
      this.nodes,
      em,
      this.layout.nodeRole,
      this.corpusCount,
      (id) => this.virtualSlotOf(id),
    );
    this.nodes.commitEmphasis();
    this.rebuildActivePickSlots();
    this.applyTraceEmphasis(em);
    this.applyHoveredLabel(em.hoveredId ?? this.idOfSlot(em.hovered));
  }

  private applyHoveredLabel(id: string | null): void {
    if (!this.layout) return;
    if (this.hoveredLabelIndex >= 0) {
      const original = this.layout.labels[this.hoveredLabelIndex];
      const work = this.labelWork[this.hoveredLabelIndex];
      if (original && work) {
        work.force = original.force;
        work.priority = original.priority;
      }
      this.hoveredLabelIndex = -1;
    }
    if (!id) return;
    const next = this.labelByPick.get(id);
    if (next === undefined) return;
    const work = this.labelWork[next];
    if (!work) return;
    work.force = true;
    work.priority = 1_000_000;
    this.hoveredLabelIndex = next;
  }

  private applyTraceEmphasis(em: MorphEmphasis): void {
    if (!this.layout || !this.transition) return;
    const hovered = em.hovered >= 0 ? em.hovered : em.hoveredId ? this.slotOfId(em.hoveredId) ?? -1 : -1;
    const selected = em.selected >= 0 ? em.selected : em.selectedId ? this.slotOfId(em.selectedId) ?? -1 : -1;
    const hoveredId = em.hoveredId ?? this.idOfSlot(hovered);
    const selectedId = em.selectedId ?? this.idOfSlot(selected);
    const hasHover = hovered >= 0 || hoveredId !== null;
    const path = new Set(em.pathNodes);
    for (const route of this.layout.routes) {
      const slot = this.transition.traceSlotOf(route.key);
      if (slot === undefined) continue;
      const incidentHover = (hovered >= 0 && (route.a === hovered || route.b === hovered)) ||
        (!!hoveredId && (route.aId === hoveredId || route.bId === hoveredId));
      const incidentSelected = (selected >= 0 && (route.a === selected || route.b === selected)) ||
        (!!selectedId && (route.aId === selectedId || route.bId === selectedId));
      const onPath = path.has(route.a) && path.has(route.b);
      const optical = hasHover
        ? incidentHover ? (route.kind === TK.BRIDGE ? 4.2 : 1.9) : 0.22
        : onPath ? 1.45 : incidentSelected ? 1.24 : 1;
      this.traces.setSlotEmphasis(slot, optical);
    }
    this.traces.commitEmphasis();
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

  pick(px: number, py: number, slopPx = 8, source: MorphPickSource = "programmatic"): MorphPickResult | null {
    if (!this.nodes || !this.layout) return null;
    return pickAt(
      this.cam,
      this.nodes,
      this.corpusCount,
      this.idOfSlot,
      this.layout.regions,
      this.transition.progress,
      px,
      py,
      {
        slopPx,
        source,
        stickyId: this.hover.snapshot().id,
        activeSlots: this.layout.mode === "organic" ? undefined : this.activePickSlots,
        activeSlotCount: this.layout.mode === "organic" ? undefined : this.activePickCount,
        roles: this.pickRoles,
        diagnostic: this.lastPickDiagnostic,
      },
    );
  }

  /**
   * Queue at most one canvas pick for the next animation frame. Pointer events
   * only overwrite the pending coordinates; React/store publication occurs
   * solely when the central controller's hovered id actually changes.
   */
  requestHoverPick(px: number, py: number, pointerType: "mouse" | "pen" | "touch" = "mouse"): void {
    if (this.disposed || !Number.isFinite(px) || !Number.isFinite(py)) return;
    this.hoverPointerX = px;
    this.hoverPointerY = py;
    this.hoverPointerType = pointerType;
    this.hover.setPointer(px, py);
    if (pointerType === "touch") {
      this.setTouchActive(true);
      return;
    }
    if (this.hover.snapshot().touchActive) this.setTouchActive(false);
    if (this.hoverPickRaf || this.hover.snapshot().cameraDragging) return;
    this.hoverPickRaf = requestAnimationFrame(() => {
      this.hoverPickRaf = 0;
      if (this.disposed || this.hover.snapshot().cameraDragging || this.hover.snapshot().touchActive) return;
      const latestPointerType = this.hoverPointerType;
      const hit = this.pick(
        this.hoverPointerX,
        this.hoverPointerY,
        latestPointerType === "pen" ? 11 : 8,
        "canvas",
      );
      this.hover.proposeCanvas(hit?.id ?? null, this.hoverPointerX, this.hoverPointerY);
      this.canvas.style.cursor = hit ? "pointer" : "default";
      // A replacement candidate is intentionally two-frame confirmed. Queue
      // its one follow-up sample even if the physical pointer is stationary
      // (notably after camera drag ends).
      if (this.hover.snapshot().candidateId) {
        this.requestHoverPick(this.hoverPointerX, this.hoverPointerY, latestPointerType);
      }
    });
  }

  leaveCanvasHover(): void {
    this.hover.leaveSurface("canvas");
  }

  cancelHover(reason: "context" | "blur" | "cancel" | "touch" | "lens" = "cancel"): void {
    this.hover.clear(reason);
  }

  setTouchActive(active: boolean): void {
    if (active && this.hoverPickRaf) {
      cancelAnimationFrame(this.hoverPickRaf);
      this.hoverPickRaf = 0;
    }
    this.hover.setTouchActive(active);
  }

  private rebuildActivePickSlots(): void {
    if (!this.nodes || !this.layout) return;
    let count = 0;
    for (let slot = 0; slot < this.nodes.total; slot++) {
      if (this.nodes.alphaTo[slot]! < 0.03 && this.nodes.alphaFrom[slot]! < 0.03) continue;
      const organized = this.layout.mode === "organic" || this.pickRoles[slot] !== MR.BACKGROUND;
      const semantic = this.nodes.semantic[slot]! > ME.AMBIENT;
      if (organized || semantic) this.activePickSlots[count++] = slot;
    }
    this.activePickCount = count;
  }

  fitLayout(durationS = 0.8, settleOrientation = false): void {
    if (!this.layout) return;
    const bounds = spatialFitBounds(this.layout);
    const points = this.layout.mode === "organic" ? undefined : spatialFitPoints(this.layout);
    this.cam.fit(
      bounds,
      0.1,
      this.reducedMotion ? 0 : durationS,
      settleOrientation ? orientationFor(this.layout.mode) : undefined,
      points,
    );
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    this.cam.reducedMotion = v;
    if (this.transition) this.transition.reducedMotion = v;
    if (v) this.pulses.clearAll();
  }

  setActive(v: boolean): void {
    this.active = v;
    if (!v) {
      this.hover.clear("lens");
      this.stop();
    }
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
    window.removeEventListener("blur", this.onWindowBlur);
    if (this.hoverPickRaf) cancelAnimationFrame(this.hoverPickRaf);
    this.hoverPickRaf = 0;
    this.labels.clear();
    this.hover.dispose();
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
    this.nodes?.setScale(this.canvas.clientHeight || 2, pr);
    this.regions.setPixelsPerWorld(pxPerWorld);
    this.traces.setResolution(this.canvas.clientWidth || 2, this.canvas.clientHeight || 2);
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
      const tierCap = MORPH_TIERS[this.tier].labelCap;
      // Orbit has two populated rings plus contextual halos; the ordinary
      // high-tier cap lets too many valid non-overlapping labels compete with
      // the topology itself. Ranking is unchanged and hovered/focused labels
      // are still forced into the pool.
      const cap = this.layout.mode === "orbit" ? Math.min(tierCap, 76) : tierCap;
      for (let i = 0; i < this.labelSlots.length; i++) {
        let slot = this.labelSlots[i]!;
        if (slot < 0) {
          const id = this.layout.labels[i]!.pick;
          if (id) slot = this.slotOfId(id) ?? -1;
          this.labelSlots[i] = slot;
        }
        if (slot < 0) continue;
        const pos = this.currentPositionOf(slot);
        if (!pos) continue;
        const label = this.labelWork[i]!;
        label.x = pos[0];
        label.y = pos[1];
        label.z = pos[2];
      }
      const report = this.labels.render(
        this.labelWork,
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
    this.bloom.enabled = false;
    this.resize();
    this.onTierChange?.(this.tier);
  }

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    this.hover.clear("context");
    this.onContextState?.("lost");
  };
  private onContextRestored = (): void => {
    this.contextLost = false;
    if (this.layout) this.setLayout(this.layout, true);
    this.onContextState?.("restored");
  };
  private onVisibility = (): void => {
    if (document.hidden) {
      this.hover.clear("blur");
      this.stop();
    }
    else this.start();
  };
  private onWindowBlur = (): void => this.hover.clear("blur");
}

function orientationFor(mode: MorphMode): { theta: number; phi: number } {
  switch (mode) {
    case "lineage": return { theta: THREE.MathUtils.degToRad(24), phi: THREE.MathUtils.degToRad(73) };
    case "career": return { theta: THREE.MathUtils.degToRad(31), phi: THREE.MathUtils.degToRad(70) };
    case "h2h": return { theta: THREE.MathUtils.degToRad(28), phi: THREE.MathUtils.degToRad(68) };
    case "orbit": return { theta: THREE.MathUtils.degToRad(22), phi: THREE.MathUtils.degToRad(64) };
    case "motherboard": return { theta: THREE.MathUtils.degToRad(34), phi: THREE.MathUtils.degToRad(66) };
    case "loom": return { theta: THREE.MathUtils.degToRad(32), phi: THREE.MathUtils.degToRad(66) };
    default: return { theta: THREE.MathUtils.degToRad(29), phi: THREE.MathUtils.degToRad(68) };
  }
}

function spatialFitBounds(layout: MorphLayoutResult): {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
} {
  const xy = layout.fitBounds ?? layout.bounds;
  let minZ = Number.isFinite(xy.minZ) ? xy.minZ! : Infinity;
  let maxZ = Number.isFinite(xy.maxZ) ? xy.maxZ! : -Infinity;
  for (let i = 0; i < layout.nodeOpacity.length; i++) {
    if (layout.nodeOpacity[i]! < 0.02 || (layout.mode !== "organic" && layout.nodeRole[i] === 0)) continue;
    const i3 = i * 3;
    const x = layout.nodeTargets[i3]!;
    const y = layout.nodeTargets[i3 + 1]!;
    if (x < xy.minX || x > xy.maxX || y < xy.minY || y > xy.maxY) continue;
    const z = layout.nodeTargets[i3 + 2]!;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  for (const v of layout.virtuals) {
    if (v.opacity < 0.02 || v.x < xy.minX || v.x > xy.maxX || v.y < xy.minY || v.y > xy.maxY) continue;
    minZ = Math.min(minZ, v.z);
    maxZ = Math.max(maxZ, v.z);
  }
  if (!Number.isFinite(minZ) || !Number.isFinite(maxZ)) minZ = maxZ = 0;
  return { ...xy, minZ, maxZ };
}

/** Exact occupied samples for perspective fitting. This runs only on Fit or a
 * semantic topology change, never per frame. Ambient corpus-shell nodes are
 * intentionally excluded so context cannot make the active sculpture tiny. */
function spatialFitPoints(layout: MorphLayoutResult): Float32Array {
  let activeNodes = 0;
  for (let i = 0; i < layout.nodeOpacity.length; i++) {
    if (layout.nodeOpacity[i]! >= 0.02 && layout.nodeRole[i] !== 0) activeNodes++;
  }
  const pointCap =
    activeNodes +
    layout.virtuals.length +
    layout.routes.length * TRACE_SAMPLES +
    layout.regions.length * 4 +
    layout.labels.length;
  const points = new Float32Array(Math.max(1, pointCap) * 3);
  let o = 0;
  const add = (x: number, y: number, z: number) => {
    points[o++] = x;
    points[o++] = y;
    points[o++] = z;
  };
  for (let i = 0; i < layout.nodeOpacity.length; i++) {
    if (layout.nodeOpacity[i]! < 0.02 || layout.nodeRole[i] === 0) continue;
    add(layout.nodeTargets[i * 3]!, layout.nodeTargets[i * 3 + 1]!, layout.nodeTargets[i * 3 + 2]!);
  }
  for (const virtual of layout.virtuals) if (virtual.opacity >= 0.02) add(virtual.x, virtual.y, virtual.z);
  for (const route of layout.routes) {
    for (let i = 0; i < route.points.length; i += 3) add(route.points[i]!, route.points[i + 1]!, route.points[i + 2]!);
  }
  for (const region of layout.regions) {
    const hw = region.w * 0.5;
    const hh = region.h * 0.5;
    add(region.x - hw, region.y - hh, region.z);
    add(region.x + hw, region.y - hh, region.z);
    add(region.x - hw, region.y + hh, region.z);
    add(region.x + hw, region.y + hh, region.z);
  }
  for (const label of layout.labels) add(label.x, label.y, label.z);
  return points.subarray(0, o);
}

function assertFiniteLayout(layout: MorphLayoutResult, count: number): void {
  if (layout.nodeTargets.length !== count * 3) throw new Error(`Morph ${layout.mode}: expected ${count} node slots`);
  for (let i = 0; i < layout.nodeTargets.length; i++) {
    if (!Number.isFinite(layout.nodeTargets[i])) throw new Error(`Morph ${layout.mode}: non-finite node target at ${i}`);
  }
  for (const [name, value] of Object.entries(layout.bounds)) {
    if (!Number.isFinite(value)) throw new Error(`Morph ${layout.mode}: non-finite bound ${name}`);
  }
  if (!(layout.bounds.maxX > layout.bounds.minX) || !(layout.bounds.maxY > layout.bounds.minY)) {
    throw new Error(`Morph ${layout.mode}: zero-sized layout bounds`);
  }
}
