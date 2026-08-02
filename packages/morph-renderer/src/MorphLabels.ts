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
const ZOOM_SUB = 0.78;
const ZOOM_DETAIL = 1.55;

interface Live {
  el: HTMLDivElement;
  primary: HTMLButtonElement | HTMLDivElement;
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
  id: string | null;
}

export class MorphLabels {
  onPick: ((id: string) => void) | null = null;
  onHoverSurface: ((id: string, source: "label" | "keyboard", phase: "enter" | "leave") => void) | null = null;
  onTouch: (() => void) | null = null;
  onAction: ((id: string, action: "focus" | "pin" | "a" | "b" | "open") => void) | null = null;
  /** Fired before a topology change removes the currently focused label. */
  onFocusRestoreRequested: ((removedId: string) => void) | null = null;

  private host: HTMLElement;
  private live = new Map<string, Live>();
  private pinInset = 12;
  private hoveredKey: string | null = null;
  private rovingKey: string | null = null;
  private suppressFocusHoverUntil = 0;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  setPinInset(px: number): void {
    this.pinInset = px;
  }

  /** Called once per topology generation so an old hovered pool entry cannot
   * survive merely because its pointerleave event vanished with the layout. */
  setLayoutKeys(specs: readonly MorphLabel[]): void {
    if (this.hoveredKey && !specs.some((spec) => spec.key === this.hoveredKey)) this.hoveredKey = null;
    if (this.rovingKey && !specs.some((spec) => spec.key === this.rovingKey)) this.rovingKey = null;
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
    const available = new Set(specs.map((spec) => spec.key));
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
        el.setAttribute("role", "group");
        const primary = spec.pick ? document.createElement("button") : document.createElement("div");
        primary.className = "mlabel-primary";
        if (primary instanceof HTMLButtonElement) {
          primary.type = "button";
          primary.dataset.morphLabelPrimary = "true";
          primary.tabIndex = -1;
        }
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
        primary.append(name, badge, sub, detail);
        el.append(primary, actions);
        this.host.appendChild(el);
        l = { el, primary, name, sub, detail, badge, actions, text: "", subText: "", detailText: "", badgeText: "", cls: "", id: spec.pick ?? null };
        this.live.set(spec.key, l);
        if (spec.pick) {
          primary.addEventListener("click", (e) => {
            e.stopPropagation();
            if (l?.id) this.onPick?.(l.id);
          });
          el.addEventListener("pointerenter", (event) => {
            if (event.pointerType === "touch") return;
            this.hoveredKey = spec.key;
            if (l?.id) this.onHoverSurface?.(l.id, "label", "enter");
          });
          el.addEventListener("pointerleave", (event) => {
            if (event.pointerType === "touch") return;
            this.hoveredKey = null;
            if (l?.id) this.onHoverSurface?.(l.id, "label", "leave");
          });
          el.addEventListener("pointerdown", (event) => {
            if (event.pointerType === "touch") {
              this.suppressFocusHoverUntil = performance.now() + 500;
              this.onTouch?.();
            }
          });
          el.addEventListener("pointerup", (event) => {
            if (event.pointerType === "touch") this.suppressFocusHoverUntil = 0;
          });
          el.addEventListener("focusin", () => {
            this.rovingKey = spec.key;
            if (performance.now() < this.suppressFocusHoverUntil) {
              this.suppressFocusHoverUntil = 0;
              return;
            }
            if (l?.id) this.onHoverSurface?.(l.id, "keyboard", "enter");
          });
          el.addEventListener("focusout", (event) => {
            if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
            if (l?.id) this.onHoverSurface?.(l.id, "keyboard", "leave");
          });
          primary.addEventListener("keydown", (event) => {
            const key = (event as KeyboardEvent).key;
            if (key.toLowerCase() === "f" && !(event as KeyboardEvent).ctrlKey && !(event as KeyboardEvent).metaKey && !(event as KeyboardEvent).altKey) {
              event.preventDefault();
              if (l?.id) this.onAction?.(l.id, "focus");
              return;
            }
            if (key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              primary.blur();
              return;
            }
            if (key !== "ArrowLeft" && key !== "ArrowUp" && key !== "ArrowRight" && key !== "ArrowDown") return;
            event.preventDefault();
            this.moveRoving(spec.key, key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1);
          });
          for (const [text, action, title] of [
            ["FOCUS", "focus", "Focus camera on entity"],
            ["PIN", "pin", "Pin entity"],
            ["A", "a", "Set comparison A"],
            ["B", "b", "Set comparison B"],
            ["OPEN", "open", "Open in Connectome"],
          ] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "mlabel-action";
            button.dataset.action = action;
            button.textContent = text;
            button.title = title;
            button.setAttribute("aria-label", title);
            button.addEventListener("pointerdown", (event) => {
              if (event.pointerType === "touch") {
                this.suppressFocusHoverUntil = performance.now() + 500;
                this.onTouch?.();
              }
              event.stopPropagation();
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (l?.id) this.onAction?.(l.id, action);
            });
            actions.appendChild(button);
          }
        }
      }
      l.id = spec.pick ?? null;
      const personActions = !!spec.pick?.startsWith("p:");
      for (const button of l.actions.querySelectorAll<HTMLButtonElement>("button[data-action='a'], button[data-action='b']")) {
        button.hidden = !personActions;
      }
      if (spec.pick) l.el.dataset.morphId = spec.pick;
      else delete l.el.dataset.morphId;
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
      if (l.primary instanceof HTMLButtonElement) {
        l.primary.setAttribute("aria-label", labelAccessibleName(spec));
      }
      // Pinning happened before collision testing, so the box we reserve is
      // exactly where the stable pooled element is drawn.
      const lx = Math.round(box.x0);
      l.el.style.transform = `translate3d(${lx}px, ${Math.round(box.y0)}px, 0)`;
      l.el.style.opacity = String(globalOpacity);
    }

    for (const [key, l] of this.live) {
      if (!used.has(key) && (key !== this.hoveredKey || !available.has(key))) {
        if (l.el.contains(document.activeElement)) {
          if (l.id) this.onFocusRestoreRequested?.(l.id);
          if (!this.host.hasAttribute("tabindex")) this.host.tabIndex = -1;
          if (l.el.contains(document.activeElement)) this.host.focus({ preventScroll: true });
          this.rovingKey = null;
        }
        l.el.remove();
        this.live.delete(key);
      }
    }
    this.updateRovingTabIndex(used);
    return { shown, wanted: specs.length };
  }

  clear(): void {
    for (const l of this.live.values()) l.el.remove();
    this.live.clear();
    this.hoveredKey = null;
    this.rovingKey = null;
  }

  private updateRovingTabIndex(used: ReadonlySet<string>): void {
    if (!this.rovingKey || !used.has(this.rovingKey)) {
      this.rovingKey = [...used].find((key) => this.live.get(key)?.primary instanceof HTMLButtonElement) ?? null;
    }
    for (const [key, live] of this.live) {
      if (live.primary instanceof HTMLButtonElement) live.primary.tabIndex = key === this.rovingKey ? 0 : -1;
    }
  }

  private moveRoving(fromKey: string, delta: -1 | 1): void {
    const keys = [...this.live]
      .filter(([, live]) => live.primary instanceof HTMLButtonElement && live.el.isConnected && live.el.style.opacity !== "0")
      .map(([key]) => key);
    const from = keys.indexOf(fromKey);
    if (from < 0 || keys.length < 2) return;
    const next = keys[(from + delta + keys.length) % keys.length]!;
    this.rovingKey = next;
    this.updateRovingTabIndex(new Set(keys));
    const primary = this.live.get(next)?.primary;
    if (primary instanceof HTMLButtonElement) primary.focus({ preventScroll: true });
  }
}

function labelAccessibleName(spec: MorphLabel): string {
  if (spec.accessibleName) return spec.accessibleName;
  const entityType = spec.pick?.startsWith("p:") ? "person" :
    spec.pick?.startsWith("pr:") ? "promotion" :
    spec.pick?.startsWith("t:") ? "championship" : spec.badge || (
    spec.tone === "promotion" ? "promotion" :
    spec.tone === "gold" ? "championship" :
    spec.tone === "person" || spec.tone === "cyan" || spec.tone === "ember" ? "person" : "entity"
  );
  return [spec.text, entityType, spec.roleDescription, spec.sub].filter(Boolean).join(", ");
}
