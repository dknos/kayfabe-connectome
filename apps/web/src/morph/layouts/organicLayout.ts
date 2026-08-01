import {
  MR,
  TK,
  hash01,
  relationColor,
  type MorphLayoutResult,
  type MorphRoute,
  type MorphLabel,
} from "@kayfabe/morph-renderer";
import { pairKey } from "@kayfabe/graph-contract";
import type { MorphData } from "../morphAdapter";
import { PRIORITY } from "./layoutTypes";
import { sampleOrganicBow } from "./routing";

/**
 * The organic reading — the tissue itself.
 *
 * Targets are the untouched organic clone, byte for byte: "return to tissue"
 * is exact because this layout never computes a position, it only restores
 * one. Ambient fibers are the strongest lifetime edges (bounded, surfaced);
 * a retained selection keeps its relationship fibers and lit neighbourhood.
 */
export function buildOrganic(
  data: MorphData,
  selectedId: string | null,
  litIds: string[],
  traceCap: number,
): MorphLayoutResult {
  const n = data.count;
  const nodeTargets = new Float32Array(n * 3);
  nodeTargets.set(data.organic);
  const nodeOpacity = new Float32Array(data.graph.organicOpacity);
  const nodeScale = new Float32Array(data.graph.organicScale);
  const nodeRole = new Uint8Array(n);
  const nodeDelay = new Float32Array(n);
  for (let i = 0; i < n; i++) nodeDelay[i] = hash01(i * 31 + 7) * 0.8;

  const selIdx = selectedId ? data.indexOf(selectedId) : undefined;
  if (selIdx !== undefined) {
    nodeRole[selIdx] = MR.SELECTED;
    nodeDelay[selIdx] = 0;
    nodeScale[selIdx] = nodeScale[selIdx]! * 1.4;
    nodeOpacity[selIdx] = 0.95;
  }
  for (const id of litIds) {
    const i = data.indexOf(id);
    if (i !== undefined && i !== selIdx) {
      nodeRole[i] = MR.MEMBER;
      nodeOpacity[i] = Math.max(nodeOpacity[i]!, 0.5);
    }
  }

  const routes: MorphRoute[] = [];
  const labels: MorphLabel[] = [];
  const notes: string[] = [];
  const org = data.organic;
  const bow = (a: number, b: number, seed: number) =>
    sampleOrganicBow(
      org[a * 3]!, org[a * 3 + 1]!, org[a * 3 + 2]!,
      org[b * 3]!, org[b * 3 + 1]!, org[b * 3 + 2]!,
      seed,
    );

  const selRels = selIdx !== undefined ? data.relationsOf(selIdx) : [];
  if (selIdx !== undefined && selRels.length > 0) {
    // the selection's documented relationships as living fibers
    const rels = selRels;
    const sorted = [...rels].sort(
      (a, b) => b.same + b.opposed + b.br - (a.same + a.opposed + a.br) || (a.id < b.id ? -1 : 1),
    );
    const shown = sorted.slice(0, traceCap);
    if (shown.length < sorted.length) {
      notes.push(`strongest ${shown.length} of ${sorted.length} relationship fibers shown`);
    }
    for (const r of shown) {
      const pts = bow(selIdx, r.index, r.index * 13 + 1);
      routes.push({
        key: pairKey(selectedId!, r.id),
        points: pts,
        fromPoints: pts,
        color: relationColor(r.same, r.opposed, r.br, r.title),
        width: 1.8 + 2.2 * Math.min(1, (r.same + r.opposed + r.br) / 40),
        alpha: 0.42,
        kind: TK.RELATION,
        a: selIdx,
        b: r.index,
      });
    }
  } else {
    // ambient tissue — strongest lifetime edges, bounded and stated
    const ambient = data.topEdges(traceCap);
    for (const e of ambient) {
      const pts = bow(e.a, e.b, e.edge * 7 + 3);
      routes.push({
        key: e.key,
        points: pts,
        fromPoints: pts,
        color: relationColor(e.same, e.opposed, e.br, e.title),
        width: 1.2 + 1.4 * Math.min(1, (e.same + e.opposed + e.br) / 120),
        alpha: 0.14,
        kind: TK.RELATION,
        a: e.a,
        b: e.b,
      });
    }
    notes.push(`${routes.length} strongest lifetime fibers shown of ${data.model.edgeCount.toLocaleString()}`);
  }

  // ambient map tier: heaviest promotion anchors + highest-degree people
  const model = data.model;
  const promos: number[] = [];
  const people: number[] = [];
  for (let i = 0; i < n; i++) {
    if (model.nodes.type[i] === 1) promos.push(i);
    else if (model.nodes.type[i] === 0) people.push(i);
  }
  promos.sort((a, b) => model.nodes.matches[b]! - model.nodes.matches[a]! || a - b);
  people.sort((a, b) => model.nodes.degree[b]! - model.nodes.degree[a]! || a - b);
  const addLabel = (i: number, priority: number, tone: MorphLabel["tone"]) => {
    labels.push({
      key: `n:${model.nodes.id[i]!}`,
      x: org[i * 3]!,
      y: org[i * 3 + 1]!,
      z: org[i * 3 + 2]!,
      text: model.nodes.name[i]!,
      priority,
      tone,
      pick: model.nodes.id[i]!,
    });
  };
  for (const i of promos.slice(0, 12)) addLabel(i, PRIORITY.ambient + model.nodes.matches[i]! / 1e7, "promotion");
  for (const i of people.slice(0, 40)) addLabel(i, PRIORITY.ambient + model.nodes.degree[i]! / 1e7, "muted");
  if (selIdx !== undefined) {
    labels.push({
      key: `n:${selectedId!}`,
      x: org[selIdx * 3]!,
      y: org[selIdx * 3 + 1]!,
      z: org[selIdx * 3 + 2]!,
      text: model.nodes.name[selIdx]!,
      sub: "selected — organic position",
      priority: PRIORITY.selected,
      tone: "person",
      force: true,
      pick: selectedId!,
    });
    for (const id of litIds.slice(0, 60)) {
      const i = data.indexOf(id);
      if (i !== undefined && i !== selIdx) addLabel(i, PRIORITY.neighborBase, "neutral");
    }
  }

  const b = data.organicBounds;
  return {
    mode: "organic",
    nodeTargets,
    nodeOpacity,
    nodeScale,
    nodeRole,
    nodeDelay,
    virtuals: [],
    routes,
    labels,
    regions: [],
    bounds: { ...b },
    anchorId: selectedId,
    representedCount: n,
    expandedCount: selIdx !== undefined ? 1 : 0,
    notes,
  };
}
