import type { GeoPulseIntent } from "@kayfabe/geo-renderer";
import { readCard, type GeoData } from "./geoAdapter";
import type { ClockKind, GeoCard } from "./geoTypes";

/**
 * The geographic playback clock.
 *
 * This is the ANALYTICAL half of the pipeline and it is deliberately blind to
 * the renderer. It walks the scoped card list in order, emits one semantic
 * intent per card, and keeps exact counters. The renderer downstream may
 * aggregate the visuals as hard as its budget requires; these numbers do not
 * change, which is what lets the inspector report "2,413 of 8,920 cards" and
 * mean it.
 *
 * Same-day cards form a BATCH. In calendar time the whole batch fires at once,
 * because the source records a date and not a start time — ordering two shows
 * within a day would be an invention. In record time they play in card-id
 * order, which the UI labels as source record order rather than as a schedule.
 */

export interface GeoCounters {
  cardsProcessed: number;
  matchesRepresented: number;
  resolvedCards: number;
  unresolvedCards: number;
  titleMatches: number;
  titleChanges: number;
  uniquePlaces: number;
  /** Logical intents the scheduler declined to emit. Must stay 0. */
  intentsDropped: number;
}

export interface GeoBatch {
  day: number;
  intents: GeoPulseIntent[];
  /** Index of the last card consumed, for the progress readout. */
  cursor: number;
}

const EMPTY: GeoCounters = {
  cardsProcessed: 0, matchesRepresented: 0, resolvedCards: 0, unresolvedCards: 0,
  titleMatches: 0, titleChanges: 0, uniquePlaces: 0, intentsDropped: 0,
};

export class GeoScheduler {
  private data: GeoData;
  /** Card indices in scope, date-sorted. */
  private scope: number[] = [];
  /** How far through `scope` playback has consumed. */
  private cursor = 0;
  private clock: ClockKind = "record";
  /** days/second in calendar mode, cards/second in record mode. */
  private speed = 3;
  private currentDay = 0;
  private carry = 0;
  private places = new Set<number>();
  counters: GeoCounters = { ...EMPTY };
  /** Batch id increments per distinct date, so arcs can refuse to connect
   * cards that share one. */
  private batchId = 0;
  private lastBatchDay = Number.NaN;

  constructor(data: GeoData) {
    this.data = data;
  }

  setScope(indices: number[]): void {
    this.scope = indices;
    this.reset();
  }

  get scopeSize(): number {
    return this.scope.length;
  }

  get position(): number {
    return this.cursor;
  }

  get done(): boolean {
    return this.cursor >= this.scope.length;
  }

  get dayRange(): [number, number] {
    if (!this.scope.length) return [0, 0];
    const s = this.data.stride;
    return [
      this.data.cards[this.scope[0]! * s]!,
      this.data.cards[this.scope[this.scope.length - 1]! * s]!,
    ];
  }

  get day(): number {
    return this.currentDay;
  }

  setClock(clock: ClockKind, speed: number): void {
    this.clock = clock;
    this.speed = speed;
    this.carry = 0;
  }

  reset(): void {
    this.cursor = 0;
    this.carry = 0;
    this.places.clear();
    this.counters = { ...EMPTY };
    this.batchId = 0;
    this.lastBatchDay = Number.NaN;
    this.currentDay = this.scope.length ? this.data.cards[this.scope[0]! * this.data.stride]! : 0;
  }

  /** Jump to a position without emitting — used by the scrubber. Counters are
   * recomputed from scratch so a scrub can never leave a stale total behind. */
  seek(position: number): void {
    const target = Math.max(0, Math.min(this.scope.length, position));
    this.reset();
    for (let i = 0; i < target; i++) this.consume(this.card(i), false);
    this.cursor = target;
    if (target > 0) this.currentDay = this.card(target - 1).day;
  }

  private card(i: number): GeoCard {
    return readCard(this.data, this.scope[i]!);
  }

  private consume(c: GeoCard, emit: boolean): GeoPulseIntent | null {
    this.counters.cardsProcessed++;
    this.counters.matchesRepresented += c.matchCount;
    this.counters.titleMatches += c.titleMatchCount;
    this.counters.titleChanges += c.titleChangeCount;
    if (c.placeIdx >= 0) {
      this.counters.resolvedCards++;
      this.places.add(c.placeIdx);
      this.counters.uniquePlaces = this.places.size;
    } else {
      // An unresolved location is still a documented card. It advances every
      // count except the geographic ones and simply never lights the globe.
      this.counters.unresolvedCards++;
    }
    if (!emit) return null;
    if (c.day !== this.lastBatchDay) {
      this.lastBatchDay = c.day;
      this.batchId++;
    }
    return {
      cardIndex: c.index,
      cardId: c.cardId,
      day: c.day,
      promotionIdx: c.promotionIdx,
      eventNameIdx: c.eventNameIdx,
      placeIdx: c.placeIdx,
      matchCount: c.matchCount,
      personCount: c.personCount,
      titleMatchCount: c.titleMatchCount,
      titleChangeCount: c.titleChangeCount,
      unresolvedParticipant: c.unresolvedParticipant,
      batchId: this.batchId,
    };
  }

  /** Consume the next single card. */
  stepCard(): GeoBatch | null {
    if (this.done) return null;
    const c = this.card(this.cursor);
    const intent = this.consume(c, true)!;
    this.cursor++;
    this.currentDay = c.day;
    return { day: c.day, intents: [intent], cursor: this.cursor };
  }

  /** Consume every remaining card sharing the next card's date. */
  stepBatch(): GeoBatch | null {
    if (this.done) return null;
    const day = this.card(this.cursor).day;
    const intents: GeoPulseIntent[] = [];
    while (!this.done && this.card(this.cursor).day === day) {
      intents.push(this.consume(this.card(this.cursor), true)!);
      this.cursor++;
    }
    this.currentDay = day;
    return { day, intents, cursor: this.cursor };
  }

  /**
   * Advance the clock by `dtSeconds` and return everything that fell due.
   *
   * Every card between the old and new clock position is consumed. Nothing is
   * skipped at high speed — the renderer decides how to draw a hundred cards
   * arriving in one tick, but all hundred are counted here.
   */
  advance(dtSeconds: number): GeoBatch | null {
    if (this.done || dtSeconds <= 0) return null;
    const intents: GeoPulseIntent[] = [];
    if (this.clock === "calendar") {
      this.currentDay += this.speed * dtSeconds;
      while (!this.done && this.card(this.cursor).day <= this.currentDay) {
        intents.push(this.consume(this.card(this.cursor), true)!);
        this.cursor++;
      }
    } else {
      this.carry += this.speed * dtSeconds;
      const take = Math.floor(this.carry);
      this.carry -= take;
      for (let n = 0; n < take && !this.done; n++) {
        const c = this.card(this.cursor);
        intents.push(this.consume(c, true)!);
        this.cursor++;
        this.currentDay = c.day;
      }
    }
    if (!intents.length) return null;
    return { day: this.currentDay, intents, cursor: this.cursor };
  }

  /** Fast-forward to the next card at a place not yet activated. */
  nextNewPlace(): GeoBatch | null {
    const intents: GeoPulseIntent[] = [];
    while (!this.done) {
      const c = this.card(this.cursor);
      const fresh = c.placeIdx >= 0 && !this.places.has(c.placeIdx);
      intents.push(this.consume(c, true)!);
      this.cursor++;
      this.currentDay = c.day;
      if (fresh) break;
    }
    return intents.length ? { day: this.currentDay, intents, cursor: this.cursor } : null;
  }

  /** Fast-forward to the next documented title change. */
  nextTitleChange(): GeoBatch | null {
    const intents: GeoPulseIntent[] = [];
    while (!this.done) {
      const c = this.card(this.cursor);
      intents.push(this.consume(c, true)!);
      this.cursor++;
      this.currentDay = c.day;
      if (c.titleChangeCount > 0) break;
    }
    return intents.length ? { day: this.currentDay, intents, cursor: this.cursor } : null;
  }

  /** The card most recently consumed, for the inspector. */
  currentCard(): GeoCard | null {
    return this.cursor > 0 ? this.card(this.cursor - 1) : null;
  }

  /** Every card at the same date as the current one — the active batch. */
  currentBatch(): GeoCard[] {
    if (this.cursor === 0) return [];
    const day = this.card(this.cursor - 1).day;
    const out: GeoCard[] = [];
    for (let i = this.cursor - 1; i >= 0; i--) {
      const c = this.card(i);
      if (c.day !== day) break;
      out.unshift(c);
    }
    return out;
  }

  /** Totals for the whole scope, independent of playback position — this is
   * what the scope summary reports so it never reads as a partial count. */
  scopeTotals(): GeoCounters {
    const t: GeoCounters = { ...EMPTY };
    const places = new Set<number>();
    for (let i = 0; i < this.scope.length; i++) {
      const c = this.card(i);
      t.cardsProcessed++;
      t.matchesRepresented += c.matchCount;
      t.titleMatches += c.titleMatchCount;
      t.titleChanges += c.titleChangeCount;
      if (c.placeIdx >= 0) {
        t.resolvedCards++;
        places.add(c.placeIdx);
      } else {
        t.unresolvedCards++;
      }
    }
    t.uniquePlaces = places.size;
    return t;
  }

  /** Place indices the scope can reach, for the heat layer and camera fit. */
  scopePlaces(): number[] {
    const s = new Set<number>();
    for (let i = 0; i < this.scope.length; i++) {
      const p = this.data.cards[this.scope[i]! * this.data.stride + 2]! - 1;
      if (p >= 0) s.add(p);
    }
    return Array.from(s).sort((a, b) => a - b);
  }

  scopeIndices(): number[] {
    return this.scope;
  }
}
