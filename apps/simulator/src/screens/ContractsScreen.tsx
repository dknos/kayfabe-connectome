import { useApp } from "../store";
import { diffDays, formatUSD } from "@kayfabe/sim-core";

export function ContractsScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const dispatch = useApp((s) => s.dispatch);
  const openPerson = useApp((s) => s.openPerson);
  const playerId = state.meta.options.playerCompanyId;

  const all = Object.keys(state.contracts)
    .sort()
    .map((id) => state.contracts[id]!)
    .filter((c) => c.companyId === playerId);
  const active = all
    .filter((c) => c.status === "active")
    .sort((a, b) => (a.endDate ?? "9999") < (b.endDate ?? "9999") ? -1 : 1);
  const ended = all.filter((c) => c.status !== "active").slice(-20).reverse();

  const weeklyOut = active.reduce((s, c) => s + c.weeklyDownsideCents, 0);

  return (
    <div className="page">
      <div className="page-title">
        <h1>Contracts</h1>
        <span className="sub">
          {active.length} active · {formatUSD(weeklyOut, { compact: true })}/week guaranteed
        </span>
      </div>
      <div className="panel">
        <div className="panel-head">Active deals — soonest expiry first</div>
        <div className="panel-body" style={{ padding: 0 }}>
          <table className="data" data-testid="contracts-table">
            <thead>
              <tr>
                <th>Talent</th>
                <th>Kind</th>
                <th className="num">Downside /wk</th>
                <th className="num">Per appearance</th>
                <th>Signed</th>
                <th>Ends</th>
                <th className="num">Days left</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((c) => {
                const w = state.workers[c.personId];
                const daysLeft = c.endDate ? diffDays(state.currentDate, c.endDate) : null;
                return (
                  <tr key={c.id}>
                    <td>
                      <a style={{ cursor: "pointer" }} onClick={() => openPerson(c.personId)}>
                        <strong>{w?.name ?? c.personId}</strong>
                      </a>
                    </td>
                    <td>
                      {c.kind}
                      {c.exclusive && <span className="pill" style={{ marginLeft: 4 }}>exclusive</span>}
                    </td>
                    <td className="num">{formatUSD(c.weeklyDownsideCents)}</td>
                    <td className="num">{formatUSD(c.perAppearanceCents)}</td>
                    <td>{c.signedDate}</td>
                    <td>{c.endDate ?? "open"}</td>
                    <td className="num">
                      {daysLeft === null ? "—" : daysLeft <= 30 ? <span className="pill alert">{daysLeft}</span> : daysLeft}
                    </td>
                    <td>
                      <button
                        className="quiet"
                        onClick={() => {
                          if (confirm(`Release ${w?.name}? The locker room will notice.`)) {
                            dispatch({ type: "RELEASE_WORKER", contractId: c.id });
                          }
                        }}
                      >
                        Release
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {active.length === 0 && <div className="empty">No one under contract. That is a problem money can fix.</div>}
        </div>
      </div>
      {ended.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head">Recently ended</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="data">
              <tbody>
                {ended.map((c) => (
                  <tr key={c.id}>
                    <td>{state.workers[c.personId]?.name ?? c.personId}</td>
                    <td>{c.kind}</td>
                    <td>
                      <span className={`pill ${c.status === "terminated" ? "alert" : ""}`}>{c.status}</span>
                    </td>
                    <td>{c.endDate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
