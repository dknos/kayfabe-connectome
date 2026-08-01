import { useEffect, useState } from "react";
import type { TimelineEvent } from "@kayfabe/graph-contract";
import { loadYear } from "../data/loader";
import { dayToIso, useGeo } from "./geoStore";

/**
 * Match Beat granularity.
 *
 * The current city stays lit and the camera stays put while the individual
 * matches on that card advance here. That is the whole point: a ten-match show
 * happened in ONE place, so inspecting its ten matches must not produce ten
 * geographic events. The globe emits a small local pulse at the same city and
 * nothing else moves.
 *
 * Matches come from the existing per-year timeline records — the same evidence
 * the connectome's dossiers read — so a match shown here and a match shown
 * there are the same record.
 */
export function GeoMatchBeats() {
  const g = useGeo();
  const card = g.openedCard ?? g.currentCard;
  const [matches, setMatches] = useState<TimelineEvent[] | null>(null);
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    if (g.unit !== "match" || !card) {
      setMatches(null);
      return;
    }
    let live = true;
    const year = Number(dayToIso(card.day).slice(0, 4));
    void loadYear(year).then((events) => {
      if (!live) return;
      setMatches(events.filter((e) => e.c === card.cardId));
      setBeat(0);
    });
    return () => { live = false; };
  }, [g.unit, card?.cardId, card?.day]);

  // A local pulse at the SAME place — never a new location.
  useEffect(() => {
    if (!matches?.length || !card || card.placeIdx < 0) return;
    const p = g.data?.places[card.placeIdx];
    if (!p) return;
    (window as any).__kayfabeGeo?.pulse([{
      placeIdx: card.placeIdx,
      latitude: p.latitude,
      longitude: p.longitude,
      energy: 0.25,
      gold: matches[beat]?.tc === 1,
      cardCount: 0, // a beat is not a card; it must not inflate any counter
      label: p.city ?? p.displayName,
    }]);
  }, [beat, matches, card?.cardId]);

  if (g.unit !== "match" || !card) return null;

  return (
    <section className="panel" data-testid="geo-match-beats">
      <h2>Match beats <i className="line" /></h2>
      {!matches && <p className="micro">loading matches on this card…</p>}
      {matches && matches.length === 0 && (
        <p className="micro">no match records for this card in the timeline store</p>
      )}
      {matches && matches.length > 0 && (
        <>
          <div className="row">
            <button
              aria-label="Previous match beat"
              onClick={() => setBeat((b) => Math.max(0, b - 1))}
              disabled={beat === 0}
            >◀</button>
            <span className="num micro" data-testid="geo-beat-position">
              match {beat + 1} of {matches.length}
            </span>
            <button
              aria-label="Next match beat"
              onClick={() => setBeat((b) => Math.min(matches.length - 1, b + 1))}
              disabled={beat >= matches.length - 1}
            >▶</button>
          </div>
          <div className="evidence">
            {matches.map((m, i) => (
              <button
                key={m.m}
                className={`ev-row ${i === beat ? "sel" : ""}`}
                onClick={() => setBeat(i)}
                data-testid="geo-beat-row"
              >
                <span className="d">{i + 1}</span>
                <span>
                  {(m.w ?? []).length} v {(m.l ?? []).length} · {m.form}
                  {m.stip ? ` · ${m.stip}` : ""}
                </span>
                {m.tc === 1 && <span className="gold-tag">★</span>}
              </button>
            ))}
          </div>
          <p className="derivation-note micro">
            Every match on this card happened in one place. Stepping through them moves the
            inspector, not the globe — no beat produces a second location.
          </p>
        </>
      )}
    </section>
  );
}
