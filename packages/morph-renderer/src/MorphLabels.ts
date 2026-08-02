import type { MorphCamera } from "./MorphCamera";
import type { MorphLabel } from "./types";

/**
 * Pooled DOM label layer.
 *
 * Elements are keyed and reused — never rebuilt wholesale, because swapping
 * the element under the cursor eats its click. Candidate selection (priority
 * sort, caps, collision) is separated from per-frame projection; content
 * expands with zoom: name → +sub (relation category / counts) → +detail.
 * Collision boxes use a char-width approximation instead of measureText —
 * one layout per label per frame is the cost this avoids.
 */

export interface MorphLabelReport {
  shown: number;
  wanted: number;
}

const CHAR_PX = 6.0;
/** px-per-world thresholds where label content deepens */
const ZOOM_SUB = 0.5;
const ZOOM_DETAIL = 1.35;

interface Live {
  el: HTMLDivElement;
  name: HTMLSpanElement;
  sub: HTMLSpanElement;
  detail: HTMLSpanElement;
  badge: HTMLSpanElement;
  actions: HTMLDivElement;
  text: string;
  subText: string;
  detailText: string;
  badgeText: string;
  cls: string;
}

export class MorphLabels {
  onPick: ((id: string) => void) | null = null;
  onHover: ((id: string | null) => void) | null = null;
  onAction: ((id: string, action: "pin" | "a" | "b" | "open") => void) | null = null;

  private host: HTMLElement;
  private live = new Map<string, Live>();
  private pinInset = 12;
  private hoveredKey: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  setPinInset(px: number): void {
    this.pinInset = px;
  }

  render(
    specs: MorphLabel[],
    cam: MorphCamera,
    cap: number,
    w: number,
    h: number,
    globalOpacity: number,
  ): MorphLabelReport {
    const pxPerWorld = 1 / Math.max(1e-9, cam.worldPerPixel);
    const sorted = [...specs].sort((a, b) => b.priority - a.priority || (a.key < b.key ? -1 : 1));

    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const used = new Set<string>();
    let shown = 0;

    for (const spec of sorted) {
      if (shown >= cap && !spec.force) continue;
      const p = cam.worldToScreen(spec.x, spec.y, spec.z);
      if (!p.front) continue;
      if (p.x < -160 || p.x > w + 160 || p.y < -46 || p.y > h + 46) continue;

      const showSub = !!spec.sub && (pxPerWorld > ZOOM_SUB || spec.force);
      const showDetail = !!spec.detail && (pxPerWorld > ZOOM_DETAIL || spec.force);
      const lines = [spec.text, showSub ? spec.sub! : "", showDetail ? spec.detail! : ""];
      const widest = Math.max(
        lines[0]!.length,
        lines[1]!.length * 0.85,
        lines[2]!.length * 0.85,
      );
      const measuredWidth = widest * CHAR_PX + (spec.badge ? 34 : 8);
      // A forced semantic label must never be wider than the screen band it
      // is pinned into. Long title metadata may overflow inside the clipped
      // label host, but it must not push the entity NAME itself off-screen.
      const pinToViewport = spec.force || this.pinInset <= 16;
      const tw = pinToViewport
        ? Math.min(measuredWidth, Math.max(48, w - this.pinInset * 2))
        : measuredWidth;
      const th = 14 + (showSub ? 12 : 0) + (showDetail ? 12 : 0);
      let x0 = spec.anchor === "left" ? p.x : p.x - tw / 2;
      if (pinToViewport) {
        const maxX = Math.max(this.pinInset, w - tw - this.pinInset);
        x0 = Math.min(maxX, Math.max(this.pinInset, x0));
      }
      const box = { x0, y0: p.y - th / 2, x1: x0 + tw, y1: p.y + th / 2 };

      if (!spec.force) {
        let hit = false;
        for (const b of placed) {
          if (box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) {
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }
      placed.push(box);
      used.add(spec.key);
      shown++;

      let l = this.live.get(spec.key);
      if (!l) {
        const el = document.createElement("div");
        const name = document.createElement("span");
        name.className = "mlabel-name";
        const sub = document.createElement("span");
        sub.className = "mlabel-sub";
        const detail = document.createElement("span");
        detail.className = "mlabel-detail";
        const badge = document.createElement("span");
        badge.className = "mlabel-badge";
        const actions = document.createElement("div");
        actions.className = "mlabel-actions";
        el.append(name, badge, sub, detail, actions);
        this.host.appendChild(el);
        l = { el, name, sub, detail, badge, actions, text: "", subText: "", detailText: "", badgeText: "", cls: "" };
        this.live.set(spec.key, l);
        if (spec.pick) {
          const id = spec.pick;
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            this.onPick?.(id);
          });
          el.addEventListener("pointerenter", () => {
            this.hoveredKey = spec.key;
            this.onHover?.(id);
          });
          el.addEventListener("pointerleave", () => {
            this.hoveredKey = null;
            this.onHover?.(null);
          });
          for (const [text, action, title] of [
            ["PIN", "pin", "Pin entity"],
            ["A", "a", "Set comparison A"],
            ["B", "b", "Set comparison B"],
            ["OPEN", "open", "Open in Connectome"],
          ] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "mlabel-action";
            button.textContent = text;
            button.title = title;
            button.setAttribute("aria-label", title);
            button.addEventListener("pointerdown", (event) => event.stopPropagation());
            button.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              this.onAction?.(id, action);
            });
            actions.appendChild(button);
          }
        }
      }
      if (l.text !== spec.text) {
        l.text = spec.text;
        l.name.textContent = spec.text;
      }
      const subT = showSub ? spec.sub! : "";
      if (l.subText !== subT) {
        l.subText = subT;
        l.sub.textContent = subT;
      }
      const detT = showDetail ? spec.detail! : "";
      if (l.detailText !== detT) {
        l.detailText = detT;
        l.detail.textContent = detT;
      }
      const badgeT = spec.badge ?? "";
      if (l.badgeText !== badgeT) {
        l.badgeText = badgeT;
        l.badge.textContent = badgeT;
        l.badge.style.display = badgeT ? "" : "none";
      }
      const cls = `mlabel tone-${spec.tone}${spec.anchor === "left" ? " left" : ""}${spec.pick ? " pickable" : ""}${spec.force ? " force" : ""}`;
      if (l.cls !== cls) {
        l.cls = cls;
        l.el.className = cls;
      }
      // Pinning happened before collision testing, so the box we reserve is
      // exactly where the stable pooled element is drawn.
      const lx = Math.round(box.x0);
      l.el.style.transform = `translate3d(${lx}px, ${Math.round(box.y0)}px, 0)`;
      l.el.style.opacity = String(globalOpacity);
    }

    for (const [key, l] of this.live) {
      if (!used.has(key) && key !== this.hoveredKey) {
        l.el.remove();
        this.live.delete(key);
      }
    }
    return { shown, wanted: specs.length };
  }

  clear(): void {
    for (const l of this.live.values()) l.el.remove();
    this.live.clear();
    this.hoveredKey = null;
  }
}
