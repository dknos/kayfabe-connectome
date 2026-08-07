import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import type { AngleBeat, BeatRole, FinishKind, Segment, SimState, WorkerState } from "@kayfabe/sim-contract";
import { forecastShow, formatUSD, resolveEra, validateCard } from "@kayfabe/sim-core";

const FINISHES: FinishKind[] = ["pin", "submission", "dq", "countout", "ko", "no_contest", "time_limit_draw"];
const PURPOSES = ["promo", "interview", "attack", "save", "betrayal", "challenge", "reveal", "contract_signing", "celebration", "video_package"] as const;
const ROLES: BeatRole[] = ["speaker", "target", "attacker", "victim", "interviewer", "bystander"];
const PUSH_RANK = { main_event: 0, upper: 1, midcard: 2, lower: 3, opener: 4, unused: 5 } as const;

function nextSegId(segments: Segment[]): string {
  let max = 0;
  for (const s of segments) {
    const m = /^seg-(\d+)$/.exec(s.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `seg-${max + 1}`;
}

function participantsOf(segments: Segment[]): Set<string> {
  const out = new Set<string>();
  for (const seg of segments) {
    if (seg.match) for (const side of seg.match.sides) for (const p of side.members) out.add(p);
    if (seg.angle) for (const b of seg.angle.beats) for (const p of b.participants) out.add(p.personId);
  }
  return out;
}

export function BookerScreen(): JSX.Element {
  const state = useApp((s) => s.simState)!;
  const showId = useApp((s) => s.selectedShowId);
  const dispatch = useApp((s) => s.dispatch);
  const go = useApp((s) => s.go);

  const show = showId ? state.shows[showId] : null;
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selSeg, setSelSeg] = useState(0);
  const [selSide, setSelSide] = useState(0);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (show) {
      setSegments(structuredClone(show.segments));
      setSelSeg(0);
      setSelSide(0);
    }
  }, [showId]); // eslint-disable-line react-hooks/exhaustive-deps

  const playerId = state.meta.options.playerCompanyId;
  const roster: WorkerState[] = useMemo(
    () =>
      Object.keys(state.contracts)
        .sort()
        .map((id) => state.contracts[id]!)
        .filter((c) => c.companyId === playerId && c.status === "active")
        .map((c) => state.workers[c.personId]!)
        .filter((w) => w !== undefined)
        .sort((a, b) => PUSH_RANK[a.push] - PUSH_RANK[b.push] || b.momentum - a.momentum || a.personId.localeCompare(b.personId)),
    [state, playerId],
  );

  if (!show || show.companyId !== playerId) {
    return (
      <div className="page">
        <div className="empty">Pick one of your shows from the Calendar to open the board.</div>
      </div>
    );
  }
  if (show.status !== "scheduled") {
    return (
      <div className="page">
        <div className="empty">
          {show.name} is {show.status}. {show.report && <button onClick={() => go("postshow")}>Read the review</button>}
        </div>
      </div>
    );
  }

  const used = participantsOf(segments);
  const errors = validateCard(state, show, segments);
  const valid = errors.length === 0 && segments.length > 0;
  const totalMin = segments.reduce((sum, s) => sum + s.durationMin, 0);
  const era = resolveEra(show.date);
  const venue = state.venues[show.venueId]!;
  const market = state.markets[show.marketId]!;
  const forecast = forecastShow({
    company: state.companies[playerId]!,
    show: { ...show, segments },
    venue,
    market,
    advertisedWorkers: [...used].sort().map((p) => state.workers[p]!).filter(Boolean),
    era,
    rng: null,
  });

  function mutate(fn: (segs: Segment[]) => void): void {
    setSegments((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }

  function assign(pid: string): void {
    if (used.has(pid)) return;
    mutate((segs) => {
      const seg = segs[selSeg];
      if (!seg) return;
      if (seg.match) {
        const side = seg.match.sides[Math.min(selSide, seg.match.sides.length - 1)];
        if (side && !side.members.includes(pid)) side.members.push(pid);
      } else if (seg.angle) {
        const beat = seg.angle.beats[0];
        if (beat && !beat.participants.some((p) => p.personId === pid)) {
          beat.participants.push({ personId: pid, role: beat.participants.length === 0 ? "speaker" : "target" });
        }
      }
    });
  }

  function autoFill(i: number): void {
    mutate((segs) => {
      const seg = segs[i];
      if (!seg) return;
      const taken = participantsOf(segs);
      const pool = roster.filter((w) => !taken.has(w.personId) && (!w.condition.injury || w.condition.injury.outUntil <= show!.date));
      let k = 0;
      if (seg.match) {
        for (const side of seg.match.sides) {
          while (side.members.length === 0 && k < pool.length) side.members.push(pool[k++]!.personId);
        }
      } else if (seg.angle) {
        const beat = seg.angle.beats[0];
        if (beat) {
          while (beat.participants.length < 2 && k < pool.length) {
            beat.participants.push({ personId: pool[k]!.personId, role: beat.participants.length === 0 ? "speaker" : "target" });
            k++;
          }
        }
      }
    });
  }

  function saveCard(): boolean {
    const res = dispatch({ type: "UPDATE_SHOW_CARD", showId: show!.id, segments, advertised: [...used].sort() });
    return res.errors.length === 0;
  }

  function runShow(): void {
    if (!saveCard()) return;
    const res = dispatch({ type: "RUN_SHOW", showId: show!.id });
    if (res.errors.length === 0) go("live");
  }

  const filteredRoster = roster.filter((w) => !search || w.personaNames.some((n) => n.toLowerCase().includes(search.toLowerCase())));

  return (
    <div className="page" data-testid="booker-board">
      <div className="page-title">
        <h1>{show.name}</h1>
        <span className="sub">
          {show.date} · {venue.name} · {show.showType.toUpperCase()} · {totalMin} min booked
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button data-testid="add-match" onClick={() => mutate((s) => { s.push({ id: nextSegId(s), kind: "match", durationMin: 12, match: { sides: [{ members: [] }, { members: [] }], titleId: null, winnerSide: 0, finish: "pin", stipulation: null, intensity: 55, risk: 35, mainEvent: false }, angle: null, storylineId: null }); setSelSeg(s.length - 1); })}>
            + Match
          </button>
          <button data-testid="add-angle" onClick={() => mutate((s) => { s.push({ id: nextSegId(s), kind: "angle", durationMin: 6, match: null, angle: { beats: [{ purpose: "promo", location: "ring", durationMin: 6, participants: [], summary: "" }] }, storylineId: null }); setSelSeg(s.length - 1); })}>
            + Angle
          </button>
          <button onClick={saveCard} disabled={errors.length > 0 && segments.length > 0 ? true : segments.length === 0}>
            Save card
          </button>
          <button className="primary" data-testid="run-show" disabled={!valid || show.date !== state.currentDate} onClick={runShow}
            title={show.date !== state.currentDate ? `Runs on ${show.date} — advance the calendar first` : "Run the show"}>
            Run show
          </button>
        </span>
      </div>

      <div className="board">
        <div className="panel">
          <div className="panel-head">Roster</div>
          <div className="panel-body" style={{ maxHeight: "68vh", overflowY: "auto" }}>
            <input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
            {filteredRoster.map((w) => {
              const injured = w.condition.injury && w.condition.injury.outUntil > show.date;
              const busy = used.has(w.personId);
              return (
                <div
                  key={w.personId}
                  data-testid={`roster-chip-${w.personId}`}
                  className={`roster-chip ${busy || injured ? "unavailable" : ""}`}
                  draggable={!busy && !injured}
                  onDragStart={(e) => e.dataTransfer.setData("text/person", w.personId)}
                  onClick={() => !busy && !injured && assign(w.personId)}
                  title={injured ? `Injured until ${w.condition.injury!.outUntil}` : busy ? "Already on the card" : "Click to add to the selected slot"}
                >
                  <span>{w.name}</span>
                  <span style={{ color: "var(--ink-faint)" }}>
                    {w.push.replace("_", " ")} · {w.momentum > 0 ? "+" : ""}{Math.round(w.momentum)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          {segments.length === 0 && <div className="empty">An empty card. Add a match or an angle.</div>}
          {segments.map((seg, i) => (
            <SegmentCard
              key={seg.id}
              seg={seg}
              index={i}
              last={i === segments.length - 1}
              selected={selSeg === i}
              selSide={selSide}
              state={state}
              showDate={show.date}
              onSelect={(side) => {
                setSelSeg(i);
                setSelSide(side);
              }}
              onDropPerson={(pid, side) => {
                setSelSeg(i);
                setSelSide(side);
                if (!used.has(pid)) {
                  mutate((segs) => {
                    const s = segs[i]!;
                    if (s.match) s.match.sides[side]?.members.push(pid);
                    else if (s.angle) s.angle.beats[0]?.participants.push({ personId: pid, role: "target" });
                  });
                }
              }}
              onAutoFill={() => autoFill(i)}
              onRemove={() => mutate((s) => { s.splice(i, 1); })}
              onMove={(dir) => mutate((s) => {
                const j = i + dir;
                if (j < 0 || j >= s.length) return;
                const [x] = s.splice(i, 1);
                s.splice(j, 0, x!);
              })}
              onChange={(fn) => mutate((segs) => fn(segs[i]!))}
            />
          ))}
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">Card check</div>
            <div className="panel-body">
              {valid ? (
                <div data-testid="card-valid" style={{ color: "var(--green)", fontWeight: 600 }}>
                  ✓ Bookable — {segments.length} segments, {totalMin} minutes
                </div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 16, color: "var(--alert)", fontSize: 12.5 }}>
                  {segments.length === 0 ? <li>Add at least one segment.</li> : errors.map((e, k) => <li key={k}>{e}</li>)}
                </ul>
              )}
            </div>
          </div>
          <div className="panel" style={{ marginTop: 12 }}>
            <div className="panel-head">Forecast</div>
            <div className="panel-body" style={{ fontSize: 13 }}>
              <div>
                Attendance {forecast.attendanceRange[0].toLocaleString("en-US")}–{forecast.attendanceRange[1].toLocaleString("en-US")} of {venue.capacity.toLocaleString("en-US")}
              </div>
              <div>
                Gate {formatUSD(forecast.gateCentsRange[0], { compact: true })}–{formatUSD(forecast.gateCentsRange[1], { compact: true })}
              </div>
              <div>Quality outlook {forecast.qualityRange[0]}–{forecast.qualityRange[1]}</div>
              {forecast.warnings.map((w, k) => (
                <div key={k} className="notice" style={{ marginTop: 6 }}>{w}</div>
              ))}
              <div style={{ color: "var(--ink-faint)", marginTop: 6, fontSize: 11.5 }}>
                Forecasts are ranges on purpose. Crowds keep their own counsel.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SegmentCard(props: {
  seg: Segment;
  index: number;
  last: boolean;
  selected: boolean;
  selSide: number;
  state: SimState;
  showDate: string;
  onSelect: (side: number) => void;
  onDropPerson: (pid: string, side: number) => void;
  onAutoFill: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onChange: (fn: (seg: Segment) => void) => void;
}): JSX.Element {
  const { seg, index, selected, selSide, state, onSelect, onDropPerson, onAutoFill, onRemove, onMove, onChange } = props;
  const playerId = state!.meta.options.playerCompanyId;
  const titles = Object.keys(state!.titles).sort().map((id) => state!.titles[id]!).filter((t) => t.companyId === playerId && t.active);
  const stories = Object.keys(state!.storylines).sort().map((id) => state!.storylines[id]!).filter((s) => s.companyId === playerId && (s.phase === "building" || s.phase === "peak" || s.phase === "blowoff"));
  const name = (pid: string): string => state!.workers[pid]?.name ?? pid;

  return (
    <div
      data-testid="segment-row"
      className={`card-slot ${seg.match?.mainEvent ? "main" : ""} ${selected ? "selected" : ""}`}
      onClick={() => onSelect(selSide)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>#{index + 1}</strong>
        <span className="pill">{seg.kind}</span>
        <label>
          <input
            type="number"
            value={seg.durationMin}
            min={1}
            style={{ width: 52 }}
            onChange={(e) => onChange((s) => { s.durationMin = Math.max(1, Number(e.target.value) || 1); if (s.angle?.beats[0]) s.angle.beats[0].durationMin = s.durationMin; })}
          />{" "}
          min
        </label>
        <select value={seg.storylineId ?? ""} title="Attach to a storyline" onChange={(e) => onChange((s) => { s.storylineId = e.target.value || null; })}>
          <option value="">no storyline</option>
          {stories.map((st) => (
            <option key={st.id} value={st.id}>{st.name}</option>
          ))}
        </select>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button className="quiet" data-testid="auto-fill-segment" onClick={(e) => { e.stopPropagation(); onAutoFill(); }} title="Fill empty slots with the best available unused talent">
            Auto-fill
          </button>
          <button className="quiet" onClick={(e) => { e.stopPropagation(); onMove(-1); }}>↑</button>
          <button className="quiet" onClick={(e) => { e.stopPropagation(); onMove(1); }}>↓</button>
          <button className="quiet" onClick={(e) => { e.stopPropagation(); onRemove(); }}>✕</button>
        </span>
      </div>

      {seg.match && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {seg.match.sides.map((side, si) => (
              <div
                key={si}
                onClick={(e) => { e.stopPropagation(); onSelect(si); }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const pid = e.dataTransfer.getData("text/person"); if (pid) onDropPerson(pid, si); }}
                style={{
                  flex: 1, minWidth: 130, border: `1px ${selected && selSide === si ? "solid var(--crimson)" : "dashed var(--line-strong)"}`,
                  borderRadius: 3, padding: 6, background: "var(--paper)",
                }}
                title="Click to select this side, then click roster names to add"
              >
                <div style={{ fontSize: 10.5, color: "var(--ink-faint)", textTransform: "uppercase" }}>
                  Side {si + 1} {seg.match!.winnerSide === si && <span className="pill gold">wins</span>}
                </div>
                {side.members.length === 0 && <div style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>empty</div>}
                {side.members.map((pid) => (
                  <div key={pid} style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>{name(pid)}</span>
                    <button className="quiet" onClick={(e) => { e.stopPropagation(); onChange((s) => { const sd = s.match!.sides[si]!; sd.members = sd.members.filter((m) => m !== pid); }); }}>✕</button>
                  </div>
                ))}
              </div>
            ))}
            {seg.match.sides.length < 4 && (
              <button className="quiet" onClick={(e) => { e.stopPropagation(); onChange((s) => { s.match!.sides.push({ members: [] }); }); }}>
                + side
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
            <label>
              Winner{" "}
              <select
                value={seg.match.winnerSide ?? "none"}
                onChange={(e) => onChange((s) => { s.match!.winnerSide = e.target.value === "none" ? null : Number(e.target.value); })}
              >
                {seg.match.sides.map((_, si) => (
                  <option key={si} value={si}>Side {si + 1}</option>
                ))}
                <option value="none">none (draw/NC)</option>
              </select>
            </label>
            <label>
              Finish{" "}
              <select value={seg.match.finish} onChange={(e) => onChange((s) => { s.match!.finish = e.target.value as FinishKind; })}>
                {FINISHES.map((f) => (
                  <option key={f} value={f}>{f.replace("_", " ")}</option>
                ))}
              </select>
            </label>
            <label title="Championships change hands only on clean finishes">
              Title{" "}
              <select value={seg.match.titleId ?? ""} onChange={(e) => onChange((s) => { s.match!.titleId = e.target.value || null; })}>
                <option value="">non-title</option>
                {titles.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label title="Physical intensity: quality fuel, fatigue and risk">
              Intensity <input type="range" min={10} max={100} value={seg.match.intensity} onChange={(e) => onChange((s) => { s.match!.intensity = Number(e.target.value); })} />
            </label>
            <label title="High spots: reception ceiling, injury risk">
              Risk <input type="range" min={0} max={100} value={seg.match.risk} onChange={(e) => onChange((s) => { s.match!.risk = Number(e.target.value); })} />
            </label>
            <label>
              <input type="checkbox" checked={seg.match.mainEvent} onChange={(e) => onChange((s) => { s.match!.mainEvent = e.target.checked; })} /> main event
            </label>
          </div>
        </div>
      )}

      {seg.angle && (
        <div style={{ marginTop: 6 }}>
          {seg.angle.beats.map((beat, bi) => (
            <BeatEditor key={bi} beat={beat} onChange={(fn) => onChange((s) => fn(s.angle!.beats[bi]!))} name={name}
              onRemoveBeat={seg.angle!.beats.length > 1 ? () => onChange((s) => { s.angle!.beats.splice(bi, 1); }) : null} />
          ))}
          <button className="quiet" onClick={(e) => { e.stopPropagation(); onChange((s) => { s.angle!.beats.push({ purpose: "attack", location: "backstage", durationMin: 2, participants: [], summary: "" }); }); }}>
            + beat
          </button>
        </div>
      )}
    </div>
  );
}

function BeatEditor({ beat, onChange, name, onRemoveBeat }: {
  beat: AngleBeat;
  onChange: (fn: (b: AngleBeat) => void) => void;
  name: (pid: string) => string;
  onRemoveBeat: (() => void) | null;
}): JSX.Element {
  return (
    <div style={{ border: "1px dotted var(--line-strong)", borderRadius: 3, padding: 6, marginTop: 4, background: "var(--paper)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={beat.purpose} onChange={(e) => onChange((b) => { b.purpose = e.target.value as AngleBeat["purpose"]; })}>
          {PURPOSES.map((p) => (
            <option key={p} value={p}>{p.replace("_", " ")}</option>
          ))}
        </select>
        <select value={beat.location} onChange={(e) => onChange((b) => { b.location = e.target.value as AngleBeat["location"]; })}>
          <option value="ring">in the ring</option>
          <option value="backstage">backstage</option>
          <option value="stage">on the stage</option>
        </select>
        <input placeholder="What happens? (optional)" value={beat.summary} style={{ flex: 1, minWidth: 140 }}
          onChange={(e) => onChange((b) => { b.summary = e.target.value; })} onClick={(e) => e.stopPropagation()} />
        {onRemoveBeat && <button className="quiet" onClick={(e) => { e.stopPropagation(); onRemoveBeat(); }}>✕ beat</button>}
      </div>
      <div style={{ marginTop: 4 }}>
        {beat.participants.map((p, pi) => (
          <span key={p.personId} style={{ marginRight: 8 }}>
            {name(p.personId)}{" "}
            <select value={p.role} onChange={(e) => onChange((b) => { b.participants[pi]!.role = e.target.value as BeatRole; })} title="What is this person doing? The sim rates them on their actual role.">
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>{" "}
            <button className="quiet" onClick={(e) => { e.stopPropagation(); onChange((b) => { b.participants.splice(pi, 1); }); }}>✕</button>
          </span>
        ))}
        {beat.participants.length === 0 && <span style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>click roster names to add participants</span>}
      </div>
    </div>
  );
}
