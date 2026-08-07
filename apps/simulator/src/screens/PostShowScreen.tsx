import { useApp } from "../store";
import { formatUSD } from "@kayfabe/sim-core";

function gradeWord(v: number): string {
  return v >= 85 ? "A classic" : v >= 70 ? "A strong night" : v >= 55 ? "A solid outing" : v >= 40 ? "A rough one" : "A disaster";
}

export function PostShowScreen(): JSX.Element {
  const report = useApp((s) => s.lastReport);
  const state = useApp((s) => s.simState)!;
  const go = useApp((s) => s.go);
  const openPerson = useApp((s) => s.openPerson);

  if (!report) {
    return (
      <div className="page">
        <div className="empty">Nothing to review yet. The review desk works show nights.</div>
      </div>
    );
  }
  const show = state.shows[report.showId];

  return (
    <div className="page" data-testid="postshow">
      <div className="page-title">
        <h1>{show?.name ?? "Post-show"} — the morning after</h1>
        <span className="sub">{report.date}</span>
        <span style={{ marginLeft: "auto" }}>
          <button onClick={() => go("control")}>Back to Control Center</button>
        </span>
      </div>

      <div className="cols cols-3">
        <div className="panel">
          <div className="panel-body" style={{ textAlign: "center" }}>
            <div className={`grade ${report.overall >= 70 ? "good" : report.overall < 45 ? "bad" : ""}`} data-testid="show-grade">
              {Math.round(report.overall)}
            </div>
            <div style={{ fontFamily: "var(--serif)" }}>{gradeWord(report.overall)}</div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-body" style={{ textAlign: "center" }}>
            <div className="grade">{report.attendance.toLocaleString("en-US")}</div>
            <div>of {report.capacity.toLocaleString("en-US")} seats</div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-body" style={{ textAlign: "center" }}>
            <div className={`grade ${report.profitCents >= 0 ? "good" : "bad"}`}>{formatUSD(report.profitCents, { compact: true })}</div>
            <div>{report.profitCents >= 0 ? "profit" : "loss"} on the night</div>
          </div>
        </div>
      </div>

      <div className="cols cols-2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head">Why this grade</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="data">
              <tbody>
                {report.overallComponents.map((c, i) => (
                  <tr key={i}>
                    <td>{c.label}</td>
                    <td className="num" style={{ color: c.value >= 0 ? "var(--green)" : "var(--alert)" }}>
                      {c.value >= 0 ? "+" : ""}{c.value.toFixed(1)}
                    </td>
                    <td style={{ color: "var(--ink-faint)", fontSize: 12 }}>{c.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {report.notes.length > 0 && (
              <div className="panel-body" style={{ fontStyle: "italic", color: "var(--ink-soft)" }}>
                {report.notes.map((n, i) => (
                  <div key={i}>{n}</div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">The money</div>
          <div className="panel-body" style={{ padding: 0 }}>
            <table className="data">
              <tbody>
                {report.revenue.map((r, i) => (
                  <tr key={`r${i}`}>
                    <td>{r.label}</td>
                    <td className="num" style={{ color: "var(--green)" }}>{formatUSD(r.amountCents)}</td>
                  </tr>
                ))}
                {report.expenses.map((e, i) => (
                  <tr key={`e${i}`}>
                    <td>{e.label}</td>
                    <td className="num" style={{ color: "var(--alert)" }}>−{formatUSD(e.amountCents)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td>Net</td>
                  <td className="num">{formatUSD(report.profitCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <h2 style={{ margin: "18px 0 8px" }}>Segment by segment</h2>
      {report.segments.map((seg, i) => (
        <div key={seg.segmentId} className="panel" style={{ marginBottom: 12 }} data-testid="segment-report">
          <div className="panel-head">
            #{i + 1} — {seg.headline}
            <span style={{ marginLeft: "auto" }}>
              execution {Math.round(seg.execution)} · reception {Math.round(seg.reception)}
            </span>
          </div>
          <div className="panel-body">
            <div className="cols cols-2">
              <div>
                <div className="confidence" style={{ marginBottom: 4 }}>What happened in there</div>
                <table className="data">
                  <tbody>
                    {seg.executionComponents.map((c, k) => (
                      <tr key={k}>
                        <td>{c.label}</td>
                        <td className="num" style={{ color: c.value >= 0 ? "var(--green)" : "var(--alert)" }}>
                          {c.value >= 0 ? "+" : ""}{c.value.toFixed(1)}
                        </td>
                        <td style={{ color: "var(--ink-faint)", fontSize: 11.5 }}>{c.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="confidence" style={{ marginBottom: 4 }}>How the crowd took it</div>
                <table className="data">
                  <tbody>
                    {seg.receptionComponents.map((c, k) => (
                      <tr key={k}>
                        <td>{c.label}</td>
                        <td className="num" style={{ color: c.value >= 0 ? "var(--green)" : "var(--alert)" }}>
                          {c.value >= 0 ? "+" : ""}{c.value.toFixed(1)}
                        </td>
                        <td style={{ color: "var(--ink-faint)", fontSize: 11.5 }}>{c.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <table className="data" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Talent</th>
                  <th>Role</th>
                  <th className="num">Contribution</th>
                  <th className="num">Momentum</th>
                  <th className="num">Affinity</th>
                  <th className="num">Morale</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {seg.participantEffects.map((p) => (
                  <tr key={p.personId} className="rowlink" onClick={() => openPerson(p.personId)}>
                    <td>{state.workers[p.personId]?.name ?? p.personId}</td>
                    <td>{p.role}</td>
                    <td className="num">{Math.round(p.contribution)}</td>
                    <td className="num" style={{ color: p.momentumDelta >= 0 ? "var(--green)" : "var(--alert)" }}>
                      {p.momentumDelta >= 0 ? "+" : ""}{p.momentumDelta.toFixed(1)}
                    </td>
                    <td className="num" style={{ color: p.affinityDelta >= 0 ? "var(--green)" : "var(--alert)" }}>
                      {p.affinityDelta >= 0 ? "+" : ""}{p.affinityDelta.toFixed(1)}
                    </td>
                    <td className="num" style={{ color: p.moraleDelta >= 0 ? "var(--green)" : "var(--alert)" }}>
                      {p.moraleDelta >= 0 ? "+" : ""}{p.moraleDelta.toFixed(1)}
                    </td>
                    <td>{p.injury && <span className="pill alert">{p.injury.severity} injury</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {seg.notes.length > 0 && (
              <ul style={{ margin: "8px 0 0 18px", fontStyle: "italic", color: "var(--ink-soft)", fontSize: 12.5 }}>
                {seg.notes.map((n, k) => (
                  <li key={k}>{n}</li>
                ))}
              </ul>
            )}
            {seg.matchLog && seg.matchLog.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ink-soft)" }}>
                  The call, beat by beat ({seg.matchLog.length})
                </summary>
                <table className="data" style={{ marginTop: 4 }}>
                  <tbody>
                    {seg.matchLog.map((m, k) => (
                      <tr key={k}>
                        <td className="num" style={{ width: 46 }}>{m.t.toFixed(1)}′</td>
                        <td style={{ width: 80 }}><span className="pill">{m.kind}</span></td>
                        <td>{m.description}</td>
                        <td className="num" style={{ width: 40 }} title="crowd heat">{m.heat}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
