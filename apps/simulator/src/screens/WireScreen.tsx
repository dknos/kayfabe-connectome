import { useState } from "react";
import { useApp } from "../store";

export function WireScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const openPerson = useApp((s) => s.openPerson);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");

  const kinds = [...new Set(state.news.map((n) => n.kind))].sort();
  const items = [...state.news]
    .reverse()
    .filter((n) => kind === "all" || n.kind === kind)
    .filter((n) => !q || n.headline.toLowerCase().includes(q.toLowerCase()) || n.body.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 300);

  return (
    <div className="page">
      <div className="page-title">
        <h1>The Ringside Ledger</h1>
        <span className="sub">the industry wire — results, moves, and talk</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input placeholder="Search the wire…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">everything</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{k.replace("_", " ")}</option>
            ))}
          </select>
        </span>
      </div>
      <div className="panel">
        <div className="panel-body" data-testid="wire-list">
          {items.length === 0 ? (
            <div className="empty">The wire is quiet. It never stays that way.</div>
          ) : (
            items.map((n) => (
              <div key={n.id} className="wire-item">
                <div className="meta">
                  {n.date} · {n.kind.replace("_", " ")}
                  {n.companyId && ` · ${state.companies[n.companyId]?.shortName ?? ""}`}
                  {n.rumor && <span className="pill alert" style={{ marginLeft: 6 }}>rumor</span>}
                </div>
                <div className="headline">{n.headline}</div>
                <div style={{ fontSize: 13 }}>
                  {n.body}
                  {n.personIds.length > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      {n.personIds.map((pid) => (
                        <a key={pid} style={{ cursor: "pointer", marginRight: 8 }} onClick={() => openPerson(pid)}>
                          {state.workers[pid]?.name ?? ""}
                        </a>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
          {state.news.length > 300 && <div className="confidence" style={{ marginTop: 8 }}>showing the latest 300 of {state.news.length} stories</div>}
        </div>
      </div>
    </div>
  );
}
