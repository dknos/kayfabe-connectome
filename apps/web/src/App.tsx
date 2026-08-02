import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectomeRenderer } from "@kayfabe/renderer";
import { dayToDate } from "@kayfabe/graph-contract";
import { restoreFromUrl, useStore } from "./state/store";
import { TimelineEngine } from "./timeline/TimelineEngine";
import { LeftPanel } from "./ui/LeftPanel";
import { RightPanel } from "./ui/RightPanel";
import { StageCanvas } from "./ui/StageCanvas";
import { TimelineBar } from "./ui/TimelineBar";
import { TopBar } from "./ui/TopBar";
import { GeoAnnouncer } from "./geo/GeoAnnouncer";
import { GeoControls } from "./geo/GeoControls";
import { GeoInspector } from "./geo/GeoInspector";
import { GeoLens } from "./geo/GeoLens";
import { GeoTimelineReadout } from "./geo/GeoTimelineReadout";
import { applyPendingGeoUrl, installGeoUrl } from "./geo/geoUrl";
import { scheduler, useGeo } from "./geo/geoStore";
import { MorphLab } from "./morph/MorphLab";
import { useMorph } from "./morph/morphStore";
import { applyPendingMorphUrl, installMorphUrl } from "./morph/morphUrl";
import { RatingsLab } from "./ratings/RatingsLab";
import { useRatings } from "./ratings/ratingsStore";
import { applyPendingRatingsUrl, installRatingsUrl } from "./ratings/ratingsUrl";

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
  // The semantic lenses own the scope while mounted and restore it on exit.
  const selection = useStore((s) => s.selection);
  useEffect(() => {
    if (lens === "morph" || lens === "ratings") return;
    const id = selection?.kind === "node" && selection.id.startsWith("p:") ? selection.id : null;
    engineRef.current.setParticipant(id);
  }, [selection, lens]);

  useEffect(() => {
    installGeoUrl();
    installMorphUrl();
    installRatingsUrl();
    void useStore.getState().boot();
    // Opening or pasting an old shared fragment into an already-running tab
    // is a same-document navigation, so boot does not run again. Restore it
    // here as well as at startup; replaceState writes do not emit hashchange.
    const onHashChange = (event: HashChangeEvent) => {
      // Read the immutable event URL: an outgoing lens may still have a
      // debounced replaceState queued when this same-document navigation fires.
      restoreFromUrl(new URL(event.newURL).hash);
      const activeLens = useStore.getState().lens;
      // Lens restorers stage their own namespaced state because cold links may
      // arrive before lazy data. If the lens is already mounted, consume that
      // state now as well; otherwise a second pasted Morph/Geo link would only
      // restore the shared selection and silently ignore its camera/scope.
      if (activeLens === "morph") void applyPendingMorphUrl();
      else if (activeLens === "geo") void applyPendingGeoUrl();
      else if (activeLens === "ratings") void applyPendingRatingsUrl();
      void useStore.getState().applyView();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // The geo projection loads only when the lens is first opened; a reader who
  // never opens GEO never pays for 16 MB of geographic data.
  const geoActive = lens === "geo";
  const geoSheet = useGeo((s) => s.sheet);
  const morphSheet = useMorph((s) => s.sheet);
  const ratingsSheet = useRatings((s) => s.sheet);
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
      if (e.key === " " && (st.lens === "connectome" || st.lens === "geo")) {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[aria-label="Play"], [aria-label="Pause"]')?.click();
      } else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
        e.preventDefault();
        st.back();
      } else if (e.key === "Escape") {
        if (st.selection) st.select(null);
        else if (st.focusId) st.focus(null);
      } else if (st.lens === "connectome" && e.key === "f" && st.selection?.kind === "node") {
        st.focus(st.selection.id);
      } else if (st.lens === "connectome" && e.key === "r") {
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
    const st = useStore.getState();
    if (!st.core) return;
    const yr = (d: number) => dayToDate(d).getUTCFullYear();
    let capture: string | null = null;
    let filename = "kayfabe-connectome.png";
    let metadata = "";
    if (st.lens === "ratings") {
      const ratings = useRatings.getState();
      capture = window.__kayfabeRatings?.screenshot() ?? null;
      filename = "meltzer-ridge.png";
      metadata = `MELTZER RATINGS · ${yr(st.filters.dayMin)}–${yr(st.filters.dayMax)} · ` +
        `${ratings.controls.filters.ratingMin}–${ratings.controls.filters.ratingMax} reported rating · ` +
        `${ratings.stats?.ratedMatches ?? 0} rated / ${(ratings.stats?.totalDocumentedMatches ?? 0).toLocaleString()} documented · ` +
        `${((ratings.stats?.coverage ?? 0) * 100).toFixed(1)}% coverage · ${ratings.scopeLabel}`;
    } else if (st.lens === "morph") {
      capture = (window as typeof window & { __kayfabeMorph?: { screenshot(): string } }).__kayfabeMorph?.screenshot() ?? null;
      filename = "kayfabe-morph-lab.png";
      metadata = `MORPH LAB · ${yr(st.filters.dayMin)}–${yr(st.filters.dayMax)} · ${st.selection?.kind === "node" ? st.selection.id : "global tissue"}`;
    } else if (st.lens === "geo") {
      capture = (window as typeof window & { __kayfabeGeo?: { screenshot(): string } }).__kayfabeGeo?.screenshot() ?? null;
      filename = "kayfabe-geo-replay.png";
      metadata = `GEO REPLAY · ${yr(st.filters.dayMin)}–${yr(st.filters.dayMax)} · local corpus geography`;
    } else {
      const renderer = rendererRef.current;
      if (!renderer) return;
      capture = renderer.screenshot();
      metadata = `KAYFABE CONNECTOME · ${yr(st.filters.dayMin)}–${yr(st.filters.dayMax)} · ` +
        `${st.view?.visibleNodeCount ?? 0} entities / ${st.view?.visible.length ?? 0} relationships · ` +
        `opposed=ember same-side=cyan title=gold · source: local corpus`;
    }
    if (!capture) {
      st.announce("The active lens is still preparing its screenshot surface.");
      return;
    }
    const image = new Image();
    image.onload = () => {
      const c = document.createElement("canvas");
      c.width = image.width;
      c.height = image.height + 44;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#04060b";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(image, 0, 0);
      ctx.fillStyle = "#8494ab";
      ctx.font = "12px ui-monospace, monospace";
      ctx.fillText(metadata, 12, image.height + 27, Math.max(1, c.width - 24));
      const a = document.createElement("a");
      a.download = filename;
      a.href = c.toDataURL("image/png");
      a.click();
      st.announce("Screenshot downloaded.");
    };
    image.src = capture;
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
          <button type="button" onClick={() => void useStore.getState().boot()}>Retry corpus load</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-lens={lens} data-geo-sheet={geoSheet} data-morph-sheet={morphSheet} data-ratings-sheet={ratingsSheet}>
      <TopBar onScreenshot={screenshot} />
      <main className="stage">
        {model && <StageCanvas engine={engineRef.current} onRenderer={onRenderer} onDropChange={onDropChange} />}
        {model && lens === "connectome" && (
          <LeftPanel shownEdges={edgeStats.shown} droppedEdges={edgeStats.dropped} tier={tier} />
        )}
        {model && lens === "connectome" && <RightPanel />}
        {model && lens === "morph" && <MorphLab engine={engineRef.current} />}
        {model && lens === "ratings" && <RatingsLab engine={engineRef.current} />}
        {model && lens === "geo" && <GeoLens />}
        {model && lens === "geo" && <GeoControls />}
        {model && lens === "geo" && <GeoInspector />}
        {model && lens === "geo" && <GeoAnnouncer />}
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
