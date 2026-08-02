import type { RatingCamera } from "./RatingCamera";
import type { RatingLabel } from "./types";

export interface RatingLabelReport {
  shown: number;
  wanted: number;
}

interface LiveLabel {
  root: HTMLDivElement;
  primary: HTMLButtonElement | HTMLDivElement;
  text: HTMLSpanElement;
  sub: HTMLSpanElement;
  pick: string | null;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Stable keyed DOM pool; projection runs in the renderer loop, not React. */
export class RatingLabels {
  onPick: ((id: string) => void) | null = null;
  onHoverSurface: ((id: string, source: "label" | "keyboard", phase: "enter" | "leave") => void) | null = null;
  onFocusRestoreRequested: ((id: string) => void) | null = null;

  private host: HTMLElement;
  private labels: RatingLabel[] = [];
  private live = new Map<string, LiveLabel>();
  private shownKeys: string[] = [];
  private boxes: Box[] = [];
  private rovingKey: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.tabIndex = -1;
  }

  setLabels(labels: RatingLabel[]): void {
    this.labels = [...labels].sort((a, b) => b.priority - a.priority || (a.key < b.key ? -1 : 1));
    const keys = new Set(labels.map((l) => l.key));
    for (const [key, live] of this.live) {
      if (keys.has(key)) continue;
      if (live.root.contains(document.activeElement)) {
        if (live.pick) this.onFocusRestoreRequested?.(live.pick);
        this.host.focus({ preventScroll: true });
      }
      live.root.remove();
      this.live.delete(key);
      if (this.rovingKey === key) this.rovingKey = null;
    }
  }

  render(
    camera: RatingCamera,
    cap: number,
    _width: number,
    _height: number,
    opacity: number,
    resolvePosition: (label: RatingLabel) => readonly [number, number, number] | null,
  ): RatingLabelReport {
    this.shownKeys.length = 0;
    this.boxes.length = 0;
    const usable = camera.usableScreenRect();
    for (const live of this.live.values()) live.root.hidden = true;
    let shown = 0;
    for (const spec of this.labels) {
      if (shown >= cap && !spec.force) continue;
      const pos = resolvePosition(spec);
      if (!pos) continue;
      const projected = camera.worldToScreen(pos[0], pos[1], pos[2]);
      if (!projected.front || projected.x < usable.left || projected.x > usable.right || projected.y < usable.top || projected.y > usable.bottom) continue;
      const availableWidth = Math.max(40, usable.right - usable.left - 16);
      const textWidth = Math.min(availableWidth, Math.max(36, spec.text.length * 6.1 + (spec.sub?.length ?? 0) * 2.5 + 12));
      const box = {
        x0: Math.max(usable.left + 8, Math.min(usable.right - textWidth - 8, projected.x - (spec.tone === "lane" ? 0 : textWidth / 2))),
        y0: Math.max(usable.top + 4, Math.min(usable.bottom - 34, projected.y - 12)),
        x1: 0,
        y1: 0,
      };
      box.x1 = box.x0 + textWidth;
      box.y1 = box.y0 + (spec.sub ? 29 : 18);
      const collides = () => this.boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      if (collides()) {
        if (!spec.force) continue;
        const originalY = box.y0;
        const height = box.y1 - box.y0;
        let placed = false;
        for (let step = 1; step <= 14 && !placed; step++) {
          for (const direction of [1, -1]) {
            box.y0 = Math.max(usable.top + 4, Math.min(usable.bottom - height - 4, originalY + direction * step * (height + 3)));
            box.y1 = box.y0 + height;
            if (!collides()) { placed = true; break; }
          }
        }
        if (!placed) continue;
      }
      this.boxes.push(box);
      const live = this.ensure(spec);
      live.pick = spec.pick ?? null;
      if (live.text.textContent !== spec.text) live.text.textContent = spec.text;
      const sub = spec.sub ?? "";
      if (live.sub.textContent !== sub) live.sub.textContent = sub;
      live.sub.hidden = !sub;
      live.root.className = `rating-label tone-${spec.tone}${spec.force ? " force" : ""}${spec.pick ? " pickable" : ""}`;
      live.root.style.transform = `translate3d(${Math.round(box.x0)}px,${Math.round(box.y0)}px,0)`;
      live.root.style.opacity = String(opacity);
      live.root.hidden = false;
      if (live.primary instanceof HTMLButtonElement) {
        live.primary.setAttribute("aria-label", spec.accessibleName ?? spec.text);
      }
      this.shownKeys.push(spec.key);
      shown++;
    }
    this.updateRoving();
    return { shown, wanted: this.labels.length };
  }

  clear(): void {
    for (const live of this.live.values()) live.root.remove();
    this.live.clear();
    this.labels = [];
    this.shownKeys.length = 0;
    this.boxes.length = 0;
    this.rovingKey = null;
  }

  private ensure(spec: RatingLabel): LiveLabel {
    const existing = this.live.get(spec.key);
    if (existing) return existing;
    const root = document.createElement("div");
    root.dataset.ratingLabel = spec.key;
    root.setAttribute("role", "group");
    const primary = spec.pick ? document.createElement("button") : document.createElement("div");
    if (primary instanceof HTMLButtonElement) {
      primary.type = "button";
      primary.tabIndex = -1;
      primary.addEventListener("click", (event) => {
        event.stopPropagation();
        const live = this.live.get(spec.key);
        if (live?.pick) this.onPick?.(live.pick);
      });
      primary.addEventListener("focus", () => {
        this.rovingKey = spec.key;
        const live = this.live.get(spec.key);
        if (live?.pick) this.onHoverSurface?.(live.pick, "keyboard", "enter");
      });
      primary.addEventListener("blur", () => {
        const live = this.live.get(spec.key);
        if (live?.pick) this.onHoverSurface?.(live.pick, "keyboard", "leave");
      });
      primary.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        this.moveRoving(spec.key, event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
      });
    }
    const text = document.createElement("span");
    text.className = "rating-label-name";
    const sub = document.createElement("span");
    sub.className = "rating-label-sub";
    primary.append(text, sub);
    root.append(primary);
    root.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch") return;
      const live = this.live.get(spec.key);
      if (live?.pick) this.onHoverSurface?.(live.pick, "label", "enter");
    });
    root.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      const live = this.live.get(spec.key);
      if (live?.pick) this.onHoverSurface?.(live.pick, "label", "leave");
    });
    const live = { root, primary, text, sub, pick: spec.pick ?? null };
    this.live.set(spec.key, live);
    this.host.appendChild(root);
    return live;
  }

  private updateRoving(): void {
    const visiblePickable = this.shownKeys.filter((key) => this.live.get(key)?.primary instanceof HTMLButtonElement);
    if (!this.rovingKey || !visiblePickable.includes(this.rovingKey)) this.rovingKey = visiblePickable[0] ?? null;
    for (const key of visiblePickable) {
      const primary = this.live.get(key)!.primary as HTMLButtonElement;
      primary.tabIndex = key === this.rovingKey ? 0 : -1;
    }
  }

  private moveRoving(from: string, delta: number): void {
    const keys = this.shownKeys.filter((key) => this.live.get(key)?.primary instanceof HTMLButtonElement);
    if (!keys.length) return;
    const at = Math.max(0, keys.indexOf(from));
    const next = keys[(at + delta + keys.length) % keys.length]!;
    this.rovingKey = next;
    (this.live.get(next)?.primary as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
  }
}
