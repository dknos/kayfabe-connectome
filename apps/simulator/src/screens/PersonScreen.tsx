import { useState } from "react";
import { useApp } from "../store";
import { ATTRIBUTE_KEYS, type ContractKind } from "@kayfabe/sim-contract";
import { askingPrice, formatUSD, resolveEra } from "@kayfabe/sim-core";

function Meter({ v }: { v: number }): JSX.Element {
  return (
    <span className="meter">
      <span className="track">
        <span className={`fill ${v >= 70 ? "good" : v <= 30 ? "hot" : ""}`} style={{ width: `${Math.min(100, Math.abs(v))}%` }} />
      </span>
      <span className="val">{Math.round(v)}</span>
    </span>
  );
}

export function PersonScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const pid = useApp((s) => s.selectedPersonId);
  const dispatch = useApp((s) => s.dispatch);
  const lastOffer = useApp((s) => s.lastOffer);
  const [offerOpen, setOfferOpen] = useState(false);
  const era = resolveEra(state.currentDate);
  const [kind, setKind] = useState<ContractKind>(era.allowedContractKinds.includes("written") ? "written" : "appearance");
  const [downside, setDownside] = useState("10000");
  const [perApp, setPerApp] = useState("0");
  const [months, setMonths] = useState("24");
  const [exclusive, setExclusive] = useState(true);

  const w = pid ? state.workers[pid] : null;
  if (!w) {
    return (
      <div className="page">
        <div className="empty">Pick someone from the Roster to open their file.</div>
      </div>
    );
  }

  const playerId = state.meta.options.playerCompanyId;
  const contract = Object.keys(state.contracts)
    .sort()
    .map((id) => state.contracts[id]!)
    .find((c) => c.personId === w.personId && c.status === "active");
  const onMyRoster = contract?.companyId === playerId;
  const market = askingPrice(w, era, kind);

  function submitOffer(): void {
    dispatch({
      type: "OFFER_CONTRACT",
      companyId: playerId,
      personId: w!.personId,
      kind,
      lengthMonths: Math.max(1, Number(months) || 12),
      perAppearanceCents: Math.max(0, Math.round(Number(perApp) * 100) || 0),
      weeklyDownsideCents: Math.max(0, Math.round(Number(downside) * 100) || 0),
      exclusive,
    });
  }

  return (
    <div className="page" data-testid="person-profile">
      <div className="page-title">
        <h1 data-testid="person-name">{w.name}</h1>
        <span className="sub">
          {w.personaNames.map((n) => (
            <span key={n} className="pill" style={{ marginRight: 4 }}>
              {n}
            </span>
          ))}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <span className={`pill ${w.alignment}`}>{w.alignment}</span>{" "}
          <span className="pill">{w.push.replace("_", " ")}</span>
        </span>
      </div>

      {w.condition.injury && (
        <div className="notice error">
          Injured: {w.condition.injury.severity} {w.condition.injury.kind}, out until {w.condition.injury.outUntil}.
        </div>
      )}

      <div className="cols cols-2">
        <div>
          <div className="panel">
            <div className="panel-head">The record</div>
            <div className="panel-body">
              <p data-testid="person-history-note" style={{ fontFamily: "var(--serif)", fontSize: 14.5 }}>
                {w.historyNote}
              </p>
              <table className="data">
                <tbody>
                  <tr><td>Debut year</td><td className="num">{w.debutYear ?? "not recorded"}</td></tr>
                  <tr><td>Experience</td><td className="num">{w.experienceYears} years</td></tr>
                  <tr><td>Styles</td><td>{w.styles.join(", ") || "—"}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">
              Scouted assessment
              <span className="confidence" style={{ marginLeft: "auto" }}>
                hover a value to see the evidence behind it
              </span>
            </div>
            <div className="panel-body" style={{ padding: 0 }}>
              <table className="data">
                <tbody>
                  {ATTRIBUTE_KEYS.map((k) => {
                    const s = w.scouted[k];
                    return (
                      <tr key={k} title={`${s.method} — evidence: ${s.inputs.join(", ")}`}>
                        <td style={{ textTransform: "capitalize" }}>{k.replace(/([A-Z])/g, " $1").toLowerCase()}</td>
                        <td><Meter v={s.value} /></td>
                        <td>
                          <span className={`confidence ${s.confidence}`}>{s.confidence}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">Standing & state</div>
            <div className="panel-body" style={{ padding: 0 }}>
              <table className="data">
                <tbody>
                  <tr><td>Awareness (national)</td><td><Meter v={w.standing.awarenessNational} /></td></tr>
                  <tr><td>Affinity (national)</td><td><Meter v={w.standing.affinityNational} /></td></tr>
                  <tr><td>Momentum</td><td><Meter v={w.momentum} /></td></tr>
                  <tr><td>Credibility</td><td><Meter v={w.credibility} /></td></tr>
                  <tr><td>Prestige</td><td><Meter v={w.prestige} /></td></tr>
                  <tr><td>Morale</td><td><Meter v={w.morale} /></td></tr>
                  <tr><td>Fatigue</td><td><Meter v={w.condition.fatigue} /></td></tr>
                  <tr><td>Days since a match</td><td className="num">{w.condition.daysSinceMatch}</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {onMyRoster && (
            <div className="panel" style={{ marginTop: 14 }}>
              <div className="panel-head">Creative direction</div>
              <div className="panel-body" style={{ display: "flex", gap: 12 }}>
                <label>
                  Push{" "}
                  <select value={w.push} onChange={(e) => dispatch({ type: "SET_PUSH", personId: w.personId, push: e.target.value as never })}>
                    {(["main_event", "upper", "midcard", "lower", "opener", "unused"] as const).map((p) => (
                      <option key={p} value={p}>{p.replace("_", " ")}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Alignment{" "}
                  <select value={w.alignment} onChange={(e) => dispatch({ type: "SET_ALIGNMENT", personId: w.personId, alignment: e.target.value as never })}>
                    <option value="face">face</option>
                    <option value="heel">heel</option>
                    <option value="neutral">neutral</option>
                  </select>
                </label>
              </div>
            </div>
          )}

          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">Contract</div>
            <div className="panel-body">
              {contract ? (
                <table className="data">
                  <tbody>
                    <tr><td>With</td><td>{state.companies[contract.companyId]?.name ?? contract.companyId}</td></tr>
                    <tr><td>Kind</td><td>{contract.kind}{contract.exclusive ? " · exclusive" : ""}</td></tr>
                    <tr><td>Weekly downside</td><td className="num">{formatUSD(contract.weeklyDownsideCents)}</td></tr>
                    <tr><td>Per appearance</td><td className="num">{formatUSD(contract.perAppearanceCents)}</td></tr>
                    <tr><td>Ends</td><td>{contract.endDate ?? "open-ended"}</td></tr>
                  </tbody>
                </table>
              ) : (
                <div className="empty">Free agent.</div>
              )}
              {(onMyRoster || !contract || !contract.exclusive) && (
                <div style={{ marginTop: 10 }}>
                  {!offerOpen ? (
                    <button data-testid="offer-open" onClick={() => setOfferOpen(true)}>
                      {onMyRoster ? "Renegotiate" : "Make an offer"}
                    </button>
                  ) : (
                    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
                        <label>
                          Kind<br />
                          <select value={kind} onChange={(e) => setKind(e.target.value as ContractKind)}>
                            {era.allowedContractKinds.map((k) => (
                              <option key={k} value={k}>{k}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Downside $/wk<br />
                          <input data-testid="offer-downside" value={downside} onChange={(e) => setDownside(e.target.value)} style={{ width: 90 }} />
                        </label>
                        <label>
                          Per appearance $<br />
                          <input value={perApp} onChange={(e) => setPerApp(e.target.value)} style={{ width: 90 }} />
                        </label>
                        <label>
                          Months<br />
                          <input data-testid="offer-length" value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 60 }} />
                        </label>
                        <label title="Exclusive deals demand a premium">
                          <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> exclusive
                        </label>
                        <button className="primary" data-testid="offer-submit" onClick={submitOffer}>
                          Present offer
                        </button>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-faint)" }}>
                        Market estimate: {formatUSD(market.weeklyDownsideCents)}/wk downside · {formatUSD(market.perAppearanceCents)} per appearance
                      </div>
                      {lastOffer && (
                        <div className={`notice ${lastOffer.accepted ? "" : "error"}`} data-testid="offer-outcome">
                          {lastOffer.accepted ? (
                            <strong>Deal. The ink is dry.</strong>
                          ) : (
                            <>
                              <strong>{lastOffer.counter ? "They countered:" : "They passed."}</strong>
                              <ul style={{ margin: "4px 0 0 18px" }}>
                                {lastOffer.reasons.map((r, i) => (
                                  <li key={i}>{r}</li>
                                ))}
                              </ul>
                              {lastOffer.counter && (
                                <div style={{ marginTop: 6 }}>
                                  {formatUSD(lastOffer.counter.weeklyDownsideCents)}/wk · {formatUSD(lastOffer.counter.perAppearanceCents)}/appearance ·{" "}
                                  {lastOffer.counter.lengthMonths} months{" "}
                                  <button
                                    onClick={() => {
                                      setDownside(String(lastOffer.counter!.weeklyDownsideCents / 100));
                                      setPerApp(String(lastOffer.counter!.perAppearanceCents / 100));
                                      setMonths(String(lastOffer.counter!.lengthMonths));
                                      dispatch({
                                        type: "OFFER_CONTRACT",
                                        companyId: playerId,
                                        personId: w.personId,
                                        kind,
                                        lengthMonths: lastOffer.counter!.lengthMonths,
                                        perAppearanceCents: lastOffer.counter!.perAppearanceCents,
                                        weeklyDownsideCents: lastOffer.counter!.weeklyDownsideCents,
                                        exclusive,
                                      });
                                    }}
                                  >
                                    Accept their terms
                                  </button>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
