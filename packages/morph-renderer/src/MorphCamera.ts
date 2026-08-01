import * as THREE from "three";
import { easeQuintic } from "./types";

/**
 * Orthographic camera for Morph Lab.
 *
 * Organized layouts are readings — equal spans must stay equal on screen, so
 * the projection is orthographic with an optional small axonometric tilt for
 * dimensionality (a pitch of the CAMERA, never a rotation of the scene: world
 * coordinates stay in the layout plane and picking survives). The organic
 * tissue reads fine under the same projection because its depth arrives
 * through z-parallax under tilt, size attenuation is deliberately absent, and
 * the haze of 30k points carries the volume.
 */

export interface MorphView {
  cx: number;
  cy: number;
  /** world half-HEIGHT of the visible region; width derives from aspect */
  half: number;
}

const MAX_TILT_RAD = (20 * Math.PI) / 180;
const DOLLY = 900;

export class MorphCamera {
  readonly camera: THREE.OrthographicCamera;
  readonly el: HTMLElement;

  minHalf = 3;
  maxHalf = 1400;
  reducedMotion = false;

  /** fires on USER-initiated view change (pan/zoom/pinch), not programmatic */
  onChange: (() => void) | null = null;
  /** fires when user input cancels an automated flight */
  onUserInput: (() => void) | null = null;

  private view: MorphView = { cx: 0, cy: 0, half: 400 };
  private vw = 2;
  private vh = 2;
  private tilt = 0;
  private tiltTarget = 0;
  private bottomInset = 0;

  private flight: { from: MorphView; to: MorphView; t: number; dur: number } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private downAt: [number, number] | null = null;
  private dragDist = 0;
  private pinchBase: { dist: number; half: number } | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    this.apply();
  }

  dispose(): void {
    const el = this.el;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointercancel", this.onUp);
    el.removeEventListener("wheel", this.onWheel);
  }

  setViewport(w: number, h: number): void {
    this.vw = Math.max(2, w);
    this.vh = Math.max(2, h);
    this.apply();
  }

  get halfHeight(): number {
    return this.view.half;
  }
  get center(): [number, number] {
    return [this.view.cx, this.view.cy];
  }
  get worldPerPixel(): number {
    return (this.view.half * 2) / this.vh;
  }
  get tiltAmount(): number {
    return this.tilt / MAX_TILT_RAD;
  }
  get isDragging(): boolean {
    return this.pointers.size > 0;
  }
  get flying(): boolean {
    return this.flight !== null;
  }

  snapshot(): MorphView {
    return { ...this.view };
  }

  /** URL restore — never animated */
  restore(v: MorphView): void {
    this.flight = null;
    this.view = {
      cx: v.cx,
      cy: v.cy,
      half: Math.min(this.maxHalf, Math.max(this.minHalf, v.half)),
    };
    this.apply();
  }

  visibleRect(): { minX: number; maxX: number; minY: number; maxY: number } {
    const hh = this.view.half;
    const hw = hh * (this.vw / this.vh);
    return {
      minX: this.view.cx - hw,
      maxX: this.view.cx + hw,
      minY: this.view.cy - hh,
      maxY: this.view.cy + hh,
    };
  }

  /** Mobile bottom sheets occlude the lower canvas — frame the free band. */
  setBottomInset(px: number): void {
    this.bottomInset = Math.max(0, px);
  }

  setTilt(amount01: number): void {
    this.tiltTarget = Math.max(0, Math.min(1, amount01)) * MAX_TILT_RAD;
    if (this.reducedMotion) {
      this.tilt = this.tiltTarget;
      this.apply();
    }
  }

  fit(b: { minX: number; maxX: number; minY: number; maxY: number }, pad = 0.07, durationS = 0.75): void {
    const w = Math.max(1e-6, b.maxX - b.minX);
    const h = Math.max(1e-6, b.maxY - b.minY);
    const aspect = this.vw / this.vh;
    const occluded = Math.min(0.45, this.bottomInset / this.vh);
    const usable = 1 - occluded;
    let half = Math.max((h * (1 + pad * 2)) / 2 / usable, (w * (1 + pad * 2)) / 2 / aspect);
    half = Math.min(this.maxHalf, Math.max(this.minHalf, half));
    const cy = (b.minY + b.maxY) / 2 - half * occluded;
    this.flyTo({ cx: (b.minX + b.maxX) / 2, cy, half }, durationS);
  }

  centerOn(x: number, y: number, durationS = 0.4): void {
    this.flyTo({ cx: x, cy: y }, durationS);
  }

  flyTo(v: Partial<MorphView>, durationS = 0.75): void {
    const to: MorphView = {
      cx: v.cx ?? this.view.cx,
      cy: v.cy ?? this.view.cy,
      half: Math.min(this.maxHalf, Math.max(this.minHalf, v.half ?? this.view.half)),
    };
    if (this.reducedMotion || durationS <= 0) {
      this.flight = null;
      this.view = to;
      this.apply();
      return;
    }
    this.flight = { from: { ...this.view }, to, t: 0, dur: durationS };
  }

  update(dt: number): void {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = easeQuintic(f.t);
      this.view.cx = f.from.cx + (f.to.cx - f.from.cx) * k;
      this.view.cy = f.from.cy + (f.to.cy - f.from.cy) * k;
      // geometric zoom — linear interpolation over a 40x half change reads
      // as a stall then a lurch
      this.view.half = f.from.half * Math.pow(f.to.half / f.from.half, k);
      if (f.t >= 1) this.flight = null;
      this.apply();
    }
    if (Math.abs(this.tilt - this.tiltTarget) > 1e-4) {
      this.tilt += (this.tiltTarget - this.tilt) * Math.min(1, dt * 6);
      this.apply();
    }
  }

  /** canonical screen→world mapping onto the plane z = zPlane */
  screenToPlane(px: number, py: number, zPlane = 0): [number, number] {
    const ndc = new THREE.Vector3((px / this.vw) * 2 - 1, -(py / this.vh) * 2 + 1, 0.5);
    ndc.unproject(this.camera);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const t = (zPlane - ndc.z) / (dir.z || -1e-9);
    return [ndc.x + dir.x * t, ndc.y + dir.y * t];
  }

  worldToScreen(x: number, y: number, z = 0): { x: number; y: number; front: boolean } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.vw,
      y: ((1 - v.y) / 2) * this.vh,
      front: v.z < 1,
    };
  }

  wasDrag(): boolean {
    return this.dragDist > 5;
  }

  private apply(): void {
    const aspect = this.vw / this.vh;
    const c = this.camera;
    c.left = -this.view.half * aspect;
    c.right = this.view.half * aspect;
    c.top = this.view.half;
    c.bottom = -this.view.half;
    const cx = this.view.cx;
    const cy = this.view.cy;
    c.position.set(cx, cy - Math.sin(this.tilt) * DOLLY, Math.cos(this.tilt) * DOLLY);
    c.up.set(0, Math.cos(this.tilt), Math.sin(this.tilt));
    c.lookAt(cx, cy, 0);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  private cancelFlight(): void {
    if (this.flight) {
      this.flight = null;
      this.onUserInput?.();
    }
  }

  private onDown = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.downAt = [e.clientX, e.clientY];
    this.dragDist = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchBase = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), half: this.view.half };
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (this.downAt) this.dragDist = Math.max(this.dragDist, Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]));
    if (this.pointers.size === 2 && this.pinchBase) {
      p.x = e.clientX;
      p.y = e.clientY;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (dist > 1) {
        this.cancelFlight();
        this.view.half = Math.min(this.maxHalf, Math.max(this.minHalf, (this.pinchBase.half * this.pinchBase.dist) / dist));
        this.apply();
        this.onChange?.();
      }
      return;
    }
    // pan in world deltas so the point under the pointer stays under it
    const rect = this.el.getBoundingClientRect();
    const w0 = this.screenToPlane(p.x - rect.left, p.y - rect.top);
    const w1 = this.screenToPlane(e.clientX - rect.left, e.clientY - rect.top);
    if (Math.abs(w1[0] - w0[0]) + Math.abs(w1[1] - w0[1]) > 1e-9) {
      this.cancelFlight();
      this.view.cx -= w1[0] - w0[0];
      this.view.cy -= w1[1] - w0[1];
      p.x = e.clientX;
      p.y = e.clientY;
      this.apply();
      this.onChange?.();
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchBase = null;
    if (this.pointers.size === 0) this.downAt = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.cancelFlight();
    const rect = this.el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const before = this.screenToPlane(px, py);
    const factor = Math.pow(1.0022, e.deltaY);
    this.view.half = Math.min(this.maxHalf, Math.max(this.minHalf, this.view.half * factor));
    this.apply();
    const after = this.screenToPlane(px, py);
    this.view.cx += before[0] - after[0];
    this.view.cy += before[1] - after[1];
    this.apply();
    this.onChange?.();
  };
}
