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
 * What playback is scoped to.
 *
 * v1 only knew about a person, because only the connectome consumed it. ATLAS
 * plays a promotion lane and a title lineage as well, and those are different
 * questions about the same record stream — so the scope is typed rather than a
 * second nullable field per kind.
 */
export type TimelineScope =
  | null
  | { kind: "person"; id: string }
  | { kind: "promotion"; id: string }
  | { kind: "title"; id: string };

export type FireListener = (f: FiredEvent) => void;

/**
 * Deterministic playback head over the materialized timeline. Ordering is the
 * files' own (date, card, match). The engine owns the clock; the store holds
 * the serializable state; renderers subscribe for fire instructions.
 *
 * Subscription rather than a single `onFire` slot: two lenses can be mounted at
 * once (the connectome stays alive but paused while ATLAS is open), and a bare
 * callback property means whichever mounted last silently owns playback and
 * whichever unmounts first silently kills it for both.
 */
export class TimelineEngine {
  private events: TimelineEvent[] = [];
  private loadedYears = new Set<number>();
  private cursor = 0; // index of next event to fire
  private raf = 0;
  private lastTs = 0;
  private listeners = new Set<FireListener>();
  private scope: TimelineScope = null;

  /** Subscribe a renderer. Returns the unsubscribe. */
  addListener(fn: FireListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(f: FiredEvent): void {
    for (const fn of this.listeners) fn(f);
  }

  setScope(scope: TimelineScope): void {
    const prev = this.scope;
    const same =
      (prev === null && scope === null) ||
      (prev !== null && scope !== null && prev.kind === scope.kind && prev.id === scope.id);
    if (same) return;
    this.scope = scope;
    // The cursor was placed under the old scope's filter; re-seat it on the
    // current playhead so a scope change does not replay or skip history.
    this.resyncCursor(useStore.getState().timeline.day);
  }

  get currentScope(): TimelineScope {
    return this.scope;
  }

  /** Back-compat shim for the connectome's person playback. */
  setParticipant(id: string | null): void {
    this.setScope(id ? { kind: "person", id } : null);
  }

  private inScope(ev: TimelineEvent): boolean {
    const s = this.scope;
    if (!s) return true;
    if (s.kind === "person") return ev.w.includes(s.id) || ev.l.includes(s.id);
    if (s.kind === "promotion") return ev.pr === s.id;
    return ev.t === s.id;
  }

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
      // The DATE bound has to be tested before the scope filter. Testing scope
      // first advanced the cursor past out-of-scope events with no date bound
      // at all — invisible for a person (they appear often) and fatal for a
      // title scope, where three reigns live inside 365,000 records and one
      // frame would scan most of the array.
      if (isoToDay(ev.d) > day) break;
      this.cursor++;
      if (!this.inScope(ev)) continue;
      fired++;
      this.emit(TimelineEngine.derive(ev));
      useStore.getState().setCurrentEvent(ev);
    }
    // If a burst was larger than the cap, skip silently past (density stays truthful in the histogram)
    while (this.cursor < this.events.length && isoToDay(this.events[this.cursor]!.d) <= day) {
      this.cursor++;
    }
  }

  /** Step to the next/previous discrete record IN SCOPE. Returns the new head day. */
  step(dir: 1 | -1): number | null {
    const st = useStore.getState();
    if (dir === 1) {
      let i = this.cursor;
      while (i < this.events.length && !this.inScope(this.events[i]!)) i++;
      const ev = this.events[i];
      if (!ev) return null;
      this.cursor = i + 1;
      this.emit(TimelineEngine.derive(ev));
      st.setCurrentEvent(ev);
      return isoToDay(ev.d);
    }
    let i = this.cursor - 2;
    while (i >= 0 && !this.inScope(this.events[i]!)) i--;
    if (i < 0) return null;
    const ev = this.events[i]!;
    this.cursor = i + 1;
    this.emit(TimelineEngine.derive(ev));
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
