import { useMemo, useState } from "react";
import { useApp } from "../store";
import { askingPrice, diffDays, formatUSD, resolveEra } from "@kayfabe/sim-core";

/**
 * The hiring floor: unattached talent (the snapshot's free-agent pool plus
 * anyone released or expired since), and rival deals about to run out.
 */
export function TalentMarketScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const snapshot = useApp((s) => s.snapshot);
  const openPerson = useApp((s) => s.openPerson);
  const [q, setQ] = useState("");
  const era = resolveEra(state.currentDate);
  const playerId = state.meta.options.playerCompanyId;
  const recordedMatches = useMemo(
    () => new Map((snapshot?.workers ?? []).map((w) => [w.personId, w.evidence.matches])),
    [snapshot],
  );

  const { freeAgents, expiringElsewhere } = useMemo(() => {
    const attached = new Map<string, { companyId: string; endDate: string | null; exclusive: boolean }>();
    for (const cid of Object.keys(state.contracts).sort()) {
      const c = state.contracts[cid]!;
      if (c.status === "active") {
        attached.set(c.personId, { companyId: c.companyId, endDate: c.endDate, exclusive: c.exclusive });
      }
    }
    const fas = Object.keys(state.workers)
      .sort()
      .map((pid) => state.workers[pid]!)
      .filter((w) => w.active && !attached.has(w.personId))
      .sort((a, b) => b.standing.awarenessNational - a.standing.awarenessNational || a.personId.localeCompare(b.personId));
    const expiring = Object.keys(state.workers)
      .sort()
      .map((pid) => state.workers[pid]!)
      .filter((w) => {
        const a = attached.get(w.personId);
        return (
          a !== undefined &&
          a.companyId !== playerId &&
          a.endDate !== null &&
          diffDays(state.currentDate, a.endDate) <= 30
        );
      })
      .map((w) => ({ w, deal: attached.get(w.personId)! }))
      .sort((a, b) => (a.deal.endDate! < b.deal.endDate! ? -1 : 1));
    return { freeAgents: fas, expiringElsewhere: expiring };
  }, [state, playerId]);

  const shown = freeAgents.filter(
    (w) => !q || w.personaNames.some((n) => n.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div className="page">
      <div className="page-title">
        <h1>Talent Market</h1>
        <span className="sub">{freeAgents.length} unattached workers — open a profile to make an offer</span>
        <span style={{ marginLeft: "auto" }}>
          <input
            data-testid="market-search"
            placeholder="Search any ring name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 240 }}
          />
        </span>
      </div>

      <div className="panel">
        <div className="panel-head">Free agents</div>
        <div className="panel-body" style={{ padding: 0, maxHeight: "52vh", overflowY: "auto" }}>
          {shown.length === 0 ? (
            <div className="empty">Nobody unattached matches. Watch the expiry list below — patience is a signing strategy.</div>
          ) : (
            <table className="data" data-testid="market-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Awareness</th>
                  <th className="num">Affinity</th>
                  <th className="num">Credibility</th>
                  <th className="num">Recorded matches</th>
                  <th className="num">Market estimate /wk</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => {
                  const ask = askingPrice(w, era, "written");
                  return (
                    <tr key={w.personId} className="rowlink" data-testid={`market-row-${w.personId}`} onClick={() => openPerson(w.personId)}>
                      <td>
                        <strong>{w.name}</strong>
                        {w.condition.injury && <span className="pill alert" style={{ marginLeft: 6 }}>injured</span>}
                      </td>
                      <td className="num">{Math.round(w.standing.awarenessNational)}</td>
                      <td className="num">{Math.round(w.standing.affinityNational)}</td>
                      <td className="num">{Math.round(w.credibility)}</td>
                      <td className="num">{recordedMatches.get(w.personId)?.toLocaleString("en-US") ?? "—"}</td>
                      <td className="num">{formatUSD(ask.weeklyDownsideCents)}</td>
                      <td>
                        <button onClick={(e) => { e.stopPropagation(); openPerson(w.personId); }}>Negotiate</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">Under contract elsewhere — expiring within 30 days</div>
        <div className="panel-body" style={{ padding: 0 }}>
          {expiringElsewhere.length === 0 ? (
            <div className="empty">No deals about to lapse across the industry.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>With</th>
                  <th>Deal ends</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {expiringElsewhere.map(({ w, deal }) => (
                  <tr key={w.personId} className="rowlink" onClick={() => openPerson(w.personId)}>
                    <td><strong>{w.name}</strong></td>
                    <td>{state.companies[deal.companyId]?.shortName ?? deal.companyId}</td>
                    <td>{deal.endDate}</td>
                    <td>
                      {deal.exclusive ? (
                        <span className="pill">exclusive — wait for expiry</span>
                      ) : (
                        <span className="pill gold">non-exclusive — approachable now</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
