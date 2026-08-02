import { useEffect, useRef, useState } from "react";
import { fnv1a32 } from "@kayfabe/graph-contract";
import { RatingRenderer, type RatingsQaSeam } from "@kayfabe/ratings-renderer";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { markRatingsCameraTouched } from "./ratingsUrlState";
import { RatingsHoverCard } from "./RatingsHoverCard";
import { useRatings } from "./ratingsStore";

declare global {
  interface Window {
    __kayfabeRatings?: RatingRenderer & RatingsQaSeam;
  }
}

export function RatingsCanvas({ engine }: { engine: TimelineEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<RatingRenderer | null>(null);
  const lastMode = useRef<string | null>(null);
  const lastScope = useRef<string | null>(null);
  const data = useRatings((state) => state.data);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!data || !canvasRef.current || !labelsRef.current || rendererRef.current) return;
    let renderer: RatingRenderer;
    try {
      renderer = new RatingRenderer(canvasRef.current, labelsRef.current);
    } catch (error) {
      setRendererError(`MELTZER RIDGE could not create its WebGL context. ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    rendererRef.current = renderer;
    window.__kayfabeRatings = renderer as RatingRenderer & RatingsQaSeam;
    renderer.dataDecodeDurationMs = data.decodeDurationMs;
    renderer.setData(data.exactMatchIds);
    renderer.setReducedMotion(useStore.getState().reducedMotion);
    renderer.setThreshold(useRatings.getState().controls.threshold);
    renderer.setQualityOverride(useRatings.getState().qualityOverride);
    renderer.onPick = (hit) => handlePick(hit, renderer);
    renderer.onHover = (hit) => useRatings.getState().setHovered(hit);
    renderer.onHoverAnchor = (x, y, visible) => {
      const card = hoverCardRef.current;
      if (!card) return;
      card.style.setProperty("--rating-anchor-x", `${Math.round(x)}px`);
      card.style.setProperty("--rating-anchor-y", `${Math.round(y)}px`);
      card.dataset.visible = visible ? "true" : "false";
    };
    renderer.onLabelReport = (report) => useRatings.getState().setLabelReport(report.shown, report.wanted);
    renderer.onTierChange = (tier) => useRatings.getState().setTier(tier);
    renderer.onCameraChange = () => {
      markRatingsCameraTouched(true);
      useRatings.getState().setCamera(renderer.cam.snapshot(), true);
    };
    renderer.onContextState = (state) => setContextLost(state === "lost");
    applyViewport(renderer, useRatings.getState().sheet);
    const initial = useRatings.getState();
    if (initial.layout) {
      renderer.setLayout(initial.layout, true);
      renderer.layoutBuildDurationMs = initial.layoutBuildDurationMs;
      renderer.setCoverageStats({
        totalDocumented: initial.stats?.totalDocumentedMatches ?? 0,
        rated: initial.stats?.coverageRatedMatches ?? 0,
        coverage: initial.stats?.coverage ?? 0,
        visibleRailCells: initial.layout.coverage.length,
      });
      const restoredCamera = initial.pendingCamera ?? (initial.cameraTouched ? initial.camera : null);
      if (restoredCamera) {
        renderer.cam.restore(restoredCamera);
        useRatings.setState({ pendingCamera: null, camera: restoredCamera, cameraTouched: true });
      } else {
        renderer.fit(0);
        markRatingsCameraTouched(false);
      }
      lastMode.current = initial.layout.mode;
      lastScope.current = initial.layout.scopeId;
    }
    const initialTimeline = useStore.getState().timeline;
    renderer.setTimeDay(initialTimeline.mode === "off" ? null : initialTimeline.day);
    renderer.start();
    const resize = () => applyViewport(renderer, useRatings.getState().sheet);
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(canvasRef.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
      renderer.dispose();
      rendererRef.current = null;
      delete window.__kayfabeRatings;
    };
  }, [data, retry]);

  useEffect(() => useRatings.subscribe((state, previous) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (state.layout !== previous.layout && state.layout) {
      const adaptiveLaneBudgetChanged = previous.layout !== null &&
        state.layout.lanes.length !== previous.layout.lanes.length;
      renderer.setLayout(state.layout);
      renderer.layoutBuildDurationMs = state.layoutBuildDurationMs;
      renderer.setCoverageStats({
        totalDocumented: state.stats?.totalDocumentedMatches ?? 0,
        rated: state.stats?.coverageRatedMatches ?? 0,
        coverage: state.stats?.coverage ?? 0,
        visibleRailCells: state.layout.coverage.length,
      });
      const pending = state.pendingCamera;
      if (pending) {
        renderer.cam.restore(pending);
        useRatings.setState({ pendingCamera: null, camera: pending, cameraTouched: true });
      } else if (
        state.layout.mode !== lastMode.current ||
        state.layout.scopeId !== lastScope.current ||
        (adaptiveLaneBudgetChanged && !state.cameraTouched)
      ) {
        renderer.fit();
        markRatingsCameraTouched(false);
        useRatings.setState({ cameraTouched: false });
      }
      lastMode.current = state.layout.mode;
      lastScope.current = state.layout.scopeId;
    }
    if (state.selectedMatchId !== previous.selectedMatchId) renderer.setSelectedMatch(state.selectedMatchId);
    if (state.currentMatchId !== previous.currentMatchId) renderer.setCurrentMatch(state.currentMatchId);
    if (state.controls.threshold !== previous.controls.threshold) renderer.setThreshold(state.controls.threshold);
    if (state.controls.showTrend !== previous.controls.showTrend) renderer.setTrendVisible(state.controls.showTrend);
    if (state.qualityOverride !== previous.qualityOverride) renderer.setQualityOverride(state.qualityOverride);
    if (state.fitToken !== previous.fitToken) renderer.fitVisible();
    if (state.focusToken !== previous.focusToken) renderer.focusSelection();
    if (state.sheet !== previous.sheet) applyViewport(renderer, state.sheet);
  }), []);

  useEffect(() => useStore.subscribe((state, previous) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (state.reducedMotion !== previous.reducedMotion) renderer.setReducedMotion(state.reducedMotion);
    if (state.timeline.day !== previous.timeline.day || state.timeline.mode !== previous.timeline.mode) {
      renderer.setTimeDay(state.timeline.mode === "off" ? null : state.timeline.day);
    }
  }), []);

  useEffect(() => engine.addListener((fired) => {
    const shared = useStore.getState();
    if (shared.lens !== "ratings" || fired.ev.mr === undefined) return;
    const renderer = rendererRef.current;
    const ratings = useRatings.getState();
    const data = ratings.data;
    if (!renderer || !data || !data.exactIndexById.has(fired.ev.m)) return;
    const exactIndex = data.exactIndexById.get(fired.ev.m)!;
    // TimelineEngine owns the entity scope; the ratings mask additionally
    // owns rating/form/flag/date/coverage filters. Never resurrect a peak that
    // the current analytical view explicitly excludes.
    if (!ratings.scopeExactIndexSet.has(exactIndex)) return;
    ratings.setCurrentMatch(fired.ev.m);
    const highSpeed = shared.timeline.speed >= 365;
    if (highSpeed && fired.ev.tc !== 1 && fired.ev.mr < ratings.controls.threshold && fnv1a32(fired.ev.m) % 3 !== 0) return;
    const kind = fired.ev.tc === 1 ? "title-change" : fired.ev.mr >= ratings.controls.threshold ? "high" : fired.ev.ppv ? "ppv" : "ordinary";
    renderer.igniteMatch(fired.ev.m, kind);
  }), [engine]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let down: { x: number; y: number; pointerType: "mouse" | "pen" | "touch" } | null = null;
    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const pointerType = (event: PointerEvent): "mouse" | "pen" | "touch" => event.pointerType === "touch" ? "touch" : event.pointerType === "pen" ? "pen" : "mouse";
    const move = (event: PointerEvent) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const p = local(event);
      const type = pointerType(event);
      if (type === "touch") renderer.hover.setTouchActive(true);
      else {
        renderer.hover.setTouchActive(false);
        renderer.requestHoverPick(p.x, p.y, type);
      }
    };
    const pointerDown = (event: PointerEvent) => {
      const p = local(event);
      down = { ...p, pointerType: pointerType(event) };
      if (down.pointerType === "touch") rendererRef.current?.hover.setTouchActive(true);
    };
    const pointerUp = (event: PointerEvent) => {
      const renderer = rendererRef.current;
      if (!renderer || !down) return;
      const p = local(event);
      const moved = Math.hypot(p.x - down.x, p.y - down.y);
      const type = down.pointerType;
      down = null;
      if (moved > (type === "touch" ? 10 : 5) || renderer.cam.wasDrag()) return;
      const hit = renderer.pick(p.x, p.y, type);
      handlePick(hit, renderer);
    };
    const cancel = () => {
      down = null;
      rendererRef.current?.hover.clear("cancel");
    };
    const dbl = (event: MouseEvent) => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pick(event.clientX - rect.left, event.clientY - rect.top, "mouse");
      if (hit?.kind === "match") renderer.focusMatch(hit.id);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerdown", pointerDown);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("dblclick", dbl);
    return () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerdown", pointerDown);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("dblclick", dbl);
    };
  }, []);

  return (
    <div className="ratings-canvas-host" id="ratings-map-surface" role="region" aria-label="Meltzer Ratings three-dimensional ridgeline" aria-describedby="ratings-axis-description">
      <canvas
        ref={canvasRef}
        className="ratings-gl"
        aria-hidden="true"
        data-testid="ratings-canvas"
      />
      <div ref={labelsRef} className="ratings-labels" role="group" aria-label="Visible ratings labels" />
      <RatingsHoverCard
        ref={hoverCardRef}
        onEnter={(id) => rendererRef.current?.hover.enterSurface("card", id)}
        onLeave={(id) => rendererRef.current?.hover.leaveSurface("card", id)}
        onFocusRequested={(id) => rendererRef.current?.focusMatch(id)}
      />
      {contextLost && <div className="ratings-context-note" role="status">Graphics context paused. Reconstructing the deterministic ridge…</div>}
      {rendererError && (
        <div className="ratings-renderer-error" role="alert">
          <p>{rendererError}</p>
          <button type="button" onClick={() => { setRendererError(null); setRetry((value) => value + 1); }}>Retry renderer</button>
        </div>
      )}
    </div>
  );
}

function handlePick(hit: ReturnType<RatingRenderer["pick"]>, renderer: RatingRenderer): void {
  const ratings = useRatings.getState();
  if (!hit) {
    if (ratings.selectedMatchId) ratings.selectMatch(null);
    else if (ratings.scope.mode !== "promotions") ratings.returnGlobal();
    return;
  }
  if (hit.kind === "match") {
    ratings.selectMatch(hit.id);
    if (window.innerWidth <= 820) ratings.setSheet("inspector");
  } else if (hit.kind === "aggregate") {
    const bin = ratings.layout?.aggregates[hit.instanceId];
    if (!bin) return;
    useStore.getState().setFilters({ dayMin: bin.startDay, dayMax: bin.endDay });
    void ratings.rebuild().then(() => renderer.fitVisible());
  } else if (hit.kind === "promotion") {
    const id = hit.id.slice("promotion:".length);
    useStore.getState().select({ kind: "node", id });
  }
}

function applyViewport(renderer: RatingRenderer, sheet: ReturnType<typeof useRatings.getState>["sheet"]): void {
  renderer.resize();
  const mobile = window.innerWidth <= 820;
  const left = mobile ? 0 : document.getElementById("ratings-controls-panel")?.getBoundingClientRect().width ?? 0;
  const right = mobile ? 0 : document.getElementById("ratings-inspector-panel")?.getBoundingClientRect().width ?? 0;
  const activePanel = mobile && sheet !== "map"
    ? document.getElementById(sheet === "controls" ? "ratings-controls-panel" : "ratings-inspector-panel")
    : null;
  const bottom = activePanel?.getBoundingClientRect().height ?? 0;
  renderer.setInsets({ left, right, bottom, top: 0 });
}
