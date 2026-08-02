import { useEffect, useRef, useState } from "react";
import { isoToDay } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
import type { TimelineEngine, TimelineScope } from "../timeline/TimelineEngine";
import { RatingsCanvas } from "./RatingsCanvas";
import { RatingsControls, ratingsAnnouncement } from "./RatingsControls";
import { RatingsInspector } from "./RatingsInspector";
import { RatingsLabels } from "./RatingsLabels";
import { applyPendingRatingsUrl } from "./ratingsUrl";
import { useRatings, type RatingsSheet } from "./ratingsStore";

/** Dedicated fourth lens; its renderer and 26 MB analytical projection boot lazily. */
export function RatingsLab({ engine }: { engine: TimelineEngine }) {
  const data = useRatings((state) => state.data);
  const loading = useRatings((state) => state.loading);
  const progress = useRatings((state) => state.progress);
  const loadingWhat = useRatings((state) => state.loadingWhat);
  const error = useRatings((state) => state.error);
  const sheet = useRatings((state) => state.sheet);
  const scope = useRatings((state) => state.scope);
  const layout = useRatings((state) => state.layout);
  const [ready, setReady] = useState(false);
  const previousScope = useRef<TimelineScope>(engine.currentScope);
  const previousRange = useRef<readonly [number, number] | null>(engine.currentRangeOverride);

  useEffect(() => {
    let cancelled = false;
    void useRatings.getState().boot()
      .then(() => applyPendingRatingsUrl())
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const selection = useStore((state) => state.selection);
  const selectedId = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    if (useRatings.getState().data) useRatings.getState().syncSharedSelection(selectedId);
  }, [selectedId, data]);

  const dayMin = useStore((state) => state.filters.dayMin);
  const dayMax = useStore((state) => state.filters.dayMax);
  useEffect(() => {
    if (useRatings.getState().data) void useRatings.getState().rebuild();
  }, [dayMin, dayMax]);

  useEffect(() => {
    previousScope.current = engine.currentScope;
    previousRange.current = engine.currentRangeOverride;
    return () => {
      engine.setScope(previousScope.current);
      engine.setRangeOverride(previousRange.current);
    };
  }, [engine]);

  useEffect(() => {
    const range = data?.manifest.date_ranges.rated;
    if (range) engine.setRangeOverride([isoToDay(range[0]), isoToDay(range[1])]);
  }, [data, engine]);

  useEffect(() => {
    if (scope.mode === "promotion" && scope.id) engine.setScope({ kind: "promotion", id: scope.id, ratedOnly: true });
    else if (scope.mode === "career" && scope.id) engine.setScope({ kind: "person", id: scope.id, ratedOnly: true });
    else if (scope.mode === "title" && scope.id) engine.setScope({ kind: "title", id: scope.id, ratedOnly: true });
    else engine.setScope({ kind: "ratings", ratedOnly: true });
  }, [engine, scope]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (useStore.getState().lens !== "ratings") return;
      const active = document.activeElement as HTMLElement | null;
      const editable = active?.closest("input, select, textarea, [contenteditable='true'], [role='textbox']");
      if (editable || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      const nativeControl = active?.closest("button, a, summary, [role='button'], [role='tab']");
      if (nativeControl) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const renderer = window.__kayfabeRatings;
        if (renderer?.hover.snapshot().id) renderer.hover.clear("cancel");
        else if (useRatings.getState().selectedMatchId) useRatings.getState().selectMatch(null);
        else if (useRatings.getState().scope.mode !== "promotions") useRatings.getState().returnGlobal();
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault(); event.stopImmediatePropagation(); useRatings.getState().requestFit();
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault(); event.stopImmediatePropagation(); useRatings.getState().requestFocus();
      } else if (event.key === "o" || event.key === "O") {
        event.preventDefault(); event.stopImmediatePropagation(); useRatings.getState().returnGlobal();
      } else if (event.key === " ") {
        event.preventDefault(); event.stopImmediatePropagation();
        document.querySelector<HTMLButtonElement>('[aria-label="Play"], [aria-label="Pause"]')?.click();
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault(); event.stopImmediatePropagation();
        document.querySelector<HTMLButtonElement>(event.key === "[" ? '[aria-label="Previous record"]' : '[aria-label="Next record"]')?.click();
      } else if (event.key === "1") {
        event.preventDefault(); event.stopImmediatePropagation(); useRatings.getState().returnGlobal();
      } else if (event.key === "2" && selectedId?.startsWith("p:")) {
        event.preventDefault(); event.stopImmediatePropagation(); useRatings.getState().setScope({ mode: "career", id: selectedId });
      } else if ((event.key === "c" || event.key === "C") && useRatings.getState().compareA && useRatings.getState().compareB) {
        event.preventDefault(); event.stopImmediatePropagation(); useRatings.getState().activateCompare();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedId]);

  const lastAnnouncement = useRef("");
  useEffect(() => {
    if (!layout) return;
    const message = ratingsAnnouncement();
    if (message !== lastAnnouncement.current) {
      lastAnnouncement.current = message;
      useStore.getState().announce(message);
    }
  }, [layout]);

  if (error) {
    return (
      <div className="boot ratings-boot">
        <div className="inner">
          <div className="ratings-boot-mark">MELTZER RIDGE</div>
          <p className="error-note" role="alert">{error}</p>
          <p>The ratings lens refuses unvalidated or corrupt projection bytes. Run <code>pnpm ratings:materialize</code> and <code>pnpm ratings:validate</code>, then retry.</p>
          <button type="button" onClick={() => { useRatings.setState({ data: null, error: null, loading: false }); void useRatings.getState().boot(); }}>Retry ratings projection</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {data && ready && layout ? <RatingsCanvas engine={engine} /> : null}
      <RatingsControls />
      <RatingsInspector />
      <RatingsLabels />
      <RatingsSheetTabs sheet={sheet} />
      {(loading || !data || !ready || !layout) && (
        <div className="boot ratings-boot" role="status">
          <div className="inner">
            <div className="ratings-boot-mark">MELTZER RIDGE</div>
            <p>Calibrating reported ratings against the canonical match ledger.</p>
            <div className="ratings-load-rule"><i style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="num">{loadingWhat || "preparing projection"} · {Math.round(progress * 100)}%</div>
          </div>
        </div>
      )}
    </>
  );
}

function RatingsSheetTabs({ sheet }: { sheet: RatingsSheet }) {
  const tabs: { key: RatingsSheet; label: string; controls: string }[] = [
    { key: "controls", label: "Layout", controls: "ratings-controls-panel" },
    { key: "inspector", label: "Details", controls: "ratings-inspector-panel" },
    { key: "map", label: "Map", controls: "ratings-map-surface" },
  ];
  const move = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length]!;
    useRatings.getState().setSheet(next.key);
    document.getElementById(`ratings-tab-${next.key}`)?.focus();
  };
  return (
    <div className="ratings-sheet-tabs mobile-only" role="tablist" aria-label="Meltzer Ratings panels">
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          id={`ratings-tab-${tab.key}`}
          type="button"
          role="tab"
          aria-selected={sheet === tab.key}
          aria-controls={tab.controls}
          tabIndex={sheet === tab.key ? 0 : -1}
          className={sheet === tab.key ? "active" : ""}
          onClick={() => useRatings.getState().setSheet(tab.key)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); move(index + 1); }
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") { event.preventDefault(); move(index - 1); }
            else if (event.key === "Home") { event.preventDefault(); move(0); }
            else if (event.key === "End") { event.preventDefault(); move(tabs.length - 1); }
          }}
        >{tab.label}</button>
      ))}
    </div>
  );
}
