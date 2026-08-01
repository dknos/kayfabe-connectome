import { useEffect, useState } from "react";
import { cardStrings, dayToIso, placeOf, useGeo } from "./geoStore";
import { loadSourceLocationMap, readCard } from "./geoAdapter";
import type { SourceLocationRow } from "./geoTypes";

/**
 * Evidence panel. Everything shown here is a documented record or a count of
 * documented records; every geographic claim carries its precision and the raw
 * source string it came from.
 */
export function GeoInspector() {
  const g = useGeo();
  const [slm, setSlm] = useState<Record<string, SourceLocationRow> | null>(null);
  const [cityCards, setCityCards] = useState<number[] | null>(null);

  useEffect(() => {
    if (g.selectedPlace >= 0 && !slm) void loadSourceLocationMap().then(setSlm).catch(() => null);
  }, [g.selectedPlace, slm]);

  // Cards in the ACTIVE SCOPE at the selected place — not every card ever
  // recorded there, which would silently widen the scope the user chose.
  useEffect(() => {
    if (!g.data || g.selectedPlace < 0) return setCityCards(null);
    const out: number[] = [];
    for (const idx of g.scopeIndices) {
      if ((g.data.cards[idx * g.data.stride + 2] ?? 0) - 1 === g.selectedPlace) out.push(idx);
    }
    setCityCards(out);
  }, [g.data, g.selectedPlace, g.scopeIndices]);

  if (!g.data) return null;
  const data = g.data;
  const card = g.openedCard ?? g.currentCard;
  const place = card ? placeOf(data, card.placeIdx) : null;
  const selected = placeOf(data, g.selectedPlace);
  const totals = g.scopeTotals;
  const c = g.counters;

  const rawFor = (pid: string): SourceLocationRow[] =>
    slm ? Object.values(slm).filter((r) => r.placeId === pid) : [];

  return (
    <aside className="rail right" aria-label="Geographic inspector">
      {card && (
        <section className="panel" data-testid="geo-current-card">
          <h2>Current card <i className="line" /></h2>
          <div className="dossier-title" data-testid="geo-event-name">
            {cardStrings(data, card).eventName || "(unnamed card)"}
          </div>
          <div className="dossier-sub">
            <span className="num" data-testid="geo-date">{dayToIso(card.day)}</span>
            {" · "}
            <span data-testid="geo-promotion">{cardStrings(data, card).promotion}</span>
          </div>
          <div className="dossier-sub" data-testid="geo-location">
            {place ? place.displayName : "location unresolved"}
            {place && (
              <span className="micro">
                {" "}· {place.precision}-level coordinate
                {place.resolution !== "confirmed" ? ` · ${place.resolution}` : ""}
              </span>
            )}
          </div>
          <div className="statgrid">
            <div className="stat">
              <div className="v num" data-testid="geo-match-count">{card.matchCount}</div>
              <div className="k">matches</div>
            </div>
            <div className="stat">
              <div className="v num">{card.personCount}</div><div className="k">wrestlers</div>
            </div>
            <div className="stat">
              <div className="v num">{card.titleMatchCount}</div><div className="k">title matches</div>
            </div>
          </div>
          {card.titleChangeCount > 0 && (
            <p className="gold-tag micro" data-testid="geo-title-change">
              {card.titleChangeCount} documented title change
              {card.titleChangeCount > 1 ? "s" : ""} on this card
            </p>
          )}
          {card.unresolvedParticipant && (
            <p className="derivation-note micro">
              This card includes a match whose participants the source did not fully name.
            </p>
          )}
          {!place && (
            <p className="derivation-note micro" data-testid="geo-unresolved-note">
              Location unresolved — this card is counted in every total but is not plotted. It is
              not placed at 0,0 and it is not discarded.
            </p>
          )}
          <p className="micro">card {card.cardId}</p>
          {g.currentBatch.length > 1 && (
            <p className="derivation-note micro" data-testid="geo-same-day">
              {g.currentBatch.length} documented cards share this date. They are shown together;
              the source records no show times, so they are not ordered into a route.
            </p>
          )}
          {g.openedCard && (
            <div className="actions">
              <button onClick={() => g.openCard(null)}>back to playback</button>
            </div>
          )}
        </section>
      )}

      {selected && (
        <section className="panel" data-testid="geo-place-inspector">
          <h2>Place <i className="line" /></h2>
          <div className="dossier-title">{selected.displayName}</div>
          <div className="dossier-sub micro">
            {selected.precision}-level coordinate · {selected.latitude.toFixed(4)},{" "}
            {selected.longitude.toFixed(4)} · {selected.source} · {selected.resolution}
            {selected.confidence ? ` (confidence ${selected.confidence.toFixed(2)})` : ""}
          </div>
          <div className="statgrid">
            <div className="stat">
              <div className="v num" data-testid="geo-place-scope-cards">
                {(cityCards?.length ?? 0).toLocaleString()}
              </div>
              <div className="k">cards in scope</div>
            </div>
            <div className="stat">
              <div className="v num">{selected.cards.toLocaleString()}</div>
              <div className="k">cards in corpus</div>
            </div>
            <div className="stat">
              <div className="v num">{selected.titleChanges}</div><div className="k">title changes</div>
            </div>
          </div>
          <p className="micro">
            first known card {selected.firstDay >= 0 ? dayToIso(selected.firstDay) : "—"} · latest{" "}
            {selected.lastDay >= 0 ? dayToIso(selected.lastDay) : "—"}
          </p>
          {slm && (
            <p className="micro">
              source strings: {rawFor(selected.id).slice(0, 4).map((r) => r.rawName).join(" · ") || "—"}
            </p>
          )}
          <div className="actions">
            <button onClick={() => { void g.setScope({ kind: "place", ids: [selected.id],
              label: selected.displayName }); }}>Play this city</button>
            <button onClick={() => (window as any).__kayfabeGeo?.focusPlace(g.selectedPlace)}>
              Focus
            </button>
            <button onClick={() => g.selectPlace(-1)}>Clear</button>
          </div>
          {cityCards && cityCards.length > 0 && (
            <div className="evidence" data-testid="geo-city-cards">
              {cityCards.slice(0, 40).map((idx) => {
                const cc = readCard(data, idx);
                const s = cardStrings(data, cc);
                return (
                  <button
                    key={cc.cardId} className="ev-row" onClick={() => g.openCard(cc)}
                    data-testid="geo-city-card-row"
                  >
                    <span className="d">{s.date}</span>
                    <span>{s.eventName || s.promotion}</span>
                    <span className="micro">{cc.matchCount}m</span>
                    {cc.titleChangeCount > 0 && <span className="gold-tag">★</span>}
                  </button>
                );
              })}
              {cityCards.length > 40 && (
                <p className="micro">showing 40 of {cityCards.length} cards in scope here</p>
              )}
            </div>
          )}
        </section>
      )}

      <section className="panel" data-testid="geo-scope-summary">
        <h2>Scope summary <i className="line" /></h2>
        <div className="statgrid">
          <div className="stat">
            <div className="v num" data-testid="geo-total-cards">
              {(totals?.cardsProcessed ?? 0).toLocaleString()}
            </div>
            <div className="k">cards</div>
          </div>
          <div className="stat">
            <div className="v num">{(totals?.matchesRepresented ?? 0).toLocaleString()}</div>
            <div className="k">matches</div>
          </div>
          <div className="stat">
            <div className="v num">{(totals?.uniquePlaces ?? 0).toLocaleString()}</div>
            <div className="k">places</div>
          </div>
          <div className="stat">
            <div className="v num">{(totals?.titleMatches ?? 0).toLocaleString()}</div>
            <div className="k">title matches</div>
          </div>
          <div className="stat">
            <div className="v num">{(totals?.titleChanges ?? 0).toLocaleString()}</div>
            <div className="k">title changes</div>
          </div>
          <div className="stat">
            <div className="v num" data-testid="geo-scope-unresolved">
              {(totals?.unresolvedCards ?? 0).toLocaleString()}
            </div>
            <div className="k">unplotted</div>
          </div>
        </div>
        <p className="micro" data-testid="geo-progress">
          processed <b className="num">{(c?.cardsProcessed ?? 0).toLocaleString()}</b> of{" "}
          <b className="num">{(totals?.cardsProcessed ?? 0).toLocaleString()}</b> cards ·{" "}
          <b className="num">{(c?.matchesRepresented ?? 0).toLocaleString()}</b> matches represented
        </p>
        {totals && totals.unresolvedCards > 0 && (
          <p className="derivation-note micro">
            {totals.unresolvedCards.toLocaleString()} card
            {totals.unresolvedCards > 1 ? "s" : ""} in this scope have a location the resolver could
            not settle. They are counted above and are not plotted.
          </p>
        )}
      </section>
    </aside>
  );
}
