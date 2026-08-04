/**
 * The Spacetime / Warp Field renderer.
 *
 * Owns the scene, the worldline field, the event beads, the bubble, the
 * packets, labels, picking and both observers. No React inside — the same
 * division every other renderer package in this repository uses.
 *
 * Two clocks, deliberately separate:
 *   * the PLAYHEAD is corpus time. It arrives from the shared timeline store
 *     and drives the lens uniforms; moving it costs one uniform write for the
 *     ribbons and one CPU re-place of the beads.
 *   * warp intent (bridge v, unwarp mix) is damped here at the frame rate, so
 *     holding U eases the sky back to its source geometry instead of teleporting.
 *
 * Physics changes apparent geometry only. What anything MEANS — class colors,
 * counts, gold — comes from the corpus and is never overwritten by the warp.
 */
import { PerspectiveCamera, Scene, Vector3, WebGLRenderer, Mesh, PlaneGeometry, MeshBasicMaterial, DoubleSide } from "three";
import { EventField } from "./EventField";
import { GeodesicPackets } from "./GeodesicPackets";
import { SpacetimeBloom } from "./SpacetimeBloom";
import { SpacetimeControls } from "./SpacetimeControls";
import { SpacetimeLabels, type SpacetimeLabelCandidate } from "./SpacetimeLabels";
import { buildLayout, classOf, type SpacetimeLayoutResult, type WorldlinePath } from "./SpacetimeLayout";
import { SpacetimePicking } from "./SpacetimePicking";
import { WarpBubble } from "./WarpBubble";
import { WorldlineField } from "./WorldlineField";
import { warpPosition, type WarpLookup } from "./WarpLookup";
import {
  DAYS_PER_YEAR, SC, SPACETIME_TIERS, TIME_AXIS_DEFAULTS, lutRowOfSpeed,
  timeAxisX, warpSpeedOfPlayback,
  type SpacetimeMode, type SpacetimePickResult, type SpacetimeQualityTier,
  type SpacetimeScope, type TimeAxis,
} from "./types";

const EVENT_CAPACITY = 1600;
const FRAME_MARGIN = 1.12;
/** exterior viewing direction: slightly above and in front of the plane */
const VIEW_DIR = new Vector3(0.10, 0.42, 1).normalize();

export class SpacetimeRenderer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, 0.1, 4000);
  readonly worldlines: WorldlineField;
  readonly events: EventField;
  readonly bubble = new WarpBubble();
  readonly packets: GeodesicPackets;
  readonly labels: SpacetimeLabels;
  readonly picking = new SpacetimePicking();
  readonly bloom: SpacetimeBloom;
  readonly controls: SpacetimeControls;

  private readonly renderer: WebGLRenderer;
  private readonly sectorMeshes: Mesh[] = [];
  private sectorGeom = new PlaneGeometry(1, 1);

  private scopeData: SpacetimeScope | null = null;
  private layout: SpacetimeLayoutResult | null = null;
  private axisState: TimeAxis = {
    day0: 0, playheadDay: 0, ...TIME_AXIS_DEFAULTS,
  };
  private modeState: SpacetimeMode = "exterior";
  private warpV = 0;
  private warpVTarget = 0;
  private warpMix = 0;
  private warpMixTarget = 0;
  private unwarpHeld = false;
  /** what the shared timeline last reported — QA reads it through the seam */
  playing = false;
  private raf = 0;
  private disposed = false;
  private lastLabelMs = 0;
  private readonly labelCadenceHz = 30;
  private frameCpuEmaMs = 0;
  private frameWallEmaMs = 0;
  private lastFrameMs = 0;
  private slowFrames = 0;
  private governedDownTo: SpacetimeQualityTier | null = null;

  hoverRel: number | null = null;
  selectedRel: number | null = null;
  selectedEvent: number | null = null;
  reducedMotion = false;
  autoQuality = true;
  tier: SpacetimeQualityTier = "high";
  onTierChanged: ((tier: SpacetimeQualityTier) => void) | null = null;
  /** lens shell asks for these; the renderer only reports intent */
  onToggleMode: (() => void) | null = null;
  onPlayPause: (() => void) | null = null;
  onTimeTravel: ((deltaDays: number) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement, labelLayer: HTMLElement, readonly lut: WarpLookup) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.worldlines = new WorldlineField(lut);
    this.scene.add(this.worldlines.mesh);
    this.events = new EventField(lut, EVENT_CAPACITY);
    this.scene.add(this.events.mesh);
    this.scene.add(this.events.caustics);
    this.scene.add(this.bubble.mesh);
    this.packets = new GeodesicPackets(SPACETIME_TIERS.high.packets);
    this.scene.add(this.packets.mesh);
    this.labels = new SpacetimeLabels(labelLayer, 192);
    this.bloom = new SpacetimeBloom(this.renderer, this.scene, this.camera);
    this.controls = new SpacetimeControls(this.camera, canvas);
    this.controls.callbacks = {
      onToggleMode: () => this.onToggleMode?.(),
      onUnwarp: (held) => this.setUnwarp(held),
      onPlayPause: () => this.onPlayPause?.(),
      onFocus: () => this.focusSelection(),
      onReset: () => this.frameExterior(true),
      onTimeTravel: (d) => this.onTimeTravel?.(d),
      onStepEvent: (dir) => this.stepEvent(dir),
    };
    this.applyTier(this.tier);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.resize();
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
  };
  private onContextRestored = (): void => {
    this.resize();
    if (this.scopeData) this.setScope(this.scopeData);
  };

  /* ---------------------------------------------------------------- state */

  get contextLost(): boolean {
    return this.renderer.getContext().isContextLost();
  }
  get mode(): SpacetimeMode {
    return this.modeState;
  }
  get axis(): TimeAxis {
    return this.axisState;
  }
  get playhead(): number {
    return this.axisState.playheadDay;
  }
  get warpSpeed(): number {
    return this.warpV;
  }
  get warpMixNow(): number {
    return this.warpMix;
  }
  get frameTimeMs(): number {
    return this.frameCpuEmaMs;
  }
  get frameWallMs(): number {
    return this.frameWallEmaMs;
  }
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }
  get governedTier(): SpacetimeQualityTier | null {
    return this.governedDownTo;
  }
  get currentLayout(): SpacetimeLayoutResult | null {
    return this.layout;
  }
  /** Deliberately public — QA reads scope identity through the seam. */
  get scope(): SpacetimeScope | null {
    return this.scopeData;
  }

  /* ----------------------------------------------------------------- data */

  setScope(scope: SpacetimeScope): void {
    this.scopeData = scope;
    this.selectedRel = null;
    this.hoverRel = null;
    this.selectedEvent = null;
    this.axisState = {
      ...this.axisState,
      day0: scope.dayRange[0],
      playheadDay: Math.min(Math.max(this.axisState.playheadDay || scope.dayRange[1],
        scope.dayRange[0]), scope.dayRange[1]),
    };
    this.rebuild();
    this.frameExterior(true);
  }

  private rebuild(): void {
    if (!this.scopeData) return;
    const budget = SPACETIME_TIERS[this.tier].worldlines;
    this.layout = buildLayout(this.scopeData, budget);
    this.worldlines.build(this.layout.lines);
    this.worldlines.clearEmphasis();
    this.events.setEvents(this.scopeData.events);
    this.syncLensUniforms();
    this.buildSectors();
    this.packets.focus(null, 0, 0, [0.5, 0.8, 1]);
  }

  /** Faint volumetric sectors: documented appearance spans per promotion.
   *  Rebuilt with the scope; x extent follows the lens every frame. */
  private buildSectors(): void {
    for (const m of this.sectorMeshes) {
      m.removeFromParent();
      (m.material as MeshBasicMaterial).dispose();
    }
    this.sectorMeshes.length = 0;
    if (!this.layout) return;
    for (const s of this.layout.sectors) {
      const mat = new MeshBasicMaterial({
        color: 0x1d2b40, transparent: true, opacity: 0.16,
        depthWrite: false, side: DoubleSide,
      });
      const mesh = new Mesh(this.sectorGeom, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = -2;
      mesh.frustumCulled = false;
      mesh.userData.sector = s;
      this.scene.add(mesh);
      this.sectorMeshes.push(mesh);
    }
  }

  private syncSectors(): void {
    for (const mesh of this.sectorMeshes) {
      const s = mesh.userData.sector as { dayFrom: number; dayTo: number; z: number };
      const x0 = timeAxisX(s.dayFrom, this.axisState);
      const x1 = timeAxisX(s.dayTo, this.axisState);
      mesh.position.set((x0 + x1) / 2, -0.4, s.z);
      mesh.scale.set(Math.max(0.5, x1 - x0), 2.0, 1);
    }
  }

  /* ------------------------------------------------------------- timeline */

  /** The shared timeline drives this; the renderer never owns playback. */
  setTimeline(day: number, playing: boolean, speedDaysPerSecond: number): void {
    if (!this.scopeData) return;
    const [d0, d1] = this.scopeData.dayRange;
    this.axisState.playheadDay = Math.min(Math.max(day, d0), d1);
    this.playing = playing;
    this.warpVTarget = playing ? warpSpeedOfPlayback(speedDaysPerSecond) : 0;
    this.syncLensUniforms();
  }

  private syncLensUniforms(): void {
    const u = this.worldlines.uniforms;
    (u.uDay0 as { value: number }).value = this.axisState.day0;
    (u.uPlayhead as { value: number }).value = this.axisState.playheadDay;
    (u.uR as { value: number }).value = this.axisState.bubbleR;
    (u.uSigma as { value: number }).value = this.axisState.bubbleSigma;
    (u.uGain as { value: number }).value = this.axisState.gain;
    (u.uScale as { value: number }).value = this.axisState.scale;
    this.events.setPlayhead(this.axisState.playheadDay);
  }

  /* ----------------------------------------------------------------- mode */

  setMode(mode: SpacetimeMode): void {
    if (this.modeState === mode) return;
    this.modeState = mode;
    this.controls.setBridge(mode === "bridge");
    this.warpMixTarget = mode === "bridge" && !this.unwarpHeld ? 1 : 0;
    if (this.reducedMotion) this.warpMix = this.warpMixTarget;
    if (mode === "exterior") this.frameExterior(true);
  }

  setUnwarp(held: boolean): void {
    this.unwarpHeld = held;
    this.warpMixTarget = this.modeState === "bridge" && !held ? 1 : 0;
    if (this.reducedMotion) this.warpMix = this.warpMixTarget;
  }
  get unwarped(): boolean {
    return this.unwarpHeld;
  }

  private stepEvent(dir: -1 | 1): void {
    if (!this.scopeData) return;
    const p = this.axisState.playheadDay;
    const evs = this.scopeData.events;
    if (dir > 0) {
      const next = evs.find((e) => e.day > p);
      if (next) this.onTimeTravel?.(next.day - p);
    } else {
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i]!.day < p) { this.onTimeTravel?.(evs[i]!.day - p); return; }
      }
    }
  }

  private focusSelection(): void {
    if (this.selectedEvent !== null && this.scopeData) {
      const e = this.scopeData.events[this.selectedEvent];
      if (e) this.onTimeTravel?.(e.day - this.axisState.playheadDay);
    }
  }

  /* ------------------------------------------------------------- emphasis */

  setHover(relIndex: number | null): void {
    if (this.hoverRel === relIndex) return;
    this.hoverRel = relIndex;
    this.writeEmphasis();
  }

  setSelected(relIndex: number | null, eventIndex: number | null = null): void {
    this.selectedRel = relIndex;
    this.selectedEvent = eventIndex;
    this.writeEmphasis();
  }

  private writeEmphasis(): void {
    if (!this.layout || !this.scopeData) return;
    this.worldlines.clearEmphasis();
    this.events.clearEmphasis();
    const lit = this.hoverRel ?? this.selectedRel;
    let focusPath: WorldlinePath | null = null;
    if (lit !== null) {
      for (let li = 0; li < this.layout.lines.length; li++) {
        if (this.layout.lines[li]!.relIndex === lit) {
          this.worldlines.setEmphasis(li, 1);
          focusPath = this.layout.lines[li]!;
          break;
        }
      }
    }
    if (this.selectedEvent !== null) this.events.setEmphasis(this.selectedEvent, 1);
    const rel = lit !== null ? this.scopeData.relationships[lit] : null;
    const budget = SPACETIME_TIERS[this.tier].packets;
    const color: [number, number, number] = rel
      ? classOf(rel) === SC.SAME ? [0.29, 0.84, 1.0]
        : classOf(rel) === SC.OPPOSED ? [1.0, 0.48, 0.30]
        : classOf(rel) === SC.MIXED ? [0.65, 0.55, 0.98] : [0.5, 0.55, 0.65]
      : [0.5, 0.8, 1.0];
    this.packets.focus(
      this.reducedMotion ? null : focusPath,
      rel ? rel.same + rel.opposed + rel.br : 0,
      budget, color,
    );
  }

  /* ------------------------------------------------------------------ pick */

  pick(px: number, py: number): SpacetimePickResult | null {
    if (!this.layout || !this.scopeData) return null;
    return this.picking.pick(
      this.events, this.layout.lines, this.axisState, this.camera,
      px, py, this.canvas.clientWidth, this.canvas.clientHeight,
      (i) => this.scopeData!.events[i]?.matchRef ?? "",
      (rel) => rel === -1 ? this.scopeData!.subjectId
        : this.scopeData!.relationships[rel]?.p ?? "",
    );
  }

  /* ---------------------------------------------------------------- tiers */

  applyTier(tier: SpacetimeQualityTier): void {
    this.tier = tier;
    const budget = SPACETIME_TIERS[tier];
    this.renderer.setPixelRatio(Math.min(budget.pixelRatioCap, window.devicePixelRatio));
    this.bloom.enabled = budget.bloom;
    this.bubble.visible = budget.bubble;
    this.resize();
    if (this.scopeData) {
      this.rebuild();
      this.writeEmphasis();
    }
  }

  private governQuality(frameMs: number): void {
    if (!this.autoQuality || this.tier === "low") return;
    if (frameMs > 100) this.slowFrames += 5;
    else if (frameMs > 34) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames < 45) return;
    this.slowFrames = 0;
    this.lastFrameMs = 0;
    this.frameWallEmaMs = 0;
    const next: SpacetimeQualityTier = this.tier === "high" ? "medium" : "low";
    this.governedDownTo = next;
    this.applyTier(next);
    this.onTierChanged?.(next);
  }

  /* --------------------------------------------------------------- camera */

  private frameExterior(immediate: boolean): void {
    if (!this.scopeData || !this.layout) return;
    const [d0, d1] = this.scopeData.dayRange;
    // The bubble shell can overhang the documented range when the playhead
    // parks at either end; the frame owes it room or the lens looks cropped.
    const x0 = timeAxisX(d0, this.axisState) - this.bubbleHalfWidth() * 0.9;
    const x1 = timeAxisX(d1, this.axisState) + this.bubbleHalfWidth() * 0.9;
    const cx = (x0 + x1) / 2;
    const halfW = (x1 - x0) / 2 + 4;
    const halfH = this.layout.extentY + 2;
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * Math.max(0.4, this.camera.aspect);
    const dist = Math.max(halfW / tanH, halfH / tanV) * FRAME_MARGIN;
    const center = new Vector3(cx, 0, -this.layout.extentZ / 2);
    const pos = center.clone().addScaledVector(VIEW_DIR, dist);
    void immediate;
    this.controls.engaged = false;
    this.controls.frame(pos, center, Math.max(halfW, halfH) * 2);
  }

  /* ----------------------------------------------------------------- loop */

  start(): void {
    if (this.raf) return;
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const t0 = performance.now();
      const dt = this.lastFrameMs > 0 ? Math.min(0.05, (now - this.lastFrameMs) / 1000) : 0;

      // Damp warp intent (snap under reduced motion).
      const ease = this.reducedMotion ? 1 : Math.min(1, dt * 3.2);
      this.warpMix += (this.warpMixTarget - this.warpMix) * ease;
      this.warpV += (this.warpVTarget - this.warpV) * ease;

      const obsX = timeAxisX(this.axisState.playheadDay, this.axisState);
      const u = this.worldlines.uniforms;
      (u.uWarpMix as { value: number }).value = this.warpMix;
      (u.uWarpRow as { value: number }).value = lutRowOfSpeed(this.warpV);
      ((u.uObserver as { value: Vector3 }).value).set(obsX, 0, 0);
      (u.uNearRadius as { value: number }).value = this.bubbleHalfWidth() * 1.2;

      if (this.modeState === "bridge") this.controls.setObserver(obsX, 0.6, 0);
      this.controls.update(dt);
      // The shell is an EXTERIOR reading of the lens. On the bridge the
      // observer is inside it, and a backside fresnel viewed from inside is a
      // full-screen veil of rings over the entire sky.
      this.bubble.visible = SPACETIME_TIERS[this.tier].bubble && this.modeState === "exterior";

      this.events.setWarpMix(this.warpMix);
      this.events.sync(this.axisState, this.camera, {
        v: this.warpV, mix: this.warpMix,
        ox: obsX, oy: 0, oz: 0,
        nearRadius: this.bubbleHalfWidth() * 1.2,
      });
      const halfW = this.bubbleHalfWidth();
      this.bubble.set(obsX, halfW,
        Math.min((this.layout?.extentY ?? 4) * 0.8, halfW * 1.5));
      this.syncSectors();
      if (!this.reducedMotion) this.packets.update(dt, this.axisState, this.camera);
      this.syncHalo();

      const interval = 1000 / this.labelCadenceHz;
      if (now - this.lastLabelMs >= interval) {
        this.lastLabelMs = now;
        this.labels.update(
          this.labelCandidates(), this.camera,
          this.canvas.clientWidth, this.canvas.clientHeight,
          SPACETIME_TIERS[this.tier].labels,
        );
      }

      this.bloom.render();
      const cpu = performance.now() - t0;
      this.frameCpuEmaMs = this.frameCpuEmaMs === 0 ? cpu : this.frameCpuEmaMs * 0.9 + cpu * 0.1;
      const wall = this.lastFrameMs > 0 ? now - this.lastFrameMs : 0;
      this.lastFrameMs = now;
      this.frameWallEmaMs = this.frameWallEmaMs === 0 ? wall : this.frameWallEmaMs * 0.9 + wall * 0.1;
      if (wall > 0) this.governQuality(wall);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** World half-width the lens actually wins on the axis right now. */
  private bubbleHalfWidth(): number {
    const p = this.axisState.playheadDay;
    return timeAxisX(p + this.axisState.bubbleR * DAYS_PER_YEAR, this.axisState)
      - timeAxisX(p, this.axisState);
  }

  private syncHalo(): void {
    if (this.selectedEvent === null || !this.scopeData) {
      this.bloom.hideHalo();
      return;
    }
    const e = this.scopeData.events[this.selectedEvent];
    if (!e) {
      this.bloom.hideHalo();
      return;
    }
    const x = timeAxisX(e.day, this.axisState);
    this.bloom.showHaloAt(x, 0, 0.05, 0.8);
    this.bloom.halo.quaternion.copy(this.camera.quaternion);
  }

  private readonly labelWarpOut = { x: 0, y: 0, z: 0, delta: 1, mag: 1, vis: 1 };

  /** Labels must ride the SAME warp as the geometry they name, or a name
   *  floats where its worldline no longer is. */
  private warpLabel(c: SpacetimeLabelCandidate): SpacetimeLabelCandidate {
    if (this.warpMix <= 0.001) return c;
    const obsX = timeAxisX(this.axisState.playheadDay, this.axisState);
    warpPosition(
      this.lut, c.x, c.y, c.z, obsX, 0, 0,
      this.warpV, this.warpMix, this.bubbleHalfWidth() * 1.2, this.labelWarpOut,
    );
    return this.labelWarpOut.vis < 0.35
      ? { ...c, emphasis: -1 } // behind the horizon: never labelled
      : { ...c, x: this.labelWarpOut.x, y: this.labelWarpOut.y, z: this.labelWarpOut.z };
  }

  private labelCandidates(): SpacetimeLabelCandidate[] {
    const out: SpacetimeLabelCandidate[] = [];
    if (!this.scopeData || !this.layout) return out;
    const axis = this.axisState;
    const p = axis.playheadDay;

    out.push({
      id: this.scopeData.subjectId,
      text: this.scopeData.subjectLabel,
      x: timeAxisX(Math.min(Math.max(p, this.scopeData.dayRange[0]), this.scopeData.dayRange[1]), axis),
      y: 0.6, z: 0, emphasis: 6, kind: "subject",
    });
    // Persona provenance: name the historical ring name where its era sits.
    for (let pi = 1; pi < this.scopeData.personas.length; pi++) {
      const per = this.scopeData.personas[pi]!;
      out.push({
        id: per.id,
        text: `competed as ${per.label}`,
        x: timeAxisX((per.firstDay + per.lastDay) / 2, axis),
        y: -0.9, z: 0, emphasis: 2.2, kind: "persona",
      });
    }
    for (const line of this.layout.lines) {
      if (line.relIndex < 0) continue;
      const rel = this.scopeData.relationships[line.relIndex];
      if (!rel) continue;
      const day = Math.min(Math.max(p, rel.firstDay), rel.lastDay);
      const strength = rel.same + rel.opposed + rel.br;
      out.push({
        id: rel.p,
        text: rel.n,
        x: timeAxisX(day, axis),
        y: line.laneY, z: line.laneZ,
        emphasis: line.relIndex === (this.hoverRel ?? -2) ? 4
          : line.relIndex === (this.selectedRel ?? -2) ? 5
          : Math.min(2, strength / 20),
        kind: "person",
      });
    }
    for (const d of this.layout.decades) {
      out.push({
        id: `era-${d}`,
        text: String(1900 + Math.round(d / 365.25)),
        x: timeAxisX(d, axis),
        y: -(this.layout.extentY + 1.2), z: 0,
        emphasis: 0.6, kind: "era",
      });
    }
    for (const s of this.layout.sectors) {
      out.push({
        id: s.pr,
        text: s.n,
        x: timeAxisX(Math.min(Math.max(p, s.dayFrom), s.dayTo), axis),
        y: -0.4, z: s.z, emphasis: 0.9, kind: "sector",
      });
    }
    if (this.warpMix > 0.001) {
      return out.map((c) => this.warpLabel(c)).filter((c) => c.emphasis >= 0);
    }
    return out;
  }

  /* -------------------------------------------------------------- utility */

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const previous = this.camera.aspect;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.worldlines.setResolution(w, h);
    this.bloom.setSize(w, h);
    if (!this.scopeData || previous === this.camera.aspect) return;
    if (!this.controls.engaged && this.modeState === "exterior") this.frameExterior(true);
  }

  screenshot(): string | null {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return null;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    const dpr = w / Math.max(1, this.canvas.clientWidth);
    this.bloom.render();
    ctx.drawImage(this.canvas, 0, 0);
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.font = this.labels.fontSpec;
    ctx.textBaseline = "top";
    for (const label of this.labels.visibleLabels()) {
      ctx.globalAlpha = label.opacity;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(4,6,11,0.9)";
      ctx.strokeText(label.text, label.x, label.y);
      ctx.fillStyle = "#dbe6f2";
      ctx.fillText(label.text, label.x, label.y);
    }
    ctx.globalAlpha = 1;
    const meta = [
      this.scopeData
        ? `${this.scopeData.subjectLabel} — Kayfabe Spacetime (${this.modeState})`
        : "Kayfabe Spacetime",
      `${this.scopeData?.events.length ?? 0} documented events · `
      + `${this.layout?.drawnWorldlines ?? 0}/${(this.layout?.drawnWorldlines ?? 0) + (this.layout?.hiddenWorldlines ?? 0)} worldlines · `
      + `warp ${this.warpV.toFixed(2)}c · ${this.tier} tier`,
    ];
    const cssH = this.canvas.clientHeight;
    ctx.fillStyle = "rgba(4,6,11,0.82)";
    ctx.fillRect(0, cssH - 14 - meta.length * 15, this.canvas.clientWidth, 14 + meta.length * 15);
    ctx.fillStyle = "#9fb4c8";
    meta.forEach((line, i) => ctx.fillText(line, 10, cssH - 8 - (meta.length - i) * 15 + 8));
    ctx.restore();
    return out.toDataURL("image/png");
  }

  /** QA surface: where an event bead sits in CSS pixels right now (exterior
   *  reasoning — bridge tests read state, not pixels). Null when off-screen. */
  projectEvent(index: number): { x: number; y: number } | null {
    const e = this.scopeData?.events[index];
    if (!e) return null;
    return this.projectPoint(timeAxisX(e.day, this.axisState), 0, 0);
  }

  /** QA surface: a clickable point on a drawn relationship's resting lane. */
  projectRelationship(relIndex: number): { x: number; y: number } | null {
    const rel = this.scopeData?.relationships[relIndex];
    const line = this.layout?.lines.find((l) => l.relIndex === relIndex);
    if (!rel || !line) return null;
    const day = Math.min(Math.max(this.axisState.playheadDay, rel.firstDay), rel.lastDay);
    return this.projectPoint(timeAxisX(day, this.axisState), line.laneY, line.laneZ);
  }

  private readonly projScratch = new Vector3();
  private projectPoint(x: number, y: number, z: number): { x: number; y: number } | null {
    this.projScratch.set(x, y, z).project(this.camera);
    if (this.projScratch.z > 1 || this.projScratch.z < -1) return null;
    return {
      x: (this.projScratch.x * 0.5 + 0.5) * this.canvas.clientWidth,
      y: (-this.projScratch.y * 0.5 + 0.5) * this.canvas.clientHeight,
    };
  }

  resourceInfo(): { geometries: number; textures: number; programs: number } {
    return {
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    for (const m of this.sectorMeshes) {
      m.removeFromParent();
      (m.material as MeshBasicMaterial).dispose();
    }
    this.sectorGeom.dispose();
    this.scene.remove(this.worldlines.mesh, this.events.mesh, this.events.caustics,
      this.bubble.mesh, this.packets.mesh);
    this.worldlines.dispose();
    this.events.dispose();
    this.bubble.dispose();
    this.packets.dispose();
    this.controls.dispose();
    this.bloom.dispose();
    this.labels.dispose();
    this.renderer.dispose();
  }
}
