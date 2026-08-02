import * as THREE from "three";
import type { RatingCamera } from "./RatingCamera";
import type { RatingAggregateRidges } from "./RatingAggregateRidges";
import type { RatingPeaks } from "./RatingPeaks";
import type { RatingPickDiagnostic, RatingPickResult, RatingPickSource } from "./types";

export interface RatingPickInput {
  x: number;
  y: number;
  pointerType: "mouse" | "pen" | "touch";
  camera: RatingCamera;
  peaks: RatingPeaks;
  aggregates: RatingAggregateRidges;
  matchIds: readonly string[];
  aggregateAlpha: number;
  exactAlpha: number;
  morph: number;
  settled: boolean;
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const projected = { x: 0, y: 0, front: false, depth: 0 };
const exactTip = new Float32Array(3);

/** Official InstancedMesh raycasting first, bounded projected fallback second. */
export function pickRating(input: RatingPickInput, diagnostic: RatingPickDiagnostic): RatingPickResult | null {
  const start = performance.now();
  const width = input.camera.el.clientWidth || 2;
  const height = input.camera.el.clientHeight || 2;
  ndc.set((input.x / width) * 2 - 1, -(input.y / height) * 2 + 1);
  raycaster.setFromCamera(ndc, input.camera.camera);
  let source: RatingPickSource = "instance-raycast";
  let result: RatingPickResult | null = null;
  let candidates = 0;

  if (input.exactAlpha >= 0.08 && input.settled && input.peaks.mesh.visible) {
    const hits = raycaster.intersectObject(input.peaks.mesh, false);
    candidates += hits.length;
    for (const hit of hits) {
      const instanceId = hit.instanceId ?? -1;
      if (instanceId < 0 || input.peaks.opacityAt(instanceId, input.morph) < 0.03) continue;
      const id = input.matchIds[instanceId];
      if (!id) continue;
      result = { id, kind: "match", instanceId, depth: hit.distance, normalizedDistance: 0 };
      break;
    }
  }

  // Thin spires are intentionally precise; a screen-space fallback supplies
  // touch slop without making their actual geometry lie about width. Exact
  // visible tips precede the co-located aggregate hull, so tapping a peak on
  // mobile selects that canonical match instead of unexpectedly zooming its
  // year bin. Empty parts of the aggregate remain selectable below.
  if (!result && input.exactAlpha >= 0.08) {
    source = "projected-fallback";
    const radius = input.pointerType === "touch" ? 20 : input.pointerType === "pen" ? 13 : 9;
    let best = Infinity;
    let bestDepth = Infinity;
    let bestIndex = -1;
    for (let i = 0; i < input.matchIds.length; i++) {
      if (input.peaks.opacityAt(i, input.morph) < 0.03) continue;
      candidates++;
      if (!input.peaks.currentTipInto(i, input.morph, exactTip)) continue;
      input.camera.projectInto(exactTip[0]!, exactTip[1]!, exactTip[2]!, projected);
      if (!projected.front) continue;
      const d = Math.hypot(projected.x - input.x, projected.y - input.y);
      const normalized = d / radius;
      if (normalized > 1 || normalized > best || (normalized === best && projected.depth >= bestDepth)) continue;
      best = normalized;
      bestDepth = projected.depth;
      bestIndex = i;
    }
    if (bestIndex >= 0) {
      result = {
        id: input.matchIds[bestIndex]!,
        kind: "match",
        instanceId: bestIndex,
        depth: bestDepth,
        normalizedDistance: best,
      };
    }
  }

  if (!result && input.aggregateAlpha > 0.08 && input.settled) {
    const hits = raycaster.intersectObject(input.aggregates.mesh, false);
    candidates += hits.length;
    const hit = hits.find((h) => (h.instanceId ?? -1) >= 0 && (h.instanceId ?? -1) < input.aggregates.bins.length);
    if (hit) {
      const instanceId = hit.instanceId!;
      const bin = input.aggregates.bins[instanceId]!;
      result = { id: bin.key, kind: "aggregate", instanceId, depth: hit.distance, normalizedDistance: 0 };
      source = "aggregate-raycast";
    }
  }

  diagnostic.id = result?.id ?? null;
  diagnostic.kind = result?.kind ?? null;
  diagnostic.source = source;
  diagnostic.candidateCount = candidates;
  diagnostic.durationMs = performance.now() - start;
  diagnostic.depth = result?.depth ?? Infinity;
  diagnostic.normalizedDistance = result?.normalizedDistance ?? Infinity;
  diagnostic.instanceId = result?.instanceId ?? -1;
  diagnostic.result = result ? "hit" : "miss";
  return result;
}
