import * as THREE from "three";

/**
 * Orthographic pan/zoom over a semantic map, with an optional axonometric tilt.
 *
 * Orthographic on purpose. The connectome is a perspective space you fly
 * through; the atlas is a chronology you READ, and under perspective the same
 * five-year span is a different width depending on where it sits on screen —
 * which makes "was this belt active longer than that one" unanswerable by
 * looking. Ortho makes the time axis honest: equal days, equal pixels,
 * everywhere.
 *
 * The tilt is a pitch of the CAMERA, not a rotation of the scene, so world
 * coordinates stay in the plane the layouts computed and picking keeps working
 * through the same projection the shader uses.
 */

const MAX_TILT_RAD = (24 * Math.PI) / 180;
/** Far enough back that scene z never crosses the near plane. */
const DOLLY = 400;

export interface AtlasView {
  cx: number;
  cy: number;
  /** World half-height of the visible region. Smaller = zoomed in. */
  half: number;
}

export class AtlasCameraController {
  readonly camera: THREE.OrthographicCamera;
  private el: HTMLElement;
  private aspect = 1;
  private pxW = 1;
  private pxH = 1;

  private view: AtlasView = { cx: 0, cy: 0, half: 50 };
  private targetView: AtlasView = { cx: 0, cy: 0, half: 50 };
  private flightT = 1;
  private flightDur = 0;
  private fromView: AtlasView = { cx: 0, cy: 0, half: 50 };

  private tilt = 0;
  private tiltTarget = 0;

  /** World half-height limits. Wide enough to frame 571 lanes, tight enough
   *  to read a single reign block. */
  minHalf = 1.2;
  maxHalf = 900;

  reducedMotion = false;
  onChange: (() => void) | null = null;

  private pointers = new Map<number, [number, number]>();
  private pinchDist = 0;
  private dragging = false;
  private movedPx = 0;

  private tmpV = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();

  constructor(el: HTMLElement) {
    this.el = el;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    this.apply();
  }

  /* ---------- geometry ---------- */

  setViewport(w: number, h: number): void {
    this.pxW = Math.max(1, w);
    this.pxH = Math.max(1, h);
    this.aspect = this.pxW / this.pxH;
    this.apply();
  }

  get halfHeight(): number {
    return this.view.half;
  }
  get center(): [number, number] {
    return [this.view.cx, this.view.cy];
  }
  /** World units per screen pixel on the (untilted) Y axis. */
  get worldPerPixel(): number {
    return (this.view.half * 2) / this.pxH;
  }
  get tiltAmount(): number {
    return this.tiltTarget / MAX_TILT_RAD;
  }
  /** True while the reader is dragging — suppresses hover work. */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** The world rectangle currently on screen, for the minimap. */
  visibleRect(): { x0: number; y0: number; x1: number; y1: number } {
    const hh = this.view.half;
    const hw = hh * this.aspect;
    return {
      x0: this.view.cx - hw,
      y0: this.view.cy - hh,
      x1: this.view.cx + hw,
      y1: this.view.cy + hh,
    };
  }

  private apply(): void {
    const hh = this.view.half;
    const hw = hh * this.aspect;
    this.camera.left = -hw;
    this.camera.right = hw;
    this.camera.top = hh;
    this.camera.bottom = -hh;
    const a = this.tilt;
    this.camera.position.set(
      this.view.cx,
      this.view.cy - Math.sin(a) * DOLLY,
      Math.cos(a) * DOLLY,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.view.cx, this.view.cy, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /**
   * Screen pixel -> the world point on the plane z = `zPlane`.
   *
   * Everything interactive routes through this: pan deltas, zoom-about-cursor
   * and picking. Deriving pan from a scalar "world per pixel" instead was
   * correct only at zero tilt, and silently drifted the moment the reader
   * tipped the board.
   */
  screenToPlane(px: number, py: number, zPlane = 0): [number, number] {
    const ndcX = (px / this.pxW) * 2 - 1;
    const ndcY = -((py / this.pxH) * 2 - 1);
    this.tmpV.set(ndcX, ndcY, -1).unproject(this.camera);
    this.camera.getWorldDirection(this.tmpDir);
    const t = Math.abs(this.tmpDir.z) < 1e-9 ? 0 : (zPlane - this.tmpV.z) / this.tmpDir.z;
    return [this.tmpV.x + this.tmpDir.x * t, this.tmpV.y + this.tmpDir.y * t];
  }

  /** World point -> screen pixel, through the same matrices the shader uses. */
  worldToScreen(x: number, y: number, z = 0): { x: number; y: number; front: boolean } {
    this.tmpV.set(x, y, z).project(this.camera);
    return {
      x: (this.tmpV.x * 0.5 + 0.5) * this.pxW,
      y: (-this.tmpV.y * 0.5 + 0.5) * this.pxH,
      front: this.tmpV.z > -1 && this.tmpV.z < 1,
    };
  }

  /* ---------- input ---------- */

  private onDown = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
    this.movedPx = 0;
    if (this.pointers.size === 1) this.dragging = true;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a![0] - b![0], a![1] - b![1]);
    }
    this.flightT = 1; // the reader always wins an in-progress flight
  };

  private onMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev[0];
    const dy = e.clientY - prev[1];
    this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
    this.movedPx += Math.hypot(dx, dy);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a![0] - b![0], a![1] - b![1]);
      if (this.pinchDist > 0 && d > 0) {
        const mx = (a![0] + b![0]) / 2;
        const my = (a![1] + b![1]) / 2;
        const rect = this.el.getBoundingClientRect();
        this.zoomAbout(this.pinchDist / d, mx - rect.left, my - rect.top);
      }
      this.pinchDist = d;
      return;
    }
    if (!(e.buttons & 1) && !(e.buttons & 2)) return;
    // Pan by the world delta the cursor actually traversed, so the point under
    // the finger stays under the finger at any tilt or zoom.
    const rect = this.el.getBoundingClientRect();
    const now = this.screenToPlane(e.clientX - rect.left, e.clientY - rect.top);
    const was = this.screenToPlane(prev[0] - rect.left, prev[1] - rect.top);
    this.view.cx -= now[0] - was[0];
    this.view.cy -= now[1] - was[1];
    this.targetView.cx = this.view.cx;
    this.targetView.cy = this.view.cy;
    this.apply();
    this.onChange?.();
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinchDist = 0;
    if (!this.pointers.size) this.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.flightT = 1;
    const rect = this.el.getBoundingClientRect();
    this.zoomAbout(Math.pow(1.0022, e.deltaY), e.clientX - rect.left, e.clientY - rect.top);
  };

  /** Zoom keeping the world point under (px,py) pinned. */
  zoomAbout(factor: number, px: number, py: number): void {
    const before = this.screenToPlane(px, py);
    const half = THREE.MathUtils.clamp(this.view.half * factor, this.minHalf, this.maxHalf);
    if (half === this.view.half) return;
    this.view.half = half;
    this.apply();
    const after = this.screenToPlane(px, py);
    this.view.cx += before[0] - after[0];
    this.view.cy += before[1] - after[1];
    this.targetView = { ...this.view };
    this.apply();
    this.onChange?.();
  }

  /** True when the pointer travelled far enough to be a drag, not a click. */
  wasDrag(): boolean {
    return this.movedPx > 5;
  }

  /* ---------- programmatic framing ---------- */

  setTilt(amount01: number): void {
    this.tiltTarget = THREE.MathUtils.clamp(amount01, 0, 1) * MAX_TILT_RAD;
    if (this.reducedMotion) {
      this.tilt = this.tiltTarget;
      this.apply();
    }
  }

  /**
   * Pixels of the canvas hidden behind chrome at the bottom.
   *
   * On a phone the bottom sheet covers half the canvas, and a fit that centres
   * content in the CANVAS centres it behind the sheet. The camera has to know
   * which part of its own viewport the reader can actually see.
   */
  private bottomInsetPx = 0;

  setBottomInset(px: number): void {
    this.bottomInsetPx = Math.max(0, Math.min(px, this.pxH * 0.8));
  }

  /** Frame a world rectangle with padding, as a fraction of the shorter side. */
  fit(
    b: { minX: number; maxX: number; minY: number; maxY: number },
    pad = 0.06,
    durationS = 0.75,
  ): void {
    const w = Math.max(1e-3, b.maxX - b.minX);
    const h = Math.max(1e-3, b.maxY - b.minY);
    // Grow the frame so the content fits the UNOCCLUDED band, not the canvas.
    const visible = Math.max(0.2, (this.pxH - this.bottomInsetPx) / this.pxH);
    const half =
      Math.max(h / 2 / visible, w / 2 / Math.max(0.2, this.aspect)) * (1 + pad * 2);
    const clamped = THREE.MathUtils.clamp(half, this.minHalf, this.maxHalf);
    // …then push the centre down by half the occluded height, so the content
    // lands in the middle of what can be seen.
    const worldPerPx = (clamped * 2) / this.pxH;
    this.flyTo(
      {
        cx: (b.minX + b.maxX) / 2,
        cy: (b.minY + b.maxY) / 2 - (this.bottomInsetPx / 2) * worldPerPx,
        half: clamped,
      },
      durationS,
    );
  }

  flyTo(v: Partial<AtlasView>, durationS = 0.75): void {
    const next: AtlasView = {
      cx: v.cx ?? this.view.cx,
      cy: v.cy ?? this.view.cy,
      half: THREE.MathUtils.clamp(v.half ?? this.view.half, this.minHalf, this.maxHalf),
    };
    if (this.reducedMotion || durationS <= 0) {
      this.view = next;
      this.targetView = { ...next };
      this.flightT = 1;
      this.apply();
      this.onChange?.();
      return;
    }
    this.fromView = { ...this.view };
    this.targetView = next;
    this.flightT = 0;
    this.flightDur = durationS;
  }

  /** Centre a world point without changing zoom. */
  centerOn(x: number, y: number, durationS = 0.6): void {
    this.flyTo({ cx: x, cy: y }, durationS);
  }

  /** Restore an exact view (URL state). Never animated. */
  restore(v: AtlasView): void {
    this.view = {
      cx: v.cx,
      cy: v.cy,
      half: THREE.MathUtils.clamp(v.half, this.minHalf, this.maxHalf),
    };
    this.targetView = { ...this.view };
    this.flightT = 1;
    this.apply();
  }

  snapshot(): AtlasView {
    return { ...this.view };
  }

  update(dt: number): void {
    let dirty = false;
    if (this.flightT < 1) {
      this.flightT = Math.min(1, this.flightT + dt / Math.max(1e-3, this.flightDur));
      // quintic in-out: leaves and arrives without a visible velocity step,
      // which matters because the camera and the layout morph run together
      const t = this.flightT;
      const k = t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
      this.view.cx = this.fromView.cx + (this.targetView.cx - this.fromView.cx) * k;
      this.view.cy = this.fromView.cy + (this.targetView.cy - this.fromView.cy) * k;
      // Zoom interpolates geometrically. Linear interpolation of a half-height
      // that changes by 40x reads as a stall then a lurch.
      this.view.half =
        this.fromView.half * Math.pow(this.targetView.half / this.fromView.half, k);
      dirty = true;
    }
    if (Math.abs(this.tilt - this.tiltTarget) > 1e-5) {
      this.tilt += (this.tiltTarget - this.tilt) * Math.min(1, dt * 6);
      dirty = true;
    }
    if (dirty) {
      this.apply();
      this.onChange?.();
    }
  }

  dispose(): void {
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onUp);
    this.el.removeEventListener("wheel", this.onWheel);
  }
}
