import { GEO_COLORS } from "./palette";

/**
 * City labels, pooled and strictly budgeted.
 *
 * Priority, highest first: the current event's location, the selected place,
 * pinned places, then the scope's heaviest places. The budget is small on
 * purpose — a globe carpeted in permanent city names is unreadable, and the
 * names that matter are the ones tied to what is happening right now.
 *
 * Cesium's own declutter handles the residual overlap; the priority order is
 * what decides who survives it.
 */

export interface LabelSpec {
  placeIdx: number;
  latitude: number;
  longitude: number;
  text: string;
  /** Higher wins a slot. */
  priority: number;
  gold?: boolean;
}

export class GeoLabelLayer {
  private Cesium: any;
  private labels: any;
  private cap = 22;

  constructor(Cesium: any, scene: any, cap: number) {
    this.Cesium = Cesium;
    this.labels = scene.primitives.add(new Cesium.LabelCollection());
    this.cap = cap;
  }

  setCap(cap: number): void {
    this.cap = cap;
  }

  get active(): number {
    return this.labels.length;
  }

  /** Replace the whole label set. Cheap because the collection is small by
   * construction — this is called on selection and on batch change, not per
   * frame. */
  set(specs: LabelSpec[]): void {
    const C = this.Cesium;
    const chosen = specs
      .slice()
      .sort((a, b) => b.priority - a.priority || a.placeIdx - b.placeIdx)
      .slice(0, this.cap);
    while (this.labels.length > chosen.length) this.labels.remove(this.labels.get(this.labels.length - 1));
    for (let i = 0; i < chosen.length; i++) {
      const s = chosen[i]!;
      const rgb = s.gold ? GEO_COLORS.gold : GEO_COLORS.label;
      const opts = {
        position: C.Cartesian3.fromDegrees(s.longitude, s.latitude),
        text: s.text,
        font: "500 12px ui-monospace, SFMono-Regular, Menlo, monospace",
        fillColor: new C.Color(rgb[0], rgb[1], rgb[2], 0.95),
        outlineColor: new C.Color(
          GEO_COLORS.labelHalo[0], GEO_COLORS.labelHalo[1], GEO_COLORS.labelHalo[2], 0.9,
        ),
        outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new C.Cartesian2(0, -14),
        horizontalOrigin: C.HorizontalOrigin.CENTER,
        verticalOrigin: C.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Hide labels for places on the far side of the globe; without this the
        // whole world's names show through the earth at once.
        translucencyByDistance: new C.NearFarScalar(1.0e6, 1.0, 4.0e7, 0.35),
      };
      if (i < this.labels.length) {
        Object.assign(this.labels.get(i), opts);
      } else {
        this.labels.add(opts);
      }
    }
  }

  clear(): void {
    this.labels.removeAll();
  }

  destroy(scene: any): void {
    scene.primitives.remove(this.labels);
    this.labels = null;
  }
}
