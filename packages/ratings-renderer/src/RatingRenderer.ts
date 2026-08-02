import * as THREE from "three";
import type { MorphHoverSnapshot } from "@kayfabe/morph-renderer";
import { RatingAggregateRidges } from "./RatingAggregateRidges";
import { RatingCamera } from "./RatingCamera";
import { RatingCoverageRails } from "./RatingCoverageRails";
import { RatingGuides } from "./RatingGuides";
import { RatingHoverController } from "./RatingHoverController";
import { RatingLabels, type RatingLabelReport } from "./RatingLabels";
import { RatingPeaks } from "./RatingPeaks";
import { pickRating } from "./RatingPicking";
import { RatingPulses, type RatingPulseKind } from "./RatingPulses";
import { RatingTransition } from "./RatingTransition";
import { RATING_PALETTE } from "./palette";
import {
  RATING_TIERS,
  type RatingCoverageReport,
  type RatingLayout,
  type RatingMode,
  type RatingPickDiagnostic,
  type RatingPickResult,
  type RatingQualityOverride,
  type RatingRendererInfo,
  type RatingTier,
} from "./types";

export class RatingRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: RatingCamera;
  readonly labels: RatingLabels;
  readonly hover = new RatingHoverController({ graceMs: 110, confirmationFrames: 2 });
  readonly aggregates = new RatingAggregateRidges();
  readonly coverage = new RatingCoverageRails();
  readonly guides = new RatingGuides();
  readonly pulses = new RatingPulses();
  private readonly outgoingAggregates = new RatingAggregateRidges();
  private readonly outgoingCoverage = new RatingCoverageRails();
  private readonly outgoingGuides = new RatingGuides();

  onPick: ((hit: RatingPickResult | null) => void) | null = null;
  onHover: ((hit: RatingPickResult | null) => void) | null = null;
  onHoverState: ((state: MorphHoverSnapshot) => void) | null = null;
  onHoverAnchor: ((x: number, y: number, visible: boolean) => void) | null = null;
  onLabelReport: ((report: RatingLabelReport) => void) | null = null;
  onTierChange: ((tier: RatingTier) => void) | null = null;
  onCameraChange: (() => void) | null = null;
  onContextState: ((state: "ready" | "lost" | "restored") => void) | null = null;

  mode: RatingMode = "promotions";
  qualityTier: RatingTier = "high";
  qualityOverride: RatingQualityOverride = "auto";
  frameTimeMs = 16.7;
  frameIntervalMs = 16.7;
  rendererCpuMs = 0;
  visibleExactMatches = 0;
  visibleAggregateBins = 0;
  omittedPromotions = 0;
  shownLabels = 0;
  wantedLabels = 0;
  selectedMatchId: string | null = null;
  hoveredMatchId: string | null = null;
  activeThreshold = 5;
  coverageStats: RatingCoverageReport = { totalDocumented: 0, rated: 0, coverage: 0, visibleRailCells: 0 };
  ratingRange: readonly [number, number] = [0, 5];
  readonly lastPickDiagnostic: RatingPickDiagnostic = {
    id: null,
    kind: null,
    source: "programmatic",
    candidateCount: 0,
    durationMs: 0,
    depth: Infinity,
    normalizedDistance: Infinity,
    instanceId: -1,
    result: "miss",
  };
  longTasks = 0;
  dataDecodeDurationMs = 0;
  layoutBuildDurationMs = 0;

  currentLayout: RatingLayout | null = null;
  private peaks: RatingPeaks | null = null;
  private matchIds: readonly string[] = [];
  private matchIndex = new Map<string, number>();
  private aggregateIndex = new Map<string, number>();
  private transition = new RatingTransition();
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private active = true;
  private disposed = false;
  private contextLost = false;
  private reducedMotion = false;
  private selectedIndex = -1;
  private hoveredIndex = -1;
  private currentIndex = -1;
  private currentMatchId: string | null = null;
  private currentTimeDay: number | null = null;
  private pendingLabels: RatingLayout["labels"] | null = null;
  private trendVisible = true;
  private aggregateAlpha = 1;
  private exactAlpha = 1;
  private tipAlpha = 0;
  private pendingHover: { x: number; y: number; pointerType: "mouse" | "pen" | "touch" } | null = null;
  private pointerX = Number.NaN;
  private pointerY = Number.NaN;
  private pointerType: "mouse" | "pen" | "touch" = "mouse";
  private lastHoverHit: RatingPickResult | null = null;
  private labelReport: RatingLabelReport = { shown: 0, wanted: 0 };
  private lastFrameAt = 0;
  private intervalEma = 16.7;
  private cpuEma = 0;
  private slowFrames = 0;
  private slowDurationMs = 0;
  private fastFrames = 0;
  private longTaskObserver: PerformanceObserver | null = null;

  constructor(canvas: HTMLCanvasElement, labelHost: HTMLElement) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    this.gl.setClearColor(RATING_PALETTE.ink, 1);
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.92;
    this.scene.background = new THREE.Color(RATING_PALETTE.ink);
    this.scene.fog = new THREE.FogExp2(RATING_PALETTE.ink, 0.00054);

    this.cam = new RatingCamera(canvas);
    this.cam.onChange = () => this.onCameraChange?.();
    this.cam.onDragChange = (dragging) => {
      this.hover.setDragging(dragging);
      if (dragging) this.pendingHover = null;
      else if (Number.isFinite(this.pointerX) && Number.isFinite(this.pointerY)) {
        this.requestHoverPick(this.pointerX, this.pointerY, this.pointerType);
      }
    };

    this.labels = new RatingLabels(labelHost);
    this.labels.onPick = (id) => this.onPick?.(this.resolveIdentity(id));
    this.labels.onHoverSurface = (id, source, phase) => {
      if (phase === "enter") this.hover.enterSurface(source, id);
      else this.hover.leaveSurface(source, id);
    };
    this.labels.onFocusRestoreRequested = () => {
      labelHost.focus({ preventScroll: true });
    };
    this.hover.onChange = (state) => {
      this.onHoverState?.(state);
      const hit = state.id ? this.resolveIdentity(state.id) : null;
      this.lastHoverHit = hit;
      this.hoveredMatchId = hit?.kind === "match" ? hit.id : null;
      this.hoveredIndex = this.hoveredMatchId ? (this.matchIndex.get(this.hoveredMatchId) ?? -1) : -1;
      this.applyEmphasis();
      this.onHover?.(hit);
    };

    this.scene.add(this.outgoingCoverage.mesh);
    this.scene.add(this.outgoingGuides.group);
    this.scene.add(this.outgoingAggregates.mesh);
    this.scene.add(this.outgoingAggregates.medianTrace);
    this.scene.add(this.coverage.mesh);
    this.scene.add(this.guides.group);
    this.scene.add(this.aggregates.mesh);
    this.scene.add(this.aggregates.medianTrace);
    this.scene.add(this.pulses.points);
    this.setOutgoingVisible(false);

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
    if (typeof PerformanceObserver !== "undefined") {
      try {
        this.longTaskObserver = new PerformanceObserver((entries) => {
          this.longTasks += entries.getEntries().length;
        });
        this.longTaskObserver.observe({ type: "longtask", buffered: true });
      } catch {
        this.longTaskObserver = null;
      }
    }
    this.resize();
  }

  setData(matchIds: readonly string[]): void {
    if (this.peaks && matchIds.length !== this.matchIds.length) {
      throw new Error("Ratings renderer identity set is immutable for its lifetime");
    }
    if (this.peaks) return;
    this.matchIds = matchIds;
    this.matchIndex.clear();
    matchIds.forEach((id, index) => this.matchIndex.set(id, index));
    this.peaks = new RatingPeaks(matchIds.length);
    this.peaks.setThreshold(this.activeThreshold);
    this.peaks.setPixelRatio(this.gl.getPixelRatio());
    this.peaks.setQualityTier(this.qualityTier);
    this.scene.add(this.peaks.mesh);
    this.scene.add(this.peaks.tips);
  }

  setLayout(layout: RatingLayout, immediate = false): void {
    if (!this.peaks) this.setData(layout.matchIds);
    if (layout.matchIds.length !== this.matchIds.length) throw new Error("Rating layout changed canonical identity count");
    const previousLayout = this.currentLayout;
    const wasEmpty = previousLayout === null;
    const animateLayers = !immediate && !wasEmpty && !this.reducedMotion;
    const current = this.transition.progress;
    if (animateLayers && previousLayout) {
      this.outgoingAggregates.setBins(previousLayout.aggregates);
      this.outgoingAggregates.medianTrace.visible = this.trendVisible && previousLayout.aggregates.length > 0;
      this.outgoingCoverage.setCells(previousLayout.coverage, previousLayout.lanes, [previousLayout.bounds.minX, previousLayout.bounds.maxX]);
      this.outgoingGuides.setLayout(previousLayout.bounds, previousLayout.ratingRange, ratingScaleOf(previousLayout));
      this.outgoingGuides.setThreshold(this.activeThreshold);
      this.outgoingGuides.setTimeX(null, false);
      this.setOutgoingVisible(true);
    } else {
      this.setOutgoingVisible(false);
    }
    this.currentLayout = layout;
    this.mode = layout.mode;
    this.visibleExactMatches = layout.visibleExactMatches;
    this.visibleAggregateBins = layout.visibleAggregateBins;
    this.omittedPromotions = layout.omittedPromotions;
    this.wantedLabels = layout.wantedLabels;
    this.ratingRange = layout.ratingRange;
    this.aggregateIndex.clear();
    layout.aggregates.forEach((bin, i) => this.aggregateIndex.set(bin.key, i));
    this.peaks!.retarget(layout, current, immediate || wasEmpty || this.reducedMotion);
    this.aggregates.setBins(layout.aggregates);
    this.aggregates.medianTrace.visible = this.trendVisible && layout.aggregates.length > 0;
    this.coverage.setCells(layout.coverage, layout.lanes, [layout.bounds.minX, layout.bounds.maxX]);
    const ratingScale = ratingScaleOf(layout);
    this.guides.setLayout(layout.bounds, layout.ratingRange, ratingScale);
    this.guides.setThreshold(this.activeThreshold);
    this.applyTimeDay();
    if (animateLayers) this.pendingLabels = layout.labels;
    else {
      this.pendingLabels = null;
      this.labels.setLabels(layout.labels);
    }
    this.hover.layoutChanged((id) => this.identityExists(id));
    // A new semantic generation can move an otherwise stable identity to a
    // different lane or screen position. Ratings deliberately clears every
    // transient owner here; persistent selection remains in the inspector.
    this.hover.clear("layout");
    if (immediate || wasEmpty || this.reducedMotion) this.transition.land();
    else this.transition.retarget(performance.now());
    this.applyEmphasis();
  }

  setSelectedMatch(id: string | null): void {
    this.selectedMatchId = id && this.matchIndex.has(id) ? id : null;
    this.selectedIndex = this.selectedMatchId ? this.matchIndex.get(this.selectedMatchId)! : -1;
    this.applyEmphasis();
  }

  setCurrentMatch(id: string | null): void {
    this.currentMatchId = id && this.matchIndex.has(id) ? id : null;
    this.currentIndex = this.currentMatchId ? this.matchIndex.get(this.currentMatchId)! : -1;
    this.applyEmphasis();
  }

  setThreshold(value: number): void {
    if (!Number.isFinite(value)) return;
    this.activeThreshold = value;
    this.peaks?.setThreshold(value);
    this.guides.setThreshold(value);
    this.outgoingGuides.setThreshold(value);
  }

  setCoverageStats(report: RatingCoverageReport): void {
    this.coverageStats = report;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
    this.transition.reducedMotion = value;
    this.cam.reducedMotion = value;
    if (value) {
      this.transition.land();
      this.peaks?.setMorph(1);
      this.pulses.clear();
    }
  }

  setQualityOverride(value: RatingQualityOverride): void {
    this.qualityOverride = value;
    if (value !== "auto" && value !== this.qualityTier) this.changeTier(value);
  }

  setTrendVisible(value: boolean): void {
    this.trendVisible = value;
    this.aggregates.medianTrace.visible = value && this.aggregates.bins.length > 0;
    this.outgoingAggregates.medianTrace.visible = value && this.outgoingAggregates.bins.length > 0 && this.outgoingAggregates.mesh.visible;
  }

  setInsets(insets: { left?: number; right?: number; top?: number; bottom?: number }): void {
    this.cam.setInsets(insets);
  }

  setTimeDay(day: number | null): void {
    this.currentTimeDay = day;
    this.applyTimeDay();
  }

  requestHoverPick(x: number, y: number, pointerType: "mouse" | "pen" | "touch" = "mouse"): void {
    this.pointerX = x;
    this.pointerY = y;
    this.pointerType = pointerType;
    this.hover.setPointer(x, y);
    if (this.cam.isDragging || pointerType === "touch") return;
    // Replacement, not a queue: at most the final pointer is sampled per frame.
    this.pendingHover = { x, y, pointerType };
  }

  pick(x: number, y: number, pointerType: "mouse" | "pen" | "touch" = "mouse"): RatingPickResult | null {
    if (!this.peaks || !this.currentLayout || this.cam.isDragging) {
      this.lastPickDiagnostic.result = "suppressed-drag";
      return null;
    }
    return pickRating({
      x,
      y,
      pointerType,
      camera: this.cam,
      peaks: this.peaks,
      aggregates: this.aggregates,
      matchIds: this.matchIds,
      aggregateAlpha: this.aggregateAlpha,
      exactAlpha: this.exactAlpha,
      morph: this.transition.progress,
      settled: !this.transition.morphing,
    }, this.lastPickDiagnostic);
  }

  focusMatch(id: string, durationS = 0.55): boolean {
    const index = this.matchIndex.get(id);
    if (index === undefined || !this.peaks) return false;
    const p = this.peaks.currentTip(index, this.transition.progress);
    if (!p) return false;
    this.cam.focus(p[0], p[1] * 0.52, p[2], 24, this.reducedMotion ? 0 : durationS);
    return true;
  }

  focusSelection(): boolean {
    return this.selectedMatchId ? this.focusMatch(this.selectedMatchId) : false;
  }

  fit(durationS = 0.72): void {
    if (!this.currentLayout) return;
    const flight = this.reducedMotion ? 0 : durationS;
    if (this.currentLayout.mode === "promotions") this.cam.chronology(this.currentLayout.bounds, flight);
    else this.cam.overview(this.currentLayout.bounds, flight);
  }

  fitVisible(): void {
    this.fit();
  }

  overview(): void {
    this.fit();
  }

  analystView(): void {
    if (this.currentLayout) this.cam.analyst(this.currentLayout.bounds, this.reducedMotion ? 0 : 0.65);
  }

  igniteMatch(id: string, kind: RatingPulseKind = "ordinary"): boolean {
    const index = this.matchIndex.get(id);
    if (index === undefined || !this.peaks || this.reducedMotion) return false;
    const p = this.peaks.currentTip(index, this.transition.progress);
    if (!p) return false;
    this.pulses.emit(p, kind);
    return true;
  }

  currentPositionOfMatch(id: string): [number, number, number] | null {
    const index = this.matchIndex.get(id);
    return index === undefined || !this.peaks ? null : this.peaks.currentTip(index, this.transition.progress);
  }

  get morphing(): boolean {
    return this.transition.morphing;
  }

  get morphProgress(): number {
    return this.transition.progress;
  }

  get camera() {
    return this.cam.snapshot();
  }

  get cameraSnapshot() {
    return this.cam.snapshot();
  }

  get rendererInfo(): RatingRendererInfo {
    const info = this.gl.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      context: this.contextLost ? "lost" : "ready",
    };
  }

  screenshot(): string {
    if (!this.contextLost) this.gl.render(this.scene, this.cam.camera);
    return this.canvas.toDataURL("image/png");
  }

  setActive(value: boolean): void {
    this.active = value;
    if (!value) {
      this.hover.clear("lens");
      this.stop();
    } else this.start();
  }

  start(): void {
    if (!this.active || this.running || this.disposed) return;
    this.running = true;
    this.clock.getDelta();
    this.lastFrameAt = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now);
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
    const dpr = Math.min(window.devicePixelRatio || 1, RATING_TIERS[this.qualityTier].pixelRatioCap);
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(w, h, false);
    this.cam.setViewport(w, h);
    this.guides.setResolution(w, h);
    this.aggregates.setResolution(w, h);
    this.outgoingGuides.setResolution(w, h);
    this.outgoingAggregates.setResolution(w, h);
    this.peaks?.setPixelRatio(dpr);
    this.pulses.setPixelRatio(dpr);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);
    this.longTaskObserver?.disconnect();
    this.hover.dispose();
    this.labels.clear();
    this.cam.dispose();
    this.peaks?.dispose();
    this.aggregates.dispose();
    this.coverage.dispose();
    this.guides.dispose();
    this.outgoingAggregates.dispose();
    this.outgoingCoverage.dispose();
    this.outgoingGuides.dispose();
    this.pulses.dispose();
    this.gl.dispose();
  }

  private frame(now: number): void {
    const cpuStart = performance.now();
    const dt = Math.min(0.1, this.clock.getDelta());
    const interval = Math.max(1, now - this.lastFrameAt);
    this.lastFrameAt = now;
    this.cam.update(dt);
    const morph = this.transition.tick(now);
    this.peaks?.setMorph(morph);
    this.updateLod();
    this.peaks?.setLodAlpha(this.exactAlpha, this.tipAlpha);
    const settle = this.reducedMotion ? 1 : Math.max(0, Math.min(1, (morph - 0.18) / 0.72));
    this.coverage.setOpacity(settle);
    this.aggregates.setOpacity(this.aggregateAlpha * settle);
    this.guides.setOpacity(settle);
    if (this.outgoingAggregates.mesh.visible) {
      const leave = Math.max(0, Math.min(1, 1 - morph / 0.58));
      this.outgoingCoverage.setOpacity(leave);
      this.outgoingAggregates.setOpacity(this.aggregateAlpha * leave);
      this.outgoingGuides.setOpacity(leave);
      if (!this.transition.morphing) this.setOutgoingVisible(false);
    }
    this.pulses.tick(now);

    if (this.pendingHover) {
      const p = this.pendingHover;
      this.pendingHover = null;
      const hit = this.pick(p.x, p.y, p.pointerType);
      this.hover.proposeCanvas(hit?.id ?? null, p.x, p.y);
    }

    if (this.currentLayout) {
      let opacity: number;
      if (this.pendingLabels && morph < 0.5) opacity = Math.max(0, 1 - morph / 0.48);
      else {
        if (this.pendingLabels) {
          this.labels.setLabels(this.pendingLabels);
          this.pendingLabels = null;
        }
        opacity = this.reducedMotion ? 1 : Math.max(0, Math.min(1, (morph - 0.5) / 0.36));
      }
      const report = this.labels.render(
        this.cam,
        RATING_TIERS[this.qualityTier].labelCap,
        this.canvas.clientWidth || 2,
        this.canvas.clientHeight || 2,
        opacity,
        (label) => {
          if (label.pick && this.matchIndex.has(label.pick)) return this.currentPositionOfMatch(label.pick);
          return [label.x, label.y, label.z];
        },
      );
      if (report.shown !== this.labelReport.shown || report.wanted !== this.labelReport.wanted) {
        this.labelReport = report;
        this.shownLabels = report.shown;
        this.wantedLabels = report.wanted;
        this.onLabelReport?.(report);
      }
    }
    this.updateHoverAnchor();
    if (!this.contextLost) this.gl.render(this.scene, this.cam.camera);

    const cpu = performance.now() - cpuStart;
    this.intervalEma = this.intervalEma * 0.95 + interval * 0.05;
    this.cpuEma = this.cpuEma * 0.94 + cpu * 0.06;
    this.frameIntervalMs = this.intervalEma;
    this.frameTimeMs = this.intervalEma;
    this.rendererCpuMs = this.cpuEma;
    this.governQuality();
  }

  private updateLod(): void {
    const distance = this.cam.distance;
    // 620..1180 is a genuine crossfade band: exact tips and bins coexist, so
    // dollying never swaps one semantic representation in a single frame.
    const near = 1 - THREE.MathUtils.smoothstep(distance, 620, 1180);
    this.exactAlpha = 0.08 + near * 0.92;
    this.tipAlpha = 0.18 + (1 - Math.abs(near - 0.45) * 1.6) * 0.48;
    this.tipAlpha = Math.max(0.12, Math.min(0.72, this.tipAlpha));
    this.aggregateAlpha = 0.14 + (1 - near) * 0.86;
  }

  private applyTimeDay(): void {
    const layout = this.currentLayout;
    if (!layout || this.currentTimeDay === null) {
      this.guides.setTimeX(null, this.reducedMotion);
      return;
    }
    const [d0, d1] = layout.dayRange;
    const t = Math.max(0, Math.min(1, (this.currentTimeDay - d0) / Math.max(1, d1 - d0)));
    this.guides.setTimeX(layout.bounds.minX + t * (layout.bounds.maxX - layout.bounds.minX), this.reducedMotion);
  }

  private setOutgoingVisible(visible: boolean): void {
    this.outgoingAggregates.mesh.visible = visible;
    this.outgoingAggregates.medianTrace.visible = visible && this.trendVisible && this.outgoingAggregates.bins.length > 0;
    this.outgoingCoverage.mesh.visible = visible;
    this.outgoingGuides.group.visible = visible;
  }

  private updateHoverAnchor(): void {
    const hit = this.lastHoverHit;
    if (!hit) {
      this.onHoverAnchor?.(0, 0, false);
      return;
    }
    let p: readonly [number, number, number] | null = null;
    if (hit.kind === "match") p = this.currentPositionOfMatch(hit.id);
    else if (hit.kind === "aggregate") {
      const bin = this.aggregates.bins[hit.instanceId];
      if (bin) p = [bin.x, Math.max(bin.maxHeight, bin.medianHeight), bin.z];
    } else if (this.currentLayout) {
      const lane = this.currentLayout.lanes.find((item) => `promotion:${item.id}` === hit.id);
      if (lane) p = [this.currentLayout.bounds.minX, 3, lane.z];
    }
    if (!p) {
      this.onHoverAnchor?.(0, 0, false);
      return;
    }
    const screen = this.cam.worldToScreen(p[0], p[1], p[2]);
    this.onHoverAnchor?.(screen.x, screen.y, screen.front);
  }

  private resolveIdentity(id: string): RatingPickResult | null {
    const match = this.matchIndex.get(id);
    if (match !== undefined) return { id, kind: "match", instanceId: match, depth: 0, normalizedDistance: 0 };
    const bin = this.aggregateIndex.get(id);
    if (bin !== undefined) return { id, kind: "aggregate", instanceId: bin, depth: 0, normalizedDistance: 0 };
    if (id.startsWith("promotion:")) return { id, kind: "promotion", instanceId: -1, depth: 0, normalizedDistance: 0 };
    return null;
  }

  private identityExists(id: string): boolean {
    return this.matchIndex.has(id) || this.aggregateIndex.has(id) || id.startsWith("promotion:");
  }

  private applyEmphasis(): void {
    this.peaks?.setEmphasis(this.selectedIndex, this.hoveredIndex, this.currentIndex);
  }

  private governQuality(): void {
    if (this.qualityOverride !== "auto") return;
    if (this.intervalEma > 30) {
      this.fastFrames = 0;
      this.slowDurationMs += this.intervalEma;
      const downgradeAfter = this.intervalEma > 50 ? 24 : 60;
      if (++this.slowFrames >= downgradeAfter || this.slowDurationMs >= 600) {
        this.slowFrames = 0;
        this.slowDurationMs = 0;
        this.stepTier(-1);
      }
    } else if (this.intervalEma < 17) {
      this.slowFrames = 0;
      this.slowDurationMs = 0;
      if (++this.fastFrames >= 600) {
        this.fastFrames = 0;
        this.stepTier(1);
      }
    } else {
      this.slowFrames = 0;
      this.slowDurationMs = 0;
      this.fastFrames = 0;
    }
  }

  private stepTier(dir: 1 | -1): void {
    const order: RatingTier[] = ["low", "medium", "high"];
    const next = order.indexOf(this.qualityTier) + dir;
    if (next < 0 || next >= order.length) return;
    this.changeTier(order[next]!);
  }

  private changeTier(tier: RatingTier): void {
    this.qualityTier = tier;
    this.peaks?.setQualityTier(tier);
    this.resize();
    this.onTierChange?.(tier);
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.pendingHover = null;
    this.hover.clear("context");
    this.onContextState?.("lost");
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    if (this.currentLayout) this.setLayout(this.currentLayout, true);
    this.onContextState?.("restored");
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.hover.clear("blur");
      this.stop();
    } else if (this.active) this.start();
  };

  private onBlur = (): void => this.hover.clear("blur");
}

function ratingScaleOf(layout: RatingLayout): number {
  return layout.ratingScale;
}
