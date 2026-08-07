import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import type { CrowdState, MatchMoment } from "@kayfabe/sim-contract";
import { RingScene, type RingSide } from "../components/RingScene";

const AXES: { key: keyof CrowdState; label: string }[] = [
  { key: "energy", label: "Energy" },
  { key: "attention", label: "Attention" },
  { key: "investment", label: "Investment" },
  { key: "anticipation", label: "Anticipation" },
  { key: "satisfaction", label: "Satisfaction" },
  { key: "fatigue", label: "Fatigue" },
  { key: "hostility", label: "Hostility" },
];

const BEAT_MS = 950;

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 3);
}

export function LiveShowScreen(): JSX.Element {
  const report = useApp((s) => s.lastReport);
  const state = useApp((s) => s.simState)!;
  const go = useApp((s) => s.go);
  const [revealed, setRevealed] = useState(0);
  const [beatIdx, setBeatIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reduced = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    setRevealed(0);
    setBeatIdx(0);
  }, [report?.showId]);

  const show = report ? state.shows[report.showId] : null;
  const current = report && revealed > 0 ? report.segments[revealed - 1]! : null;
  const beats: MatchMoment[] = current?.matchLog ?? [];
  const playing = current !== null && beats.length > 0 && beatIdx < beats.length;

  // Beats advance on their own; the booker just watches the monitor.
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (!playing) return;
    if (reduced) {
      setBeatIdx(beats.length);
      return;
    }
    timerRef.current = setInterval(() => {
      setBeatIdx((i) => {
        if (i + 1 >= beats.length && timerRef.current) clearInterval(timerRef.current);
        return Math.min(i + 1, beats.length);
      });
    }, BEAT_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [current?.segmentId, playing, reduced, beats.length]);

  if (!report || !show) {
    return (
      <div className="page">
        <div className="empty">No show is on the air. Book a card and run it — this room comes alive on show night.</div>
      </div>
    );
  }

  const moment: MatchMoment | null = playing && beatIdx > 0 ? beats[beatIdx - 1]! : playing ? beats[0]! : beats.length > 0 ? beats[beats.length - 1]! : null;
  const crowd: CrowdState = revealed === 0 ? report.crowdStart : report.segments[revealed - 1]!.crowdAfter;
  const doneAll = revealed >= report.segments.length && !playing;

  const ringSides: RingSide[] = (() => {
    if (!current || current.kind !== "match") return [];
    const seg = show.segments.find((s) => s.id === current.segmentId);
    if (!seg?.match) return [];
    return seg.match.sides.map((side) => {
      const names = side.members.map((id) => state.workers[id]?.name ?? id);
      const label = names.join(" & ");
      return { label, initials: initialsOf(names[0] ?? "?") };
    });
  })();

  function next(): void {
    if (playing) {
      setBeatIdx(beats.length);
      return;
    }
    setRevealed((r) => Math.min(r + 1, report!.segments.length));
    setBeatIdx(0);
  }

  return (
    <div className="page" data-testid="live-show">
      <div className="page-title">
        <h1>{show.name}</h1>
        <span className="sub">
          {report.date} · {report.attendance.toLocaleString("en-US")} in a {report.capacity.toLocaleString("en-US")}-seat building
          {report.attendance >= report.capacity * 0.98 ? " · SOLD OUT" : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {!doneAll && (
            <button className="primary" data-testid="live-next" onClick={next}>
              {revealed === 0 ? "Ring the bell" : playing ? "Skip to the finish" : "Next segment"}
            </button>
          )}
          <button data-testid="live-finish" onClick={() => { setRevealed(report.segments.length); setBeatIdx(0); go("postshow"); }}>
            {doneAll ? "To the review" : "Skip to the end"}
          </button>
        </span>
      </div>

      {current && current.kind === "match" && ringSides.length > 0 && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <div className="panel-head">
            The hard camera
            {moment && (
              <span style={{ marginLeft: "auto" }} title="Crowd temperature at this moment">
                heat {moment.heat}
              </span>
            )}
          </div>
          <div className="panel-body">
            <RingScene sides={ringSides} moment={moment} attendance={report.attendance} capacity={report.capacity} />
            <div
              data-testid="ring-call"
              style={{ textAlign: "center", fontFamily: "var(--serif)", fontSize: 16, minHeight: 24, marginTop: 8 }}
            >
              {moment ? moment.description : "…"}
            </div>
            {beats.length > 0 && (
              <div style={{ textAlign: "center", color: "var(--ink-faint)", fontSize: 11.5 }}>
                {Math.min(beatIdx === 0 && playing ? 1 : beatIdx, beats.length)} / {beats.length} · {ringSides.map((s) => s.label).join(" vs ")}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">The building</div>
        <div className="panel-body">
          <div className="crowd-strip">
            {AXES.map(({ key, label }) => (
              <div key={key} className="crowd-dial" data-testid={`crowd-${key}`}>
                <div className="label">{label}</div>
                <div className="value" style={key === "hostility" || key === "fatigue" ? { color: crowd[key] > 50 ? "var(--alert)" : undefined } : { color: crowd[key] >= 70 ? "var(--green)" : undefined }}>
                  {Math.round(crowd[key])}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        {report.segments.slice(0, revealed).map((seg, i) => {
          const isCurrent = i === revealed - 1;
          if (isCurrent && playing) {
            return (
              <div key={seg.segmentId} className="card-slot selected">
                <strong>#{i + 1}</strong> <span style={{ color: "var(--ink-faint)" }}>— in progress…</span>
              </div>
            );
          }
          return (
            <div key={seg.segmentId} className={`card-slot ${isCurrent ? "selected" : ""}`}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <strong>#{i + 1}</strong>
                <span style={{ fontFamily: "var(--serif)", fontSize: 15.5 }}>{seg.headline}</span>
                <span style={{ marginLeft: "auto", display: "flex", gap: 12, alignItems: "baseline" }}>
                  <span title="How well it was performed">exec {Math.round(seg.execution)}</span>
                  <span className={seg.reception >= 80 ? "grade good" : ""} style={{ fontSize: seg.reception >= 80 ? 22 : 14 }} title="How the crowd took it">
                    {Math.round(seg.reception)}
                  </span>
                </span>
              </div>
              {seg.notes.slice(0, 2).map((n, k) => (
                <div key={k} style={{ fontSize: 12.5, color: "var(--ink-soft)", fontStyle: "italic" }}>{n}</div>
              ))}
            </div>
          );
        })}
        {revealed === 0 && <div className="empty">The house lights are down. Ring the bell.</div>}
      </div>
    </div>
  );
}
