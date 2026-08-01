import type { TimelineEvent } from "@kayfabe/graph-contract";
import { isoToDay } from "@kayfabe/graph-contract";
import { loadYear } from "../data/loader";
import { useStore } from "../state/store";

export interface FiredEvent {
  ev: TimelineEvent;
  /** derived pulse instructions per CANONICAL-MODEL derivation rules */
  pulses: { a: string; b: string; kind: "same" | "opposed" | "br" | "gold" }[];
  ignite: string[];
}

/**
 * Deterministic playback head over the materialized timeline. Ordering is the
 * files' own (date, card, match). The engine owns the clock; the store holds
 * the serializable state; the renderer receives fire instructions via callback.
 */
export class TimelineEngine {
  private events: TimelineEvent[] = [];
  private loadedYears = new Set<number>();
  private cursor = 0; // index of next event to fire
  private raf = 0;
  private lastTs = 0;
  onFire: ((f: FiredEvent) => void) | null = null;

  async ensureRange(y0: number, y1: number): Promise<void> {
    const range = useStore.getState().core?.manifest.date_range;
    if (range) {
      // never request years the corpus does not materialize — a 404 is noise
      y0 = Math.max(y0, Number(range[0].slice(0, 4)));
      y1 = Math.min(y1, Number(range[1].slice(0, 4)));
    }
    const missing: number[] = [];
    for (let y = y0; y <= y1; y++) if (!this.loadedYears.has(y)) missing.push(y);
    if (!missing.length) return;
    const batches = await Promise.all(missing.map((y) => loadYear(y)));
    missing.forEach((y) => this.loadedYears.add(y));
    this.events = this.events.concat(batches.flat());
    this.events.sort((a, b) =>
      a.d < b.d ? -1 : a.d > b.d ? 1 : numId(a.c) - numId(b.c) || numId(a.m) - numId(b.m),
    );
    this.resyncCursor(useStore.getState().timeline.day);
  }

  resyncCursor(day: number): void {
    // first event strictly after `day`
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (isoToDay(this.events[mid]!.d) <= day) lo = mid + 1;
      else hi = mid;
    }
    this.cursor = lo;
  }

  eventAtCursor(offset = -1): TimelineEvent | null {
    return this.events[this.cursor + offset] ?? null;
  }

  /** Derive pulse set for one match event — mirrors docs/CANONICAL-MODEL.md. */
  static derive(ev: TimelineEvent): FiredEvent {
    const pulses: FiredEvent["pulses"] = [];
    const decisive = ev.res.startsWith("def");
    const cap = 8; // bounded per-event fan-out; battle royals stay legible
    for (const a of ev.w)
      for (const b of ev.l) {
        if (pulses.length >= cap) break;
        pulses.push({ a, b, kind: ev.form === "battle_royal" ? "br" : "opposed" });
      }
    const teamForm = ev.form === "tag_team" || ev.form === "team_implied";
    const sameWithin = (side: string[]) => {
      for (let i = 0; i < side.length; i++)
        for (let j = i + 1; j < side.length; j++) {
          if (pulses.length >= cap) return;
          pulses.push({ a: side[i]!, b: side[j]!, kind: "same" });
        }
    };
    if (teamForm) {
      sameWithin(ev.w);
      sameWithin(ev.l);
    } else if (ev.form === "multi_way" && decisive) {
      sameWithin(ev.w);
    }
    if (ev.tc === 1) {
      for (const winner of ev.w.slice(0, 4)) {
        for (const loser of ev.l.slice(0, 2)) pulses.push({ a: loser, b: winner, kind: "gold" });
      }
    }
    return { ev, pulses, ignite: [...ev.w, ...ev.l] };
  }

  private fireUpTo(day: number): void {
    let fired = 0;
    while (this.cursor < this.events.length && fired < 12) {
      const ev = this.events[this.cursor]!;
      if (isoToDay(ev.d) > day) break;
      this.cursor++;
      fired++;
      this.onFire?.(TimelineEngine.derive(ev));
      useStore.getState().setCurrentEvent(ev);
    }
    // If a burst was larger than the cap, skip silently past (density stays truthful in the histogram)
    while (this.cursor < this.events.length && isoToDay(this.events[this.cursor]!.d) <= day) {
      this.cursor++;
    }
  }

  /** Step to the next/previous discrete record. Returns the new head day. */
  step(dir: 1 | -1): number | null {
    const st = useStore.getState();
    if (dir === 1) {
      const ev = this.events[this.cursor];
      if (!ev) return null;
      this.cursor++;
      this.onFire?.(TimelineEngine.derive(ev));
      st.setCurrentEvent(ev);
      return isoToDay(ev.d);
    }
    if (this.cursor <= 1) return null;
    this.cursor -= 1;
    const ev = this.events[this.cursor - 1]!;
    this.onFire?.(TimelineEngine.derive(ev));
    st.setCurrentEvent(ev);
    return isoToDay(ev.d);
  }

  play(): void {
    this.stopLoop();
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      const st = useStore.getState();
      if (!st.timeline.playing) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      const day = st.timeline.day + st.timeline.speed * dt;
      const [_, dMax] = st.model?.fullDayRange ?? [0, 0];
      if (day >= dMax) {
        st.setTimeline({ day: dMax, playing: false });
        return;
      }
      this.fireUpTo(Math.floor(day));
      st.setTimeline({ day });
    };
    this.raf = requestAnimationFrame(loop);
  }

  stopLoop(): void {
    cancelAnimationFrame(this.raf);
  }

  scrubTo(day: number): void {
    this.resyncCursor(day);
    useStore.getState().setCurrentEvent(this.eventAtCursor(-1));
  }
}

const numId = (id: string): number => Number(id.slice(id.indexOf(":") + 1));
