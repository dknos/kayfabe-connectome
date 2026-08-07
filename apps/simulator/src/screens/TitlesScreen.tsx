import { useState } from "react";
import { useApp } from "../store";
import { diffDays } from "@kayfabe/sim-core";

export function TitlesScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const dispatch = useApp((s) => s.dispatch);
  const openPerson = useApp((s) => s.openPerson);
  const playerId = state.meta.options.playerCompanyId;
  const [adminPick, setAdminPick] = useState<Record<string, string>>({});

  const titles = Object.keys(state.titles)
    .sort()
    .map((id) => state.titles[id]!)
    .filter((t) => t.active)
    .sort((a, b) =>
      (a.companyId === playerId ? 0 : 1) - (b.companyId === playerId ? 0 : 1) ||
      a.companyId.localeCompare(b.companyId) ||
      b.prestige - a.prestige,
    );

  const roster = Object.keys(state.contracts)
    .sort()
    .map((id) => state.contracts[id]!)
    .filter((c) => c.companyId === playerId && c.status === "active")
    .map((c) => c.personId);

  const [newName, setNewName] = useState("");
  const [newTier, setNewTier] = useState<"world" | "secondary" | "tag" | "other">("world");

  return (
    <div className="page">
      <div className="page-title">
        <h1>Championships</h1>
        <span className="sub">{titles.length} active belts across the industry</span>
      </div>
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-head">Create a championship</div>
        <div className="panel-body" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            data-testid="title-name"
            placeholder="Championship name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: 300 }}
          />
          <select data-testid="title-tier" value={newTier} onChange={(e) => setNewTier(e.target.value as never)}>
            <option value="world">world</option>
            <option value="secondary">secondary</option>
            <option value="tag">tag</option>
            <option value="other">other</option>
          </select>
          <button
            className="primary"
            data-testid="title-create"
            disabled={newName.trim().length < 3}
            onClick={() => {
              const res = dispatch({ type: "CREATE_TITLE", name: newName.trim(), tier: newTier });
              if (res.errors.length === 0) setNewName("");
            }}
          >
            Unveil it
          </button>
          <span className="confidence">New belts start with little prestige — defenses earn it.</span>
        </div>
      </div>
      {titles.map((t) => {
        const current = t.lineage[t.lineage.length - 1];
        const mine = t.companyId === playerId;
        return (
          <div key={t.id} className="panel" style={{ marginBottom: 12 }}>
            <div className="panel-head">
              {t.name}
              <span className="pill">{state.companies[t.companyId]?.shortName}</span>
              <span className={`pill ${t.tier === "world" ? "gold" : ""}`}>{t.tier}</span>
              <span style={{ marginLeft: "auto" }}>prestige {Math.round(t.prestige)}</span>
            </div>
            <div className="panel-body">
              <div style={{ display: "flex", gap: 18, alignItems: "baseline", flexWrap: "wrap" }}>
                <div style={{ fontFamily: "var(--serif)", fontSize: 17 }}>
                  {t.holderIds.length === 0
                    ? "Vacant"
                    : t.holderIds.map((pid, i) => (
                        <span key={pid}>
                          {i > 0 && " & "}
                          <a style={{ cursor: "pointer" }} onClick={() => openPerson(pid)}>
                            {state.workers[pid]?.name ?? pid}
                          </a>
                        </span>
                      ))}
                </div>
                {current && current.toDate === null && t.holderIds.length > 0 && (
                  <span style={{ color: "var(--ink-faint)" }}>
                    day {diffDays(current.fromDate, state.currentDate)} of the reign · {t.defensesSinceChange} defenses
                  </span>
                )}
              </div>
              {t.lineage.length > 0 ? (
                <table className="data" style={{ marginTop: 8 }}>
                  <thead>
                    <tr><th>Holders</th><th>From</th><th>To</th><th>Provenance</th></tr>
                  </thead>
                  <tbody>
                    {[...t.lineage].reverse().slice(0, 8).map((r, i) => (
                      <tr key={i}>
                        <td>{r.holderIds.map((p) => state.workers[p]?.name ?? p).join(" & ") || "vacant"}</td>
                        <td>{r.fromDate}</td>
                        <td>{r.toDate ?? "present"}</td>
                        <td>
                          <span className={`pill ${r.historical ? "" : "gold"}`}>
                            {r.historical ? "historical record" : "this universe"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="confidence" style={{ marginTop: 6 }}>
                  No derivable lineage in the record — the corpus documents this belt's matches but not its reigns.
                </div>
              )}
              {mine && (
                <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                  <span className="confidence">Front office:</span>
                  <select value={adminPick[t.id] ?? ""} onChange={(e) => setAdminPick({ ...adminPick, [t.id]: e.target.value })}>
                    <option value="">— pick a new holder —</option>
                    {roster.map((pid) => (
                      <option key={pid} value={pid}>{state.workers[pid]?.name ?? pid}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const pick = adminPick[t.id];
                      if (!pick) return;
                      if (confirm(`Hand the ${t.name} to ${state.workers[pick]?.name}? Titles usually change in the ring.`)) {
                        dispatch({ type: "SET_TITLE_HOLDER", titleId: t.id, holderIds: [pick], reason: "front-office decision" });
                      }
                    }}
                  >
                    Award
                  </button>
                  <button
                    className="quiet"
                    onClick={() => {
                      if (confirm(`Vacate the ${t.name}?`)) {
                        dispatch({ type: "SET_TITLE_HOLDER", titleId: t.id, holderIds: [], reason: "vacated" });
                      }
                    }}
                  >
                    Vacate
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
