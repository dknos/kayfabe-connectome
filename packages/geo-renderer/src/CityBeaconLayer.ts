import { GEO_COLORS, type RGB } from "./palette";
import type { BeaconSpec } from "./types";

/**
 * Pooled city beacons: a bright core, an expanding surface ripple, and an
 * optional vertical light column.
 *
 * Everything is drawn from three fixed-size primitive COLLECTIONS allocated
 * once. Nothing is created or destroyed per card — at 100 cards/second, an
 * entity-per-card design would spend its whole frame budget in allocation and
 * would leak GPU buffers on scrub. Retiring a beacon means setting its alpha
 * to zero and returning its slot to a free list.
 */

interface Slot {
  /** Wall-clock ms remaining; <= 0 means the slot is free. */
  life: number;
  total: number;
  energy: number;
  gold: boolean;
  placeIdx: number;
}

const NO_SLOT = -1;

export class CityBeaconLayer {
  private Cesium: any;
  private cores: any;
  private rings: any;
  private columns: any;
  private coreSlots: Slot[] = [];
  private ringSlots: Slot[] = [];
  private columnSlots: Slot[] = [];
  private coreFree: number[] = [];
  private ringFree: number[] = [];
  private columnFree: number[] = [];
  /** placeIdx -> live core slot, so repeat hits on one place re-energise the
   * existing beacon rather than stacking identical primitives on one pixel. */
  private byPlace = new Map<number, number>();

  private coreMs = 1500;
  private ringMs = 1300;
  private reducedMotion = false;

  constructor(Cesium: any, scene: any, caps: { beaconCap: number; ringCap: number; columnCap: number }) {
    this.Cesium = Cesium;
    this.cores = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.rings = scene.primitives.add(new Cesium.PointPrimitiveCollection());
    this.columns = scene.primitives.add(new Cesium.PolylineCollection());
    this.allocate(caps);
  }

  /** Pre-allocate every primitive the highest tier can use. Lower tiers simply
   * leave the tail of each pool idle — resizing pools at runtime is what
   * causes the buffer churn this design exists to avoid. */
  private allocate(caps: { beaconCap: number; ringCap: number; columnCap: number }): void {
    const C = this.Cesium;
    const dead = C.Color.TRANSPARENT;
    for (let i = this.coreSlots.length; i < caps.beaconCap; i++) {
      this.cores.add({
        position: C.Cartesian3.ZERO,
        color: dead,
        pixelSize: 1,
        // Beacons must stay visible when the globe's depth buffer would hide a
        // surface-level point behind terrain-free ellipsoid curvature.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      this.coreSlots.push({ life: 0, total: 1, energy: 0, gold: false, placeIdx: -1 });
      this.coreFree.push(i);
    }
    for (let i = this.ringSlots.length; i < caps.ringCap; i++) {
      this.rings.add({
        position: C.Cartesian3.ZERO,
        color: dead,
        outlineColor: dead,
        outlineWidth: 2,
        pixelSize: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      this.ringSlots.push({ life: 0, total: 1, energy: 0, gold: false, placeIdx: -1 });
      this.ringFree.push(i);
    }
    for (let i = this.columnSlots.length; i < caps.columnCap; i++) {
      this.columns.add({
        positions: [C.Cartesian3.ZERO, C.Cartesian3.ZERO],
        width: 2,
        material: C.Material.fromType("Color", { color: dead }),
      });
      this.columnSlots.push({ life: 0, total: 1, energy: 0, gold: false, placeIdx: -1 });
      this.columnFree.push(i);
    }
  }

  setCaps(caps: { beaconCap: number; ringCap: number; columnCap: number }): void {
    this.allocate(caps);
  }

  setDurations(coreMs: number, ringMs: number): void {
    this.coreMs = coreMs;
    this.ringMs = ringMs;
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  get activeCounts(): { cores: number; rings: number; columns: number } {
    return {
      cores: this.coreSlots.length - this.coreFree.length,
      rings: this.ringSlots.length - this.ringFree.length,
      columns: this.columnSlots.length - this.columnFree.length,
    };
  }

  /**
   * Ignite one beacon. Returns false only when every core slot is busy, which
   * the caller reports as visual aggregation pressure — the underlying card is
   * still counted upstream either way.
   */
  ignite(spec: BeaconSpec): boolean {
    const C = this.Cesium;
    const pos = C.Cartesian3.fromDegrees(spec.longitude, spec.latitude);

    const live = this.byPlace.get(spec.placeIdx);
    if (live !== undefined && this.coreSlots[live]!.life > 0) {
      // Same place, still glowing: fold the new card's energy in and restart
      // the decay instead of stacking a second identical dot on one pixel.
      const s = this.coreSlots[live]!;
      s.energy = Math.min(1, s.energy + spec.energy * 0.6);
      s.gold = s.gold || spec.gold;
      s.life = s.total;
      return true;
    }

    const idx = this.coreFree.pop() ?? NO_SLOT;
    if (idx === NO_SLOT) return false;
    const slot = this.coreSlots[idx]!;
    slot.life = slot.total = this.reducedMotion ? this.coreMs * 0.5 : this.coreMs;
    slot.energy = spec.energy;
    slot.gold = spec.gold;
    slot.placeIdx = spec.placeIdx;
    this.byPlace.set(spec.placeIdx, idx);
    const p = this.cores.get(idx);
    p.position = pos;
    p.id = { kind: "beacon", placeIdx: spec.placeIdx };

    // Reduced motion keeps the location highlight but drops travelling effects:
    // the ripple and the rising column are exactly the parts that move.
    if (!this.reducedMotion) {
      const r = this.ringFree.pop() ?? NO_SLOT;
      if (r !== NO_SLOT) {
        const rs = this.ringSlots[r]!;
        rs.life = rs.total = this.ringMs;
        rs.energy = spec.energy;
        rs.gold = spec.gold;
        rs.placeIdx = spec.placeIdx;
        const rp = this.rings.get(r);
        rp.position = pos;
        rp.id = { kind: "beacon", placeIdx: spec.placeIdx };
      }
      const c = this.columnFree.pop() ?? NO_SLOT;
      if (c !== NO_SLOT) {
        const cs = this.columnSlots[c]!;
        cs.life = cs.total = this.coreMs;
        cs.energy = spec.energy;
        cs.gold = spec.gold;
        cs.placeIdx = spec.placeIdx;
        const cp = this.columns.get(c);
        const height = 40_000 + spec.energy * 620_000;
        cp.positions = [
          C.Cartesian3.fromDegrees(spec.longitude, spec.latitude, 0),
          C.Cartesian3.fromDegrees(spec.longitude, spec.latitude, height),
        ];
      }
    }
    return true;
  }

  /** Advance every live slot. Returns true while anything is still animating,
   * which is what keeps requestRenderMode from going back to sleep. */
  update(dtMs: number): boolean {
    const C = this.Cesium;
    let alive = false;

    for (let i = 0; i < this.coreSlots.length; i++) {
      const s = this.coreSlots[i]!;
      if (s.life <= 0) continue;
      s.life -= dtMs;
      const p = this.cores.get(i);
      if (s.life <= 0) {
        p.color = C.Color.TRANSPARENT;
        p.pixelSize = 1;
        this.coreFree.push(i);
        if (this.byPlace.get(s.placeIdx) === i) this.byPlace.delete(s.placeIdx);
        continue;
      }
      alive = true;
      const t = s.life / s.total; // 1 -> 0
      const rgb: RGB = s.gold ? GEO_COLORS.goldCore : GEO_COLORS.beaconHot;
      // Fade out on a curve rather than linearly so the ignition frame reads as
      // a flash and the tail lingers just long enough to be followed by eye.
      const a = t * t * (0.55 + 0.45 * s.energy);
      p.color = new C.Color(rgb[0], rgb[1], rgb[2], a);
      p.pixelSize = 4 + s.energy * 9 + (1 - t) * 2;
    }

    for (let i = 0; i < this.ringSlots.length; i++) {
      const s = this.ringSlots[i]!;
      if (s.life <= 0) continue;
      s.life -= dtMs;
      const p = this.rings.get(i);
      if (s.life <= 0) {
        p.color = C.Color.TRANSPARENT;
        p.outlineColor = C.Color.TRANSPARENT;
        p.pixelSize = 1;
        p.outlineWidth = 0;
        this.ringFree.push(i);
        continue;
      }
      alive = true;
      const t = 1 - s.life / s.total; // 0 -> 1, the expansion
      const rgb: RGB = s.gold ? GEO_COLORS.gold : GEO_COLORS.ring;
      const a = (1 - t) * (1 - t) * 0.75;
      // Transparent fill + coloured outline = a ring, drawn by one pooled point
      // primitive instead of an ellipse entity rebuilt every frame.
      p.color = C.Color.TRANSPARENT;
      p.outlineColor = new C.Color(rgb[0], rgb[1], rgb[2], a);
      p.outlineWidth = s.gold ? 2.4 : 1.6;
      p.pixelSize = 5 + t * (26 + s.energy * 30);
    }

    for (let i = 0; i < this.columnSlots.length; i++) {
      const s = this.columnSlots[i]!;
      if (s.life <= 0) continue;
      s.life -= dtMs;
      const p = this.columns.get(i);
      if (s.life <= 0) {
        p.material.uniforms.color = C.Color.TRANSPARENT;
        this.columnFree.push(i);
        continue;
      }
      alive = true;
      const t = s.life / s.total;
      const rgb: RGB = s.gold ? GEO_COLORS.gold : GEO_COLORS.column;
      p.material.uniforms.color = new C.Color(rgb[0], rgb[1], rgb[2], t * t * 0.5);
      p.width = s.gold ? 2.5 : 1.5;
    }
    return alive;
  }

  /** Retire every beacon immediately — used on scope change and on scrub, so a
   * new range never inherits the previous one's glow. */
  clear(): void {
    const C = this.Cesium;
    for (let i = 0; i < this.coreSlots.length; i++) {
      if (this.coreSlots[i]!.life > 0) this.coreFree.push(i);
      this.coreSlots[i]!.life = 0;
      this.cores.get(i).color = C.Color.TRANSPARENT;
    }
    for (let i = 0; i < this.ringSlots.length; i++) {
      if (this.ringSlots[i]!.life > 0) this.ringFree.push(i);
      this.ringSlots[i]!.life = 0;
      const p = this.rings.get(i);
      p.color = C.Color.TRANSPARENT;
      p.outlineColor = C.Color.TRANSPARENT;
    }
    for (let i = 0; i < this.columnSlots.length; i++) {
      if (this.columnSlots[i]!.life > 0) this.columnFree.push(i);
      this.columnSlots[i]!.life = 0;
      this.columns.get(i).material.uniforms.color = C.Color.TRANSPARENT;
    }
    this.byPlace.clear();
  }

  destroy(scene: any): void {
    scene.primitives.remove(this.cores);
    scene.primitives.remove(this.rings);
    scene.primitives.remove(this.columns);
    this.cores = this.rings = this.columns = null;
    this.coreSlots = this.ringSlots = this.columnSlots = [];
    this.coreFree = this.ringFree = this.columnFree = [];
    this.byPlace.clear();
  }
}
