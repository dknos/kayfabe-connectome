import * as THREE from "three";
import { easeQuintic } from "./types";

/** Serializable perspective-orbit state. `c*` is the semantic focus. */
export interface MorphView {
  cx: number;
  cy: number;
  cz: number;
  distance: number;
  /** azimuth around +Y, radians */
  theta: number;
  /** polar angle down from +Y, radians */
  phi: number;
}

export interface MorphBounds3 {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ?: number;
  maxZ?: number;
}

export interface MorphScreenPoint {
  x: number;
  y: number;
  front: boolean;
  depth: number;
}

interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PointerState {
  x: number;
  y: number;
  button: number;
  pan: boolean;
}

const FOV = 50;
const MIN_PHI = THREE.MathUtils.degToRad(8);
const MAX_PHI = THREE.MathUtils.degToRad(172);
const DEFAULT_VIEW: MorphView = {
  cx: 0,
  cy: 0,
  cz: 0,
  distance: 760,
  theta: THREE.MathUtils.degToRad(29),
  phi: THREE.MathUtils.degToRad(68),
};

/**
 * Perspective spatial controller for Morph Lab.
 *
 * The target is semantic: orbit never loses the selected entity or active
 * structure. Left drag orbits, right/modified drag pans, wheel/pinch dollies,
 * and WASD/QE flies relative to the current camera. User input only cancels
 * this controller's camera flight; node interpolation remains untouched.
 */
export class MorphCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly el: HTMLElement;

  minDistance = 8;
  maxDistance = 5200;
  reducedMotion = false;
  inputEnabled = true;

  /** fires on USER-initiated view change, not programmatic flight */
  onChange: (() => void) | null = null;
  /** fires when user input cancels an automated camera flight */
  onUserInput: (() => void) | null = null;
  /** fires only when camera drag crosses its movement threshold or ends */
  onDragChange: ((dragging: boolean) => void) | null = null;

  private view: MorphView = { ...DEFAULT_VIEW };
  private vw = 2;
  private vh = 2;
  private insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private flight: { from: MorphView; to: MorphView; t: number; dur: number } | null = null;
  private dollyTarget = DEFAULT_VIEW.distance;
  private pointers = new Map<number, PointerState>();
  private downAt: [number, number] | null = null;
  private dragDist = 0;
  private dragReported = false;
  private pinchBase: { distancePx: number; cameraDistance: number; cx: number; cy: number } | null = null;
  private keys = new Set<string>();

  private projTmp = new THREE.Vector3();
  private rayOrigin = new THREE.Vector3();
  private rayPoint = new THREE.Vector3();
  private rayDir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private forward = new THREE.Vector3();

  get viewportHeight(): number {
    return this.vh;
  }

  constructor(el: HTMLElement) {
    this.el = el;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 12000);
    this.camera.up.set(0, 1, 0);
    el.addEventListener("contextmenu", this.onContextMenu);
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("blur", this.onBlur);
    this.apply();
  }

  dispose(): void {
    const el = this.el;
    el.removeEventListener("contextmenu", this.onContextMenu);
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointermove", this.onMove);
    el.removeEventListener("pointerup", this.onUp);
    el.removeEventListener("pointercancel", this.onUp);
    el.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onBlur);
  }

  setViewport(w: number, h: number): void {
    this.vw = Math.max(2, w);
    this.vh = Math.max(2, h);
    this.camera.aspect = this.vw / this.vh;
    this.apply();
  }

  /** Perspective world span at the semantic focus plane. */
  get halfHeight(): number {
    return Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.view.distance;
  }
  get center(): [number, number] {
    return [this.view.cx, this.view.cy];
  }
  get target(): [number, number, number] {
    return [this.view.cx, this.view.cy, this.view.cz];
  }
  get distance(): number {
    return this.view.distance;
  }
  /** Perspective world units per CSS pixel at the focus plane. */
  get worldPerPixel(): number {
    return (this.halfHeight * 2) / this.vh;
  }
  get isDragging(): boolean {
    return this.pointers.size > 0 && this.dragDist > 2;
  }
  get flying(): boolean {
    return this.flight !== null;
  }

  snapshot(): MorphView {
    return { ...this.view };
  }

  /** URL restore — never animated. Invalid fragments fall back safely. */
  restore(v: MorphView): void {
    this.flight = null;
    this.view = this.sanitize(v);
    this.dollyTarget = this.view.distance;
    this.apply();
  }

  setInputEnabled(v: boolean): void {
    this.inputEnabled = v;
    if (!v) {
      this.keys.clear();
      this.pointers.clear();
      this.setDragReported(false);
    }
  }

  /** Approximate target-plane rectangle, retained for QA/minimap callers. */
  visibleRect(): { minX: number; maxX: number; minY: number; maxY: number } {
    const hh = this.halfHeight;
    const hw = hh * (this.vw / this.vh);
    return { minX: this.view.cx - hw, maxX: this.view.cx + hw, minY: this.view.cy - hh, maxY: this.view.cy + hh };
  }

  setInsets(next: Partial<Insets>): void {
    this.insets = {
      left: Math.max(0, next.left ?? this.insets.left),
      right: Math.max(0, next.right ?? this.insets.right),
      top: Math.max(0, next.top ?? this.insets.top),
      bottom: Math.max(0, next.bottom ?? this.insets.bottom),
    };
  }

  /** Compatibility helper used by the mobile Morph sheet. */
  setBottomInset(px: number): void {
    this.setInsets({ bottom: px });
  }

  /**
   * Fit a genuine 3D volume in the unobscured viewport. The current orbit is
   * retained so a reader's chosen viewpoint survives an explicit Fit.
   */
  fit(
    b: MorphBounds3,
    pad = 0.1,
    durationS = 0.75,
    orientation?: { theta: number; phi: number },
    points?: ArrayLike<number>,
  ): void {
    const minZ = Number.isFinite(b.minZ) ? b.minZ! : 0;
    const maxZ = Number.isFinite(b.maxZ) ? b.maxZ! : 0;
    const cx = (b.minX + b.maxX) * 0.5;
    const cy = (b.minY + b.maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const sx = Math.max(1e-4, b.maxX - b.minX);
    const sy = Math.max(1e-4, b.maxY - b.minY);
    const sz = Math.max(1e-4, maxZ - minZ);

    const usableW = Math.max(80, this.vw - this.insets.left - this.insets.right);
    const usableH = Math.max(80, this.vh - this.insets.top - this.insets.bottom);
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
    const tanFullV = Math.tan(vHalf);
    // Insets crop the FULL camera viewport; they do not create a new camera
    // aspect ratio. Express the free rectangle's half-angle in the original
    // canvas pixel scale. Using usableW/usableH here overestimates both axes
    // whenever a mobile sheet removes vertical space and clips the structure.
    const tanFitV = tanFullV * (usableH / this.vh);
    const tanFitH = tanFullV * (usableW / this.vh);
    const theta = orientation?.theta ?? this.view.theta;
    const phi = orientation?.phi ?? this.view.phi;
    const sinPhi = Math.sin(phi);
    // Camera-back vector (target -> eye), then the view-plane basis. Fitting
    // an oriented box against the actual perspective frustum avoids the huge
    // empty margins produced by a diagonal bounding sphere for long lineages.
    const ex = sinPhi * Math.sin(theta);
    const ey = Math.cos(phi);
    const ez = sinPhi * Math.cos(theta);
    const rightLen = Math.hypot(ez, ex) || 1;
    const rx = ez / rightLen;
    const ry = 0;
    const rz = -ex / rightLen;
    const fx = -ex;
    const fy = -ey;
    const fz = -ez;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;
    let distance = 1;
    const include = (dx: number, dy: number, dz: number) => {
      const scale = 1 + pad;
      dx *= scale;
      dy *= scale;
      dz *= scale;
      const towardEye = dx * ex + dy * ey + dz * ez;
      const screenX = Math.abs(dx * rx + dy * ry + dz * rz);
      const screenY = Math.abs(dx * ux + dy * uy + dz * uz);
      distance = Math.max(
        distance,
        towardEye + screenX / Math.max(1e-6, tanFitH),
        towardEye + screenY / Math.max(1e-6, tanFitV),
      );
    };
    if (points && points.length >= 3) {
      // Organized structures are often correlated volumes (a career lane's X
      // and Z move together). Fitting their occupied samples avoids framing
      // imaginary AABB corners and leaving most of the viewport empty.
      for (let i = 0; i + 2 < points.length; i += 3) {
        const x = points[i]!;
        const y = points[i + 1]!;
        const z = points[i + 2]!;
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) include(x - cx, y - cy, z - cz);
      }
    } else {
      const hx = sx * 0.5;
      const hy = sy * 0.5;
      const hz = sz * 0.5;
      for (const dx of [-hx, hx]) {
        for (const dy of [-hy, hy]) {
          for (const dz of [-hz, hz]) include(dx, dy, dz);
        }
      }
    }
    distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);

    // Shift the semantic target opposite the occupied rail so the volume's
    // projected centre lands in the actual free band, not canvas centre.
    const worldPerPx = (2 * distance * tanFullV) / this.vh;
    const shiftX = (this.insets.left - this.insets.right) * 0.5 * worldPerPx;
    const shiftY = (this.insets.bottom - this.insets.top) * 0.5 * worldPerPx;
    const target: Partial<MorphView> = {
      cx: cx - rx * shiftX - ux * shiftY,
      cy: cy - ry * shiftX - uy * shiftY,
      cz: cz - rz * shiftX - uz * shiftY,
      distance,
    };
    if (orientation) {
      target.theta = orientation.theta;
      target.phi = orientation.phi;
    }
    this.flyTo(target, durationS);
  }

  centerOn(x: number, y: number, durationS = 0.4, z = 0): void {
    this.flyTo({ cx: x, cy: y, cz: z }, durationS);
  }

  /** Focus one entity without changing the current orbit direction. */
  focus(x: number, y: number, z: number, radius = 16, durationS = 0.55): void {
    const desired = THREE.MathUtils.clamp(radius * 7.5, 34, Math.min(this.view.distance, 360));
    this.flyTo({ cx: x, cy: y, cz: z, distance: desired }, durationS);
  }

  /** Settle on a spatially legible default angle for a topology change. */
  orient(theta: number, phi: number, durationS = 0.65): void {
    this.flyTo({ theta, phi }, durationS);
  }

  flyTo(v: Partial<MorphView>, durationS = 0.75): void {
    const to = this.sanitize({ ...this.view, ...v });
    this.dollyTarget = to.distance;
    if (this.reducedMotion || durationS <= 0) {
      this.flight = null;
      this.view = to;
      this.apply();
      return;
    }
    this.flight = { from: { ...this.view }, to, t: 0, dur: Math.max(0.001, durationS) };
  }

  update(dt: number): void {
    let changed = false;
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.dur);
      const k = easeQuintic(f.t);
      this.view.cx = THREE.MathUtils.lerp(f.from.cx, f.to.cx, k);
      this.view.cy = THREE.MathUtils.lerp(f.from.cy, f.to.cy, k);
      this.view.cz = THREE.MathUtils.lerp(f.from.cz, f.to.cz, k);
      this.view.distance = f.from.distance * Math.pow(f.to.distance / f.from.distance, k);
      this.view.theta = lerpAngle(f.from.theta, f.to.theta, k);
      this.view.phi = THREE.MathUtils.lerp(f.from.phi, f.to.phi, k);
      if (f.t >= 1) this.flight = null;
      changed = true;
    } else if (Math.abs(this.view.distance - this.dollyTarget) > 0.005) {
      const k = 1 - Math.exp(-dt * 12);
      this.view.distance = THREE.MathUtils.lerp(this.view.distance, this.dollyTarget, k);
      changed = true;
    }

    if (this.keys.size > 0 && this.inputEnabled) {
      const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 3.2 : 1;
      const speed = Math.max(12, this.view.distance * 0.48) * boost * dt;
      this.camera.getWorldDirection(this.forward).normalize();
      this.right.crossVectors(this.forward, this.camera.up).normalize();
      // WASD follows the view plane; Q/E is unambiguously world vertical.
      this.up.crossVectors(this.right, this.forward).normalize();
      let dx = 0;
      let dy = 0;
      let dz = 0;
      if (this.keys.has("KeyW")) { dx += this.forward.x; dy += this.forward.y; dz += this.forward.z; }
      if (this.keys.has("KeyS")) { dx -= this.forward.x; dy -= this.forward.y; dz -= this.forward.z; }
      if (this.keys.has("KeyD")) { dx += this.right.x; dy += this.right.y; dz += this.right.z; }
      if (this.keys.has("KeyA")) { dx -= this.right.x; dy -= this.right.y; dz -= this.right.z; }
      if (this.keys.has("KeyE")) dy += 1;
      if (this.keys.has("KeyQ")) dy -= 1;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-8) {
        this.view.cx += (dx / len) * speed;
        this.view.cy += (dy / len) * speed;
        this.view.cz += (dz / len) * speed;
        changed = true;
        this.onChange?.();
      }
    }
    if (changed) this.apply();
  }

  /** screen ray intersection with the world plane z = zPlane */
  screenToPlane(px: number, py: number, zPlane = 0): [number, number] {
    this.rayFromScreen(px, py);
    const t = (zPlane - this.rayOrigin.z) / (this.rayDir.z || 1e-9);
    return [this.rayOrigin.x + this.rayDir.x * t, this.rayOrigin.y + this.rayDir.y * t];
  }

  rayFromScreen(px: number, py: number): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    this.rayOrigin.copy(this.camera.position);
    this.rayPoint.set((px / this.vw) * 2 - 1, -(py / this.vh) * 2 + 1, 0.5).unproject(this.camera);
    this.rayDir.copy(this.rayPoint).sub(this.rayOrigin).normalize();
    return { origin: this.rayOrigin, direction: this.rayDir };
  }

  worldToScreen(x: number, y: number, z = 0): MorphScreenPoint {
    return this.projectInto(x, y, z, { x: 0, y: 0, front: false, depth: 0 });
  }

  /** Allocation-free projection seam used by full-corpus picking. */
  projectInto(x: number, y: number, z: number, out: MorphScreenPoint): MorphScreenPoint {
    this.projTmp.set(x, y, z);
    const cameraZ = this.projTmp.applyMatrix4(this.camera.matrixWorldInverse).z;
    this.projTmp.set(x, y, z).project(this.camera);
    out.x = ((this.projTmp.x + 1) / 2) * this.vw;
    out.y = ((1 - this.projTmp.y) / 2) * this.vh;
    out.front = cameraZ < 0 && this.projTmp.z >= -1 && this.projTmp.z <= 1;
    out.depth = -cameraZ;
    return out;
  }

  wasDrag(): boolean {
    return this.dragDist > 5;
  }

  private sanitize(v: MorphView): MorphView {
    const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
    return {
      cx: finite(v.cx, 0),
      cy: finite(v.cy, 0),
      cz: finite(v.cz, 0),
      distance: THREE.MathUtils.clamp(finite(v.distance, DEFAULT_VIEW.distance), this.minDistance, this.maxDistance),
      theta: finite(v.theta, DEFAULT_VIEW.theta),
      phi: THREE.MathUtils.clamp(finite(v.phi, DEFAULT_VIEW.phi), MIN_PHI, MAX_PHI),
    };
  }

  private apply(): void {
    const v = this.view;
    const sinPhi = Math.sin(v.phi);
    this.camera.position.set(
      v.cx + v.distance * sinPhi * Math.sin(v.theta),
      v.cy + v.distance * Math.cos(v.phi),
      v.cz + v.distance * sinPhi * Math.cos(v.theta),
    );
    this.camera.lookAt(v.cx, v.cy, v.cz);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  private cancelFlight(): void {
    if (this.flight) {
      this.flight = null;
      this.onUserInput?.();
    }
  }

  private beginUserInput(): void {
    this.cancelFlight();
    this.dollyTarget = this.view.distance;
  }

  private panByPixels(dx: number, dy: number): void {
    this.camera.getWorldDirection(this.forward).normalize();
    this.right.crossVectors(this.forward, this.camera.up).normalize();
    this.up.crossVectors(this.right, this.forward).normalize();
    const scale = this.worldPerPixel;
    this.view.cx += (-this.right.x * dx + this.up.x * dy) * scale;
    this.view.cy += (-this.right.y * dx + this.up.y * dy) * scale;
    this.view.cz += (-this.right.z * dx + this.up.z * dy) * scale;
  }

  private onContextMenu = (e: MouseEvent): void => e.preventDefault();

  private onDown = (e: PointerEvent): void => {
    if (!this.inputEnabled) return;
    this.el.setPointerCapture(e.pointerId);
    const pan = e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, pan });
    this.downAt = [e.clientX, e.clientY];
    this.dragDist = 0;
    this.beginUserInput();
    if (this.pointers.size === 2) this.capturePinchBase();
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.inputEnabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.downAt) this.dragDist = Math.max(this.dragDist, Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]));
    if (this.dragDist > 2) this.setDragReported(true);

    if (this.pointers.size >= 2 && this.pinchBase) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y));
      const cx = (a!.x + b!.x) * 0.5;
      const cy = (a!.y + b!.y) * 0.5;
      this.view.distance = THREE.MathUtils.clamp(
        this.pinchBase.cameraDistance * (this.pinchBase.distancePx / dist),
        this.minDistance,
        this.maxDistance,
      );
      this.dollyTarget = this.view.distance;
      this.panByPixels(cx - this.pinchBase.cx, cy - this.pinchBase.cy);
      this.pinchBase = { distancePx: dist, cameraDistance: this.view.distance, cx, cy };
    } else if (p.pan) {
      this.panByPixels(dx, dy);
    } else {
      this.view.theta -= dx * 0.0062;
      this.view.phi = THREE.MathUtils.clamp(this.view.phi - dy * 0.0062, MIN_PHI, MAX_PHI);
    }
    this.apply();
    this.onChange?.();
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchBase = null;
    if (this.pointers.size === 0) {
      this.downAt = null;
      this.setDragReported(false);
    }
  };

  private capturePinchBase(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinchBase = {
      distancePx: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)),
      cameraDistance: this.view.distance,
      cx: (a!.x + b!.x) * 0.5,
      cy: (a!.y + b!.y) * 0.5,
    };
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.inputEnabled) return;
    e.preventDefault();
    this.beginUserInput();
    const dy = THREE.MathUtils.clamp(e.deltaY, -180, 180);
    this.dollyTarget = THREE.MathUtils.clamp(this.view.distance * Math.exp(dy * 0.0018), this.minDistance, this.maxDistance);
    this.onChange?.();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.inputEnabled || editableTarget(e.target)) return;
    if (!["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"].includes(e.code)) return;
    if (!this.keys.has(e.code) && e.code !== "ShiftLeft" && e.code !== "ShiftRight") this.beginUserInput();
    this.keys.add(e.code);
    e.preventDefault();
    e.stopPropagation();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.keys.delete(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.pointers.clear();
    this.downAt = null;
    this.pinchBase = null;
    this.setDragReported(false);
  };

  private setDragReported(dragging: boolean): void {
    if (this.dragReported === dragging) return;
    this.dragReported = dragging;
    this.onDragChange?.(dragging);
  }
}

function editableTarget(t: EventTarget | null): boolean {
  const el = t instanceof HTMLElement ? t : null;
  return !!el?.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
