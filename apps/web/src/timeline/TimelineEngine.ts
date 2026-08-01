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
    // mirror the materializer's (date, card, match) string ordering exactly —
    // ids are NOT all numeric ('c:c45' is a csv card), so no Number() here
    this.events.sort((a, b) =>
      a.d < b.d ? -1 : a.d > b.d ? 1 : a.c < b.c ? -1 : a.c > b.c ? 1 : a.m < b.m ? -1 : a.m > b.m ? 1 : 0,
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

  /** Derive pulse set for one match event — mirrors encounters@2
   * (docs/CANONICAL-MODEL.md), bounded for visual legibility. */
  static derive(ev: TimelineEvent): FiredEvent {
    const pulses: FiredEvent["pulses"] = [];
    const decisive = ev.res.startsWith("def");
    const cap = 8; // bounded per-event fan-out; battle royals stay legible
    const push = (a: string, b: string, kind: "same" | "opposed" | "br") => {
      if (pulses.length < cap) pulses.push({ a, b, kind });
    };
    const sameWithin = (unit: string[]) => {
      for (let i = 0; i < unit.length; i++)
        for (let j = i + 1; j < unit.length; j++) push(unit[i]!, unit[j]!, "same");
    };
    if (ev.form === "battle_royal") {
      for (const a of ev.w) for (const b of ev.l) push(a, b, "br");
    } else if (ev.form === "multi_way") {
      const all = [...(ev.wu ?? [ev.w]), ...(ev.lu ?? [ev.l])];
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++)
          for (const a of all[i]!) for (const b of all[j]!) push(a, b, "opposed");
      const explicitW = (ev.wu ?? [ev.w]).length >= 2;
      const explicitL = (ev.lu ?? [ev.l]).length >= 2;
      for (const u of ev.wu ?? [ev.w]) if (explicitW || decisive) sameWithin(u);
      for (const u of ev.lu ?? [ev.l]) if (explicitL) sameWithin(u);
    } else {
      for (const a of ev.w) for (const b of ev.l) push(a, b, "opposed");
      if (ev.form === "tag_team" || ev.form === "team_implied") {
        for (const u of ev.wu ?? [ev.w]) sameWithin(u);
        for (const u of ev.lu ?? [ev.l]) sameWithin(u);
      }
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
