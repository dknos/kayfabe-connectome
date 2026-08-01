import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectomeRenderer } from "@kayfabe/renderer";
import { useStore } from "./state/store";
import { TimelineEngine } from "./timeline/TimelineEngine";
import { LeftPanel } from "./ui/LeftPanel";
import { RightPanel } from "./ui/RightPanel";
import { StageCanvas } from "./ui/StageCanvas";
import { TableView } from "./ui/TableView";
import { TimelineBar } from "./ui/TimelineBar";
import { TopBar } from "./ui/TopBar";
import { GeoAnnouncer } from "./geo/GeoAnnouncer";
import { GeoControls } from "./geo/GeoControls";
import { GeoInspector } from "./geo/GeoInspector";
import { GeoLens } from "./geo/GeoLens";
import { GeoTable } from "./geo/GeoTable";
import { GeoTimelineReadout } from "./geo/GeoTimelineReadout";
import { applyPendingGeoUrl, installGeoUrl } from "./geo/geoUrl";
import { scheduler, useGeo } from "./geo/geoStore";
import { AtlasLens } from "./atlas/AtlasLens";
import { useAtlas } from "./atlas/atlasStore";
import { installAtlasUrl } from "./atlas/atlasUrl";

export function App() {
  const bootError = useStore((s) => s.bootError);
  const bootProgress = useStore((s) => s.bootProgress);
  const bootWhat = useStore((s) => s.bootWhat);
  const model = useStore((s) => s.model);
  const lens = useStore((s) => s.lens);
  const announcement = useStore((s) => s.announcement);
  const engineRef = useRef(new TimelineEngine());
  const rendererRef = useRef<ConnectomeRenderer | null>(null);
  const [edgeStats, setEdgeStats] = useState({ dropped: 0, shown: 0 });
  const [tier, setTier] = useState("high");

  // Playback follows the selection: choosing a wrestler and pressing play
  // replays that career.
  // The ATLAS lens owns the scope while it is mounted (a promotion lane and a
  // title lineage are scopes too), and restores this one on the way out.
  const selection = useStore((s) => s.selection);
  useEffect(() => {
    if (lens === "atlas") return;
    const id = selection?.kind === "node" && selection.id.startsWith("p:") ? selection.id : null;
    engineRef.current.setParticipant(id);
  }, [selection, lens]);

  useEffect(() => {
    installGeoUrl();
    installAtlasUrl();
    void useStore.getState().boot();
  }, []);

  // The geo projection loads only when the lens is first opened; a reader who
  // never opens GEO never pays for 16 MB of geographic data.
  const geoActive = lens === "geo" || lens === "geoTable";
  const geoSheet = useGeo((s) => s.sheet);
  const atlasSheet = useAtlas((s) => s.sheet);
  useEffect(() => {
    if (!geoActive) return;
    void useGeo.getState().boot().then(() => applyPendingGeoUrl());
  }, [geoActive]);

  // global keyboard map
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      const st = useStore.getState();
      if (e.key === " ") {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[aria-label="Play"], [aria-label="Pause"]')?.click();
      } else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
        e.preventDefault();
        st.back();
      } else if (e.key === "Escape") {
        if (st.selection) st.select(null);
        else if (st.focusId) st.focus(null);
      } else if (e.key === "f" && st.selection?.kind === "node") {
        st.focus(st.selection.id);
      } else if (e.key === "r") {
        rendererRef.current?.fitAll();
      } else if (st.lens === "geo" && (e.key === "f" || e.key === "F")) {
        const g = useGeo.getState();
        if (g.selectedPlace >= 0) (window as any).__kayfabeGeo?.focusPlace(g.selectedPlace);
      } else if (st.lens === "geo" && (e.key === "w" || e.key === "W")) {
        (window as any).__kayfabeGeo?.worldView();
      } else if (st.lens === "geo" && (e.key === "a" || e.key === "A")) {
        useGeo.getState().setShowArcs(!useGeo.getState().showArcs);
      } else if (st.lens === "geo" && (e.key === "h" || e.key === "H")) {
        const g = useGeo.getState();
        g.setAfterglow(g.afterglow === "none" ? "accumulate" : "none");
      } else if (st.lens === "geo" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const g = useGeo.getState();
        if (e.key === "ArrowRight") {
          const b = e.shiftKey ? scheduler?.stepBatch() : scheduler?.stepCard();
          if (b) (window as any).__kayfabeGeoEmit?.(b.intents);
        } else {
          scheduler?.seek(Math.max(0, g.cursor - (e.shiftKey ? 10 : 1)));
          g.syncFromScheduler();
        }
      } else if (e.key === "[") {
        document.querySelector<HTMLButtonElement>('[aria-label="Previous record"]')?.click();
      } else if (e.key === "]") {
        document.querySelector<HTMLButtonElement>('[aria-label="Next record"]')?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onRenderer = useCallback((r: ConnectomeRenderer) => {
    rendererRef.current = r;
    r.onTierChange = (t) => setTier(t);
  }, []);
  const onDropChange = useCallback((dropped: number, shown: number) => {
    setEdgeStats({ dropped, shown });
  }, []);

  const screenshot = useCallback(() => {
    const r = rendererRef.current;
    const st = useStore.getState();
    if (!r || !st.core) return;
    const src = new Image();
    src.onload = () => {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height + 44;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#04060b";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(src, 0, 0);
      ctx.fillStyle = "#8494ab";
      ctx.font = "12px ui-monospace, monospace";
      const yr = (d: number) => new Date(Date.UTC(1950, 0, 1) + d * 86400000).getUTCFullYear();
      ctx.fillText(
        `KAYFABE CONNECTOME · ${yr(st.filters.dayMin)}–${yr(st.filters.dayMax)} · ` +
          `${st.view?.visibleNodeCount ?? 0} entities / ${st.view?.visible.length ?? 0} relationships · ` +
          `opposed=ember same-side=cyan title=gold · source: local corpus`,
        12,
        src.height + 27,
      );
      const a = document.createElement("a");
      a.download = "kayfabe-connectome.png";
      a.href = c.toDataURL("image/png");
      a.click();
      st.announce("Screenshot downloaded.");
    };
    src.src = r.screenshot();
  }, []);

  if (bootError) {
    return (
      <div className="boot">
        <div className="inner">
          <div className="brand"><b>KAYFABE CONNECTOME</b></div>
          <p className="error-note" role="alert">{bootError}</p>
          <p className="micro">
            run `pnpm data:materialize` to build the graph, then reload. The renderer refuses
            fabricated placeholder data by design.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-lens={lens} data-geo-sheet={geoSheet} data-atlas-sheet={atlasSheet}>
      <TopBar onScreenshot={screenshot} />
      <main className="stage">
        {model && <StageCanvas engine={engineRef.current} onRenderer={onRenderer} onDropChange={onDropChange} />}
        {model && lens === "connectome" && (
          <LeftPanel shownEdges={edgeStats.shown} droppedEdges={edgeStats.dropped} tier={tier} />
        )}
        {model && lens === "connectome" && <RightPanel />}
        {model && lens === "atlas" && <AtlasLens engine={engineRef.current} />}
        {model && lens === "table" && <TableView />}
        {model && lens === "geo" && <GeoLens />}
        {model && lens === "geo" && <GeoControls />}
        {model && lens === "geo" && <GeoInspector />}
        {model && lens === "geo" && <GeoAnnouncer />}
        {model && lens === "geoTable" && <GeoTable />}
        {!model && (
          <div className="boot">
            <div className="inner">
              <div className="brand"><b>KAYFABE CONNECTOME</b> <span className="micro">loading archive</span></div>
              <div className="bar"><i style={{ width: `${bootProgress * 100}%` }} /></div>
              <div className="micro">{bootWhat}</div>
            </div>
          </div>
        )}
      </main>
      {model && lens === "geo" && <GeoTimelineReadout />}
      {model && lens !== "geo" && <TimelineBar engine={engineRef.current} />}
      <div aria-live="polite" className="visually-hidden">{announcement}</div>
    </div>
  );
}
