import { useState } from "react";
import { useApp } from "../store";
import type { ShowType } from "@kayfabe/sim-contract";
import { resolveEra } from "@kayfabe/sim-core";

export function CalendarScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const dispatch = useApp((s) => s.dispatch);
  const openShow = useApp((s) => s.openShow);
  const era = resolveEra(state.currentDate);

  const [name, setName] = useState(`THE BOOK Live ${state.currentDate}`);
  const [date, setDate] = useState(state.currentDate);
  const venues = Object.keys(state.venues).sort();
  const [venueId, setVenueId] = useState(venues[0] ?? "");
  const [showType, setShowType] = useState<ShowType>("ppv");
  const [price, setPrice] = useState(String(era.ticketPriceTypicalCents / 100));

  const playerId = state.meta.options.playerCompanyId;
  const shows = Object.keys(state.shows)
    .sort()
    .map((id) => state.shows[id]!)
    .filter((s) => s.status !== "cancelled")
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
  const upcoming = shows.filter((s) => s.date >= state.currentDate);
  const past = shows.filter((s) => s.date < state.currentDate).slice(-15).reverse();

  function schedule(): void {
    dispatch({
      type: "SCHEDULE_SHOW",
      companyId: playerId,
      name: name.trim() || `THE BOOK Live ${date}`,
      date,
      venueId,
      showType,
      ticketPriceCents: Math.max(1, Math.round(Number(price) * 100) || era.ticketPriceTypicalCents),
    });
  }

  return (
    <div className="page">
      <div className="page-title">
        <h1>Calendar</h1>
        <span className="sub">today is {state.currentDate}</span>
      </div>
      <div className="cols cols-sidebar">
        <div className="panel">
          <div className="panel-head">Upcoming</div>
          <div className="panel-body" style={{ padding: 0 }}>
            {upcoming.length === 0 ? (
              <div className="empty">An empty calendar is a dying territory.</div>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Company</th>
                    <th>Show</th>
                    <th>Type</th>
                    <th>Venue</th>
                    <th className="num">Card</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((s) => {
                    const mine = s.companyId === playerId;
                    return (
                      <tr key={s.id} style={mine ? { fontWeight: 600 } : undefined}>
                        <td>{s.date}</td>
                        <td>{state.companies[s.companyId]?.shortName}</td>
                        <td>{s.name}</td>
                        <td>{s.showType.toUpperCase()}</td>
                        <td>{state.venues[s.venueId]?.name}</td>
                        <td className="num">
                          {mine && s.segments.length === 0 ? <span className="pill alert">unbooked</span> : s.segments.length || "—"}
                        </td>
                        <td>{mine && <button onClick={() => openShow(s.id)}>Book</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="panel-head">Schedule a show</div>
            <div className="panel-body" style={{ display: "grid", gap: 8 }}>
              <label>
                Name
                <input data-testid="schedule-name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
              </label>
              <label>
                Date (YYYY-MM-DD)
                <input data-testid="schedule-date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "100%" }} />
              </label>
              <label>
                Venue
                <select data-testid="schedule-venue" value={venueId} onChange={(e) => setVenueId(e.target.value)} style={{ width: "100%" }}>
                  {venues.map((vid) => (
                    <option key={vid} value={vid}>
                      {state.venues[vid]!.name} ({state.venues[vid]!.capacity.toLocaleString("en-US")})
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "flex", gap: 10 }}>
                <label>
                  Type{" "}
                  <select data-testid="schedule-type" value={showType} onChange={(e) => setShowType(e.target.value as ShowType)}>
                    <option value="ppv">PPV</option>
                    <option value="tv">TV</option>
                    <option value="house">House</option>
                  </select>
                </label>
                <label>
                  Ticket $ <input data-testid="schedule-price" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 64 }} />
                </label>
              </div>
              <button className="primary" data-testid="schedule-submit" onClick={schedule}>
                Put it on the calendar
              </button>
              <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                Era-typical ticket: ${(era.ticketPriceTypicalCents / 100).toFixed(2)}. Booking today runs tonight.
              </div>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">Recent results</div>
            <div className="panel-body" style={{ padding: 0 }}>
              {past.length === 0 ? (
                <div className="empty">No history yet in this universe.</div>
              ) : (
                <table className="data">
                  <tbody>
                    {past.map((s) => (
                      <tr key={s.id} className={s.companyId === playerId ? "rowlink" : ""} onClick={() => s.companyId === playerId && s.report && openShow(s.id, "postshow")}>
                        <td>{s.date}</td>
                        <td>{state.companies[s.companyId]?.shortName}</td>
                        <td>{s.name}</td>
                        <td className="num">{s.report ? Math.round(s.report.overall) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
