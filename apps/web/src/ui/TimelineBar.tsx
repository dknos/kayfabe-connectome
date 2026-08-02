import { useEffect, useRef } from "react";
import { dayToDate } from "@kayfabe/graph-contract";
import { fmtDay, isoToDay, useStore, type TimelineMode } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { useRatings } from "../ratings/ratingsStore";

const MODES: { id: TimelineMode; label: string }[] = [
  { id: "off", label: "All history" },
  { id: "playback", label: "Playback" },
  { id: "accumulate", label: "Accumulation" },
  { id: "snapshot", label: "Snapshot" },
  { id: "window", label: "Sliding window" },
];

/** History Pulse — the seismograph of wrestling history. Single-series density
 * area (matches/year) with gold title-change ticks; scrub head = playback date. */
export function TimelineBar({ engine }: { engine: TimelineEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const core = useStore((s) => s.core);
  const model = useStore((s) => s.model);
  const timeline = useStore((s) => s.timeline);
  const currentEvent = useStore((s) => s.currentEvent);
  const setTimeline = useStore((s) => s.setTimeline);
  const pulseScope = useStore((s) => s.pulseScope);
  const lens = useStore((s) => s.lens);
  const ratingsData = useRatings((s) => s.data);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !core || !model) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const ratingsMode = lens === "ratings" && !!ratingsData?.histograms;
    const ratingsRange = ratingsData?.manifest.date_ranges.rated ?? ratingsData?.manifest.date_ranges.canonical;
    const years = ratingsMode
      ? inclusiveYears(ratingsRange!)
      : Object.keys(core.density.years).map(Number).sort((a, b) => a - b);
    if (!years.length) return;
    const y0 = years[0]!;
    const y1 = years[years.length - 1]!;
    const countAt = (year: number) => ratingsMode
      ? ratingsData!.histograms!.by_year[String(year)]?.rated ?? 0
      : core.density.years[String(year)]!.matches;
    const maxM = Math.max(1, ...years.map(countAt));
    const x = (year: number) => ((year - y0) / Math.max(1, y1 - y0)) * (w - 2) + 1;
    const bw = Math.max(1.5, (w - 2) / (y1 - y0 + 1) - 1);

    // density: sqrt scale keeps the 1960s visible next to the Attitude Era wall
    // When something is selected the corpus drops to a ghost and the selection
    // is drawn over it at its OWN scale — the reading is "when was this active",
    // and a career of 200 matches against a corpus peak of 20,000 would be a
    // flat line if both shared an axis.
    const scopeMax = pulseScope
      ? Math.max(1, ...Object.values(pulseScope.years))
      : 0;
    for (const y of years) {
      const d = core.density.years[String(y)];
      const hh = Math.sqrt(countAt(y) / maxM) * (h - 18);
      ctx.fillStyle = ratingsMode ? "rgba(193, 123, 67, 0.62)" : pulseScope ? "rgba(63, 211, 255, 0.09)" : "rgba(63, 211, 255, 0.34)";
      ctx.fillRect(x(y), h - 12 - hh, bw, hh);
      if (pulseScope && !ratingsMode) {
        const n = pulseScope.years[String(y)] ?? 0;
        if (n > 0) {
          const sh = Math.sqrt(n / scopeMax) * (h - 18);
          ctx.fillStyle = "rgba(255, 122, 69, 0.85)";
          ctx.fillRect(x(y), h - 12 - sh, bw, sh);
        }
      }
      if (!ratingsMode && !pulseScope && d && d.titleChanges > 0) {
        const th = Math.min(1, d.titleChanges / 40) * (h - 26) + 4;
        ctx.fillStyle = "rgba(255, 209, 102, 0.8)";
        ctx.fillRect(x(y) + bw / 2 - 0.5, h - 12 - th, 1, th);
      }
    }
    // decade ticks
    ctx.fillStyle = "rgba(90, 104, 128, 0.9)";
    ctx.font = "9px ui-monospace, monospace";
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) {
      ctx.fillRect(x(y), h - 10, 1, 3);
      ctx.fillText(String(y), x(y) - 12, h - 1);
    }
    // scrub head
    if (timeline.mode !== "off") {
      const headYear = dayToDate(timeline.day).getUTCFullYear() +
        dayToDate(timeline.day).getUTCMonth() / 12;
      const hx = x(headYear);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(hx, 2, 1.5, h - 14);
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(hx - 3, 2, 7, h - 14);
    }
  }, [core, model, timeline.day, timeline.mode, pulseScope, lens, ratingsData]);

  if (!core || !model) return <div className="pulsebar" />;

  const scrub = (clientX: number, el: HTMLCanvasElement) => {
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const years = lens === "ratings" && ratingsData?.histograms
      ? inclusiveYears(ratingsData.manifest.date_ranges.rated ?? ratingsData.manifest.date_ranges.canonical)
      : Object.keys(core.density.years).map(Number).sort((a, b) => a - b);
    const yearF = years[0]! + frac * (years[years.length - 1]! - years[0]!);
    const day = isoToDay(`${Math.floor(yearF)}-01-01`) + Math.round((yearF % 1) * 365);
    if (timeline.mode === "off") setTimeline({ mode: "accumulate", day });
    else setTimeline({ day });
    engine.scrubTo(day);
  };

  const play = () => {
    if (timeline.playing) {
      setTimeline({ playing: false });
      engine.stopLoop();
      return;
    }
    const mode = timeline.mode === "off" ? "playback" : timeline.mode;
    // at the end of history there is nothing left to fire — restart from the range start
    const [rangeMin, rangeMax] = engine.activeDayRange;
    const day = timeline.day >= rangeMax - 1 || timeline.day < rangeMin ? rangeMin : timeline.day;
    setTimeline({ playing: true, mode, day });
    engine.scrubTo(day);
    const y = dayToDate(day).getUTCFullYear();
    void engine.ensureRange(y - 1, Math.min(2026, y + 3)).then(() => engine.play());
  };

  const step = (dir: 1 | -1) => {
    const y = dayToDate(timeline.day).getUTCFullYear();
    void engine.ensureRange(y - 1, Math.min(2026, y + 1)).then(() => {
      const day = engine.step(dir);
      if (day !== null) setTimeline({ day, mode: timeline.mode === "off" ? "playback" : timeline.mode });
    });
  };

  return (
    <div className="pulsebar" role="group" aria-label="History Pulse timeline">
      <div className="pulse-controls">
        <select
          aria-label="Timeline mode"
          value={timeline.mode}
          onChange={(e) => {
            const mode = e.target.value as TimelineMode;
            setTimeline({ mode, playing: false });
            engine.stopLoop();
          }}
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button onClick={() => step(-1)} aria-label="Previous record" title="Previous record [">⏮</button>
        <button onClick={play} aria-label={timeline.playing ? "Pause" : "Play"} className={timeline.playing ? "active" : ""}>
          {timeline.playing ? "⏸" : "▶"}
        </button>
        <button onClick={() => step(1)} aria-label="Next record" title="Next record ]">⏭</button>
        <select
          aria-label="Playback speed"
          value={timeline.speed}
          onChange={(e) => setTimeline({ speed: Number(e.target.value) })}
        >
          <option value={30}>30 d/s</option>
          <option value={120}>120 d/s</option>
          <option value={365}>1 y/s</option>
          <option value={1460}>4 y/s</option>
        </select>
        {timeline.mode === "window" && (
          <select
            aria-label="Window size"
            value={timeline.windowDays}
            onChange={(e) => setTimeline({ windowDays: Number(e.target.value) })}
          >
            <option value={90}>90 d</option>
            <option value={365}>1 y</option>
            <option value={1825}>5 y</option>
          </select>
        )}
      </div>
      <div className="pulse-canvas-wrap">
        <canvas
          ref={canvasRef}
          aria-label={lens === "ratings" ? "Rated-match density per year. Click to scrub the reported-rating timeline." : "Match density per year; gold ticks mark championship changes. Click to scrub."}
          role="slider"
          aria-valuetext={fmtDay(timeline.day)}
          tabIndex={0}
          onPointerDown={(e) => {
            (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
            scrub(e.clientX, e.currentTarget);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) scrub(e.clientX, e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setTimeline({ day: timeline.day + 30 });
            if (e.key === "ArrowLeft") setTimeline({ day: timeline.day - 30 });
          }}
        />
      </div>
      <div className="pulse-readout">
        {pulseScope && (
          <div className="pulse-scope micro" data-testid="pulse-scope">
            {pulseScope.label} · career
          </div>
        )}
        <div className="date">{timeline.mode === "off" ? (lens === "ratings" && ratingsData ? formatRatingsRange(ratingsData.manifest.date_ranges.rated, ratingsData.manifest.date_ranges.canonical) : `${core.manifest.date_range[0]} → ${core.manifest.date_range[1]}`) : fmtDay(timeline.day)}</div>
        <div className="evt" aria-live="off">
          {timeline.mode === "off"
            ? lens === "ratings" ? "reported-rating timeline · missing is not zero" : "full corpus"
            : currentEvent
              ? `${currentEvent.en} · ${currentEvent.res}${currentEvent.tc ? " · TITLE CHANGE" : ""}`
              : "—"}
        </div>
      </div>
    </div>
  );
}

function inclusiveYears(range: readonly [string, string]): number[] {
  const first = Number(range[0].slice(0, 4));
  const last = Number(range[1].slice(0, 4));
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

function formatRatingsRange(rated: readonly [string, string] | null, canonical: readonly [string, string]): string {
  return rated ? `${rated[0]} → ${rated[1]}` : `${canonical[0]} → ${canonical[1]} · no reported ratings`;
}
