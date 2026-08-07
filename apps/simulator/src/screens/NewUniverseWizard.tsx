import { useEffect, useMemo, useState } from "react";
import type { SimOptions, UniverseSnapshot } from "@kayfabe/sim-contract";
import { createUniverse, seedWorker, isIsoDate } from "@kayfabe/sim-core";
import { buildUniverseSnapshot } from "@kayfabe/history-adapter";
import { fetchCorpusJson } from "../corpus";
import { useApp } from "../store";

type Step = "date" | "building" | "company" | "failed";

const PRESETS: { date: string; label: string; blurb: string }[] = [
  {
    date: "1997-01-06",
    label: "The National War — January 1997",
    blurb: "Two Monday-night juggernauts, one violent upstart in Philadelphia. The flagship scenario.",
  },
  {
    date: "1992-01-06",
    label: "After the Boom — January 1992",
    blurb: "The 80s expansion has cooled. Rebuild from star power aging fast.",
  },
  {
    date: "2001-04-02",
    label: "The Morning After — April 2001",
    blurb: "The war just ended. What happens to a one-company industry?",
  },
];

export function NewUniverseWizard(): JSX.Element {
  const startUniverse = useApp((s) => s.startUniverse);
  const setPhase = useApp((s) => s.setPhase);

  const [step, setStep] = useState<Step>("date");
  const [startDate, setStartDate] = useState("1997-01-06");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<UniverseSnapshot | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [role, setRole] = useState<SimOptions["playerRole"]>("owner_booker");
  const [seed, setSeed] = useState("");

  const dateValid = isIsoDate(startDate) && startDate >= "1950-01-01" && startDate <= "2025-12-31";

  useEffect(() => {
    if (step !== "building") return;
    let cancelled = false;
    setProgress("Reading the historical record…");
    buildUniverseSnapshot({
      fetch: fetchCorpusJson,
      startDate,
      seedWorker,
    })
      .then((snap) => {
        if (cancelled) return;
        setSnapshot(snap);
        const playable = snap.companies.filter((c) => c.playable);
        setCompanyId(playable[0]?.companyId ?? null);
        setStep("company");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setStep("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [step, startDate]);

  const playable = useMemo(() => snapshot?.companies.filter((c) => c.playable) ?? [], [snapshot]);

  function create(): void {
    if (!snapshot || !companyId) return;
    const worldSeed = seed.trim() || `book-${startDate}`;
    const options: SimOptions = {
      historicalMode: "open_alternate",
      playerRole: role,
      playerCompanyId: companyId,
      startDate,
      worldSeed,
      scoutingFog: true,
      abstractTierEnabled: true,
    };
    const state = createUniverse(snapshot, options);
    startUniverse(state, snapshot);
  }

  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: "100%", padding: 24 }}>
      <div style={{ width: 860, maxWidth: "94vw" }}>
        <h1 className="display">New Universe</h1>
        <p style={{ color: "var(--ink-soft)" }}>
          Pick a date. Everything before it is the historical record; everything after it is yours.
        </p>

        {step === "date" && (
          <>
            <div className="panel" style={{ marginTop: 16 }}>
              <div className="panel-head">Start date</div>
              <div className="panel-body">
                {PRESETS.map((p) => (
                  <label
                    key={p.date}
                    style={{ display: "block", padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid var(--line)" }}
                  >
                    <input
                      type="radio"
                      name="preset"
                      checked={startDate === p.date}
                      onChange={() => setStartDate(p.date)}
                    />{" "}
                    <strong>{p.label}</strong>
                    <div style={{ color: "var(--ink-faint)", fontSize: 12.5, marginLeft: 22 }}>{p.blurb}</div>
                  </label>
                ))}
                <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
                  <span>Or any date:</span>
                  <input
                    data-testid="start-date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    placeholder="YYYY-MM-DD"
                    style={{ width: 130 }}
                  />
                  {!dateValid && <span className="confidence low">Enter a date between 1950 and 2025</span>}
                </div>
                <div className="notice" style={{ marginTop: 12 }}>
                  Coverage is best from the mid-1980s onward. Earlier dates produce thinner worlds —
                  the wizard will show exactly what the record supports before you commit.
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "space-between" }}>
              <button className="quiet" onClick={() => setPhase("menu")}>
                Back
              </button>
              <button className="primary" data-testid="wizard-build" disabled={!dateValid} onClick={() => setStep("building")}>
                Survey the territory →
              </button>
            </div>
          </>
        )}

        {step === "building" && (
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-body" style={{ textAlign: "center", padding: 48 }}>
              <h2 className="display">Building {startDate}…</h2>
              <p style={{ color: "var(--ink-soft)" }} data-testid="wizard-progress">
                {progress}
              </p>
              <p style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>
                Inferring rosters from appearance records, resolving champions, seeding abilities from
                pre-{startDate.slice(0, 4)} evidence only. Nothing after your start date leaks in.
              </p>
            </div>
          </div>
        )}

        {step === "failed" && (
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="panel-body">
              <div className="notice error" data-testid="wizard-error">
                Could not build the universe: {error}
              </div>
              <p>
                The historical corpus must be present at <code>data/materialized/</code>. See
                docs/simulator-audit.md.
              </p>
              <button onClick={() => setStep("date")}>Back</button>
            </div>
          </div>
        )}

        {step === "company" && snapshot && (
          <>
            <div className="cols cols-sidebar" style={{ marginTop: 16 }}>
              <div className="panel">
                <div className="panel-head">Choose your company — {startDate}</div>
                <div className="panel-body">
                  <table className="data" data-testid="company-table">
                    <thead>
                      <tr>
                        <th />
                        <th>Company</th>
                        <th>Tier</th>
                        <th className="num">Roster</th>
                        <th className="num">Titles</th>
                        <th className="num">Awareness</th>
                      </tr>
                    </thead>
                    <tbody>
                      {playable.map((c) => (
                        <tr key={c.companyId} className="rowlink" onClick={() => setCompanyId(c.companyId)}>
                          <td>
                            <input type="radio" checked={companyId === c.companyId} onChange={() => setCompanyId(c.companyId)} />
                          </td>
                          <td>
                            <strong>{c.name}</strong>
                          </td>
                          <td>{c.sizeTier}</td>
                          <td className="num">{c.rosterPersonIds.length}</td>
                          <td className="num">{c.titleIds.length}</td>
                          <td className="num">{Math.round(c.awarenessNational)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 14 }}>
                    <div className="panel-head" style={{ borderTop: "1px solid var(--line)" }}>
                      Your role
                    </div>
                    <div style={{ display: "flex", gap: 16, padding: "10px 4px" }}>
                      {(
                        [
                          ["owner", "Owner", "Run the business, delegate the pencil"],
                          ["booker", "Head Booker", "Run creative for an owner"],
                          ["owner_booker", "Owner-Booker", "Hold everything. Sleep later."],
                        ] as const
                      ).map(([id, label, blurb]) => (
                        <label key={id} style={{ cursor: "pointer" }}>
                          <input type="radio" name="role" checked={role === id} onChange={() => setRole(id)} /> <strong>{label}</strong>
                          <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{blurb}</div>
                        </label>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
                      <span>World seed:</span>
                      <input
                        data-testid="world-seed"
                        value={seed}
                        onChange={(e) => setSeed(e.target.value)}
                        placeholder={`book-${startDate}`}
                        style={{ width: 220 }}
                      />
                      <span style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>
                        Same seed + same choices ⇒ same universe.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <div className="panel">
                  <div className="panel-head">World summary</div>
                  <div className="panel-body" style={{ fontSize: 13 }}>
                    <div>
                      {snapshot.companies.length} active companies · {snapshot.workers.length} rostered workers ·{" "}
                      {snapshot.titles.length} championships
                    </div>
                    <div style={{ color: "var(--ink-faint)", marginTop: 6, fontFamily: "var(--mono)", fontSize: 11 }}>
                      snapshot {snapshot.meta.snapshotHash.slice(0, 12)}… · bundle {snapshot.meta.bundleHash.slice(0, 12)}…
                    </div>
                  </div>
                </div>
                <div className="panel" style={{ marginTop: 12 }}>
                  <div className="panel-head">Data health</div>
                  <div className="panel-body" style={{ fontSize: 12.5 }}>
                    <div>{snapshot.dataHealth.titlesWithoutLineage} championships without derivable lineage</div>
                    <div>{snapshot.dataHealth.workersLowConfidence} workers with thin evidence (wide confidence bands)</div>
                    <div>{snapshot.dataHealth.aliasSuspects.length} unresolved alias suspects (reported, never auto-merged)</div>
                    {snapshot.dataHealth.notes.slice(0, 4).map((n, i) => (
                      <div key={i} style={{ color: "var(--ink-faint)", marginTop: 4 }}>
                        {n}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "space-between" }}>
              <button className="quiet" onClick={() => setStep("date")}>
                Back
              </button>
              <button className="primary" data-testid="create-universe" disabled={!companyId} onClick={create}>
                Take the book →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
