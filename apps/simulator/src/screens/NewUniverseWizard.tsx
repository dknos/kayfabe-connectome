import { useEffect, useMemo, useState } from "react";
import type { ProductDna, SimOptions, SnapshotCompany, UniverseSnapshot, Venue } from "@kayfabe/sim-contract";
import { hashValue } from "@kayfabe/sim-contract";
import { createUniverse, seedWorker, isIsoDate } from "@kayfabe/sim-core";
import { buildUniverseSnapshot } from "@kayfabe/history-adapter";
import { fetchCorpusJson } from "../corpus";
import { useApp } from "../store";

type Step = "date" | "building" | "company" | "failed";

const BACKINGS: { id: string; label: string; blurb: string; cashCents: number }[] = [
  { id: "shoestring", label: "Shoestring", blurb: "$75K — your savings and a handshake loan", cashCents: 7_500_000 },
  { id: "backed", label: "Backed", blurb: "$250K — a believer with money", cashCents: 25_000_000 },
  { id: "bankrolled", label: "Bankrolled", blurb: "$1M — serious investors, serious expectations", cashCents: 100_000_000 },
];

const IDENTITIES: { id: string; label: string; blurb: string; dna: ProductDna }[] = [
  {
    id: "fight-club",
    label: "The Fight Club",
    blurb: "Athletic, hard-hitting, results matter",
    dna: { athleticCompetition: 85, characterSpectacle: 25, serializedStory: 35, violence: 60, comedy: 10, starDriven: 40, nationalAmbition: 40 },
  },
  {
    id: "spectacle",
    label: "Spectacle & Stories",
    blurb: "Characters, arcs, and larger-than-life moments",
    dna: { athleticCompetition: 40, characterSpectacle: 80, serializedStory: 75, violence: 25, comedy: 40, starDriven: 70, nationalAmbition: 55 },
  },
  {
    id: "blood",
    label: "Blood & Thunder",
    blurb: "Ultraviolence with a cult following",
    dna: { athleticCompetition: 55, characterSpectacle: 45, serializedStory: 50, violence: 90, comedy: 15, starDriven: 45, nationalAmbition: 35 },
  },
  {
    id: "variety",
    label: "Saturday Variety",
    blurb: "Family-friendly, comedy-forward, everyone leaves smiling",
    dna: { athleticCompetition: 45, characterSpectacle: 65, serializedStory: 55, violence: 5, comedy: 60, starDriven: 55, nationalAmbition: 45 },
  },
];

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
  const [mode, setMode] = useState<"existing" | "found">("existing");
  const [foundName, setFoundName] = useState("");
  const [foundShort, setFoundShort] = useState("");
  const [foundMarket, setFoundMarket] = useState("mkt:philadelphia");
  const [backing, setBacking] = useState("backed");
  const [identity, setIdentity] = useState("fight-club");

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
    if (!snapshot) return;
    const worldSeed = seed.trim() || `book-${startDate}`;
    let snap = snapshot;
    let playerCompanyId = companyId;

    if (mode === "found") {
      const name = foundName.trim();
      if (name.length < 3) return;
      const short = foundShort.trim() || name.split(/\s+/).map((w) => w[0]).join("").toUpperCase().slice(0, 5);
      const marketName = snapshot.markets.find((m) => m.id === foundMarket)?.name ?? "Home";
      const founded: SnapshotCompany = {
        companyId: "co:founded",
        name,
        shortName: short,
        lineageIds: [],
        sizeTier: "indie",
        detailTier: "full",
        homeMarketId: foundMarket,
        rosterPersonIds: [],
        titleIds: [],
        awarenessNational: 4,
        affinityNational: 2,
        prestige: 10,
        productDna: IDENTITIES.find((i) => i.id === identity)!.dna,
        playable: true,
        startCashCents: BACKINGS.find((b) => b.id === backing)!.cashCents,
      };
      // A startup always has one modest building it can afford in its home town.
      const hall: Venue = {
        id: "v:founded-hall",
        name: `${marketName.split("/")[0]!.trim()} Athletic Club`,
        marketId: foundMarket,
        capacity: 800,
        prestige: 25,
        rentalCents: 120_000,
      };
      snap = {
        ...snapshot,
        companies: [...snapshot.companies, founded],
        venues: [...snapshot.venues, hall],
        meta: {
          ...snapshot.meta,
          snapshotHash: hashValue({ base: snapshot.meta.snapshotHash, founded, hall }),
        },
      };
      playerCompanyId = "co:founded";
    }

    if (!playerCompanyId) return;
    const options: SimOptions = {
      historicalMode: "open_alternate",
      playerRole: role,
      playerCompanyId,
      startDate,
      worldSeed,
      scoutingFog: true,
      abstractTierEnabled: true,
    };
    const state = createUniverse(snap, options);
    startUniverse(state, snap);
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
                <div className="panel-head">
                  Your company — {startDate}
                  <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    <button
                      className={mode === "existing" ? "primary" : "quiet"}
                      data-testid="mode-existing"
                      onClick={() => setMode("existing")}
                    >
                      Take over
                    </button>
                    <button
                      className={mode === "found" ? "primary" : "quiet"}
                      data-testid="mode-found"
                      onClick={() => setMode("found")}
                    >
                      Found your own
                    </button>
                  </span>
                </div>
                {mode === "found" && (
                  <div className="panel-body" data-testid="found-form">
                    <p style={{ marginTop: 0, color: "var(--ink-soft)", fontSize: 13 }}>
                      Start from nothing: no roster, no belts, no television — a building, a bankroll,
                      and {startDate.slice(0, 4)}'s free-agent pool. Outdraw the giants and the giants
                      will notice.
                    </p>
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <label style={{ flex: 2 }}>
                          Promotion name
                          <input
                            data-testid="found-name"
                            value={foundName}
                            onChange={(e) => setFoundName(e.target.value)}
                            placeholder="e.g. Keystone Championship Wrestling"
                            style={{ width: "100%" }}
                          />
                        </label>
                        <label style={{ flex: 1 }}>
                          Short name
                          <input
                            data-testid="found-short"
                            value={foundShort}
                            onChange={(e) => setFoundShort(e.target.value)}
                            placeholder="auto"
                            style={{ width: "100%" }}
                          />
                        </label>
                      </div>
                      <label>
                        Home market
                        <select
                          data-testid="found-market"
                          value={foundMarket}
                          onChange={(e) => setFoundMarket(e.target.value)}
                          style={{ width: "100%" }}
                        >
                          {snapshot.markets.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} — interest {m.wrestlingInterest}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div>
                        <div className="confidence" style={{ marginBottom: 4 }}>Backing</div>
                        <div style={{ display: "flex", gap: 12 }}>
                          {BACKINGS.map((b) => (
                            <label key={b.id} style={{ cursor: "pointer", flex: 1 }} title={b.blurb}>
                              <input type="radio" name="backing" checked={backing === b.id} onChange={() => setBacking(b.id)} />{" "}
                              <strong>{b.label}</strong>
                              <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{b.blurb}</div>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="confidence" style={{ marginBottom: 4 }}>Identity (your Product DNA — audiences will hold you to it)</div>
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                          {IDENTITIES.map((i) => (
                            <label key={i.id} style={{ cursor: "pointer", flex: "1 1 40%" }} title={i.blurb}>
                              <input type="radio" name="identity" checked={identity === i.id} onChange={() => setIdentity(i.id)} />{" "}
                              <strong>{i.label}</strong>
                              <div style={{ fontSize: 11.5, color: "var(--ink-faint)" }}>{i.blurb}</div>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="panel-body" style={mode === "found" ? { display: "none" } : undefined}>
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
                </div>
                <div className="panel-body">
                  <div>
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
              <button
                className="primary"
                data-testid="create-universe"
                disabled={mode === "found" ? foundName.trim().length < 3 : !companyId}
                onClick={create}
              >
                {mode === "found" ? "Open the doors →" : "Take the book →"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
