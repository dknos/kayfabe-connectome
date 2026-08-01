import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { cardStrings, dayToIso, placeOf, useGeo } from "./geoStore";

/**
 * Speaks playback to a screen reader without flooding it.
 *
 * At one card a second every card can be announced. At a hundred a second no
 * one can hear a hundred announcements, and a live region that never settles
 * is worse than silence — so above the readable rate this switches to
 * periodic BATCH summaries: how many cards, how many cities, how many title
 * changes since the last announcement.
 */

const MIN_GAP_MS = 2600;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function spokenDate(day: number): string {
  const iso = dayToIso(day);
  const [y, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
}

export function GeoAnnouncer() {
  const cursor = useGeo((s) => s.cursor);
  const playing = useGeo((s) => s.playing);
  const lastAt = useRef(0);
  const lastCursor = useRef(0);
  const announce = useStore((s) => s.announce);

  useEffect(() => {
    const g = useGeo.getState();
    if (!g.data || !g.currentCard) return;
    const now = performance.now();
    if (now - lastAt.current < MIN_GAP_MS) return;
    const since = cursor - lastCursor.current;
    lastAt.current = now;
    lastCursor.current = cursor;

    const card = g.currentCard;
    const place = placeOf(g.data, card.placeIdx);
    const s = cardStrings(g.data, card);

    if (!playing || since <= 2) {
      // Readable rate: the full record, in the order a reader needs it.
      announce(
        `${spokenDate(card.day)}. ${s.promotion}. ` +
          `${place ? place.displayName : "Location unresolved"}. ` +
          `${card.matchCount} ${card.matchCount === 1 ? "match" : "matches"}.` +
          (card.titleChangeCount
            ? ` ${card.titleChangeCount} title change${card.titleChangeCount > 1 ? "s" : ""}.`
            : ""),
      );
    } else {
      // Above the readable rate, summarise the batch instead of racing it.
      const c = g.counters;
      announce(
        `${since} cards through ${spokenDate(card.day)}. ` +
          `${c?.uniquePlaces ?? 0} cities so far, ` +
          `${(c?.titleChanges ?? 0).toLocaleString()} title changes, ` +
          `${(c?.cardsProcessed ?? 0).toLocaleString()} of ` +
          `${(g.scopeTotals?.cardsProcessed ?? 0).toLocaleString()} cards.`,
      );
    }
  }, [cursor, playing, announce]);

  return null;
}

/** Keyboard reference, rendered in the controls so the shortcuts are
 * discoverable rather than folklore. */
export function GeoShortcuts() {
  return (
    <section className="panel">
      <h2>Keyboard <i className="line" /></h2>
      <dl className="geo-keys micro">
        <dt>Space</dt><dd>play / pause</dd>
        <dt>→ / ←</dt><dd>next / previous card</dd>
        <dt>Shift + → / ←</dt><dd>next / previous date batch</dd>
        <dt>F</dt><dd>focus the selected city</dd>
        <dt>W</dt><dd>return to the world view</dd>
        <dt>A</dt><dd>toggle chronological record arcs</dd>
        <dt>H</dt><dd>toggle geographic afterglow</dd>
        <dt>Esc</dt><dd>close the inspector / release camera follow</dd>
      </dl>
    </section>
  );
}
