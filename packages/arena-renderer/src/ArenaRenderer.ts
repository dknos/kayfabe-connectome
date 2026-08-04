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
import { ArenaTransition, SlotPool } from "./ArenaTransition";
import { eraSections, layoutArena, layoutEcho, layoutIndex, personSections } from "./ArenaLayouts";
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

  selectedId: string | null = null;
  hoverId: string | null = null;
  reducedMotion = false;
  tier: ArenaQualityTier = "high";

  constructor(readonly canvas: HTMLCanvasElement, labelLayer: HTMLElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.cards = new ArenaCards(CAPACITY);
    this.scene.add(this.cards.mesh);
    this.labels = new ArenaLabels(labelLayer, 96, CAPACITY);
    // Fat routes cost one draw call each, so the pool is sized to the highest
    // tier's budget rather than to the card capacity.
    this.routes = new ArenaRoutes(this.scene, ARENA_TIERS.high.routes);
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
  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  applyTier(tier: ArenaQualityTier): void {
    this.tier = tier;
    const budget = ARENA_TIERS[tier];
    this.renderer.setPixelRatio(Math.min(budget.pixelRatioCap, window.devicePixelRatio));
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
    this.active = scope.cards.slice(0, ARENA_TIERS[this.tier].cards);
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
    // Routes resolve AFTER the cards settle, per the brief's ordering: they are
    // evidence about a formation, not part of its assembly.
    this.routes.setReveal(immediate ? 1 : 0);
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
    this.camera.position.copy(this.camCur);
    this.camera.lookAt(this.lookCur);
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
      const raw = this.transition.progressRaw;
      if (this.routes.count > 0) {
        this.routes.follow(this.transition, this.pool, this.scope?.anchorId ?? "");
        const revealFrom = 0.55;
        this.routes.setReveal(raw <= revealFrom ? 0 : Math.min(1, (raw - revealFrom) / (1 - revealFrom)));
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
      this.renderer.render(this.scene, this.camera);
      const cpu = performance.now() - t0;
      this.frameCpuEmaMs = this.frameCpuEmaMs === 0 ? cpu : this.frameCpuEmaMs * 0.9 + cpu * 0.1;
    };
    this.raf = requestAnimationFrame(tick);
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
    this.labels.dispose();
    this.renderer.dispose();
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
