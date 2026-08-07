import { useApp } from "../store";
import { diffDays, formatLong, formatUSD } from "@kayfabe/sim-core";

/** Daily hub: what needs a decision, what's coming, what just happened. */
export function ControlCenter(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const go = useApp((s) => s.go);
  const openShow = useApp((s) => s.openShow);
  const openPerson = useApp((s) => s.openPerson);
  const dispatch = useApp((s) => s.dispatch);

  const playerId = state.meta.options.playerCompanyId;
  const company = state.companies[playerId]!;

  const inbox = state.inbox.filter((i) => !i.resolved).slice(-8).reverse();
  const upcoming = Object.keys(state.shows)
    .sort()
    .map((id) => state.shows[id]!)
    .filter((s) => s.status === "scheduled" && diffDays(state.currentDate, s.date) >= 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const mine = upcoming.filter((s) => s.companyId === playerId).slice(0, 5);
  const rivals = upcoming.filter((s) => s.companyId !== playerId).slice(0, 5);
  const news = [...state.news].slice(-6).reverse();
  const injured = Object.keys(state.workers)
    .sort()
    .map((id) => state.workers[id]!)
    .filter((w) => w.condition.injury !== null)
    .slice(0, 6);

  return (
    <div className="page" data-testid="control-center">
      <div className="page-title">
        <h1>{formatLong(state.currentDate)}</h1>
        <span className="sub">
          {company.name} · {formatUSD(company.cashCents)} on hand
        </span>
      </div>

      <div className="cols cols-2">
        <div>
          <div className="panel">
            <div className="panel-head">Needs your attention</div>
            <div className="panel-body">
              {inbox.length === 0 ? (
                <div className="empty">A quiet desk. Enjoy it while it lasts.</div>
              ) : (
                inbox.map((item) => (
                  <div key={item.id} className="wire-item" data-testid="inbox-item">
                    <div className="headline">{item.title}</div>
                    <div style={{ fontSize: 13 }}>{item.body}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      {item.relatedPersonId && (
                        <button onClick={() => openPerson(item.relatedPersonId!)}>Open profile</button>
                      )}
                      {item.relatedShowId && (
                        <button onClick={() => openShow(item.relatedShowId!)}>Open show</button>
                      )}
                      <button
                        className="quiet"
                        onClick={() => dispatch({ type: "RESOLVE_INBOX", inboxId: item.id })}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">
              Your upcoming shows
              <span style={{ marginLeft: "auto" }}>
                <button className="quiet" onClick={() => go("calendar")}>
                  Calendar →
                </button>
              </span>
            </div>
            <div className="panel-body">
              {mine.length === 0 ? (
                <div className="empty">
                  Nothing on the calendar. Schedule a show from the Calendar screen — buildings don't
                  fill themselves.
                </div>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Show</th>
                      <th>Type</th>
                      <th className="num">Card</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {mine.map((s) => (
                      <tr key={s.id}>
                        <td>{s.date}</td>
                        <td>
                          <strong>{s.name}</strong>
                        </td>
                        <td>{s.showType.toUpperCase()}</td>
                        <td className="num">
                          {s.segments.length === 0 ? <span className="pill alert">unbooked</span> : s.segments.length}
                        </td>
                        <td>
                          <button data-testid={`book-${s.id}`} onClick={() => openShow(s.id)}>
                            {s.date === state.currentDate ? "Book & run" : "Book"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">Injury report</div>
            <div className="panel-body">
              {injured.length === 0 ? (
                <div className="empty">Everyone is walking under their own power.</div>
              ) : (
                injured.map((w) => (
                  <div key={w.personId} style={{ padding: "4px 0", fontSize: 13 }}>
                    <a onClick={() => openPerson(w.personId)} style={{ cursor: "pointer" }}>
                      {w.name}
                    </a>{" "}
                    — {w.condition.injury!.severity} {w.condition.injury!.kind}, out until{" "}
                    {w.condition.injury!.outUntil}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">
              The Ringside Ledger
              <span style={{ marginLeft: "auto" }}>
                <button className="quiet" onClick={() => go("wire")}>
                  Full wire →
                </button>
              </span>
            </div>
            <div className="panel-body">
              {news.length === 0 ? (
                <div className="empty">The wire is cold.</div>
              ) : (
                news.map((n) => (
                  <div key={n.id} className="wire-item">
                    <div className="meta">
                      {n.date} · {n.kind.replace("_", " ")}
                      {n.rumor ? " · RUMOR" : ""}
                    </div>
                    <div className="headline">{n.headline}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">Across the industry</div>
            <div className="panel-body">
              {rivals.length === 0 ? (
                <div className="empty">No rival events announced.</div>
              ) : (
                <table className="data">
                  <tbody>
                    {rivals.map((s) => (
                      <tr key={s.id}>
                        <td>{s.date}</td>
                        <td>{state.companies[s.companyId]?.shortName}</td>
                        <td>{s.name}</td>
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
