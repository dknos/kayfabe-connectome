import { useState } from "react";
import { useApp } from "../store";
import { diffDays } from "@kayfabe/sim-core";

export function CreativeScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const dispatch = useApp((s) => s.dispatch);
  const openPerson = useApp((s) => s.openPerson);

  const playerId = state.meta.options.playerCompanyId;
  const [name, setName] = useState("");
  const [premise, setPremise] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [titleId, setTitleId] = useState("");
  const [target, setTarget] = useState("");
  const [milestone, setMilestone] = useState("");

  const roster = Object.keys(state.contracts)
    .sort()
    .map((id) => state.contracts[id]!)
    .filter((c) => c.companyId === playerId && c.status === "active")
    .map((c) => state.workers[c.personId]!)
    .sort((a, b) => b.standing.awarenessNational - a.standing.awarenessNational);

  const stories = Object.keys(state.storylines)
    .sort()
    .map((id) => state.storylines[id]!)
    .filter((s) => s.companyId === playerId);
  const active = stories.filter((s) => s.phase !== "concluded" && s.phase !== "abandoned");
  const done = stories.filter((s) => s.phase === "concluded" || s.phase === "abandoned").slice(-6);

  const inStories = new Map<string, number>();
  for (const s of active) for (const p of s.participants) inStories.set(p.personId, (inStories.get(p.personId) ?? 0) + 1);
  const neglected = roster.filter((w) => !inStories.has(w.personId) && w.condition.daysSinceMatch >= 14 && w.push !== "unused");
  const overused = roster.filter((w) => (inStories.get(w.personId) ?? 0) >= 2);

  const titles = Object.keys(state.titles).sort().map((id) => state.titles[id]!).filter((t) => t.companyId === playerId);

  function create(): void {
    const participants = [...picked].sort().map((personId, i) => ({
      personId,
      role: (i === 0 ? "protagonist" : i === 1 ? "antagonist" : "supporting") as "protagonist" | "antagonist" | "supporting",
    }));
    const res = dispatch({
      type: "CREATE_STORYLINE",
      companyId: playerId,
      name: name.trim() || "Untitled program",
      premise: premise.trim() || "Two forces on a collision course.",
      participants,
      titleId: titleId || null,
      targetDate: /^\d{4}-\d{2}-\d{2}$/.test(target) ? target : null,
      milestones: milestone.trim() ? [{ description: milestone.trim(), targetDate: /^\d{4}-\d{2}-\d{2}$/.test(target) ? target : null }] : [],
    });
    if (res.errors.length === 0) {
      setName(""); setPremise(""); setPicked(new Set()); setMilestone("");
    }
  }

  return (
    <div className="page">
      <div className="page-title">
        <h1>Creative Room</h1>
        <span className="sub">{active.length} running programs</span>
      </div>
      <div className="cols cols-sidebar">
        <div>
          {active.length === 0 && <div className="empty">Nothing on the board. A territory without stories is just a gym with lights.</div>}
          {active.map((s) => (
            <div key={s.id} className="panel" style={{ marginBottom: 12 }} data-testid="storyline-row">
              <div className="panel-head">
                {s.name}
                <span className={`pill ${s.phase === "peak" ? "gold" : ""}`}>{s.phase}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button className="quiet" onClick={() => dispatch({ type: "CONCLUDE_STORYLINE", storylineId: s.id, outcome: "concluded" })}>
                    Conclude
                  </button>
                  <button className="quiet" onClick={() => dispatch({ type: "CONCLUDE_STORYLINE", storylineId: s.id, outcome: "abandoned" })}>
                    Abandon
                  </button>
                </span>
              </div>
              <div className="panel-body" style={{ fontSize: 13 }}>
                <p style={{ margin: "0 0 6px", fontFamily: "var(--serif)" }}>{s.premise}</p>
                <div>
                  {s.participants.map((p) => (
                    <span key={p.personId} style={{ marginRight: 10 }}>
                      <a style={{ cursor: "pointer" }} onClick={() => openPerson(p.personId)}>{state.workers[p.personId]?.name ?? p.personId}</a>{" "}
                      <span className="confidence">{p.role}</span>
                    </span>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 16, marginTop: 6, alignItems: "center" }}>
                  <span className="meter" title="Audience investment in the story">
                    <span className="track"><span className={`fill ${s.heat >= 60 ? "hot" : ""}`} style={{ width: `${s.heat}%` }} /></span>
                    <span className="val">{Math.round(s.heat)}</span>
                  </span>
                  <span style={{ color: "var(--ink-faint)" }}>
                    day {diffDays(s.startDate, state.currentDate)} · {s.beats.length} beats
                    {s.targetDate ? ` · aiming for ${s.targetDate}` : ""}
                    {s.titleId ? ` · ${state.titles[s.titleId]?.name}` : ""}
                  </span>
                </div>
                {s.milestones.length > 0 && (
                  <ul style={{ margin: "6px 0 0 18px" }}>
                    {s.milestones.map((m, i) => (
                      <li key={i} style={{ textDecoration: m.done ? "line-through" : "none" }}>
                        {m.description} {m.targetDate && <span className="confidence">by {m.targetDate}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {s.beats.length > 0 && (
                  <div style={{ marginTop: 6, color: "var(--ink-soft)", fontSize: 12.5 }}>
                    {s.beats.slice(-3).map((b, i) => (
                      <div key={i}>· {b.date} — {b.summary}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          {done.length > 0 && (
            <div className="panel">
              <div className="panel-head">Closed programs</div>
              <div className="panel-body" style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>
                {done.map((s) => (
                  <div key={s.id}>{s.name} — {s.phase} after {s.beats.length} beats</div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">Start a program</div>
            <div className="panel-body" style={{ display: "grid", gap: 8 }}>
              <input data-testid="story-name" placeholder="Program name" value={name} onChange={(e) => setName(e.target.value)} />
              <textarea placeholder="The premise — what is this about?" value={premise} rows={2} onChange={(e) => setPremise(e.target.value)} />
              <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 3, padding: 6 }}>
                {roster.map((w) => (
                  <label key={w.personId} style={{ display: "block", fontSize: 12.5 }}>
                    <input
                      type="checkbox"
                      data-testid={`story-pick-${w.personId}`}
                      checked={picked.has(w.personId)}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(w.personId);
                        else next.delete(w.personId);
                        setPicked(next);
                      }}
                    />{" "}
                    {w.name} <span className="confidence">{w.push.replace("_", " ")}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={titleId} onChange={(e) => setTitleId(e.target.value)} title="Optional championship at stake">
                  <option value="">no title attached</option>
                  {titles.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <input placeholder="Target date" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 110 }} />
              </div>
              <input placeholder="First milestone (optional)" value={milestone} onChange={(e) => setMilestone(e.target.value)} />
              <button className="primary" data-testid="story-create" disabled={picked.size < 2} onClick={create}
                title={picked.size < 2 ? "Pick at least two participants" : "Create the storyline"}>
                Put it on the board
              </button>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="panel-head">Roster usage</div>
            <div className="panel-body" style={{ fontSize: 12.5 }}>
              {neglected.length > 0 && (
                <>
                  <div style={{ color: "var(--alert)", fontWeight: 600 }}>Cold — no story, no match in 14+ days:</div>
                  <div>{neglected.slice(0, 8).map((w) => w.name).join(", ")}{neglected.length > 8 ? ` +${neglected.length - 8} more` : ""}</div>
                </>
              )}
              {overused.length > 0 && (
                <>
                  <div style={{ color: "var(--gold)", fontWeight: 600, marginTop: 6 }}>Stretched across 2+ programs:</div>
                  <div>{overused.map((w) => w.name).join(", ")}</div>
                </>
              )}
              {neglected.length === 0 && overused.length === 0 && <div className="empty">Usage looks healthy.</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
