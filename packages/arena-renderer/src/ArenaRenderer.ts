/**
 * The Arena Array renderer.
 *
 * Owns the scene, the card field, the label field, picking and the camera. No
 * React inside, matching every other renderer package in this repository.
 *
 * The camera travels on the SAME clock as the cards, which is not a stylistic
 * choice: SPIKE 1 measured that with perfectly interpolated cards and an
 * instant camera cut, a tracked card jumps 0.786 NDC in one frame against a
 * 0.0003 ordinary step. Snapping the camera is itself a teleport and it breaks
 * the one thing the Arena-to-Index transformation owes the reader, which is
 * that a named card can be followed across it.
 */
import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { ArenaCards } from "./ArenaCards";
import { ArenaLabels, type ArenaLabelInput } from "./ArenaLabels";
import { ArenaPicking } from "./ArenaPicking";
import { ArenaRoutes } from "./ArenaRoutes";
import { ArenaBloom } from "./ArenaBloom";
import { ArenaPulses } from "./ArenaPulses";
import { ArenaRail } from "./ArenaRail";
import { ArenaControls } from "./ArenaControls";
import { ArenaTransition, SlotPool } from "./ArenaTransition";
import { eraSections, layoutArena, layoutEcho, layoutIndex, personSections } from "./ArenaLayouts";
import { railSegmentsFromYears } from "./ArenaRail";
import {
  AB, AE, ARENA_TIERS, CS, easeQuintic, prominence,
  type ArenaCard, type ArenaFormation, type ArenaLayoutResult,
  type ArenaPickResult, type ArenaQualityTier,
} from "./types";

const CAPACITY = 640;

const CAM: Record<ArenaFormation, readonly [number, number, number]> = {
  echo: [0, 0, 22],
  arena: [0, 7.5, 21],
  index: [0, -8, 26],
};
const LOOK: Record<ArenaFormation, readonly [number, number, number]> = {
  echo: [0, 0.5, 0],
  arena: [0, 0.5, 0],
  index: [0, -8, 0],
};

export interface ArenaScope {
  kind: "person" | "promotion";
  anchorId: string;
  anchorName: string;
  cards: ArenaCard[];
  /** Aggregate card id -> the cards it stands for. Present only when the
   *  population was capped, which the corpus forces for large promotions. */
  represented?: Map<string, ArenaCard[]>;
  /** Documented title activity per year, for the championship rail. Absent
   *  when the corpus documents none — in which case no rail is drawn at all,
   *  rather than an empty one implying we looked and found nothing. */
  titleYears?: { from: number; counts: number[] };
}

export class ArenaRenderer {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(46, 1, 0.1, 400);
  readonly transition = new ArenaTransition(CAPACITY);
  readonly pool = new SlotPool(CAPACITY);
  readonly cards: ArenaCards;
  readonly labels: ArenaLabels;
  readonly picking = new ArenaPicking();
  readonly routes: ArenaRoutes;
  readonly bloom: ArenaBloom;
  readonly pulses: ArenaPulses;
  readonly rail: ArenaRail;
  readonly controls: ArenaControls;

  private readonly renderer: WebGLRenderer;
  private readonly camFrom = new Vector3();
  private readonly camTo = new Vector3();
  private readonly lookFrom = new Vector3();
  private readonly lookTo = new Vector3();
  private readonly camCur = new Vector3();
  private readonly lookCur = new Vector3();

  private scope: ArenaScope | null = null;
  private active: ArenaCard[] = [];
  private byId = new Map<string, ArenaCard>();
  private formationName: ArenaFormation = "arena";
  private lastLayout: ArenaLayoutResult | null = null;
  private raf = 0;
  private disposed = false;
  private lastLabelMs = 0;
  private labelCadenceHz = 30;
  private frameCpuEmaMs = 0;
  private frameWallEmaMs = 0;
  private lastFrameMs = 0;

  /** Set false to pin the tier and stop the governor stepping it down. */
  autoQuality = true;
  private slowFrames = 0;
  private governedDownTo: ArenaQualityTier | null = null;

  selectedId: string | null = null;
  hoverId: string | null = null;
  reducedMotion = false;
  tier: ArenaQualityTier = "high";

  constructor(readonly canvas: HTMLCanvasElement, labelLayer: HTMLElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.cards = new ArenaCards(CAPACITY);
    this.scene.add(this.cards.mesh);
    this.labels = new ArenaLabels(labelLayer, 192, CAPACITY);
    // Fat routes cost one draw call each, so the pool is sized to the highest
    // tier's budget rather than to the card capacity.
    this.routes = new ArenaRoutes(this.scene, ARENA_TIERS.high.routes);
    this.bloom = new ArenaBloom(this.renderer, this.scene, this.camera);
    this.pulses = new ArenaPulses(this.scene, ARENA_TIERS.high.pulses);
    this.rail = new ArenaRail(this.scene, 96);
    this.controls = new ArenaControls(this.camera, canvas);
    this.applyTier(this.tier);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.resize();
  }

  /** Context loss is recoverable: three re-uploads its own GPU resources, but
   *  the formation must be re-committed because our authoritative transforms
   *  live in typed arrays on our side. */
  private onContextLost = (event: Event): void => {
    event.preventDefault();
  };
  private onContextRestored = (): void => {
    this.resize();
    if (this.scope) this.setFormation(this.formationName, true);
  };

  get contextLost(): boolean {
    return this.renderer.getContext().isContextLost();
  }
  get formation(): ArenaFormation {
    return this.formationName;
  }
  get animating(): boolean {
    return this.transition.animating;
  }
  get layout(): ArenaLayoutResult | null {
    return this.lastLayout;
  }
  get frameTimeMs(): number {
    return this.frameCpuEmaMs;
  }
  /** Wall-clock frame time — what the reader actually experiences. */
  get frameWallMs(): number {
    return this.frameWallEmaMs;
  }
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  applyTier(tier: ArenaQualityTier): void {
    this.tier = tier;
    const budget = ARENA_TIERS[tier];
    this.renderer.setPixelRatio(Math.min(budget.pixelRatioCap, window.devicePixelRatio));
    // Effects degrade individually: bloom is its own lever, and the low tier
    // switches it off while the scene stays coherent without it.
    this.bloom.enabled = budget.bloom;
    this.pulses.setCount(budget.pulses);
    this.resize();
    if (this.scope) this.setScope(this.scope);
  }

  setScope(scope: ArenaScope): void {
    for (const card of this.active) this.pool.release(card.id);
    if (this.scope) this.pool.release(this.scope.anchorId);
    this.transition.state.fill(CS.ABSENT);
    this.transition.present.fill(0);
    this.scope = scope;
    this.selectedId ??= scope.anchorId;
    // The card budget is a quality tier, and the corpus forces it to bite:
    // pr:c8 alone is 1,087 people against 600 slots.
    //
    // Summary cards are exempt from the cut. They are what keeps the count
    // honest, and they sort last, so a naive slice removes exactly the cards
    // that say how much is missing — which is how the drill-down affordance
    // existed in the data and never once reached the screen.
    const budget = ARENA_TIERS[this.tier].cards;
    const summaries = scope.cards.filter((c) => c.represents !== undefined);
    const people = scope.cards.filter((c) => c.represents === undefined);
    this.active = people.slice(0, Math.max(0, budget - summaries.length)).concat(summaries);
    this.byId = new Map(this.active.map((c) => [c.id, c]));
    this.setFormation(this.formationName, true);
  }

  setFormation(name: ArenaFormation, immediate = false): void {
    if (!this.scope) return;
    this.formationName = name;
    this.transition.captureCurrent();
    const anchorId = this.scope.anchorId;
    this.lastLayout =
      name === "echo" ? layoutEcho(this.transition, this.pool, this.active, anchorId)
      : name === "arena" ? layoutArena(
          this.transition, this.pool, this.active, anchorId,
          this.scope.kind === "promotion" ? eraSections(this.active) : personSections(),
        )
      : layoutIndex(
          this.transition, this.pool, this.active, anchorId,
          (c) => (this.scope!.kind === "promotion" ? c.era : bankLabel(c.bank)),
        );
    this.frameCamera(name, immediate);
    this.transition.reducedMotion = this.reducedMotion;
    this.transition.commit(performance.now(), immediate);
    this.writeSemantics();
    this.updateCamera();
    this.routes.build(
      this.transition, this.pool, this.active, anchorId, ARENA_TIERS[this.tier].routes,
    );
    this.buildRail();
    // Routes resolve AFTER the cards settle, per the brief's ordering: they are
    // evidence about a formation, not part of its assembly.
    this.routes.setReveal(immediate ? 1 : 0);
  }

  /** The rail belongs to the Arena reading; the Index wall is an archive and
   *  the Echo is a source topology, so neither carries one. */
  private buildRail(): void {
    const years = this.scope?.titleYears;
    if (!years || this.formationName !== "arena" || years.counts.length === 0) {
      this.rail.build([], 0, 0, 0, 0, 0);
      return;
    }
    const segments = railSegmentsFromYears(years.from, years.counts);
    const extent = this.lastLayout?.extent ?? 12;
    this.rail.build(
      segments, years.from, years.from + years.counts.length,
      extent * 0.86, extent * 0.52, -1.6,
    );
  }

  private frameCamera(name: ArenaFormation, immediate: boolean): void {
    // Frame from the layout's own extent. A subject with 142 opponents and 31
    // partners builds a far wider arena than the reverse, and a fixed camera
    // distance lets the wide bank run straight off the viewport — which the
    // brief forbids at both 1920x1080 and 1366x768.
    const extent = this.lastLayout?.extent ?? 10;
    // The arena is wide and shallow, so the HORIZONTAL field of view is the
    // binding constraint. Using the vertical one pulls the camera back roughly
    // twice as far as needed and leaves the arena occupying a third of the
    // frame — technically "all visible", practically unreadable.
    const aspect = Math.max(0.6, this.camera.aspect);
    const halfFovY = (this.camera.fov * Math.PI) / 360;
    const halfWidthPerUnit = Math.tan(halfFovY) * Math.min(aspect, 2);
    const needed = extent / Math.max(1e-3, halfWidthPerUnit);
    const base = CAM[name];
    const fit = Math.max(1, (needed * 1.26) / Math.hypot(base[0], base[1], base[2]));
    if (immediate) {
      this.camCur.set(base[0] * fit, base[1] * fit, base[2] * fit);
      this.lookCur.set(...LOOK[name]);
    }
    this.camFrom.copy(this.camCur);
    this.lookFrom.copy(this.lookCur);
    this.camTo.set(base[0] * fit, base[1] * fit, base[2] * fit);
    this.lookTo.set(...LOOK[name]);
  }

  private updateCamera(): void {
    const e = easeQuintic(this.transition.progressRaw);
    this.camCur.lerpVectors(this.camFrom, this.camTo, e);
    this.lookCur.lerpVectors(this.lookFrom, this.lookTo, e);
    // The formation proposes a pose; the controls own the camera. Once the
    // reader has taken hold of it the formation may move only what the camera
    // looks AT — re-proposing a pose every frame is what made the wheel and the
    // orbit drag appear to do nothing at all.
    const extent = this.lastLayout?.extent ?? 12;
    if (this.controls.engaged) this.controls.retarget(this.lookCur, extent);
    else this.controls.frame(this.camCur, this.lookCur, extent);
    this.controls.update();
  }

  private writeSemantics(): void {
    this.cards.clearSemantics();
    let maxStrength = 0;
    for (const c of this.active) if (c.strength > maxStrength) maxStrength = c.strength;
    for (const card of this.active) {
      const slot = this.pool.slotOf(card.id);
      if (slot === undefined) continue;
      const emphasis = card.id === this.selectedId ? 1
        : card.id === this.hoverId ? 0.8
        : 0.25;
      this.cards.setSemantics(
        slot,
        card.id === this.scope?.anchorId ? AB.CENTER : card.bank,
        emphasis,
        maxStrength > 0 ? prominence(card.strength, maxStrength) - 0.82 : 0,
      );
      this.cards.setBillboard(slot, this.formationName === "echo" && card.id !== this.scope?.anchorId);
    }
    this.cards.commitSemantics();
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    this.writeSemantics();
  }
  setHover(id: string | null): void {
    if (this.hoverId === id) return;
    this.hoverId = id;
    // Hover must never trigger a layout rebuild; only emphasis changes.
    this.writeSemantics();
  }

  pick(px: number, py: number): ArenaPickResult | null {
    return this.picking.pick(
      this.cards, this.transition, this.camera, px, py,
      this.canvas.clientWidth, this.canvas.clientHeight,
      (slot) => this.pool.idOf(slot),
    );
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // CSS pixels, deliberately not multiplied by devicePixelRatio.
    this.routes.setResolution(w, h);
    this.rail.setResolution(w, h);
    this.bloom.setSize(w, h);
  }

  start(): void {
    if (this.raf) return;
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(tick);
      const t0 = performance.now();
      this.transition.tick(now);
      this.cards.sync(this.transition);
      this.updateCamera();
      // Routes stay attached to their cards while the formation travels, then
      // draw in over the tail of the transition.
      const dt = this.lastFrameMs > 0 ? Math.min(0.05, (now - this.lastFrameMs) / 1000) : 0;
      // Packets ride the routes only once those routes are actually drawn;
      // a pulse on an unrevealed route is a claim about nothing.
      if (this.routes.count > 0 && this.transition.progressRaw >= 1) {
        this.pulses.update(dt, this.routes);
      } else {
        this.pulses.mesh.count = 0;
      }
      const raw = this.transition.progressRaw;
      if (this.routes.count > 0) {
        this.routes.follow(this.transition, this.pool, this.scope?.anchorId ?? "");
        const revealFrom = 0.55;
        const progress = raw <= revealFrom ? 0 : Math.min(1, (raw - revealFrom) / (1 - revealFrom));
        this.routes.setReveal(progress);
        this.rail.setReveal(progress);
      }
      const interval = 1000 / this.labelCadenceHz;
      if (now - this.lastLabelMs >= interval) {
        this.lastLabelMs = now;
        this.labels.update(
          this.transition, this.camera,
          this.canvas.clientWidth, this.canvas.clientHeight,
          ARENA_TIERS[this.tier].labels,
          (slot) => this.pool.idOf(slot),
          (id) => this.labelInput(id),
        );
      }
      this.syncHalo();
      this.bloom.render();
      const cpu = performance.now() - t0;
      this.frameCpuEmaMs = this.frameCpuEmaMs === 0 ? cpu : this.frameCpuEmaMs * 0.9 + cpu * 0.1;
      // The governor judges WALL-CLOCK frames, not CPU submission. Submission
      // reads 1.1 ms while the same frame takes 89 ms on a fill-bound
      // rasteriser, so governing on CPU time would never fire on exactly the
      // devices that need it.
      const wall = this.lastFrameMs > 0 ? now - this.lastFrameMs : 0;
      this.lastFrameMs = now;
      this.frameWallEmaMs = this.frameWallEmaMs === 0 ? wall : this.frameWallEmaMs * 0.9 + wall * 0.1;
      if (wall > 0) this.governQuality(wall);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** The selection halo tracks the selected card's live transform, so it
   *  travels with it through a formation change instead of snapping at the end. */
  private syncHalo(): void {
    const id = this.selectedId;
    const slot = id ? this.pool.slotOf(id) : undefined;
    if (slot === undefined || this.transition.state[slot] === CS.ABSENT) {
      this.bloom.hideHalo();
      return;
    }
    const i3 = slot * 3;
    this.bloom.showHaloAt(
      this.transition.posCur[i3]!,
      this.transition.posCur[i3 + 1]!,
      this.transition.posCur[i3 + 2]! + 0.02,
      Math.max(this.transition.scaleCur[i3]!, this.transition.scaleCur[i3 + 1]!) * 1.25,
    );
  }

  /**
   * Step the tier down when the renderer cannot hold the frame.
   *
   * Postprocessing is not affordable everywhere: measured on a software
   * rasteriser, the bloom chain costs ~77 ms a frame at 1920x1080 against
   * ~18 ms without it, because every full-screen pass is fill-bound. A tier
   * ladder that only a human can operate is not a budget, so the renderer
   * measures its own frame and drops a rung after sustained misses. It never
   * climbs back on its own — oscillating between tiers would be worse than
   * either of them.
   */
  private governQuality(frameMs: number): void {
    if (!this.autoQuality || this.tier === "low") return;
    // Only judge settled frames: a transition legitimately costs more.
    if (this.transition.animating) return;
    // Graduated: a device merely missing 30 fps gets the benefit of the doubt
    // for a while, but one rendering at 8 fps should not be made to endure six
    // seconds of it before anything happens.
    if (frameMs > 100) this.slowFrames += 5;
    else if (frameMs > 34) this.slowFrames++;
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    if (this.slowFrames < 45) return;
    this.slowFrames = 0;
    this.lastFrameMs = 0;
    this.frameWallEmaMs = 0;
    const next: ArenaQualityTier = this.tier === "high" ? "medium" : "low";
    this.governedDownTo = next;
    this.applyTier(next);
    this.onTierChanged?.(next);
  }

  /** Notified when the governor changes the tier, so a UI showing the tier
   *  does not keep claiming one the renderer has already abandoned. */
  onTierChanged: ((tier: ArenaQualityTier) => void) | null = null;

  /** The tier the governor selected, if it has intervened. */
  get governedTier(): ArenaQualityTier | null {
    return this.governedDownTo;
  }

  private labelInput(id: string): ArenaLabelInput | undefined {
    const card = this.byId.get(id);
    if (!card) return undefined;
    return {
      id,
      name: card.name,
      emphasis: id === this.selectedId ? AE.SELECTED
        : id === this.hoverId ? AE.HOVERED
        : card.strength >= 10 ? AE.MEMBER : AE.AMBIENT,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.scene.remove(this.cards.mesh);
    this.cards.dispose();
    this.routes.dispose();
    this.pulses.dispose();
    this.rail.dispose();
    this.controls.dispose();
    this.bloom.dispose();
    this.labels.dispose();
    this.renderer.dispose();
  }

  /**
   * A screenshot that contains what the reader actually sees.
   *
   * `canvas.toDataURL()` captures the WebGL surface only, and the label layer
   * is a sibling DOM node, so a naive capture silently drops every name — the
   * one thing that makes the picture legible. Labels are composited here at
   * their live positions, and a metadata strip records what the picture is OF,
   * because an unlabelled arena screenshot is not evidence of anything.
   */
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

    // Render immediately before reading. The context is not created with
    // preserveDrawingBuffer, so the buffer is undefined after a swap and a
    // later drawImage yields a blank frame — which is how a capture can come
    // back with perfect labels sitting on nothing at all. Rendering here keeps
    // the read inside the same task instead of paying preserveDrawingBuffer on
    // every frame forever.
    this.syncHalo();
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

    const seated = this.lastLayout?.seated ?? 0;
    const sections = (this.lastLayout?.sections ?? []).map((s) => `${s.label} ${s.count}`).join(" · ");
    const meta = [
      this.scope ? `${this.scope.anchorName} — Arena Array (${this.formationName})` : "Arena Array",
      `${seated} cards · ${this.labels.report.shown}/${this.labels.report.wanted} labels · ${this.routes.count} routes · ${this.tier} tier`,
      sections,
    ].filter(Boolean);
    const cssH = this.canvas.clientHeight;
    ctx.fillStyle = "rgba(4,6,11,0.82)";
    ctx.fillRect(0, cssH - 14 - meta.length * 15, this.canvas.clientWidth, 14 + meta.length * 15);
    ctx.fillStyle = "#9fb4c8";
    meta.forEach((line, i) => ctx.fillText(line, 10, cssH - 8 - (meta.length - i) * 15 + 8));
    ctx.restore();
    return out.toDataURL("image/png");
  }

  /** Renderer resource counters, for the "lens switching releases resources"
   *  acceptance test. */
  resourceInfo(): { geometries: number; textures: number; programs: number } {
    return {
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      programs: this.renderer.info.programs?.length ?? 0,
    };
  }
}

function bankLabel(bank: number): string {
  return bank === AB.OPPOSED ? "Opponents"
    : bank === AB.SAME ? "Tag partners"
    : bank === AB.MIXED ? "Fought and teamed"
    : bank === AB.AGGREGATE ? "Summaries"
    : "Context";
}
