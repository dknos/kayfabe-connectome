import { useApp } from "../store";
import { stateHash } from "@kayfabe/sim-core";

export function SettingsScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const snapshot = useApp((s) => s.snapshot);
  const saveGame = useApp((s) => s.saveGame);
  const setPhase = useApp((s) => s.setPhase);
  const hash = stateHash(state);

  return (
    <div className="page">
      <div className="page-title">
        <h1>Settings & Universe Facts</h1>
      </div>
      <div className="cols cols-2">
        <div>
          <div className="panel">
            <div className="panel-head">This universe</div>
            <div className="panel-body" style={{ padding: 0 }}>
              <table className="data">
                <tbody>
                  <tr><td>Save ID</td><td className="num">{state.meta.saveId}</td></tr>
                  <tr><td>World seed</td><td className="num">{state.meta.worldSeed}</td></tr>
                  <tr><td>Started</td><td className="num">{state.meta.startDate}</td></tr>
                  <tr><td>Current date</td><td className="num">{state.currentDate}</td></tr>
                  <tr><td>Role</td><td className="num">{state.meta.options.playerRole.replace("_", "-")}</td></tr>
                  <tr><td>Scouting fog</td><td className="num">{state.meta.options.scoutingFog ? "on" : "off"}</td></tr>
                  <tr><td>Engine</td><td className="num">v{state.meta.engineVersion} · schema {state.meta.schemaVersion}</td></tr>
                  <tr><td>Data bundle</td><td className="num">{state.meta.bundleHash.slice(0, 16)}…</td></tr>
                  <tr><td>Snapshot</td><td className="num">{state.meta.snapshotHash.slice(0, 16)}…</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 14 }}>
            <div className="panel-head">State fingerprint</div>
            <div className="panel-body">
              <div style={{ fontFamily: "var(--mono)", fontSize: 13 }} data-testid="state-hash">{hash}</div>
              <div className="confidence" style={{ marginTop: 6 }}>
                Canonical hash of the entire universe. Save, reload, and this number must not move —
                that is the determinism promise, and it is under automated test.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="primary" onClick={() => void saveGame()}>Save universe</button>
            <button
              onClick={() => {
                if (confirm("Leave to the main menu? Unsaved progress stays behind.")) setPhase("menu");
              }}
            >
              Main menu
            </button>
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="panel-head">Honest limitations</div>
            <div className="panel-body" style={{ fontSize: 13 }}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  The historical corpus records <em>appearances</em>, not employment. Rosters were inferred
                  {snapshot
                    ? ` (${snapshot.meta.rosterInference.method}: ≥${snapshot.meta.rosterInference.minAppearances} appearances in ${snapshot.meta.rosterInference.windowDays} days, last within ${snapshot.meta.rosterInference.maxDaysSinceLast})`
                    : " from recent appearance patterns"}.
                </li>
                <li>
                  Starting abilities are estimates seeded from pre-start evidence
                  {snapshot ? ` (${snapshot.meta.seederMethod})` : ""} with confidence grades — hover any
                  attribute on a profile to see the evidence behind it.
                </li>
                <li>Championship lineages exist in the record for WWE-family belts only; other belts start without derivable history.</li>
                <li>Owner and booker roles currently play identically; delegation depth is roadmap (see PROGRESS.md).</li>
                <li>Reduced motion is honored; all controls are keyboard-reachable with visible focus.</li>
              </ul>
              {snapshot && snapshot.dataHealth.notes.length > 0 && (
                <>
                  <div className="confidence" style={{ marginTop: 8 }}>Data health notes from universe creation</div>
                  <ul style={{ margin: "4px 0 0 18px", color: "var(--ink-soft)" }}>
                    {snapshot.dataHealth.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
