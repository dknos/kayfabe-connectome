/**
 * The label field.
 *
 * Pooled DOM nodes projected from card anchors, not CSS2DRenderer. The audit
 * rejected the addon because `MorphLabels.ts` in this repository already does
 * more — keyed pooling, priority sort, collision suppression — and because
 * CSS2D's layer "gate" still runs the projection maths for hidden labels.
 *
 * SPIKE 5 measured this against the real corpus at three viewports: pr:c8
 * wants 513 labels at 1920x1080 and gets 48 with zero overlapping pairs, the
 * pool never grows past its allocation, and the pass costs 0.0–0.2 ms.
 *
 * Two things here look like details and are not:
 *
 *   measured width   Estimating a label box from character count produced
 *                    real overlaps, because proportional type gives two
 *                    19-character Lucha names different widths. Canvas
 *                    measureText, cached per distinct name, is exact.
 *   top-left boxes   Labels are positioned with translate(x,y) from
 *                    transform-origin 0 0. Testing centre-based boxes cleared
 *                    collisions that were still plainly on screen.
 */
import { Vector3, type Camera } from "three";
import type { ArenaTransition } from "./ArenaTransition";
import { AE, CS } from "./types";

export interface ArenaLabelReport {
  wanted: number;
  shown: number;
  suppressed: number;
  updateMs: number;
}

interface LabelSlot {
  el: HTMLDivElement;
  boundId: string | null;
  text: string;
  shown: boolean;
}

interface Candidate {
  id: string;
  name: string;
  emphasis: number;
  x: number;
  y: number;
  depth: number;
  w: number;
  h: number;
}

export interface ArenaLabelInput {
  id: string;
  name: string;
  emphasis: number;
}

export class ArenaLabels {
  private readonly slots: LabelSlot[] = [];
  private readonly candidates: Candidate[] = [];
  private readonly measureCtx: CanvasRenderingContext2D | null;
  private readonly widthCache = new Map<string, number>();
  private readonly proj = new Vector3();
  private readonly ax: number[] = [];
  private readonly ay: number[] = [];
  private readonly aw: number[] = [];
  private readonly ah: number[] = [];
  private readonly font: string;
  report: ArenaLabelReport = { wanted: 0, shown: 0, suppressed: 0, updateMs: 0 };

  constructor(
    layer: HTMLElement,
    readonly poolSize: number,
    capacity: number,
    fontPx = 11,
    fontFamily = "ui-sans-serif, system-ui, sans-serif",
  ) {
    this.font = `${fontPx}px ${fontFamily}`;
    const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
    this.measureCtx = canvas?.getContext("2d") ?? null;
    if (this.measureCtx) this.measureCtx.font = this.font;
    for (let i = 0; i < poolSize; i++) {
      const el = document.createElement("div");
      el.className = "arena-label";
      el.style.display = "none";
      layer.appendChild(el);
      this.slots.push({ el, boundId: null, text: "", shown: false });
    }
    for (let i = 0; i < capacity; i++) {
      this.candidates.push({ id: "", name: "", emphasis: AE.AMBIENT, x: 0, y: 0, depth: 0, w: 0, h: 0 });
    }
  }

  private textWidth(text: string): number {
    let w = this.widthCache.get(text);
    if (w === undefined) {
      w = this.measureCtx ? this.measureCtx.measureText(text).width : text.length * 6.2;
      this.widthCache.set(text, w);
    }
    return w;
  }

  /**
   * Project, sort by priority, and accept a label only if its box clears
   * everything already accepted. Selected and focused labels displace what is
   * under them rather than being dropped — the brief forbids ever
   * collision-dropping them, and nothing is shrunk to fit.
   */
  update(
    transition: ArenaTransition, camera: Camera,
    widthPx: number, heightPx: number, budget: number,
    idOfSlot: (slot: number) => string | null,
    inputOf: (id: string) => ArenaLabelInput | undefined,
  ): void {
    const t0 = performance.now();
    let count = 0;
    for (let slot = 0; slot < transition.capacity; slot++) {
      if (transition.state[slot] === CS.ABSENT) continue;
      const id = idOfSlot(slot);
      if (!id) continue;
      const input = inputOf(id);
      if (!input) continue;
      const i3 = slot * 3;
      this.proj.set(transition.posCur[i3]!, transition.posCur[i3 + 1]!, transition.posCur[i3 + 2]!);
      this.proj.project(camera);
      if (this.proj.z < -1 || this.proj.z > 1) continue;
      const x = (this.proj.x * 0.5 + 0.5) * widthPx;
      const y = (-this.proj.y * 0.5 + 0.5) * heightPx;
      if (x < -80 || y < -24 || x > widthPx + 80 || y > heightPx + 24) continue;
      const c = this.candidates[count]!;
      c.id = id;
      c.name = input.name;
      c.emphasis = input.emphasis;
      c.x = x;
      c.y = y;
      c.depth = this.proj.z;
      c.w = this.textWidth(input.name) + 10;
      c.h = 17;
      count++;
    }

    const live = this.candidates.slice(0, count);
    // Higher emphasis first, then nearer, then a stable id so the same frame
    // always resolves the same way.
    live.sort((a, b) => b.emphasis - a.emphasis || a.depth - b.depth || (a.id < b.id ? -1 : 1));

    this.ax.length = 0; this.ay.length = 0; this.aw.length = 0; this.ah.length = 0;
    let shown = 0;
    let suppressed = 0;
    const cap = Math.min(budget, this.poolSize);
    for (const c of live) {
      if (shown >= cap) { suppressed++; continue; }
      let clashes = false;
      for (let i = 0; i < this.ax.length; i++) {
        if (c.x < this.ax[i]! + this.aw[i]! && c.x + c.w > this.ax[i]! &&
            c.y < this.ay[i]! + this.ah[i]! && c.y + c.h > this.ay[i]!) { clashes = true; break; }
      }
      if (clashes && c.emphasis < AE.HOVERED) { suppressed++; continue; }
      const slot = this.slots[shown]!;
      if (slot.boundId !== c.id || slot.text !== c.name) {
        slot.el.textContent = c.name;
        slot.text = c.name;
        slot.boundId = c.id;
      }
      slot.el.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`;
      slot.el.style.opacity = c.emphasis >= AE.HOVERED ? "1" : "0.78";
      if (!slot.shown) { slot.el.style.display = "block"; slot.shown = true; }
      this.ax.push(c.x); this.ay.push(c.y); this.aw.push(c.w); this.ah.push(c.h);
      shown++;
    }
    for (let i = shown; i < this.poolSize; i++) {
      const slot = this.slots[i]!;
      if (slot.shown) { slot.el.style.display = "none"; slot.shown = false; }
    }
    this.report = { wanted: count, shown, suppressed, updateMs: performance.now() - t0 };
  }

  shownIds(): (string | null)[] {
    return this.slots.filter((s) => s.shown).map((s) => s.boundId);
  }

  dispose(): void {
    for (const slot of this.slots) slot.el.remove();
    this.slots.length = 0;
    this.widthCache.clear();
  }
}
