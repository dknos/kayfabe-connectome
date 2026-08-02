export type MorphHoverSource = "canvas" | "label" | "card" | "keyboard";

export interface MorphHoverSnapshot {
  readonly id: string | null;
  readonly source: MorphHoverSource | null;
  readonly candidateId: string | null;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly acquisitionTime: number;
  readonly lastConfirmedTime: number;
  readonly layoutGeneration: number;
  readonly cameraDragging: boolean;
  readonly touchActive: boolean;
}

export interface MorphHoverControllerOptions {
  graceMs?: number;
  confirmationFrames?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * One source-aware owner for transient Morph hover.
 *
 * Canvas candidates are frame-confirmed, while explicit DOM/keyboard surfaces
 * acquire immediately. Related surfaces share one leave timer, which means a
 * pointer can travel canvas -> label -> card without clearing semantic state.
 * The class has no React or DOM dependency and is intentionally fake-timer
 * friendly.
 */
export class MorphHoverController {
  onChange: ((state: MorphHoverSnapshot) => void) | null = null;

  private readonly graceMs: number;
  private readonly confirmationFrames: number;
  private readonly now: () => number;
  private readonly setTimer: MorphHoverControllerOptions["setTimer"];
  private readonly clearTimer: MorphHoverControllerOptions["clearTimer"];
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private candidateFrames = 0;
  private disposed = false;
  private state: MorphHoverSnapshot = {
    id: null,
    source: null,
    candidateId: null,
    pointerX: Number.NaN,
    pointerY: Number.NaN,
    acquisitionTime: 0,
    lastConfirmedTime: 0,
    layoutGeneration: 0,
    cameraDragging: false,
    touchActive: false,
  };

  constructor(options: MorphHoverControllerOptions = {}) {
    this.graceMs = options.graceMs ?? 100;
    this.confirmationFrames = Math.max(1, options.confirmationFrames ?? 2);
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  snapshot(): MorphHoverSnapshot {
    return this.state;
  }

  /** Update the last known local canvas pointer without causing a state emit. */
  setPointer(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.state = { ...this.state, pointerX: x, pointerY: y };
  }

  /** Canvas acquisition: first target is immediate; replacements need stable frames. */
  proposeCanvas(id: string | null, x: number, y: number): void {
    if (this.disposed) return;
    this.setPointer(x, y);
    if (this.state.cameraDragging || this.state.touchActive) return;
    // A focused DOM label owns semantic hover until focus leaves it. Pointer
    // movement underneath that label must not churn the keyboard target.
    if (this.state.source === "keyboard") return;
    if (!id) {
      this.leaveSurface("canvas");
      return;
    }
    this.cancelLeave();
    const now = this.now();
    if (this.state.id === id) {
      this.candidateFrames = 0;
      if (this.state.source === "canvas" && this.state.candidateId === null) {
        // Confirmation time is diagnostic state, not a UI event. Keeping this
        // silent prevents a React bridge from re-rendering per pointer frame.
        this.state = { ...this.state, lastConfirmedTime: now };
      } else {
        this.update({ source: "canvas", candidateId: null, lastConfirmedTime: now });
      }
      return;
    }
    if (this.state.id === null) {
      this.candidateFrames = 0;
      this.acquire(id, "canvas", now);
      return;
    }
    if (this.state.candidateId !== id) {
      this.candidateFrames = 1;
      this.update({ candidateId: id });
      return;
    }
    this.candidateFrames++;
    if (this.candidateFrames >= this.confirmationFrames) {
      this.candidateFrames = 0;
      this.acquire(id, "canvas", now);
    }
  }

  enterSurface(source: Exclude<MorphHoverSource, "canvas">, id: string): void {
    if (this.disposed || !id || (this.state.touchActive && source !== "keyboard")) return;
    this.cancelLeave();
    if (this.state.source === "keyboard" && this.state.id === id && source !== "keyboard") {
      this.state = { ...this.state, lastConfirmedTime: this.now() };
      return;
    }
    this.candidateFrames = 0;
    this.acquire(id, source, this.now());
  }

  leaveSurface(source: MorphHoverSource, id?: string): void {
    if (this.disposed) return;
    if (id && this.state.id !== id) return;
    // Ignore a stale leave from the surface that was just replaced by another.
    if (this.state.source !== source && this.state.id !== null) return;
    // Repeated empty canvas samples must not keep pushing the grace deadline
    // forward while the pointer travels through empty space.
    if (this.leaveTimer !== null) return;
    this.cancelLeave();
    this.leaveTimer = this.setTimer!(() => {
      this.leaveTimer = null;
      this.clear("leave");
    }, this.graceMs);
  }

  setDragging(dragging: boolean): void {
    if (this.disposed || this.state.cameraDragging === dragging) return;
    this.cancelLeave();
    this.update({ cameraDragging: dragging, candidateId: null });
    this.candidateFrames = 0;
  }

  setTouchActive(active: boolean): void {
    if (this.disposed || this.state.touchActive === active) return;
    this.cancelLeave();
    this.candidateFrames = 0;
    if (active) {
      this.update({
        id: null,
        source: null,
        candidateId: null,
        acquisitionTime: 0,
        lastConfirmedTime: this.now(),
        touchActive: true,
        cameraDragging: false,
      });
    } else {
      this.update({ touchActive: false });
    }
  }

  layoutChanged(isStillPresent: (id: string) => boolean): void {
    if (this.disposed) return;
    const generation = this.state.layoutGeneration + 1;
    this.cancelLeave();
    this.candidateFrames = 0;
    // A layout change invalidates spatial pointer ownership even when the same
    // canonical id survives: its projected node/label may have moved out from
    // under the pointer. Keyboard and card ownership are explicit surfaces
    // and may persist while that entity remains represented.
    const staleSpatialOwner = this.state.source === "canvas" || this.state.source === "label";
    if (this.state.id && (!isStillPresent(this.state.id) || staleSpatialOwner)) {
      this.update({
        id: null,
        source: null,
        candidateId: null,
        acquisitionTime: 0,
        lastConfirmedTime: this.now(),
        layoutGeneration: generation,
      });
    } else {
      this.update({ layoutGeneration: generation, candidateId: null });
    }
  }

  clear(_reason: "leave" | "layout" | "context" | "blur" | "cancel" | "touch" | "lens" = "cancel"): void {
    if (this.disposed) return;
    this.cancelLeave();
    this.candidateFrames = 0;
    if (this.state.id === null && this.state.source === null && this.state.candidateId === null) return;
    this.update({ id: null, source: null, candidateId: null, acquisitionTime: 0, lastConfirmedTime: this.now() });
  }

  dispose(): void {
    this.cancelLeave();
    this.disposed = true;
    this.onChange = null;
  }

  private acquire(id: string, source: MorphHoverSource, now: number): void {
    const acquisitionTime = this.state.id === id ? this.state.acquisitionTime : now;
    this.update({ id, source, candidateId: null, acquisitionTime, lastConfirmedTime: now });
  }

  private update(patch: Partial<MorphHoverSnapshot>): void {
    const before = this.state;
    const next = { ...before, ...patch };
    const changed = Object.keys(patch).some((key) =>
      before[key as keyof MorphHoverSnapshot] !== next[key as keyof MorphHoverSnapshot]);
    if (!changed) return;
    this.state = next;
    this.onChange?.(next);
  }

  private cancelLeave(): void {
    if (this.leaveTimer === null) return;
    this.clearTimer!(this.leaveTimer);
    this.leaveTimer = null;
  }
}
