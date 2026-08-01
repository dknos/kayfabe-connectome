import { GEO_COLORS } from "./palette";
import type { ArcSpec } from "./types";

/**
 * Chronological record connections.
 *
 * An arc here means exactly one thing: these are CONSECUTIVE PLOTTED RECORDS
 * in the selected scope. It is not a tour route, not a travel path, and not
 * evidence that anyone went directly from one city to the other. The scheduler
 * decides which consecutive pairs are eligible (never same-day cards of one
 * promotion, which would invent a route out of a scheduling coincidence); this
 * layer only draws them, dim and short-lived, so they read as annotation
 * rather than as infrastructure.
 *
 * Pooled polylines, allocated once. Arcs are raised above the ellipsoid so
 * they are legible across a hemisphere without z-fighting the surface.
 */

interface ArcSlot {
  life: number;
  total: number;
  strength: number;
}

const SEGMENTS = 24;
/** Peak arc height as a fraction of the great-circle distance. Flat enough to
 * stay readable at world zoom, high enough to clear the limb on long hops. */
const ARC_RISE = 0.16;

export class GeoArcLayer {
  private Cesium: any;
  private lines: any;
  private slots: ArcSlot[] = [];
  private free: number[] = [];
  private lifeMs = 2600;
  private reducedMotion = false;

  constructor(Cesium: any, scene: any, cap: number) {
    this.Cesium = Cesium;
    this.lines = scene.primitives.add(new Cesium.PolylineCollection());
    this.allocate(cap);
  }

  private allocate(cap: number): void {
    const C = this.Cesium;
    const zeros = new Array(SEGMENTS + 1).fill(C.Cartesian3.ZERO);
    for (let i = this.slots.length; i < cap; i++) {
      this.lines.add({
        positions: zeros.slice(),
        width: 1.2,
        material: C.Material.fromType("Color", { color: C.Color.TRANSPARENT }),
      });
      this.slots.push({ life: 0, total: 1, strength: 0 });
      this.free.push(i);
    }
  }

  setCap(cap: number): void {
    this.allocate(cap);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  get active(): number {
    return this.slots.length - this.free.length;
  }

  /**
   * Draw one record connection. Returns false when the pool is exhausted; the
   * caller counts that as visual pressure, never as a lost record — the
   * connection is a derived annotation, not a datum.
   */
  add(spec: ArcSpec): boolean {
    const idx = this.free.pop();
    if (idx === undefined) return false;
    const C = this.Cesium;
    const slot = this.slots[idx]!;
    slot.life = slot.total = this.reducedMotion ? this.lifeMs * 3 : this.lifeMs;
    slot.strength = spec.strength;

    // Sample the geodesic and lift the middle — a straight Cartesian chord
    // would sink through the globe on any hop longer than a few hundred km.
    const geo = new C.EllipsoidGeodesic(
      C.Cartographic.fromDegrees(spec.fromLon, spec.fromLat),
      C.Cartographic.fromDegrees(spec.toLon, spec.toLat),
    );
    const surface = geo.surfaceDistance;
    const peak = surface * ARC_RISE;
    const positions: any[] = [];
    for (let s = 0; s <= SEGMENTS; s++) {
      const f = s / SEGMENTS;
      const c = geo.interpolateUsingFraction(f);
      positions.push(
        C.Cartesian3.fromRadians(c.longitude, c.latitude, Math.sin(f * Math.PI) * peak),
      );
    }
    const line = this.lines.get(idx);
    line.positions = positions;
    return true;
  }

  update(dtMs: number): boolean {
    const C = this.Cesium;
    let alive = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.life <= 0) continue;
      s.life -= dtMs;
      const line = this.lines.get(i);
      if (s.life <= 0) {
        line.material.uniforms.color = C.Color.TRANSPARENT;
        this.free.push(i);
        continue;
      }
      alive = true;
      const t = s.life / s.total;
      const [r, g, b] = GEO_COLORS.arc;
      line.material.uniforms.color = new C.Color(r, g, b, t * 0.5 * (0.4 + 0.6 * s.strength));
      line.width = 0.9 + s.strength * 1.2;
    }
    return alive;
  }

  clear(): void {
    const C = this.Cesium;
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]!.life > 0) this.free.push(i);
      this.slots[i]!.life = 0;
      this.lines.get(i).material.uniforms.color = C.Color.TRANSPARENT;
    }
  }

  destroy(scene: any): void {
    scene.primitives.remove(this.lines);
    this.lines = null;
    this.slots = [];
    this.free = [];
  }
}
