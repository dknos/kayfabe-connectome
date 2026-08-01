import type { Manifest, NodesColumnar, TimelineEvent } from "@kayfabe/graph-contract";
import { isoToDay, pairKey } from "@kayfabe/graph-contract";

/** edges.bin field offsets (stride 10) */
export const EF = {
  a: 0, b: 1, same: 2, opposed: 3, br: 4, title: 5, firstDay: 6, lastDay: 7, promoMask: 8, formMask: 9,
} as const;
export const STRIDE = 10;

export interface Filters {
  dayMin: number;
  dayMax: number;
  promoMask: number; // selected promotions bitmask
  formMask: number; // selected forms bitmask
  showSame: boolean;
  showOpposed: boolean;
  showBr: boolean;
  minEncounters: number;
}

export interface EdgeWeights {
  same: number;
  opposed: number;
  br: number;
  title: number;
}

export interface FilteredView {
  /** edge indices (into edges.bin records) that survive the filters */
  visible: Uint32Array;
  /** per visible edge, the effective weights (recomputed from records when date-narrowed) */
  weights: EdgeWeights[];
  /** true when weights came from record-level re-aggregation rather than lifetime totals */
  recordAccurate: boolean;
  visibleNodeCount: number;
  nodeVisible: Uint8Array;
}

export class GraphModel {
  readonly nodes: NodesColumnar;
  readonly edges: Uint32Array;
  readonly edgeCount: number;
  readonly manifest: Manifest;
  readonly indexOfId = new Map<string, number>();
  readonly fullDayRange: [number, number];

  // CSR adjacency
  private adjOffsets: Uint32Array;
  private adjNode: Uint32Array;
  private adjEdge: Uint32Array;

  constructor(nodes: NodesColumnar, edges: Uint32Array, manifest: Manifest) {
    this.nodes = nodes;
    this.edges = edges;
    this.manifest = manifest;
    this.edgeCount = edges.length / STRIDE;
    nodes.id.forEach((id, i) => this.indexOfId.set(id, i));
    this.fullDayRange = [isoToDay(manifest.date_range[0]), isoToDay(manifest.date_range[1])];

    const n = nodes.count;
    const deg = new Uint32Array(n);
    for (let e = 0; e < this.edgeCount; e++) {
      deg[edges[e * STRIDE + EF.a]!]!++;
      deg[edges[e * STRIDE + EF.b]!]!++;
    }
    this.adjOffsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.adjOffsets[i + 1] = this.adjOffsets[i]! + deg[i]!;
    const total = this.adjOffsets[n]!;
    this.adjNode = new Uint32Array(total);
    this.adjEdge = new Uint32Array(total);
    const cursor = this.adjOffsets.slice(0, n);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = edges[e * STRIDE + EF.a]!;
      const b = edges[e * STRIDE + EF.b]!;
      this.adjNode[cursor[a]!] = b;
      this.adjEdge[cursor[a]!] = e;
      cursor[a]!++;
      this.adjNode[cursor[b]!] = a;
      this.adjEdge[cursor[b]!] = e;
      cursor[b]!++;
    }
  }

  edgeField(e: number, f: number): number {
    return this.edges[e * STRIDE + f]!;
  }

  edgePairKey(e: number): string {
    const a = this.nodes.id[this.edgeField(e, EF.a)]!;
    const b = this.nodes.id[this.edgeField(e, EF.b)]!;
    return pairKey(a, b);
  }

  neighbors(node: number): { node: number; edge: number }[] {
    const out: { node: number; edge: number }[] = [];
    for (let i = this.adjOffsets[node]!; i < this.adjOffsets[node + 1]!; i++) {
      out.push({ node: this.adjNode[i]!, edge: this.adjEdge[i]! });
    }
    return out;
  }

  isFullRange(f: Filters): boolean {
    return f.dayMin <= this.fullDayRange[0] && f.dayMax >= this.fullDayRange[1];
  }

  /** Fast lifetime-aggregate filtering (valid only for the full date range). */
  filterAggregate(f: Filters): FilteredView {
    const visible: number[] = [];
    const weights: EdgeWeights[] = [];
    const nodeVisible = new Uint8Array(this.nodes.count);
    for (let e = 0; e < this.edgeCount; e++) {
      const o = e * STRIDE;
      if (!(this.edges[o + EF.promoMask]! & f.promoMask)) continue;
      if (!(this.edges[o + EF.formMask]! & f.formMask)) continue;
      const same = f.showSame ? this.edges[o + EF.same]! : 0;
      const opposed = f.showOpposed ? this.edges[o + EF.opposed]! : 0;
      const br = f.showBr ? this.edges[o + EF.br]! : 0;
      if (same + opposed + br < f.minEncounters || same + opposed + br === 0) continue;
      visible.push(e);
      weights.push({ same, opposed, br, title: this.edges[o + EF.title]! });
      nodeVisible[this.edges[o + EF.a]!] = 1;
      nodeVisible[this.edges[o + EF.b]!] = 1;
    }
    // Promotions/titles stay visible as anchors when their bit is selected
    for (let i = 0; i < this.nodes.count; i++) {
      const t = this.nodes.type[i]!;
      if (t !== 0 && (this.nodes.promoMask[i]! & f.promoMask || this.nodes.promoMask[i] === 0)) nodeVisible[i] = 1;
    }
    let count = 0;
    for (let i = 0; i < nodeVisible.length; i++) count += nodeVisible[i]!;
    return { visible: Uint32Array.from(visible), weights, recordAccurate: true, visibleNodeCount: count, nodeVisible };
  }

  /**
   * Record-accurate filtering: re-derive observations from source match events in
   * the date range (spec: filter source records BEFORE aggregation), then apply
   * thresholds. Derivation rules mirror docs/CANONICAL-MODEL.md exactly.
   */
  filterFromRecords(f: Filters, events: TimelineEvent[]): FilteredView {
    const promoBit = this.manifest.promo_bits;
    const formBit = this.manifest.form_bits;
    const acc = new Map<number, EdgeWeights>();
    const pairEdge = new Map<string, number>();
    for (let e = 0; e < this.edgeCount; e++) pairEdge.set(this.edgePairKey(e), e);

    for (const ev of events) {
      const day = isoToDay(ev.d);
      if (day < f.dayMin || day > f.dayMax) continue;
      const pb = promoBit[ev.pr.slice(3)];
      if (pb === undefined || !((1 << pb) & f.promoMask)) continue;
      const fb = formBit[ev.form];
      if (fb === undefined || !((1 << fb) & f.formMask)) continue;

      const decisive = ev.res.startsWith("def");
      const isTitle = ev.t !== null;
      const bump = (idA: string, idB: string, rel: "same" | "opposed" | "br") => {
        const e = pairEdge.get(pairKey(idA, idB));
        if (e === undefined) return;
        let w = acc.get(e);
        if (!w) acc.set(e, (w = { same: 0, opposed: 0, br: 0, title: 0 }));
        w[rel]++;
        if (isTitle) w.title++;
      };

      // opposed: winners × losers (battle royal → br class)
      for (const a of ev.w)
        for (const b of ev.l) bump(a, b, ev.form === "battle_royal" ? "br" : "opposed");
      // partners: genuine team sides only; multi_way only the decisive winner side
      const teamForm = ev.form === "tag_team" || ev.form === "team_implied";
      const sameWithin = (side: string[]) => {
        for (let i = 0; i < side.length; i++)
          for (let j = i + 1; j < side.length; j++) bump(side[i]!, side[j]!, "same");
      };
      if (teamForm) {
        sameWithin(ev.w);
        sameWithin(ev.l);
      } else if (ev.form === "multi_way" && decisive) {
        sameWithin(ev.w);
      }
    }

    const visible: number[] = [];
    const weights: EdgeWeights[] = [];
    const nodeVisible = new Uint8Array(this.nodes.count);
    for (const [e, w] of acc) {
      const same = f.showSame ? w.same : 0;
      const opposed = f.showOpposed ? w.opposed : 0;
      const br = f.showBr ? w.br : 0;
      if (same + opposed + br < f.minEncounters || same + opposed + br === 0) continue;
      visible.push(e);
      weights.push({ same, opposed, br, title: w.title });
      nodeVisible[this.edgeField(e, EF.a)] = 1;
      nodeVisible[this.edgeField(e, EF.b)] = 1;
    }
    const order = visible.map((_e, i) => i).sort((x, y) => visible[x]! - visible[y]!);
    const vis = Uint32Array.from(order.map((i) => visible[i]!));
    const ws = order.map((i) => weights[i]!);
    let count = 0;
    for (let i = 0; i < nodeVisible.length; i++) count += nodeVisible[i]!;
    return { visible: vis, weights: ws, recordAccurate: true, visibleNodeCount: count, nodeVisible };
  }

  /* ---------- paths (Six Degrees) ---------- */

  shortestPath(
    fromId: string,
    toId: string,
    view: FilteredView,
    mode: "fewest" | "strongest" | "partners" | "opponents",
  ): { nodes: string[]; edges: number[] } | null {
    const from = this.indexOfId.get(fromId);
    const to = this.indexOfId.get(toId);
    if (from === undefined || to === undefined) return null;

    const allowed = new Map<number, number>(); // edge -> weight for mode
    view.visible.forEach((e, i) => {
      const w = view.weights[i]!;
      if (mode === "partners" && w.same === 0) return;
      if (mode === "opponents" && w.opposed + w.br === 0) return;
      allowed.set(e, w.same + w.opposed + w.br);
    });

    const prevNode = new Int32Array(this.nodes.count).fill(-1);
    const prevEdge = new Int32Array(this.nodes.count).fill(-1);

    if (mode === "strongest") {
      const dist = new Float64Array(this.nodes.count).fill(Infinity);
      dist[from] = 0;
      const heap: [number, number][] = [[0, from]];
      while (heap.length) {
        let bi = 0;
        for (let i = 1; i < heap.length; i++) if (heap[i]![0] < heap[bi]![0]) bi = i;
        const [d, u] = heap.splice(bi, 1)[0]!;
        if (d > dist[u]!) continue;
        if (u === to) break;
        for (const { node: v, edge } of this.neighbors(u)) {
          const w = allowed.get(edge);
          if (w === undefined) continue;
          const nd = d + 1 / (1 + w);
          if (nd < dist[v]!) {
            dist[v] = nd;
            prevNode[v] = u;
            prevEdge[v] = edge;
            heap.push([nd, v]);
          }
        }
      }
      if (!isFinite(dist[to]!)) return null;
    } else {
      const seen = new Uint8Array(this.nodes.count);
      seen[from] = 1;
      let frontier = [from];
      let found = false;
      while (frontier.length && !found) {
        const next: number[] = [];
        for (const u of frontier) {
          for (const { node: v, edge } of this.neighbors(u)) {
            if (!allowed.has(edge) || seen[v]) continue;
            seen[v] = 1;
            prevNode[v] = u;
            prevEdge[v] = edge;
            if (v === to) {
              found = true;
              break;
            }
            next.push(v);
          }
          if (found) break;
        }
        frontier = next;
      }
      if (!found) return null;
    }

    const nodePath: string[] = [];
    const edgePath: number[] = [];
    let cur = to;
    while (cur !== from) {
      nodePath.unshift(this.nodes.id[cur]!);
      edgePath.unshift(prevEdge[cur]!);
      cur = prevNode[cur]!;
      if (cur === -1) return null;
    }
    nodePath.unshift(this.nodes.id[from]!);
    return { nodes: nodePath, edges: edgePath };
  }
}
