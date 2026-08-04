/**
 * Camera controls.
 *
 * Orbit, dolly and pan around the arena, with damping, held in spherical
 * coordinates around a target rather than as a free camera — the arena has a
 * centre and a floor, and a free camera lets a reader end up under the seating
 * looking at the backs of cards.
 *
 * The formation still frames the camera, but only until the reader takes hold
 * of it. After that, a formation change re-frames the TARGET and keeps the
 * reader's angle, because moving someone's viewpoint out from under them to
 * show them something else is the fastest way to lose where they were.
 *
 * Not TrackballControls: the brief rules it out, it is not this repository's
 * idiom, and its unconstrained roll is precisely wrong for seating that has an
 * up direction.
 */
import { Spherical, Vector3, type PerspectiveCamera } from "three";

const MIN_POLAR = 0.12;
const MAX_POLAR = Math.PI * 0.495; // never below the floor plane
const DAMPING = 0.12;

/**
 * Keys that walk the arena, as (right, up, forward) in the camera's GROUND
 * basis — forward and right flattened onto the floor plane, up along world Y.
 *
 * Deliberately not the camera's own basis: taking forward straight from the
 * view matrix means W dives into the floor whenever the reader is looking down
 * at the seating, which is most of the time. Q/E on world Y rather than camera
 * up for the same reason — they must rise and fall, not tilt with the orbit.
 */
const WALK_KEYS: Record<string, [number, number, number]> = {
  w: [0, 0, 1],
  s: [0, 0, -1],
  a: [-1, 0, 0],
  d: [1, 0, 0],
  e: [0, 1, 0],
  q: [0, -1, 0],
};

/** Travel per second, multiplied by the orbit radius so walking stays
 *  fine-grained close in and does not crawl from the back of the room. */
const WALK_SPEED = 0.55;
const WALK_BOOST = 2.1;

export class ArenaControls {
  /** where the camera looks */
  readonly target = new Vector3();
  private readonly targetGoal = new Vector3();
  private readonly spherical = new Spherical(24, 1.1, 0);
  private readonly sphericalGoal = new Spherical(24, 1.1, 0);
  private readonly offset = new Vector3();
  private readonly panScratch = new Vector3();

  private pointers = new Map<number, { x: number; y: number }>();
  private mode: "none" | "orbit" | "pan" = "none";
  private lastPinch = 0;
  private minDistance = 4;
  private maxDistance = 400;

  /** Held walk keys. Movement is applied once per frame in update() rather than
   *  per keydown event, so travel is frame-rate independent and a diagonal does
   *  not move √2 faster than a straight line. */
  private held = new Set<string>();
  private boost = false;
  /** How far the reader may travel from the formation's own centre. */
  private walkReach = 60;
  /**
   * Where the FORMATION wants the camera to look, and how far the reader has
   * since travelled from it.
   *
   * These are separate because the formation re-proposes its look-at on every
   * frame the reader is engaged. Writing travel straight into the goal meant
   * the next frame copied the formation's target back over it, so a pan moved
   * the arena for exactly one frame and a walk never moved it at all.
   */
  private readonly formationTarget = new Vector3();
  private readonly userOffset = new Vector3();
  private readonly walkScratch = new Vector3();
  private readonly walkFwd = new Vector3();
  private readonly walkRight = new Vector3();

  /** True once the reader has moved the camera themselves. */
  engaged = false;
  enabled = true;

  constructor(private readonly camera: PerspectiveCamera, private readonly dom: HTMLElement) {
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("pointercancel", this.onPointerUp);
    dom.addEventListener("wheel", this.onWheel, { passive: false });
    dom.addEventListener("contextmenu", this.onContextMenu);
    // The canvas is not focusable, so keys have to be read at the window. The
    // handlers themselves refuse to act while the reader is in a form control.
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    dom.style.touchAction = "none";
  }

  /** True while the reader is typing, in which case W is a letter. */
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
    if (!(k in WALK_KEYS)) return;
    e.preventDefault();
    this.held.add(k);
    // Walking is the reader taking hold of the camera. Without this the next
    // formation frame() would put them straight back where they started.
    this.engaged = true;
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.boost = false;
    this.held.delete(e.key.toLowerCase());
  };

  /** Losing focus mid-press never delivers the keyup, and a stuck key walks
   *  the camera out of the arena while the reader is in another tab. */
  private onBlur = (): void => {
    this.held.clear();
    this.boost = false;
  };

  /** True while at least one walk key is down — QA and the HUD read this. */
  get walking(): boolean {
    return this.held.size > 0;
  }

  /**
   * Apply held keys for one frame.
   *
   * This moves the look-at TARGET, never the camera directly: the spherical
   * pose, its floor clamp and its distance bounds all survive untouched, so
   * walking cannot put the reader under the seating looking at the backs of
   * the cards. It is the same act as a pan, with a keyboard instead of a drag.
   */
  private walk(dt: number): void {
    if (this.held.size === 0 || dt <= 0) return;
    let rx = 0, uy = 0, fz = 0;
    for (const k of this.held) {
      const v = WALK_KEYS[k];
      if (!v) continue;
      rx += v[0]; uy += v[1]; fz += v[2];
    }
    if (rx === 0 && uy === 0 && fz === 0) return;

    // Flatten the camera basis onto the floor. Column 2 points BEHIND the
    // camera in three.js, so forward is its negation.
    this.walkFwd.setFromMatrixColumn(this.camera.matrix, 2).negate();
    this.walkFwd.y = 0;
    this.walkRight.setFromMatrixColumn(this.camera.matrix, 0);
    this.walkRight.y = 0;
    // Looking straight down leaves no forward direction on the floor at all;
    // fall back to the camera's up, which is the horizon in that pose.
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

  /** Walking out of the arena and then orbiting would strand the reader looking
   *  at empty space with nothing on screen to steer back by. */
  private clampTravel(): void {
    if (this.userOffset.lengthSq() > this.walkReach * this.walkReach) {
      this.userOffset.setLength(this.walkReach);
    }
  }

  /** The formation's preferred pose. Applied outright until the reader engages,
   *  and after that only the target and distance bounds follow. */
  frame(position: Vector3, target: Vector3, extent: number): void {
    this.minDistance = Math.max(2, extent * 0.25);
    this.maxDistance = Math.max(20, extent * 6);
    this.walkReach = Math.max(20, extent * 3);
    this.formationTarget.copy(target);
    // An un-engaged reader has no travel to preserve, and carrying a stale
    // offset into a new formation would frame it off-centre.
    if (!this.engaged) this.userOffset.set(0, 0, 0);
    this.composeTarget();
    this.offset.copy(position).sub(target);
    const goal = new Spherical().setFromVector3(this.offset);
    if (this.engaged) {
      // Once the reader owns the camera, a formation change moves only what it
      // is looking AT. Adopting the framing distance here would undo a dolly on
      // the very next frame, which is what made the wheel appear dead.
    } else {
      this.sphericalGoal.set(goal.radius, goal.phi, goal.theta);
      this.spherical.set(goal.radius, goal.phi, goal.theta);
      this.target.copy(target);
    }
    this.clampGoal();
  }

  /** The goal is the formation's target plus wherever the reader has walked or
   *  panned to from it. */
  private composeTarget(): void {
    this.targetGoal.copy(this.formationTarget).add(this.userOffset);
  }

  private clampGoal(): void {
    this.sphericalGoal.phi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, this.sphericalGoal.phi));
    this.sphericalGoal.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.sphericalGoal.radius));
  }

  /** Damped approach, then compose the camera. Called every frame; `dt` is
   *  seconds since the last frame and only the keyboard walk consumes it. */
  update(dt = 0): void {
    this.walk(dt);
    this.spherical.radius += (this.sphericalGoal.radius - this.spherical.radius) * DAMPING;
    this.spherical.phi += (this.sphericalGoal.phi - this.spherical.phi) * DAMPING;
    this.spherical.theta += (this.sphericalGoal.theta - this.spherical.theta) * DAMPING;
    this.target.lerp(this.targetGoal, DAMPING);
    this.offset.setFromSpherical(this.spherical);
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.lookAt(this.target);
  }

  /** Current distance, for distance-driven detail decisions. */
  get distance(): number {
    return this.spherical.radius;
  }

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
    if (this.mode === "orbit") {
      this.engaged = true;
      const w = this.dom.clientWidth || 1;
      const h = this.dom.clientHeight || 1;
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
    this.engaged = true;
    this.dolly(e.deltaY > 0 ? 1.09 : 1 / 1.09);
  };

  private dolly(scale: number): void {
    this.sphericalGoal.radius *= scale;
    this.clampGoal();
  }

  /** Pan in the camera's own plane, scaled by distance so the drag tracks the
   *  content rather than accelerating as the reader zooms out. */
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

  /** Follow the formation's look-at without touching the reader's angle or
   *  distance. Used while a transition plays after the reader has engaged. */
  retarget(target: Vector3, extent: number): void {
    this.minDistance = Math.max(2, extent * 0.25);
    this.maxDistance = Math.max(20, extent * 6);
    this.walkReach = Math.max(20, extent * 3);
    this.formationTarget.copy(target);
    this.composeTarget();
    this.clampGoal();
  }

  /** Give the framing back to the formation. */
  reset(): void {
    this.engaged = false;
    this.held.clear();
    this.boost = false;
    this.userOffset.set(0, 0, 0);
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
