import type { AtlasCameraController } from "./AtlasCameraController";
import type { AtlasLabelSpec } from "./types";

/**
 * The label layer.
 *
 * Imperative DOM over the canvas, in the spirit of the connectome's managed
 * labels: elements are keyed and REUSED rather than rebuilt, because a layer
 * that calls replaceChildren on a timer swaps the element out from under the
 * cursor and eats the click aimed at it.
 *
 * Collision suppression is by measured rectangle, not by grid cell. Atlas
 * labels sit beside rails of wildly different lengths ("WWE" against
 * "Cruiserweight Classic Championship WWE Cruiserweight Title"), and a fixed
 * cell either lets long names overlap or throws away short ones that fit.
 *
 * What is suppressed is always COUNTED and reported, because "42 labels shown"
 * over 571 represented promotions has to be legible as a label cap and not as
 * a promotion count.
 */

export type LabelDensity = "sparse" | "normal" | "dense";

const CAPS: Record<LabelDensity, number> = { sparse: 26, normal: 64, dense: 150 };
/** Approximate advance width per character at the label's font size. Measuring
 *  each string would force a layout per label per rebuild. */
const CHAR_PX = 5.9;

interface Live {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  sub: HTMLSpanElement | null;
  badge: HTMLSpanElement | null;
  text: string;
  subText: string;
  badgeText: string;
  tone: string;
}

export interface LabelReport {
  shown: number;
  wanted: number;
}

export class AtlasLabels {
  private host: HTMLElement;
  private live = new Map<string, Live>();
  /**
   * Left inset for viewport-pinned lane names.
   *
   * Set by the app from its own chrome: a lane name pinned at x=8 on a desktop
   * lands underneath the floating controls rail, which is exactly as invisible
   * as leaving it off screen was.
   */
  private pinInset = 8;
  onPick: ((id: string) => void) | null = null;
  onHover: ((id: string | null) => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  setPinInset(px: number): void {
    this.pinInset = px;
  }

  clear(): void {
    for (const l of this.live.values()) l.el.remove();
    this.live.clear();
  }

  /**
   * Project, rank, suppress, and paint.
   *
   * Ranking is by the layout's own priority ladder; `force` labels bypass
   * suppression entirely because they answer a question the reader asked
   * directly (the selection, the breadcrumb context, the playback head).
   */
  render(
    specs: AtlasLabelSpec[],
    cam: AtlasCameraController,
    density: LabelDensity,
    w: number,
    h: number,
    /** Screen X of the board's left edge. Pinned labels sit just left of the
     *  board when it is inset from the viewport, and fall back to the fixed
     *  inset once the board's edge has been panned off screen. Without this a
     *  lane name floats in the gutter, disconnected from its own lane. */
    boardLeftPx = -Infinity,
  ): LabelReport {
    const cap = CAPS[density];
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const keep = new Set<string>();

    const ranked = [...specs].sort((a, b) => b.priority - a.priority || (a.key < b.key ? -1 : 1));
    let shown = 0;

    for (const s of ranked) {
      if (!s.force && shown >= cap) break;
      const p = cam.worldToScreen(s.x, s.y, s.z);
      if (!p.front) continue;
      const pinned = s.pin === "left";
      // A margin rather than a hard clip: a label anchored just off the left
      // edge of the viewport still names a rail that is visible. Pinned labels
      // ignore the X test entirely — their whole point is to survive it.
      if (!pinned && (p.x < -160 || p.x > w + 160)) continue;
      if (p.y < -40 || p.y > h + 40) continue;

      // Measure the WIDEST line, not just the name. A sub-line like
      // "2006-05-15 → 2006-06-11 · 27 days" is four times the width of "Edge",
      // and sizing the collision box from the name let every sub-line in a
      // dense lineage overlap its neighbours.
      const nameChars = s.text.length + (s.badge ? s.badge.length + 2 : 0);
      const subChars = s.sub ? s.sub.length * 0.82 : 0; // sub renders smaller
      const tw = Math.max(18, Math.max(nameChars, subChars) * CHAR_PX + 10);
      const th = s.sub ? 26 : 15;
      const left = pinned
        ? Math.max(this.pinInset, Math.min(boardLeftPx - tw - 8, w - tw - 8))
        : s.anchor === "center"
          ? p.x - tw / 2
          : p.x;
      const box = { x0: left - 2, y0: p.y - th / 2, x1: left + tw + 2, y1: p.y + th / 2 };

      if (!s.force) {
        let hit = false;
        for (const q of placed) {
          if (box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0) {
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }
      placed.push(box);
      keep.add(s.key);
      shown++;
      this.paint(s, left, p.y);
    }

    for (const [k, l] of this.live) {
      if (keep.has(k)) continue;
      l.el.remove();
      this.live.delete(k);
    }
    return { shown, wanted: specs.length };
  }

  private paint(s: AtlasLabelSpec, left: number, top: number): void {
    let l = this.live.get(s.key);
    if (!l) {
      const el = document.createElement("div");
      el.className = "alabel";
      const name = document.createElement("span");
      name.className = "alabel-name";
      el.appendChild(name);
      l = { el, name, sub: null, badge: null, text: "", subText: "", badgeText: "", tone: "" };
      this.live.set(s.key, l);
      this.host.appendChild(el);
    }
    if (l.text !== s.text) {
      l.name.textContent = s.text;
      l.text = s.text;
    }
    const badgeText = s.badge ?? "";
    if (l.badgeText !== badgeText) {
      if (!badgeText) {
        l.badge?.remove();
        l.badge = null;
      } else {
        if (!l.badge) {
          l.badge = document.createElement("span");
          l.badge.className = "alabel-badge";
          l.el.appendChild(l.badge);
        }
        l.badge.textContent = badgeText;
      }
      l.badgeText = badgeText;
    }
    const subText = s.sub ?? "";
    if (l.subText !== subText) {
      if (!subText) {
        l.sub?.remove();
        l.sub = null;
      } else {
        if (!l.sub) {
          l.sub = document.createElement("span");
          l.sub.className = "alabel-sub";
          l.el.appendChild(l.sub);
        }
        l.sub.textContent = subText;
      }
      l.subText = subText;
    }
    const tone = `alabel tone-${s.tone}${s.anchor === "center" ? " center" : ""}${s.pick ? " pickable" : ""}`;
    if (l.tone !== tone) {
      l.el.className = tone;
      l.tone = tone;
    }
    l.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;

    const id = s.pick;
    if (id) {
      l.el.onclick = (e) => {
        e.stopPropagation();
        this.onPick?.(id);
      };
      l.el.onpointerenter = () => this.onHover?.(id);
      l.el.onpointerleave = () => this.onHover?.(null);
    } else {
      l.el.onclick = null;
      l.el.onpointerenter = null;
      l.el.onpointerleave = null;
    }
  }

  dispose(): void {
    this.clear();
  }
}
