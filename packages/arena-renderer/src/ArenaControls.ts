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
    dom.style.touchAction = "none";
  }

  /** The formation's preferred pose. Applied outright until the reader engages,
   *  and after that only the target and distance bounds follow. */
  frame(position: Vector3, target: Vector3, extent: number): void {
    this.minDistance = Math.max(2, extent * 0.25);
    this.maxDistance = Math.max(20, extent * 6);
    this.targetGoal.copy(target);
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

  private clampGoal(): void {
    this.sphericalGoal.phi = Math.max(MIN_POLAR, Math.min(MAX_POLAR, this.sphericalGoal.phi));
    this.sphericalGoal.radius = Math.max(this.minDistance, Math.min(this.maxDistance, this.sphericalGoal.radius));
  }

  /** Damped approach, then compose the camera. Called every frame. */
  update(): void {
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
    this.targetGoal.add(this.panScratch);
    this.panScratch.setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(dy * perPixel);
    this.targetGoal.add(this.panScratch);
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
    this.targetGoal.copy(target);
    this.clampGoal();
  }

  /** Give the framing back to the formation. */
  reset(): void {
    this.engaged = false;
  }

  dispose(): void {
    this.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.dom.removeEventListener("pointermove", this.onPointerMove);
    this.dom.removeEventListener("pointerup", this.onPointerUp);
    this.dom.removeEventListener("pointercancel", this.onPointerUp);
    this.dom.removeEventListener("wheel", this.onWheel);
    this.dom.removeEventListener("contextmenu", this.onContextMenu);
    this.pointers.clear();
  }
}
