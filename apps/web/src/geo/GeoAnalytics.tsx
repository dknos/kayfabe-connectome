import { useMemo, useState } from "react";
import { resolveScope } from "./geoAdapter";
import { comparePlaces, computeFootprint, FORMULAS } from "./geoAnalytics";
import { dayToIso, useGeo } from "./geoStore";

/**
 * Derived geographic metrics, each shown with the formula that produced it.
 *
 * The labels are the point. "Computed centre of documented cards" is a true
 * statement about an arithmetic mean; "headquarters" would be a claim about
 * the world that this corpus cannot support.
 */
export function GeoAnalytics() {
  const g = useGeo();
  const [open, setOpen] = useState(false);
  const fp = useMemo(
    () => (open && g.data && g.scopeIndices.length ? computeFootprint(g.data, g.scopeIndices) : null),
    [open, g.data, g.scopeIndices],
  );

  if (!g.data) return null;
  return (
    <section className="panel" data-testid="geo-analytics">
      <h2>
        Footprint <i className="line" />
        <button className="collapse-btn ghost" onClick={() => setOpen(!open)}>
          {open ? "hide" : "compute"}
        </button>
      </h2>
      {!open && <p className="micro">Derived metrics over the {g.scopeIndices.length.toLocaleString()} cards in scope.</p>}
      {open && fp && (
        <>
          <div className="statgrid">
            <div className="stat"><div className="v num">{fp.places.toLocaleString()}</div><div className="k">places</div></div>
            <div className="stat"><div className="v num">{fp.countries}</div><div className="k">countries</div></div>
            <div className="stat"><div className="v num">{fp.cards.toLocaleString()}</div><div className="k">cards</div></div>
          </div>
          <p className="micro">
            first known plotted record {fp.firstDay >= 0 ? dayToIso(fp.firstDay) : "—"} · latest{" "}
            {fp.lastDay >= 0 ? dayToIso(fp.lastDay) : "—"}
          </p>

          <h2 className="micro">Computed centre <i className="line" /></h2>
          <p className="num" data-testid="geo-centroid">
            {fp.centroid
              ? `${fp.centroid.latitude.toFixed(3)}, ${fp.centroid.longitude.toFixed(3)}`
              : "undefined for this scope"}
          </p>
          <p className="derivation-note micro">
            Computed centre of documented cards. <b>Not</b> a headquarters, home city or base of
            operations. Formula: {FORMULAS.centroid}.
          </p>

          <h2 className="micro">Geographic spread <i className="line" /></h2>
          <div className="statgrid">
            <div className="stat">
              <div className="v num">{fp.medianSpreadKm.toLocaleString()}</div><div className="k">median km</div>
            </div>
            <div className="stat">
              <div className="v num">{fp.p90SpreadKm.toLocaleString()}</div><div className="k">p90 km</div>
            </div>
            <div className="stat">
              <div className="v num">{fp.maxSeparationKm.toLocaleString()}</div><div className="k">max sep km</div>
            </div>
          </div>
          <p className="derivation-note micro">
            {FORMULAS.medianSpread}. The p90 is the {FORMULAS.p90Spread}. Max separation is the{" "}
            {FORMULAS.maxSeparation}. <b>Not</b> tour mileage.
          </p>

          <h2 className="micro">Record-sequence distance <i className="line" /></h2>
          <p className="num" data-testid="geo-sequence-km">
            {fp.recordSequenceKm.toLocaleString()} km
          </p>
          <p className="derivation-note micro">
            Cumulative straight-line distance between consecutive plotted records. {FORMULAS.recordSequence}.
            Same-day records are skipped because the source gives no show times, so ordering them
            would invent both a route and a distance.
          </p>

          <h2 className="micro">Most frequent places <i className="line" /></h2>
          <div className="evidence">
            {fp.topPlaces.map((t) => (
              <button key={t.place.id} className="ev-row" onClick={() => g.selectPlace(t.place.index)}>
                <span>{t.place.displayName}</span>
                <span className="num micro">{t.cards}</span>
              </button>
            ))}
          </div>

          <h2 className="micro">Countries <i className="line" /></h2>
          <div className="evidence">
            {fp.topCountries.map((c) => (
              <div key={c.country} className="ev-row">
                <span>{c.country}</span>
                <span className="num micro">{c.cards} cards · {c.places} places</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Two-promotion geographic comparison. Restrained encoding on purpose: A,
 * B and shared, not a rainbow of unrelated promotion colours. */
export function GeoComparison() {
  const g = useGeo();
  const [other, setOther] = useState("");
  const [result, setResult] = useState<ReturnType<typeof comparePlaces> | null>(null);
  const [otherLabel, setOtherLabel] = useState("");

  if (!g.data || g.scope.kind !== "promotion") return null;
  const data = g.data;

  const run = async (id: string) => {
    const idx = data.strings.promotionIds.indexOf(id);
    setOtherLabel(data.strings.promotionNames[idx] ?? id);
    const bAll = await resolveScope(data, { kind: "promotion", ids: [id], label: id });
    setResult(comparePlaces(data, g.scopeIndices, bAll));
  };

  const options = data.strings.promotionIds
    .map((id, i) => ({ id, name: data.strings.promotionNames[i] ?? id }))
    .filter((o) => !other || o.name.toLowerCase().includes(other.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30);

  return (
    <section className="panel" data-testid="geo-comparison">
      <h2>Compare promotion <i className="line" /></h2>
      <div className="row">
        <input
          aria-label="Compare with promotion"
          placeholder="compare with…"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          style={{ width: "100%" }}
        />
      </div>
      {other && !result && (
        <div className="checks scrollable">
          {options.map((o) => (
            <button key={o.id} className="chip" onClick={() => void run(o.id)}>{o.name}</button>
          ))}
        </div>
      )}
      {result && (
        <>
          <div className="statgrid">
            <div className="stat">
              <div className="v num">{result.aOnly.length}</div><div className="k">{g.scope.label} only</div>
            </div>
            <div className="stat">
              <div className="v num">{result.shared.length}</div><div className="k">shared</div>
            </div>
            <div className="stat">
              <div className="v num">{result.bOnly.length}</div><div className="k">{otherLabel} only</div>
            </div>
          </div>
          <p className="micro" data-testid="geo-overlap">
            geographic overlap <b className="num">{(result.overlapFraction * 100).toFixed(1)}%</b>{" "}
            · {result.sharedCountries.length} shared countries
          </p>
          <p className="derivation-note micro">
            Overlap is shared places divided by the union of both place sets, computed from the
            current corpus and the active date range — not a general claim about either promotion.
          </p>
          <div className="evidence">
            {result.topShared.map((t) => (
              <button key={t.place.id} className="ev-row" onClick={() => g.selectPlace(t.place.index)}>
                <span>{t.place.displayName}</span>
                <span className="num micro">{t.aCards} / {t.bCards}</span>
              </button>
            ))}
          </div>
          <div className="actions">
            <button onClick={() => { setResult(null); setOther(""); }}>clear comparison</button>
          </div>
        </>
      )}
    </section>
  );
}
