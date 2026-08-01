import { useMemo, useState } from "react";
import { readCard } from "./geoAdapter";
import { cardStrings, placeOf, useGeo } from "./geoStore";

/**
 * Every geographic result, reachable without seeing or manipulating the globe.
 *
 * This is not a fallback view — it reads the same scope, the same card list
 * and the same counters the globe does, so an answer found here and an answer
 * found on the globe cannot disagree.
 */

type SortKey =
  | "date" | "event" | "promotion" | "location" | "country" | "precision"
  | "matches" | "people" | "titleMatches" | "titleChanges" | "cardId";

const COLUMNS: Array<[SortKey, string]> = [
  ["date", "Date"],
  ["event", "Event"],
  ["promotion", "Promotion"],
  ["location", "Location"],
  ["country", "Country"],
  ["precision", "Precision"],
  ["matches", "Matches"],
  ["people", "Wrestlers"],
  ["titleMatches", "Title matches"],
  ["titleChanges", "Title changes"],
  ["cardId", "Card id"],
];

const PAGE = 250;

export function GeoTable() {
  const g = useGeo();
  const [sort, setSort] = useState<SortKey>("date");
  const [asc, setAsc] = useState(true);
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<"cards" | "places" | "countries" | "unplotted">("cards");

  const rows = useMemo(() => {
    if (!g.data) return [];
    const data = g.data;
    const out = g.scopeIndices.map((i) => {
      const c = readCard(data, i);
      const p = placeOf(data, c.placeIdx);
      const s = cardStrings(data, c);
      return {
        date: s.date, event: s.eventName, promotion: s.promotion,
        location: p?.displayName ?? "location unresolved",
        country: p?.country ?? "—",
        precision: p ? `${p.precision} (${p.resolution})` : "unresolved",
        matches: c.matchCount, people: c.personCount,
        titleMatches: c.titleMatchCount, titleChanges: c.titleChangeCount,
        cardId: c.cardId,
      };
    });
    out.sort((a, b) => {
      const x = a[sort] ?? "", y = b[sort] ?? "";
      const cmp = typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
      return asc ? cmp : -cmp;
    });
    return out;
  }, [g.data, g.scopeIndices, sort, asc]);

  const places = useMemo(() => {
    if (!g.data) return [];
    const counts = new Map<number, { cards: number; matches: number; tc: number }>();
    for (const i of g.scopeIndices) {
      const b = i * g.data.stride;
      const p = (g.data.cards[b + 2] ?? 0) - 1;
      if (p < 0) continue;
      const e = counts.get(p) ?? { cards: 0, matches: 0, tc: 0 };
      e.cards++;
      e.matches += g.data.cards[b + 4] ?? 0;
      e.tc += ((g.data.cards[b + 6] ?? 0) >>> 16) & 0xffff;
      counts.set(p, e);
    }
    return Array.from(counts.entries())
      .flatMap(([idx, v]) => {
        const place = g.data!.places[idx];
        return place ? [{ place, ...v }] : [];
      })
      .sort((a, b) => b.cards - a.cards);
  }, [g.data, g.scopeIndices]);

  const countries = useMemo(() => {
    const m = new Map<string, { cards: number; places: number }>();
    for (const r of places) {
      const k = r.place.country ?? "—";
      const e = m.get(k) ?? { cards: 0, places: 0 };
      e.cards += r.cards;
      e.places++;
      m.set(k, e);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].cards - a[1].cards);
  }, [places]);

  const unplotted = useMemo(
    () => rows.filter((r) => r.precision === "unresolved"),
    [rows],
  );

  if (!g.data) return null;
  const slice = (tab === "unplotted" ? unplotted : rows).slice(page * PAGE, page * PAGE + PAGE);
  const totalRows = (tab === "unplotted" ? unplotted : rows).length;

  return (
    <div className="tableview geo-table" data-testid="geo-table">
      <div className="row" role="tablist" aria-label="Geo table view">
        {(["cards", "places", "countries", "unplotted"] as const).map((t) => (
          <button
            key={t} role="tab" aria-selected={tab === t}
            className={`chip ${tab === t ? "on" : ""}`}
            onClick={() => { setTab(t); setPage(0); }}
          >
            {t}
          </button>
        ))}
        <span className="micro">
          {g.scope.label} · {g.scopeIndices.length.toLocaleString()} cards in scope
        </span>
      </div>

      {(tab === "cards" || tab === "unplotted") && (
        <>
          <table>
            <caption className="visually-hidden">
              Documented cards in the active geographic scope
            </caption>
            <thead>
              <tr>
                {COLUMNS.map(([k, label]) => (
                  <th key={k} scope="col">
                    <button
                      onClick={() => { setSort(k); setAsc(sort === k ? !asc : true); }}
                      aria-sort={sort === k ? (asc ? "ascending" : "descending") : "none"}
                    >
                      {label}{sort === k ? (asc ? " ▲" : " ▼") : ""}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map((r) => (
                <tr key={r.cardId}>
                  <td className="num">{r.date}</td>
                  <td>{r.event}</td>
                  <td>{r.promotion}</td>
                  <td>{r.location}</td>
                  <td>{r.country}</td>
                  <td className="micro">{r.precision}</td>
                  <td className="num">{r.matches}</td>
                  <td className="num">{r.people}</td>
                  <td className="num">{r.titleMatches}</td>
                  <td className="num">{r.titleChanges}</td>
                  <td className="micro">{r.cardId}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>previous</button>
            <span className="micro">
              rows {page * PAGE + 1}–{Math.min(totalRows, (page + 1) * PAGE)} of{" "}
              {totalRows.toLocaleString()}
            </span>
            <button
              disabled={(page + 1) * PAGE >= totalRows}
              onClick={() => setPage(page + 1)}
            >next</button>
          </div>
        </>
      )}

      {tab === "places" && (
        <table>
          <caption className="visually-hidden">Places in the active geographic scope</caption>
          <thead>
            <tr>
              <th scope="col">Place</th><th scope="col">Country</th><th scope="col">Precision</th>
              <th scope="col">Cards</th><th scope="col">Matches</th><th scope="col">Title changes</th>
              <th scope="col">Coordinate</th>
            </tr>
          </thead>
          <tbody>
            {places.slice(0, 500).map((r) => (
              <tr key={r.place.id}>
                <td>{r.place.displayName}</td>
                <td>{r.place.country}</td>
                <td className="micro">{r.place.precision} · {r.place.resolution}</td>
                <td className="num">{r.cards}</td>
                <td className="num">{r.matches}</td>
                <td className="num">{r.tc}</td>
                <td className="num micro">
                  {r.place.latitude.toFixed(3)}, {r.place.longitude.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "countries" && (
        <table>
          <caption className="visually-hidden">Countries in the active geographic scope</caption>
          <thead>
            <tr><th scope="col">Country</th><th scope="col">Cards</th><th scope="col">Places</th></tr>
          </thead>
          <tbody>
            {countries.map(([name, v]) => (
              <tr key={name}>
                <td>{name}</td><td className="num">{v.cards}</td><td className="num">{v.places}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
