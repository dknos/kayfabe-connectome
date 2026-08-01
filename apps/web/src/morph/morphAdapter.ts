import {
  communityColor,
  M,
  rgb,
  type MorphGraphInput,
} from "@kayfabe/morph-renderer";
import type { CoreData } from "../data/loader";
import { EF, type GraphModel } from "../graph/model";
import { ORGANIC_SCALE } from "./layouts/layoutTypes";

/**
 * The bridge between the shared corpus and the morph engine.
 *
 * Reads model.nodes.pos ONCE into its own scaled Float32Array — the
 * connectome's arrays are never retained, referenced or mutated. The organic
 * clone is the single source for "return to tissue": restoring it is a copy
 * of this array, so the round trip is exact by construction.
 */

export interface NeighborRel {
  /** neighbor corpus index */
  index: number;
  id: string;
  name: string;
  same: number;
  opposed: number;
  br: number;
  title: number;
  firstDay: number;
  lastDay: number;
  promoMask: number;
}

export interface AmbientEdge {
  a: number;
  b: number;
  same: number;
  opposed: number;
  br: number;
  title: number;
  /** pair key — the stable trace identity shared with organized modes */
  key: string;
  edge: number;
}

export interface MorphData {
  count: number;
  /** organic positions in world units — flat xyz, OWNED by morph lab */
  organic: Float32Array;
  organicBounds: { minX: number; maxX: number; minY: number; maxY: number };
  graph: MorphGraphInput;
  model: GraphModel;
  core: CoreData;
  idOf(index: number): string | null;
  indexOf(id: string): number | undefined;
  nameOf(id: string): string | null;
  relationsOf(index: number): NeighborRel[];
  /** strongest lifetime edges, computed once — the organic ambient fiber set */
  topEdges(limit: number): AmbientEdge[];
}

export function buildMorphData(model: GraphModel, core: CoreData): MorphData {
  const n = model.nodes.count;
  const organic = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) organic[i] = model.nodes.pos[i]! * ORGANIC_SCALE;

  const color = new Float32Array(n * 3);
  const type = new Uint8Array(n);
  const scale = new Float32Array(n);
  const opacity = new Float32Array(n);
  const promoRgb = rgb(M.promotion);
  const goldRgb = rgb(M.gold);
  for (let i = 0; i < n; i++) {
    const t = model.nodes.type[i]!;
    type[i] = t;
    let c: [number, number, number];
    if (t === 1) c = promoRgb;
    else if (t === 2) c = goldRgb;
    else {
      const cc = communityColor(model.nodes.community[i]!);
      c = [cc.r, cc.g, cc.b];
    }
    color[i * 3] = c[0];
    color[i * 3 + 1] = c[1];
    color[i * 3 + 2] = c[2];
    const deg = model.nodes.degree[i]!;
    // world-unit sizes; the shader clamps px so dust stays dust
    scale[i] = t === 1 ? 5.2 : t === 2 ? 2.8 : 1.7 + 3.6 * Math.min(1, Math.sqrt(deg) / 26);
    // quiet somas, density-compensated: additive alpha divided by the square
    // root of community population — the connectome's own white-plateau fix —
    // so the dense core reads as tissue instead of saturating to white and
    // swallowing every fiber drawn through it
    if (t === 0) {
      const comm = model.nodes.community[i]!;
      const csize = comm >= 0 ? (core.communities.size[comm] ?? 200) : 200;
      const density = Math.min(1, Math.max(0.18, Math.sqrt(140 / Math.max(1, csize))));
      opacity[i] = (0.1 + 0.16 * Math.min(1, Math.sqrt(deg) / 26)) * density;
    } else {
      opacity[i] = t === 1 ? 0.22 : 0.2;
    }
  }

  const relCache = new Map<number, NeighborRel[]>();
  let topEdgeCache: AmbientEdge[] | null = null;

  const organicBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let i = 0; i < n; i++) {
    const x = organic[i * 3]!;
    const y = organic[i * 3 + 1]!;
    if (x < organicBounds.minX) organicBounds.minX = x;
    if (x > organicBounds.maxX) organicBounds.maxX = x;
    if (y < organicBounds.minY) organicBounds.minY = y;
    if (y > organicBounds.maxY) organicBounds.maxY = y;
  }

  return {
    count: n,
    organic,
    organicBounds,
    graph: { count: n, organic, color, type, organicScale: scale, organicOpacity: opacity },
    model,
    core,
    idOf: (i) => model.nodes.id[i] ?? null,
    indexOf: (id) => model.indexOfId.get(id),
    nameOf(id) {
      const i = model.indexOfId.get(id);
      if (i !== undefined) return model.nodes.name[i] ?? null;
      // 406 of 571 promotions never earned a node; the registry names them all
      return core.promotions[id]?.n ?? null;
    },
    relationsOf(index) {
      const hit = relCache.get(index);
      if (hit) return hit;
      const out: NeighborRel[] = model.neighbors(index).map(({ node, edge }) => ({
        index: node,
        id: model.nodes.id[node]!,
        name: model.nodes.name[node]!,
        same: model.edgeField(edge, EF.same),
        opposed: model.edgeField(edge, EF.opposed),
        br: model.edgeField(edge, EF.br),
        title: model.edgeField(edge, EF.title),
        firstDay: model.edgeField(edge, EF.firstDay),
        lastDay: model.edgeField(edge, EF.lastDay),
        promoMask: model.edgeField(edge, EF.promoMask),
      }));
      relCache.set(index, out);
      if (relCache.size > 24) {
        const first = relCache.keys().next().value;
        if (first !== undefined && first !== index) relCache.delete(first);
      }
      return out;
    },
    topEdges(limit) {
      if (!topEdgeCache) {
        const count = model.edgeCount;
        const weights = new Float32Array(count);
        for (let e = 0; e < count; e++) {
          weights[e] =
            model.edgeField(e, EF.same) + model.edgeField(e, EF.opposed) + model.edgeField(e, EF.br);
        }
        const order = Array.from({ length: count }, (_, e) => e);
        order.sort((a, b) => weights[b]! - weights[a]! || a - b);
        topEdgeCache = order.slice(0, 2400).map((e) => {
          const a = model.edgeField(e, EF.a);
          const b = model.edgeField(e, EF.b);
          return {
            a,
            b,
            same: model.edgeField(e, EF.same),
            opposed: model.edgeField(e, EF.opposed),
            br: model.edgeField(e, EF.br),
            title: model.edgeField(e, EF.title),
            key: model.edgePairKey(e),
            edge: e,
          };
        });
      }
      return topEdgeCache.slice(0, limit);
    },
  };
}
