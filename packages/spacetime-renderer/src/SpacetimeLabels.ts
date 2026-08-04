/**
 * Pooled DOM labels with collision suppression — the arena recipe: real
 * measureText widths cached per string (character estimates produced real
 * overlaps), stable sort by emphasis then depth then id, greedy AABB
 * acceptance, hovered/selected never suppressed. Not CSS2DRenderer; a pool of
 * plain divs the lens styles like every other lens here.
 */
import type { Camera } from "three";
import { Vector3 } from "three";

export interface SpacetimeLabelCandidate {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  emphasis: number;
  /** styling class suffix: person | subject | era | sector | persona */
  kind: string;
}

export interface SpacetimeLabelReport {
  wanted: number;
  shown: number;
}

const measureCache = new Map<string, number>();

export class SpacetimeLabels {
  private readonly pool: HTMLDivElement[] = [];
  private readonly ctx: CanvasRenderingContext2D | null;
  readonly fontSpec = "500 11px 'IBM Plex Mono', monospace";
  report: SpacetimeLabelReport = { wanted: 0, shown: 0 };
  private readonly v = new Vector3();
  private shownNow: { text: string; x: number; y: number; opacity: number }[] = [];

  constructor(layer: HTMLElement, poolSize: number) {
    for (let i = 0; i < poolSize; i++) {
      const el = document.createElement("div");
      el.className = "spacetime-label";
      el.style.display = "none";
      layer.appendChild(el);
      this.pool.push(el);
    }
    const canvas = document.createElement("canvas");
    this.ctx = canvas.getContext("2d");
    if (this.ctx) this.ctx.font = this.fontSpec;
  }

  private width(text: string): number {
    let w = measureCache.get(text);
    if (w === undefined) {
      w = this.ctx ? this.ctx.measureText(text).width : text.length * 6.4;
      measureCache.set(text, w);
    }
    return w;
  }

  update(
    candidates: SpacetimeLabelCandidate[], camera: Camera,
    viewW: number, viewH: number, budget: number,
  ): void {
    interface Placed {
      c: SpacetimeLabelCandidate;
      sx: number;
      sy: number;
      depth: number;
      w: number;
    }
    const placed: Placed[] = [];
    for (const c of candidates) {
      this.v.set(c.x, c.y, c.z).project(camera);
      if (this.v.z > 1 || this.v.z < -1) continue;
      const sx = (this.v.x * 0.5 + 0.5) * viewW;
      const sy = (-this.v.y * 0.5 + 0.5) * viewH;
      if (sx < -40 || sx > viewW + 40 || sy < -20 || sy > viewH + 20) continue;
      placed.push({ c, sx, sy, depth: this.v.z, w: this.width(c.text) });
    }
    this.report = { wanted: placed.length, shown: 0 };
    placed.sort((a, b) =>
      b.c.emphasis - a.c.emphasis || a.depth - b.depth || (a.c.id < b.c.id ? -1 : 1));

    const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const accepted: Placed[] = [];
    const limit = Math.min(budget, this.pool.length);
    for (const p of placed) {
      if (accepted.length >= limit) break;
      const x0 = p.sx + 8, y0 = p.sy - 7;
      const x1 = x0 + p.w + 6, y1 = y0 + 15;
      // The pointed-at name is the one question the reader actually asked;
      // it is never collision-dropped.
      const sticky = p.c.emphasis >= 4;
      if (!sticky && boxes.some((b) => x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0)) continue;
      boxes.push({ x0, y0, x1, y1 });
      accepted.push(p);
    }
    this.report.shown = accepted.length;

    this.shownNow = [];
    for (let i = 0; i < this.pool.length; i++) {
      const el = this.pool[i]!;
      const p = accepted[i];
      if (!p) {
        if (el.style.display !== "none") el.style.display = "none";
        continue;
      }
      const opacity = p.c.emphasis >= 4 ? 1 : 0.55 + Math.min(0.4, p.c.emphasis * 0.12);
      el.textContent = p.c.text;
      el.className = `spacetime-label spacetime-label-${p.c.kind}`;
      el.style.display = "block";
      el.style.opacity = String(opacity);
      el.style.transform = `translate(${Math.round(p.sx + 8)}px, ${Math.round(p.sy - 7)}px)`;
      this.shownNow.push({ text: p.c.text, x: p.sx + 8, y: p.sy - 7, opacity });
    }
  }

  /** For the screenshot compositor: what is on screen right now. */
  visibleLabels(): { text: string; x: number; y: number; opacity: number }[] {
    return this.shownNow;
  }

  dispose(): void {
    for (const el of this.pool) el.remove();
    this.pool.length = 0;
  }
}
