import { useApp } from "../store";
import { WEEKDAY_NAMES } from "@kayfabe/sim-core";

export function CompaniesScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const openPerson = useApp((s) => s.openPerson);
  const playerId = state.meta.options.playerCompanyId;

  const rosterCount = new Map<string, number>();
  for (const cid of Object.keys(state.contracts).sort()) {
    const c = state.contracts[cid]!;
    if (c.status === "active") rosterCount.set(c.companyId, (rosterCount.get(c.companyId) ?? 0) + 1);
  }

  const companies = Object.keys(state.companies)
    .sort()
    .map((id) => state.companies[id]!)
    .filter((c) => c.active)
    .sort((a, b) => b.standing.awarenessNational - a.standing.awarenessNational || a.id.localeCompare(b.id));

  return (
    <div className="page">
      <div className="page-title">
        <h1>World Companies</h1>
        <span className="sub">what the industry can see — no one's books are open</span>
      </div>
      <div className="panel">
        <div className="panel-body" style={{ padding: 0 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Company</th>
                <th>Tier</th>
                <th>Television</th>
                <th className="num">Awareness</th>
                <th className="num">Affinity</th>
                <th className="num">Momentum</th>
                <th className="num">Roster</th>
                <th>World champion</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => {
                const worldTitle = Object.keys(state.titles)
                  .sort()
                  .map((id) => state.titles[id]!)
                  .find((t) => t.companyId === c.id && t.tier === "world");
                const champs = worldTitle?.holderIds.map((p) => ({ pid: p, name: state.workers[p]?.name ?? p })) ?? [];
                return (
                  <tr key={c.id} data-testid="company-row" style={c.id === playerId ? { fontWeight: 700, background: "var(--paper-sunken)" } : undefined}>
                    <td>
                      {c.name}
                      {c.id === playerId && <span className="pill gold" style={{ marginLeft: 6 }}>you</span>}
                    </td>
                    <td>{c.sizeTier}</td>
                    <td>
                      {c.tvDeal ? `${c.tvDeal.programName} · ${WEEKDAY_NAMES[c.tvDeal.dayOfWeek]}s` : "—"}
                    </td>
                    <td className="num">{Math.round(c.standing.awarenessNational)}</td>
                    <td className="num">{Math.round(c.standing.affinityNational)}</td>
                    <td className="num" style={{ color: c.momentum >= 0 ? "var(--green)" : "var(--alert)" }}>
                      {c.momentum >= 0 ? "+" : ""}{Math.round(c.momentum)}
                    </td>
                    <td className="num">{rosterCount.get(c.id) ?? 0}</td>
                    <td>
                      {worldTitle
                        ? champs.length > 0
                          ? champs.map((h, i) => (
                              <span key={h.pid}>
                                {i > 0 && " & "}
                                <a style={{ cursor: "pointer" }} onClick={() => openPerson(h.pid)}>{h.name}</a>
                              </span>
                            ))
                          : "vacant"
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
