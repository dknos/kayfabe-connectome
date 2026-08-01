import * as THREE from "three";

/** Keys that fly the camera, mapped to a local-basis direction. */
const FLY_KEYS: Record<string, [number, number, number]> = {
  //        right, up, forward
  w: [0, 0, 1],
  s: [0, 0, -1],
  a: [-1, 0, 0],
  d: [1, 0, 0],
  e: [0, 1, 0],
  q: [0, -1, 0],
};

/**
 * Orbit/pan/zoom with damped focus flights, plus WASD free flight. The user
 * always wins: any input cancels an in-progress flight. Reduced motion snaps
 * instead of flying.
 *
 * Flight moves the orbit TARGET along the camera's own basis rather than
 * dollying the radius, so W actually travels through the tissue instead of
 * pressing the camera against whatever it was already framing. Speed scales
 * with the orbit radius for the same reason panning does: a fixed metres-per-
 * second feels glacial zoomed out and uncontrollable zoomed in.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  private sph = new THREE.Spherical(2.8, Math.PI / 2.3, 0.6);
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

  /** Held fly keys. Movement is applied per frame in update(), not per event,
   * so travel speed is frame-rate independent and diagonals do not double. */
  private held = new Set<string>();
  private boost = false;
  /** Only the lens on screen listens: a paused renderer must not eat WASD. */
  private flyEnabled = true;
  /** Scratch vectors — update() runs every frame and must not allocate. */
  private vRight = new THREE.Vector3();
  private vUp = new THREE.Vector3();
  private vFwd = new THREE.Vector3();
  private vMove = new THREE.Vector3();

  constructor(el: HTMLElement, aspect: number) {
    this.el = el;
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.01, 60);
    this.update(0);

    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  /** Enable/disable flight input. Also clears held keys, so switching lens
   * mid-press cannot leave the camera drifting forever. */
  setFlyEnabled(v: boolean): void {
    this.flyEnabled = v;
    if (!v) {
      this.held.clear();
      this.boost = false;
    }
  }

  /** True while at least one fly key is down — the HUD reads this. */
  get flying(): boolean {
    return this.held.size > 0;
  }

  private typing(): boolean {
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    return tag === "input" || tag === "select" || tag === "textarea";
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.flyEnabled || this.typing()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Shift") {
      this.boost = true;
      return;
    }
    const k = e.key.toLowerCase();
    if (!(k in FLY_KEYS)) return;
    e.preventDefault();
    if (!this.held.has(k)) this.cancelFlight();
    this.held.add(k);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === "Shift") this.boost = false;
    this.held.delete(e.key.toLowerCase());
  };

  /** Losing focus mid-press never delivers the keyup. */
  private onBlur = (): void => {
    this.held.clear();
    this.boost = false;
  };

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

  /** Apply held fly keys for one frame. Returns true if the camera moved. */
  private fly(dt: number): boolean {
    if (!this.held.size || dt <= 0) return false;
    let rx = 0;
    let uy = 0;
    let fz = 0;
    for (const k of this.held) {
      const v = FLY_KEYS[k];
      if (!v) continue;
      rx += v[0];
      uy += v[1];
      fz += v[2];
    }
    if (rx === 0 && uy === 0 && fz === 0) return false;

    this.vRight.setFromMatrixColumn(this.camera.matrix, 0);
    this.vUp.setFromMatrixColumn(this.camera.matrix, 1);
    // matrix column 2 points BEHIND the camera in three.js, so forward is -Z.
    this.vFwd.setFromMatrixColumn(this.camera.matrix, 2).negate();

    this.vMove
      .set(0, 0, 0)
      .addScaledVector(this.vRight, rx)
      .addScaledVector(this.vUp, uy)
      .addScaledVector(this.vFwd, fz);
    if (this.vMove.lengthSq() < 1e-12) return false;
    // Normalised: holding W+A must not travel √2 faster than W alone.
    this.vMove.normalize();

    // Speed is capped against the GRAPH's scale, not the orbit radius alone.
    // Scaling purely with radius meant a single 0.7 s press at the default
    // framing travelled 1.8 units through a corpus that is 2 units across —
    // you left the tissue before you saw it. The radius term survives so that
    // flying stays fine-grained once you are inside a lobe.
    const speed = Math.min(this.sph.radius, 1.1) * (this.boost ? 1.9 : 0.62);
    this.target.addScaledVector(this.vMove, speed * dt);
    // Stay inside the dolly clamp's world: flying far outside the graph and
    // then scrolling would otherwise strand the reader in empty space.
    const reach = 6;
    if (this.target.lengthSq() > reach * reach) this.target.setLength(reach);
    return true;
  }

  update(dt: number): void {
    if (this.fly(dt)) this.flight = null;
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
    this.flyTo(new THREE.Vector3(0, 0, 0), 2.8, 0.9);
  }

  setAspect(aspect: number): void {
    const wasPortrait = this.camera.aspect < 0.8;
    this.camera.aspect = aspect;
    // portrait screens: widen the vertical fov so the structure fits horizontally
    this.camera.fov = aspect < 1 ? Math.min(84, 52 / Math.pow(aspect, 0.6)) : 52;
    if (aspect < 0.8 && !wasPortrait && this.sph.radius < 3.4) this.sph.radius = 3.8;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("pointermove", this.onMove);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onUp);
    this.el.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }
}
