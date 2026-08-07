import { useMemo, useState } from "react";
import { useApp } from "../store";
import type { WorkerState } from "@kayfabe/sim-contract";

type SortKey = "name" | "push" | "momentum" | "awareness" | "affinity" | "credibility" | "fatigue" | "idle";

const PUSH_ORDER = { main_event: 0, upper: 1, midcard: 2, lower: 3, opener: 4, unused: 5 } as const;

function Meter({ v, signed = false }: { v: number; signed?: boolean }): JSX.Element {
  const pct = signed ? Math.abs(v) : v;
  return (
    <span className="meter">
      <span className="track">
        <span className={`fill ${v >= 70 ? "good" : v <= (signed ? -20 : 25) ? "hot" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span className="val">{Math.round(v)}</span>
    </span>
  );
}

export function RosterScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const openPerson = useApp((s) => s.openPerson);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("push");
  const [dir, setDir] = useState(1);

  const playerId = state.meta.options.playerCompanyId;
  const roster = useMemo(() => {
    const ids = new Set(
      Object.keys(state.contracts)
        .sort()
        .map((id) => state.contracts[id]!)
        .filter((c) => c.companyId === playerId && c.status === "active")
        .map((c) => c.personId),
    );
    const endById = new Map<string, string>();
    for (const cid of Object.keys(state.contracts).sort()) {
      const c = state.contracts[cid]!;
      if (c.companyId === playerId && c.status === "active") endById.set(c.personId, c.endDate ?? "open");
    }
    let list = [...ids].map((pid) => ({ w: state.workers[pid]!, end: endById.get(pid) ?? "—" }));
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter(({ w }) => w.personaNames.some((n) => n.toLowerCase().includes(needle)));
    }
    const key = (w: WorkerState): number | string => {
      switch (sort) {
        case "name": return w.name;
        case "push": return PUSH_ORDER[w.push];
        case "momentum": return -w.momentum;
        case "awareness": return -w.standing.awarenessNational;
        case "affinity": return -w.standing.affinityNational;
        case "credibility": return -w.credibility;
        case "fatigue": return -w.condition.fatigue;
        case "idle": return -w.condition.daysSinceMatch;
      }
    };
    list.sort((a, b) => {
      const ka = key(a.w), kb = key(b.w);
      const c = typeof ka === "string" ? ka.localeCompare(kb as string) : (ka as number) - (kb as number);
      return c !== 0 ? c * dir : a.w.personId.localeCompare(b.w.personId);
    });
    return list;
  }, [state, q, sort, dir, playerId]);

  function header(label: string, k: SortKey): JSX.Element {
    return (
      <th onClick={() => (sort === k ? setDir(-dir) : (setSort(k), setDir(1)))} title={`Sort by ${label}`}>
        {label} {sort === k ? (dir === 1 ? "▾" : "▴") : ""}
      </th>
    );
  }

  return (
    <div className="page">
      <div className="page-title">
        <h1>Roster</h1>
        <span className="sub">{roster.length} under contract</span>
        <span style={{ marginLeft: "auto" }}>
          <input
            data-testid="roster-search"
            placeholder="Search any ring name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 240 }}
          />
        </span>
      </div>
      <div className="panel">
        <div className="panel-body" style={{ padding: 0, maxHeight: "72vh", overflowY: "auto" }}>
          <table className="data" data-testid="roster-table">
            <thead>
              <tr>
                {header("Name", "name")}
                {header("Push", "push")}
                <th>Align</th>
                {header("Momentum", "momentum")}
                {header("Awareness", "awareness")}
                {header("Affinity", "affinity")}
                {header("Credibility", "credibility")}
                {header("Fatigue", "fatigue")}
                {header("Days idle", "idle")}
                <th>Contract ends</th>
              </tr>
            </thead>
            <tbody>
              {roster.map(({ w, end }) => (
                <tr key={w.personId} className="rowlink" onClick={() => openPerson(w.personId)}>
                  <td>
                    <strong>{w.name}</strong>
                    {w.condition.injury && <span className="pill alert" style={{ marginLeft: 6 }}>injured</span>}
                  </td>
                  <td>{w.push.replace("_", " ")}</td>
                  <td>
                    <span className={`pill ${w.alignment}`}>{w.alignment}</span>
                  </td>
                  <td><Meter v={w.momentum} signed /></td>
                  <td><Meter v={w.standing.awarenessNational} /></td>
                  <td><Meter v={w.standing.affinityNational} signed /></td>
                  <td><Meter v={w.credibility} /></td>
                  <td><Meter v={w.condition.fatigue} /></td>
                  <td className="num">{w.condition.daysSinceMatch}</td>
                  <td>{end}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {roster.length === 0 && <div className="empty">No one matches that search.</div>}
        </div>
      </div>
    </div>
  );
}
