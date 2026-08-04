/**
 * Two observers, one control surface.
 *
 * EXTERIOR is the arena camera model: spherical orbit around a look-at
 * target, with the load-bearing three-way decomposition (formationTarget +
 * userOffset -> targetGoal) that keeps reader travel from being overwritten
 * by the frame's own retargeting, ground-basis WASDQE walk, and clamps whose
 * ceiling respects the framing distance. Wider polar range than the arena —
 * worldlines have no floor to fall under, only a soft pole guard.
 *
 * BRIDGE parks the reader ON the subject's worldline: the camera sits at the
 * observer point the renderer feeds in, yaw/pitch look around it, and the
 * travel keys change TIME rather than space — W/S scrub the playhead, A/D
 * step between exact documented events, Q/E lean off the line. The renderer
 * owns the playhead; the controls only report intent through callbacks.
 *
 * Lens-local shortcuts (B, U, Space, F, R) are also read here so there is
 * exactly one window key listener to guard against typing.
 */
import { Euler, Spherical, Vector3, type PerspectiveCamera } from "three";

const MIN_POLAR = 0.06;
const MAX_POLAR = Math.PI - 0.06;
const DAMPING = 0.12;
const WALK_SPEED = 0.55;
const WALK_BOOST = 2.1;
/** playhead scrub in years-per-second while W/S is held in Bridge mode */
const TIME_SPEED_YPS = 2.2;
const TIME_BOOST = 5;

const WALK_KEYS: Record<string, [number, number, number]> = {
  w: [0, 0, 1],
  s: [0, 0, -1],
  a: [-1, 0, 0],
  d: [1, 0, 0],
  e: [0, 1, 0],
  q: [0, -1, 0],
};

export interface SpacetimeControlCallbacks {
  onToggleMode?: () => void;
  onUnwarp?: (held: boolean) => void;
  onPlayPause?: () => void;
  onFocus?: () => void;
  onReset?: () => void;
  /** Bridge W/S: signed days to move the playhead */
  onTimeTravel?: (deltaDays: number) => void;
  /** Bridge A/D: previous/next exact documented event */
  onStepEvent?: (direction: -1 | 1) => void;
}

export class SpacetimeControls {
  readonly target = new Vector3();
  private readonly targetGoal = new Vector3();
  private readonly spherical = new Spherical(60, 1.35, 0.35);
  private readonly sphericalGoal = new Spherical(60, 1.35, 0.35);
  private readonly offset = new Vector3();
  private readonly panScratch = new Vector3();
  private readonly formationTarget = new Vector3();
  private readonly userOffset = new Vector3();
  private readonly walkScratch = new Vector3();
  private readonly walkFwd = new Vector3();
  private readonly walkRight = new Vector3();

  /** Bridge state: the observer point the renderer feeds each frame, and the
   *  reader's look around it. */
  private readonly observer = new Vector3();
  private readonly lean = new Vector3();
  private yaw = 0;
  private pitch = 0;
  private readonly lookEuler = new Euler(0, 0, 0, "YXZ");
  private readonly lookTmp = new Vector3();

  private pointers = new Map<number, { x: number; y: number }>();
  private mode: "none" | "orbit" | "pan" = "none";
  private lastPinch = 0;
  private minDistance = 4;
  private maxDistance = 600;
  private walkReach = 120;
  private fitDistance = 0;
  private held = new Set<string>();
  private boost = false;
  private unwarpHeld = false;

  bridge = false;
  engaged = false;
  enabled = true;
  callbacks: SpacetimeControlCallbacks = {};

  constructor(private readonly camera: PerspectiveCamera, private readonly dom: HTMLElement) {
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("pointercancel", this.onPointerUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    dom.style.touchAction = "none";
  }

  private typing(): boolean {
    const el = document.activeElement as HTMLElement | null;
    const tag = (el?.tagName ?? "").toLowerCase();
    return tag === "input" || tag === "select" || tag === "textarea" || Boolean(el?.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled || this.typing()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Shift") { this.boost = true; return; }
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); this.callbacks.onToggleMode?.(); return; }
    if (k === "u") {
      e.preventDefault();
      if (!this.unwarpHeld) { this.unwarpHeld = true; this.callbacks.onUnwarp?.(true); }
      return;
    }
    if (k === " ") { e.preventDefault(); this.callbacks.onPlayPause?.(); return; }
    if (k === "f") { e.preventDefault(); this.callbacks.onFocus?.(); return; }
    if (k === "r") { e.preventDefault(); this.reset(); this.callbacks.onReset?.(); return; }
    if (this.bridge && (k === "a" || k === "d")) {
      e.preventDefault();
      this.callbacks.onStepEvent?.(k === "a" ? -1 : 1);
      return;
    }
    if (!(k in WALK_KEYS)) return;
    e.preventDefault();
    this.held.add(k);
    if (!this.bridge) this.engaged = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.boost = false;
    const k = e.key.toLowerCase();
    if (k === "u" && this.unwarpHeld) {
      this.unwarpHeld = false;
      this.callbacks.onUnwarp?.(false);
    }
    this.held.delete(k);
  };

  private onBlur = (): void => {
    this.held.clear();
    this.boost = false;
    if (this.unwarpHeld) {
      this.unwarpHeld = false;
      this.callbacks.onUnwarp?.(false);
    }
  };

  get walking(): boolean {
    return this.held.size > 0;
  }

  /* ------------------------------------------------------------- exterior */

  frame(position: Vector3, target: Vector3, extent: number): void {
    this.fitDistance = position.distanceTo(target);
    this.applyBounds(extent);
    this.formationTarget.copy(target);
    if (!this.engaged) this.userOffset.set(0, 0, 0);
    this.composeTarget();
    this.offset.copy(position).sub(target);
    const goal = new Spherical().setFromVector3(this.offset);
    if (!this.engaged) {
      this.sphericalGoal.set(goal.radius, goal.phi, goal.theta);
      this.spherical.set(goal.radius, goal.phi, goal.theta);
      this.target.copy(target);
    }
    this.clampGoal();
  }

  retarget(target: Vector3, extent: number): void {
    this.applyBounds(extent);
    this.formationTarget.copy(target);
    this.composeTarget();
    this.clampGoal();
  }

  private composeTarget(): void {
    this.targetGoal.copy(this.formationTarget).add(this.userOffset);
  }

  private applyBounds(extent: number): void {
    this.minDistance = Math.max(2, Math.min(extent * 0.2, this.fitDistance * 0.9));
    this.maxDistance = Math.max(40, extent * 5, this.fitDistance * 1.7);
    this.walkReach = Math.max(40, extent * 2.5);
  }

  private clampGoal(): void {
    this.sphericalGoal.phi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, this.sphericalGoal.phi));
    this.sphericalGoal.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.sphericalGoal.radius));
  }

  private clampTravel(): void {
    if (this.userOffset.lengthSq() > this.walkReach * this.walkReach) {
      this.userOffset.setLength(this.walkReach);
    }
  }

  private walk(dt: number): void {
    if (this.held.size === 0 || dt <= 0) return;
    if (this.bridge) {
      // W/S is time travel; Q/E leans the observer off the worldline.
      let time = 0, lean = 0;
      for (const k of this.held) {
        if (k === "w") time += 1;
        else if (k === "s") time -= 1;
        else if (k === "e") lean += 1;
        else if (k === "q") lean -= 1;
      }
      if (time !== 0) {
        const speed = TIME_SPEED_YPS * (this.boost ? TIME_BOOST : 1);
        this.callbacks.onTimeTravel?.(time * speed * 365.25 * dt);
      }
      if (lean !== 0) {
        this.lean.y = Math.max(-4, Math.min(4, this.lean.y + lean * 2.2 * dt));
      }
      return;
    }
    let rx = 0, uy = 0, fz = 0;
    for (const k of this.held) {
      const v = WALK_KEYS[k];
      if (!v) continue;
      rx += v[0]; uy += v[1]; fz += v[2];
    }
    if (rx === 0 && uy === 0 && fz === 0) return;
    this.walkFwd.setFromMatrixColumn(this.camera.matrix, 2).negate();
    this.walkFwd.y = 0;
    this.walkRight.setFromMatrixColumn(this.camera.matrix, 0);
    this.walkRight.y = 0;
    if (this.walkFwd.lengthSq() < 1e-6) {
      this.walkFwd.setFromMatrixColumn(this.camera.matrix, 1);
      this.walkFwd.y = 0;
    }
    if (this.walkFwd.lengthSq() < 1e-6 || this.walkRight.lengthSq() < 1e-6) return;
    this.walkFwd.normalize();
    this.walkRight.normalize();
    this.walkScratch
      .set(0, 0, 0)
      .addScaledVector(this.walkRight, rx)
      .addScaledVector(this.walkFwd, fz);
    this.walkScratch.y += uy;
    if (this.walkScratch.lengthSq() < 1e-12) return;
    this.walkScratch.normalize();
    const speed = this.spherical.radius * (this.boost ? WALK_BOOST : WALK_SPEED);
    this.userOffset.addScaledVector(this.walkScratch, speed * dt);
    this.clampTravel();
    this.composeTarget();
  }

  /* --------------------------------------------------------------- bridge */

  /** The renderer feeds the observer point (the worldline at the playhead)
   *  every frame; the reader's yaw/pitch/lean survive on top of it. */
  setObserver(x: number, y: number, z: number): void {
    this.observer.set(x, y, z);
  }

  get observerLean(): Vector3 {
    return this.lean;
  }

  setBridge(on: boolean): void {
    if (this.bridge === on) return;
    this.bridge = on;
    if (on) {
      this.yaw = 0;
      this.pitch = 0;
      this.lean.set(0, 0, 0);
    }
  }

  /* ---------------------------------------------------------------- frame */

  update(dt = 0): void {
    this.walk(dt);
    if (this.bridge) {
      this.camera.position.copy(this.observer).add(this.lean);
      // Look forward along the direction of travel (+X = the future), bent by
      // the reader's yaw (around world Y) and pitch (around the lateral axis).
      this.lookEuler.set(this.pitch, this.yaw, 0, "YXZ");
      this.lookTmp.set(1, 0, 0).applyEuler(this.lookEuler);
      this.camera.lookAt(
        this.camera.position.x + this.lookTmp.x,
        this.camera.position.y + this.lookTmp.y,
        this.camera.position.z + this.lookTmp.z,
      );
      return;
    }
    this.spherical.radius += (this.sphericalGoal.radius - this.spherical.radius) * DAMPING;
    this.spherical.phi += (this.sphericalGoal.phi - this.spherical.phi) * DAMPING;
    this.spherical.theta += (this.sphericalGoal.theta - this.spherical.theta) * DAMPING;
    this.target.lerp(this.targetGoal, DAMPING);
    this.offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);
  }

  get distance(): number {
    return this.spherical.radius;
  }

  /* -------------------------------------------------------------- pointer */

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.dom.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.mode = e.button === 2 || e.shiftKey ? "pan" : "orbit";
    else if (this.pointers.size === 2) { this.mode = "pan"; this.lastPinch = this.pinchDistance(); }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      const pinch = this.pinchDistance();
      if (this.lastPinch > 0) this.dolly(this.lastPinch / Math.max(1e-3, pinch));
      this.lastPinch = pinch;
      return;
    }
    const w = this.dom.clientWidth || 1;
    const h = this.dom.clientHeight || 1;
    if (this.bridge) {
      // Any drag is a look-around; the observer stays on the worldline.
      this.yaw -= (dx / w) * Math.PI * 1.4;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - (dy / h) * Math.PI * 0.9));
      return;
    }
    if (this.mode === "orbit") {
      this.engaged = true;
      this.sphericalGoal.theta -= (dx / w) * Math.PI * 2;
      this.sphericalGoal.phi -= (dy / h) * Math.PI;
      this.clampGoal();
    } else if (this.mode === "pan") {
      this.engaged = true;
      this.pan(dx, dy);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.mode = "none";
    this.lastPinch = 0;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    if (this.bridge) {
      // The wheel nudges time — the bridge has no distance to dolly.
      this.callbacks.onTimeTravel?.(e.deltaY > 0 ? 45 : -45);
      return;
    }
    this.engaged = true;
    this.dolly(e.deltaY > 0 ? 1.09 : 1 / 1.09);
  };

  private dolly(scale: number): void {
    this.sphericalGoal.radius *= scale;
    this.clampGoal();
  }

  private pan(dx: number, dy: number): void {
    const h = this.dom.clientHeight || 1;
    const perPixel = (2 * this.spherical.radius * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    this.panScratch.setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(-dx * perPixel);
    this.userOffset.add(this.panScratch);
    this.panScratch.setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(dy * perPixel);
    this.userOffset.add(this.panScratch);
    this.clampTravel();
    this.composeTarget();
  }

  private pinchDistance(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  }

  reset(): void {
    this.engaged = false;
    this.held.clear();
    this.boost = false;
    this.userOffset.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;
    this.lean.set(0, 0, 0);
    this.composeTarget();
  }

  dispose(): void {
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    this.dom.removeEventListener("pointerup", this.onPointerUp);
    this.dom.removeEventListener("pointercancel", this.onPointerUp);
    this.dom.removeEventListener("wheel", this.onWheel);
    this.dom.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.pointers.clear();
    this.held.clear();
  }
}
