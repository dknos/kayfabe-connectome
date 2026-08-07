import { useEffect, useState } from "react";
import { useApp } from "../store";
import type { CrowdState } from "@kayfabe/sim-contract";

const AXES: { key: keyof CrowdState; label: string }[] = [
  { key: "energy", label: "Energy" },
  { key: "attention", label: "Attention" },
  { key: "investment", label: "Investment" },
  { key: "anticipation", label: "Anticipation" },
  { key: "satisfaction", label: "Satisfaction" },
  { key: "fatigue", label: "Fatigue" },
  { key: "hostility", label: "Hostility" },
];

export function LiveShowScreen(): JSX.Element {
  const report = useApp((s) => s.lastReport);
  const state = useApp((s) => s.simState)!;
  const go = useApp((s) => s.go);
  const [revealed, setRevealed] = useState(0);

  useEffect(() => setRevealed(0), [report?.showId]);

  if (!report) {
    return (
      <div className="page">
        <div className="empty">No show is on the air. Book a card and run it — this room comes alive on show night.</div>
      </div>
    );
  }

  const show = state.shows[report.showId];
  const crowd: CrowdState = revealed === 0 ? report.crowdStart : report.segments[revealed - 1]!.crowdAfter;
  const doneAll = revealed >= report.segments.length;

  return (
    <div className="page" data-testid="live-show">
      <div className="page-title">
        <h1>{show?.name ?? "Live"}</h1>
        <span className="sub">
          {report.date} · {report.attendance.toLocaleString("en-US")} in a {report.capacity.toLocaleString("en-US")}-seat building
          {report.attendance >= report.capacity * 0.98 ? " · SOLD OUT" : ""}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {!doneAll && (
            <button className="primary" data-testid="live-next" onClick={() => setRevealed(revealed + 1)}>
              {revealed === 0 ? "Ring the bell" : "Next segment"}
            </button>
          )}
          <button data-testid="live-finish" onClick={() => { setRevealed(report.segments.length); go("postshow"); }}>
            {doneAll ? "To the review" : "Skip to the end"}
          </button>
        </span>
      </div>

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
        {report.segments.slice(0, revealed).map((seg, i) => (
          <div key={seg.segmentId} className={`card-slot ${i === revealed - 1 ? "selected" : ""}`}>
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
        ))}
        {revealed === 0 && <div className="empty">The house lights are down. Ring the bell.</div>}
      </div>
    </div>
  );
}
