import { GEO_COLORS, heatColor } from "./palette";
import type { GeoPlace } from "./types";

/**
 * The accumulated geographic footprint: one persistent point per place, sized
 * and coloured by the active metric.
 *
 * This layer is also the PICK TARGET. Every place in scope carries a point
 * here — dim but present — so clicking a city works whether or not a card is
 * currently lighting it, and so the footprint of a finished playback stays
 * inspectable.
 *
 * The weights it draws come from the scheduler's exact per-place counters. The
 * layer decides size and colour; it never decides what happened.
 */
export class GeoHeatLayer {
  private Cesium: any;
  private points: any;
  private places: GeoPlace[] = [];
  /** placeIdx -> primitive index, so a weight update is O(1). */
  private slotOf = new Map<number, number>();
  private weights: Float64Array = new Float64Array(0);
  private peak = 1;
  private visible = true;
  private selected = -1;

  constructor(Cesium: any, scene: any) {
    this.Cesium = Cesium;
    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
  }

  /**
   * Rebuild for a new scope. Places are the ones the current scope can reach;
   * anything beyond the quality cap is dropped from the DRAWING only, keeps
   * its analytical weight, and is reported by `truncated` so the UI can say so
   * rather than implying full coverage.
   */
  setPlaces(places: GeoPlace[], cap: number): void {
    const C = this.Cesium;
    this.places = places;
    this.weights = new Float64Array(places.length);
    this.slotOf.clear();
    this.points.removeAll();
    // Densest places first, so a cap trims the tail rather than an arbitrary
    // slice — the places a reader would notice missing survive.
    const order = places
      .map((_p, i) => i)
      .sort((a, b) => (places[b]?.cards ?? 0) - (places[a]?.cards ?? 0) || a - b)
      .slice(0, cap);
    for (const i of order) {
      const p = places[i]!;
      const slot = this.points.length;
      this.points.add({
        position: C.Cartesian3.fromDegrees(p.longitude, p.latitude),
        color: C.Color.TRANSPARENT,
        pixelSize: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        id: { kind: "place", placeIdx: i },
      });
      this.slotOf.set(i, slot);
    }
    this.peak = 1;
    this.redraw();
  }

  get truncated(): number {
    return Math.max(0, this.places.length - this.slotOf.size);
  }

  get drawn(): number {
    return this.slotOf.size;
  }

  /** Replace every weight (accumulate / sliding-window recomputes wholesale). */
  setWeights(weights: Float64Array): void {
    this.weights = weights;
    this.peak = 1;
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i]!;
      if (w > this.peak) this.peak = w;
    }
    this.redraw();
  }

  /** Add to one place's weight (the accumulate path during playback). */
  add(placeIdx: number, amount: number): void {
    if (placeIdx < 0 || placeIdx >= this.weights.length) return;
    const w = (this.weights[placeIdx]! += amount);
    if (w > this.peak) {
      // A new peak rescales everything, so redraw wholesale rather than
      // leaving the rest of the map on a stale normalisation.
      this.peak = w;
      this.redraw();
    } else {
      this.paint(placeIdx);
    }
  }

  reset(): void {
    this.weights.fill(0);
    this.peak = 1;
    this.redraw();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.points.show = on;
  }

  setSelected(placeIdx: number): void {
    const prev = this.selected;
    this.selected = placeIdx;
    if (prev >= 0) this.paint(prev);
    if (placeIdx >= 0) this.paint(placeIdx);
  }

  private redraw(): void {
    for (const idx of this.slotOf.keys()) this.paint(idx);
  }

  private paint(placeIdx: number): void {
    const slot = this.slotOf.get(placeIdx);
    if (slot === undefined) return;
    const C = this.Cesium;
    const p = this.points.get(slot);
    const w = this.weights[placeIdx] ?? 0;
    const t = w / this.peak;
    if (placeIdx === this.selected) {
      const s = GEO_COLORS.select;
      p.color = new C.Color(s[0], s[1], s[2], 1);
      p.pixelSize = 11;
      return;
    }
    if (w <= 0) {
      // Present but unvisited: a faint dot keeps the place clickable and shows
      // the scope's reachable geography without claiming activity there.
      p.color = new C.Color(0.35, 0.45, 0.6, this.visible ? 0.22 : 0);
      p.pixelSize = 2.5;
      return;
    }
    const [r, g, b] = heatColor(t);
    p.color = new C.Color(r, g, b, 0.35 + 0.55 * Math.sqrt(t));
    p.pixelSize = 3 + Math.sqrt(t) * 13;
  }

  destroy(scene: any): void {
    scene.primitives.remove(this.points);
    this.points = null;
    this.slotOf.clear();
    this.places = [];
  }
}
