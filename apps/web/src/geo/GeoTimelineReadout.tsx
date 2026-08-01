import { cardStrings, dayToIso, placeOf, scheduler, useGeo } from "./geoStore";
import { GEO_COLORS } from "@kayfabe/geo-renderer";

const rgb = (c: readonly [number, number, number], a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/**
 * The bottom bar: where playback is, what is on screen right now, and what the
 * globe's encodings mean. The legend is not decoration — beacon size encodes a
 * metric the user chose, and an unlabelled size encoding is unreadable.
 */
export function GeoTimelineReadout() {
  const g = useGeo();
  if (!g.data) return null;
  const data = g.data;
  const card = g.currentCard;
  const place = card ? placeOf(data, card.placeIdx) : null;
  const total = g.scopeTotals?.cardsProcessed ?? 0;
  const pct = total ? Math.min(100, (g.cursor / total) * 100) : 0;
  const quality = data.quality;

  return (
    <footer className="pulsebar geo-bar">
      <div className="pulse-controls">
        <button
          aria-label={g.playing ? "Pause" : "Play"}
          className={g.playing ? "active" : ""}
          onClick={() => g.setPlaying(!g.playing)}
          disabled={!g.scopeIndices.length}
        >
          {g.playing ? "❚❚" : "▶"}
        </button>
        <input
          className="geo-scrub"
          type="range" min={0} max={Math.max(0, total)} value={g.cursor}
          aria-label="Scrub playback"
          onChange={(e) => {
            scheduler?.seek(Number(e.target.value));
            useGeo.getState().syncFromScheduler();
            (window as any).__kayfabeGeo?.clearTransient();
          }}
        />
      </div>

      <div className="geo-legend" aria-label="Legend">
        <span><i className="swatch dot" style={{ background: rgb(GEO_COLORS.beaconHot) }} /> card</span>
        <span><i className="swatch dot" style={{ background: rgb(GEO_COLORS.gold) }} /> title change</span>
        <span><i className="swatch" style={{ background: rgb(GEO_COLORS.arc) }} /> record sequence</span>
        <span className="micro">beacon size = {g.heatMetric === "cards" ? "matches on the card" : g.heatMetric}</span>
      </div>

      <div className="pulse-readout" data-testid="geo-readout">
        <div className="date num">{card ? dayToIso(card.day) : "—"}</div>
        <div className="evt">
          {card ? `${cardStrings(data, card).promotion} · ${cardStrings(data, card).eventName}` : "press play"}
        </div>
        <div className="evt">{place ? place.displayName : card ? "location unresolved" : ""}</div>
        <div className="micro">
          {card ? `${card.matchCount} matches` : ""}
          {card && card.titleChangeCount > 0 ? ` · ${card.titleChangeCount} title change` : ""}
          {total ? ` · card ${g.cursor.toLocaleString()} of ${total.toLocaleString()} in scope` : ""}
        </div>
        <div className="micro" data-testid="geo-coverage">
          geographic coverage {(quality.cardCoverage * 100).toFixed(1)}% of cards ·{" "}
          {quality.unplottedCards.toLocaleString()} unplotted · city-level coordinates
        </div>
      </div>
      <div className="geo-progress-line" style={{ width: `${pct}%` }} aria-hidden />
    </footer>
  );
}
