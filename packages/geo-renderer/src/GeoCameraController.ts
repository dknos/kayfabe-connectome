import type { CameraMode } from "./types";

/**
 * Camera behaviour for playback.
 *
 * Two rules dominate the design:
 *
 *  1. Manual input always wins. Touching the globe suspends automatic camera
 *     control for a grace period, because a camera that fights the user is
 *     worse than one that never moves.
 *  2. Automatic movement is suppressed at speed. Flying between ten locations
 *     a second is nausea, not information, so follow degrades to a stationary
 *     world view once events arrive faster than a flight can finish.
 */

const MANUAL_GRACE_MS = 6000;
/** Below this separation a follow is not worth a flight — the next city is
 * already on screen, and moving anyway reads as drift. */
const NEAR_DEGREES = 12;
const WORLD_HEIGHT = 22_000_000;

export class GeoCameraController {
  private Cesium: any;
  private viewer: any;
  mode: CameraMode = "world";
  reducedMotion = false;
  /** Wall-clock ms until automatic control resumes after manual input. */
  private manualUntil = 0;
  private lastLon = Number.NaN;
  private lastLat = Number.NaN;
  private flying = false;

  constructor(Cesium: any, viewer: any) {
    this.Cesium = Cesium;
    this.viewer = viewer;
  }

  /** Called by the engine whenever the user drags, wheels or pinches. */
  noteManualInput(now: number): void {
    this.manualUntil = now + MANUAL_GRACE_MS;
  }

  get manualHold(): boolean {
    return this.now() < this.manualUntil;
  }

  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : 0;
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === "world") this.world();
  }

  world(): void {
    const C = this.Cesium;
    this.fly({
      destination: C.Cartesian3.fromDegrees(-30, 20, WORLD_HEIGHT),
      orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
      duration: this.reducedMotion ? 0 : 1.2,
    });
  }

  /** Frame one place. Always allowed — this is an explicit user action, so it
   * ignores the manual-input hold rather than being swallowed by it. */
  focus(lat: number, lon: number, heightM = 900_000): void {
    const C = this.Cesium;
    this.fly({
      destination: C.Cartesian3.fromDegrees(lon, lat, heightM),
      duration: this.reducedMotion ? 0 : 1.0,
    });
  }

  /** Frame a set of places (the active scope's footprint). */
  fit(coords: Array<[number, number]>): void {
    if (!coords.length) return this.world();
    const C = this.Cesium;
    let west = 180, east = -180, south = 90, north = -90;
    for (const [lat, lon] of coords) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    // A degenerate box (one place, or a scope confined to one city) has no
    // extent to frame, so pad it into something the camera can fly to.
    if (east - west < 1) { west -= 3; east += 3; }
    if (north - south < 1) { south -= 3; north += 3; }
    this.viewer.camera.flyTo({
      destination: C.Rectangle.fromDegrees(west, south, east, north),
      duration: this.reducedMotion ? 0 : 1.2,
    });
  }

  /**
   * React to the current event location during playback. Returns true when the
   * camera actually moved, which the engine reports in its stats.
   */
  onEvent(lat: number, lon: number, eventsPerSecond: number): boolean {
    if (this.mode === "free" || this.mode === "region" || this.mode === "world") return false;
    if (this.manualHold) return false;
    // Above this rate a flight cannot finish before the next event arrives, so
    // following would only ever show a blur of half-completed movements.
    if (eventsPerSecond > 4) return false;
    if (this.reducedMotion) {
      // Reduced motion still tracks location, but steps rather than flies.
      this.viewer.camera.setView({
        destination: this.Cesium.Cartesian3.fromDegrees(lon, lat, 2_400_000),
      });
      this.lastLat = lat;
      this.lastLon = lon;
      return true;
    }
    if (this.mode === "smart" && Number.isFinite(this.lastLat)) {
      const d = Math.hypot(lat - this.lastLat, lon - this.lastLon);
      if (d < NEAR_DEGREES) return false;
    }
    this.lastLat = lat;
    this.lastLon = lon;
    const C = this.Cesium;
    const height = this.mode === "tour" ? 1_600_000 : 2_600_000;
    const pitch = this.mode === "tour" ? -42 : -78;
    this.fly({
      destination: C.Cartesian3.fromDegrees(lon, lat - (this.mode === "tour" ? 6 : 0), height),
      orientation: { heading: 0, pitch: C.Math.toRadians(pitch), roll: 0 },
      duration: Math.min(1.4, 0.7 / Math.max(0.35, eventsPerSecond)),
    });
    return true;
  }

  private fly(opts: any): void {
    if (!this.viewer || this.viewer.isDestroyed?.()) return;
    // Cancelling first stops flights from queueing when events outpace them.
    this.viewer.camera.cancelFlight?.();
    this.flying = true;
    this.viewer.camera.flyTo({
      ...opts,
      complete: () => { this.flying = false; },
      cancel: () => { this.flying = false; },
    });
  }

  get isFlying(): boolean {
    return this.flying;
  }
}
