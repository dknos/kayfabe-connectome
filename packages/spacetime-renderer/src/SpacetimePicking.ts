/**
 * Picking: exact raycast for event beads, bounded screen-space test for
 * worldlines.
 *
 * Beads are CPU-positioned InstancedMesh instances, so the raycast is exact —
 * with the arena's mandatory fix applied: InstancedMesh bounds are never
 * recomputed as instances move, so computeBoundingSphere() runs on every pick
 * or the stale sphere silently eats hits (measured at 69.5% agreement in the
 * arena spikes before the fix).
 *
 * Worldlines are shader-positioned and invisible to the raycaster; a click
 * near one is resolved by projecting each drawn line's samples through the
 * SAME TS lens and testing screen distance — a few thousand projections per
 * pointer event, bounded by the tier's worldline budget.
 */
import { Raycaster, Vector2, Vector3, type Camera } from "three";
import type { EventField } from "./EventField";
import { SAMPLE_STRIDE, type WorldlinePath } from "./SpacetimeLayout";
import {
  DAYS_PER_YEAR, focusF, timeAxisX,
  type SpacetimePickResult, type TimeAxis,
} from "./types";

const LINE_PICK_PX = 7;

export class SpacetimePicking {
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly v = new Vector3();

  pickEvent(
    events: EventField, camera: Camera, px: number, py: number, w: number, h: number,
  ): number | null {
    this.ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, camera as never);
    events.mesh.computeBoundingSphere();
    const hits = this.raycaster.intersectObject(events.mesh, false);
    for (const hit of hits) {
      if (hit.instanceId !== undefined && hit.instanceId < events.count) {
        return hit.instanceId;
      }
    }
    return null;
  }

  /** Nearest drawn worldline within LINE_PICK_PX of the pointer, or null.
   *  Returns the path's relIndex (-1 is the subject's own line). */
  pickLine(
    lines: WorldlinePath[], axis: TimeAxis, camera: Camera,
    px: number, py: number, w: number, h: number,
  ): number | null {
    let best: number | null = null;
    let bestD = LINE_PICK_PX;
    for (const path of lines) {
      const s = path.samples;
      const n = s.length / SAMPLE_STRIDE;
      for (let k = 0; k < n; k++) {
        const o = k * SAMPLE_STRIDE;
        if (s[o + 3]! <= 0) continue; // dissolved samples make no claim
        // The same focus blend the ribbon shader draws with, or the hit test
        // would answer for geometry that is not on screen.
        const conv = focusF((s[o]! - axis.playheadDay) / DAYS_PER_YEAR, axis.bubbleR, axis.bubbleSigma);
        this.v.set(
          timeAxisX(s[o]!, axis),
          s[o + 6]! + (s[o + 1]! - s[o + 6]!) * conv,
          s[o + 7]! + (s[o + 2]! - s[o + 7]!) * conv,
        ).project(camera);
        if (this.v.z > 1 || this.v.z < -1) continue;
        const sx = (this.v.x * 0.5 + 0.5) * w;
        const sy = (-this.v.y * 0.5 + 0.5) * h;
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestD) {
          bestD = d;
          best = path.relIndex;
        }
      }
    }
    return best;
  }

  pick(
    events: EventField, lines: WorldlinePath[], axis: TimeAxis, camera: Camera,
    px: number, py: number, w: number, h: number,
    idOfEvent: (index: number) => string,
    idOfRel: (relIndex: number) => string,
  ): SpacetimePickResult | null {
    const ev = this.pickEvent(events, camera, px, py, w, h);
    if (ev !== null) return { kind: "event", index: ev, id: idOfEvent(ev) };
    const line = this.pickLine(lines, axis, camera, px, py, w, h);
    if (line !== null) return { kind: "person", index: line, id: idOfRel(line) };
    return null;
  }
}
