import * as THREE from "three";

/**
 * Orbit/pan/zoom with damped focus flights. The user always wins: any input
 * cancels an in-progress flight. Reduced motion snaps instead of flying.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  private sph = new THREE.Spherical(3.4, Math.PI / 2.3, 0.6);
  private velYaw = 0;
  private velPitch = 0;
  private flight: {
    fromT: THREE.Vector3; toT: THREE.Vector3;
    fromS: THREE.Spherical; toS: THREE.Spherical;
    t: number; dur: number;
  } | null = null;
  reducedMotion = false;
  private el: HTMLElement;
  private pointers = new Map<number, [number, number]>();
  private pinchDist = 0;
  onUserInput: (() => void) | null = null;

  constructor(el: HTMLElement, aspect: number) {
    this.el = el;
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.01, 60);
    this.update(0);

    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private cancelFlight(): void {
    this.flight = null;
    this.onUserInput?.();
  }

  private onDown = (e: PointerEvent): void => {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a![0] - b![0], a![1] - b![1]);
    }
    this.cancelFlight();
  };

  private onMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev[0];
    const dy = e.clientY - prev[1];
    this.pointers.set(e.pointerId, [e.clientX, e.clientY]);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a![0] - b![0], a![1] - b![1]);
      if (this.pinchDist > 0) this.dolly(this.pinchDist / Math.max(1, d));
      this.pinchDist = d;
      this.pan(dx * 0.5, dy * 0.5);
      return;
    }
    if (e.buttons & 2 || e.shiftKey) {
      this.pan(dx, dy);
    } else if (e.buttons & 1) {
      this.velYaw = -dx * 0.0042;
      this.velPitch = -dy * 0.0042;
      this.sph.theta += this.velYaw;
      this.sph.phi = THREE.MathUtils.clamp(this.sph.phi + this.velPitch, 0.05, Math.PI - 0.05);
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.pinchDist = 0;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.cancelFlight();
    this.dolly(Math.pow(1.0016, e.deltaY));
  };

  private dolly(factor: number): void {
    this.sph.radius = THREE.MathUtils.clamp(this.sph.radius * factor, 0.12, 14);
  }

  private pan(dx: number, dy: number): void {
    const scale = this.sph.radius * 0.0012;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
  }

  /** Smooth flight to frame a point at the given distance. */
  flyTo(point: THREE.Vector3, distance: number, durationS = 1.1): void {
    const toS = new THREE.Spherical(distance, this.sph.phi, this.sph.theta);
    if (this.reducedMotion || durationS <= 0) {
      this.target.copy(point);
      this.sph.radius = distance;
      this.flight = null;
      return;
    }
    this.flight = {
      fromT: this.target.clone(),
      toT: point.clone(),
      fromS: this.sph.clone(),
      toS,
      t: 0,
      dur: durationS,
    };
  }

  distance(): number {
    return this.sph.radius;
  }

  update(dt: number): void {
    if (this.flight) {
      this.flight.t = Math.min(1, this.flight.t + dt / this.flight.dur);
      const k = 1 - Math.pow(1 - this.flight.t, 3); // ease-out cubic
      this.target.lerpVectors(this.flight.fromT, this.flight.toT, k);
      this.sph.radius = THREE.MathUtils.lerp(this.flight.fromS.radius, this.flight.toS.radius, k);
      this.sph.theta = THREE.MathUtils.lerp(this.flight.fromS.theta, this.flight.toS.theta, k);
      this.sph.phi = THREE.MathUtils.lerp(this.flight.fromS.phi, this.flight.toS.phi, k);
      if (this.flight.t >= 1) this.flight = null;
    } else if (this.pointers.size === 0) {
      // inertial decay
      this.velYaw *= Math.exp(-dt * 5);
      this.velPitch *= Math.exp(-dt * 5);
      if (Math.abs(this.velYaw) > 1e-4) this.sph.theta += this.velYaw;
      if (Math.abs(this.velPitch) > 1e-4)
        this.sph.phi = THREE.MathUtils.clamp(this.sph.phi + this.velPitch, 0.05, Math.PI - 0.05);
    }
    const pos = new THREE.Vector3().setFromSpherical(this.sph).add(this.target);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }

  reset(): void {
    this.flyTo(new THREE.Vector3(0, 0, 0), 3.4, 0.9);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onUp);
    this.el.removeEventListener("wheel", this.onWheel);
  }
}
