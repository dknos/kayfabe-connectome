/**
 * Card picking.
 *
 * Instanced raycast, chosen by measurement rather than by preference. SPIKE 2
 * put three mechanisms against a pixel-exact GPU-ID reference on the same
 * field: raycast agreed 96.8–100% at 160/360/600 cards, while the camera
 * orbited and mid-transition, for 0.1–0.2 ms. GPU-ID picking was correct but
 * cost 3 ms per sample INCLUDING idle pointer movement, plus a driver-reported
 * stall on every readback. A projected-distance scan — the technique this
 * repository already ships for the Morph lens — does not transfer to rotated
 * card quads; approximating an oriented quad with a screen-aligned box swung
 * between 6.8% and 100% agreement.
 *
 * The bounds recompute below is NOT optional. InstancedMesh.boundingSphere is
 * null until computed and is never recomputed as instances move, so a
 * transitioning field silently misses: measured at 69.5% agreement with 67
 * false misses, cards the pointer sits directly on that report nothing.
 */
import { Raycaster, Vector2, type Camera, type Intersection, type Object3D } from "three";
import type { ArenaCards } from "./ArenaCards";
import type { ArenaTransition } from "./ArenaTransition";
import { CS, type ArenaPickResult } from "./types";

export class ArenaPicking {
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  /** Reused so a pointer move allocates nothing. */
  private readonly hits: Intersection<Object3D>[] = [];

  constructor() {
    // Fat routes read their hover tolerance from this bucket, and it does not
    // exist by default: Raycaster.params ships Mesh/Line/LOD/Points/Sprite
    // only, and LineSegments2 falls back to a threshold of 0. Measured, that
    // is the difference between a 90% and a 60% hit-rate 5 px off a route.
    this.raycaster.params.Line2 = { threshold: 6 };
  }

  /** Screen-space hover tolerance for routes, in CSS pixels. */
  setRouteThreshold(px: number): void {
    this.raycaster.params.Line2 = { threshold: px };
  }

  pick(
    cards: ArenaCards, transition: ArenaTransition, camera: Camera,
    px: number, py: number, widthPx: number, heightPx: number,
    idOfSlot: (slot: number) => string | null,
  ): ArenaPickResult | null {
    if (widthPx <= 0 || heightPx <= 0) return null;
    this.ndc.set((px / widthPx) * 2 - 1, -(py / heightPx) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera);
    // Instances moved since the last pick; stale bounds cull real hits.
    cards.mesh.computeBoundingSphere();
    this.hits.length = 0;
    cards.mesh.raycast(this.raycaster, this.hits);
    if (this.hits.length === 0) return null;
    this.hits.sort((a, b) => a.distance - b.distance);
    for (const hit of this.hits) {
      const slot = hit.instanceId;
      if (slot === undefined) continue;
      if (transition.state[slot] === CS.ABSENT) continue;
      const id = idOfSlot(slot);
      if (!id) continue;
      return { id, slot };
    }
    return null;
  }
}
