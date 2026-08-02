import { useEffect, useRef, useState } from "react";
import { M, MorphRenderer, rgb } from "@kayfabe/morph-renderer";
import { pairKey } from "@kayfabe/graph-contract";
import { selectSemanticEmphasis, semanticEmphasisChanged } from "../graph/semanticEmphasis";
import { loadChampionships } from "../data/loader";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { markMorphCameraTouched } from "./morphUrl";
import { useMorph } from "./morphStore";

/**
 * Owns the MorphRenderer. React renders exactly two hosts (canvas + label
 * layer) and never re-renders per frame — store subscriptions drive the
 * renderer imperatively, the same contract StageCanvas obeys.
 */
export function MorphCanvas({ engine }: { engine: TimelineEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MorphRenderer | null>(null);
  const lastModeRef = useRef<string | null>(null);
  const lastAnchorRef = useRef<string | null>(null);
  const [rendererFailure, setRendererFailure] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const hoverRelatedRef = useRef<readonly string[]>([]);

  // ---------- create / destroy ----------
  // Keyed on `data`: boot resolves after the first mount, and an effect with
  // an empty dep list would wait forever for a corpus that already arrived.
  const morphData = useMorph((s) => s.data);
  useEffect(() => {
    const data = morphData;
    if (!canvasRef.current || !labelsRef.current || rendererRef.current || !data) return;
    let r: MorphRenderer;
    try {
      r = new MorphRenderer(canvasRef.current, labelsRef.current);
      setRendererFailure(null);
    } catch (error) {
      setRendererFailure(
        `Morph Lab could not create a WebGL renderer. ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    rendererRef.current = r;
    (window as { __kayfabeMorph?: MorphRenderer }).__kayfabeMorph = r;
    r.setGraph(data.graph, (slot) => data.idOf(slot));
    r.setReducedMotion(useStore.getState().reducedMotion);

    let hoverResolveToken = 0;
    r.onPick = (hit) => {
      if (!hit) return;
      hoverRelatedRef.current = [];
      useMorph.getState().leaveTissue();
      useStore.getState().select({ kind: "node", id: hit.id });
    };
    r.onHover = (id) => {
      const token = ++hoverResolveToken;
      hoverRelatedRef.current = [];
      const shared = useStore.getState();
      shared.hover(id);
      const selected = shared.selection?.kind === "node" ? shared.selection.id : null;
      const promotion = useMorph.getState().promotion;
      if (!id?.startsWith("t:") || !selected?.startsWith("pr:") || !promotion?.titles.some((t) => t.t === id)) return;
      void loadChampionships().then((records) => {
        const now = useStore.getState();
        if (
          token !== hoverResolveToken ||
          now.hoverId !== id ||
          now.selection?.kind !== "node" ||
          now.selection.id !== selected
        ) return;
        useMorph.setState({ championships: records });
        const population = new Set(now.members.ids);
        hoverRelatedRef.current = [...new Set((records[id]?.reigns ?? []).flatMap((reign) => reign.holders))]
          .filter((holder) => population.has(holder));
        applyEmphasisFrom(r, hoverRelatedRef.current);
      }).catch(() => {
        // Optional hover detail degrades to ordinary title hover; the cached
        // loader remains retryable on the next hover.
      });
    };
    r.labels.onAction = (id, action) => {
      const st = useStore.getState();
      if (action === "pin") st.togglePin(id);
      else if (action === "a") st.setPathEndpoint("a", st.pathA === id ? null : id);
      else if (action === "b") st.setPathEndpoint("b", st.pathB === id ? null : id);
      else {
        st.select({ kind: "node", id });
        st.setLens("connectome");
        if (st.model?.indexOfId.has(id)) st.focus(id);
      }
    };
    r.onLabelReport = (rep) => useMorph.getState().setLabelReport(rep.shown, rep.wanted);
    r.onTierChange = (t) => useMorph.getState().setTier(t);
    r.onCameraChange = () => {
      markMorphCameraTouched(true);
      useMorph.getState().setCamera(r.cam.snapshot());
    };
    r.onContextState = (state) => setContextLost(state === "lost");
    applyMorphViewport(r, useMorph.getState().sheet, false);

    // replay whatever layout existed before this subscription registered
    const s0 = useMorph.getState();
    if (s0.layout) {
      r.setLayout(s0.layout, true);
      const pending = s0.pendingCamera;
      if (pending) {
        r.cam.restore(pending);
        useMorph.setState({ pendingCamera: null });
      } else {
        r.fitLayout(0, true);
        markMorphCameraTouched(false);
      }
      lastModeRef.current = s0.layout.mode;
      lastAnchorRef.current = s0.layout.anchorId;
    }
    applyEmphasisFrom(r, hoverRelatedRef.current);
    r.start();

    let resizeFitTimer: number | null = null;
    const onResize = () => {
      // Resolution, label clipping and obstruction insets update immediately;
      // the trailing fit avoids restarting a camera flight on every pixel of
      // an interactive desktop resize while still handling rotation/crossing
      // the mobile breakpoint without requiring a sheet toggle.
      applyMorphViewport(r, useMorph.getState().sheet, false);
      if (resizeFitTimer !== null) window.clearTimeout(resizeFitTimer);
      resizeFitTimer = window.setTimeout(() => {
        resizeFitTimer = null;
        applyMorphViewport(r, useMorph.getState().sheet, true);
      }, 120);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (resizeFitTimer !== null) window.clearTimeout(resizeFitTimer);
      r.dispose();
      hoverResolveToken++;
      rendererRef.current = null;
      delete (window as { __kayfabeMorph?: MorphRenderer }).__kayfabeMorph;
    };
  }, [morphData, retryToken]);

  // ---------- layout → renderer ----------
  useEffect(() => {
    const unsub = useMorph.subscribe((s, prev) => {
      const r = rendererRef.current;
      if (!r) return;
      if (s.layout !== prev.layout && s.layout) {
        r.setLayout(s.layout);
        const pending = s.pendingCamera;
        if (pending) {
          r.cam.restore(pending);
          useMorph.setState({ pendingCamera: null });
          lastModeRef.current = s.layout.mode;
          lastAnchorRef.current = s.layout.anchorId;
          return;
        }
        // reframe on a semantic change, never on a control tweak
        if (s.layout.mode !== lastModeRef.current || s.layout.anchorId !== lastAnchorRef.current) {
          r.fitLayout(0.85, true);
          markMorphCameraTouched(false);
        }
        lastModeRef.current = s.layout.mode;
        lastAnchorRef.current = s.layout.anchorId;
      }
      if (s.fitToken !== prev.fitToken) {
        r.fitLayout(0.7);
        markMorphCameraTouched(false);
      }
      // re-derive emphasis once a rebuild lands: the dim was suspended while
      // roles belonged to the outgoing layout
      if (s.building !== prev.building && !s.building) applyEmphasisFrom(r, hoverRelatedRef.current);
    });
    return unsub;
  }, []);

  // ---------- shared store → emphasis / reduced motion ----------
  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      const r = rendererRef.current;
      if (!r) return;
      if (semanticEmphasisChanged(s, prev)) {
        if (s.selection !== prev.selection) hoverRelatedRef.current = [];
        applyEmphasisFrom(r, hoverRelatedRef.current);
      }
      if (s.reducedMotion !== prev.reducedMotion) r.setReducedMotion(s.reducedMotion);
    });
    return unsub;
  }, []);

  // ---------- playhead follows the timeline on time-axis modes ----------
  // Subscribed to BOTH stores: a new layout carries a new day→x mapping, and
  // a playhead cached against the old axis would strand at the previous
  // board's coordinates until the day crossed a month boundary.
  useEffect(() => {
    let lastMonth = -1;
    let lastAxis: object | undefined;
    const sync = () => {
      const r = rendererRef.current;
      if (!r) return;
      const s = useStore.getState();
      const axis = useMorph.getState().layout?.timeAxis;
      if (!axis || s.timeline.mode === "off") {
        if (lastMonth !== -1 || lastAxis) {
          r.setPlayhead(null);
          lastMonth = -1;
          lastAxis = undefined;
        }
        return;
      }
      const month = Math.floor(s.timeline.day / 30);
      if (month === lastMonth && axis === lastAxis) return;
      lastMonth = month;
      lastAxis = axis;
      const day = Math.max(axis.dayMin, Math.min(axis.dayMax, s.timeline.day));
      const x = axis.x0 + ((day - axis.dayMin) / Math.max(1, axis.dayMax - axis.dayMin)) * (axis.x1 - axis.x0);
      r.setPlayhead(x, axis.y0, axis.y1);
    };
    const u1 = useStore.subscribe(sync);
    const u2 = useMorph.subscribe(sync);
    return () => {
      u1();
      u2();
    };
  }, []);

  // ---------- timeline playback pulses ----------
  useEffect(() => {
    const unlisten = engine.addListener((f) => {
      const st = useStore.getState();
      if (st.lens !== "morph") return;
      const r = rendererRef.current;
      const data = useMorph.getState().data;
      if (!r || !data) return;
      const idx = (id: string) => data.indexOf(id);
      for (const id of f.ignite) {
        const i = idx(id);
        if (i !== undefined) r.igniteSlot(i);
      }
      if (st.reducedMotion) return;
      // deterministic sampling at high speed — same rule as the other lenses
      const mNum = Number(f.ev.m.slice(2));
      if (st.timeline.speed >= 365 && f.ev.tc !== 1 && (!Number.isFinite(mNum) || mNum % 3 !== 0)) return;
      let emitted = 0;
      for (const p of f.pulses) {
        if (emitted >= 6) break;
        const color =
          p.kind === "gold" ? rgb(M.gold) : p.kind === "same" ? rgb(M.same) : p.kind === "br" ? rgb(M.br) : rgb(M.opposed);
        const key = pairKey(p.a, p.b);
        if (r.pulseTrace(key, color)) {
          emitted++;
        }
      }
      if (f.ev.tc === 1 && f.ev.t) {
        const ti = idx(f.ev.t);
        if (ti !== undefined) r.pulseGoldAt(ti);
      }
    });
    return unlisten;
  }, [engine]);

  // ---------- pointer interaction ----------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    let hoverPending = false;
    const onMove = (e: PointerEvent) => {
      if (hoverPending || e.buttons !== 0 || rendererRef.current?.cam.isDragging) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        const r = rendererRef.current;
        if (!r) return;
        const rect = cv.getBoundingClientRect();
        const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
        r.onHover?.(hit?.id ?? null);
        cv.style.cursor = hit ? "pointer" : "default";
      });
    };
    let downAt: [number, number] | null = null;
    const onDown = (e: PointerEvent) => {
      downAt = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      downAt = null;
      if (moved > 5 || e.button !== 0) return; // drag/right-pan = camera, not selection
      const r = rendererRef.current;
      const st = useStore.getState();
      if (!r) return;
      const rect = cv.getBoundingClientRect();
      const slop = e.pointerType === "touch" ? 14 : 8;
      const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top, slop);
      if (!hit) {
        // background: one semantic level up, never a history wipe
        useMorph.getState().ascend();
        return;
      }
      if (e.shiftKey && hit.id.startsWith("p:")) {
        if (!st.pathA || (st.pathA && st.pathB)) {
          st.setPathEndpoint("a", hit.id);
          st.setPathEndpoint("b", null);
        } else {
          st.setPathEndpoint("b", hit.id);
          setTimeout(() => useStore.getState().runPath(), 0);
        }
        return;
      }
      useMorph.getState().leaveTissue();
      st.select({ kind: "node", id: hit.id });
    };
    const onDbl = (e: MouseEvent) => {
      const r = rendererRef.current;
      const st = useStore.getState();
      if (!r) return;
      const rect = cv.getBoundingClientRect();
      const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (hit) {
        // Double click is a Morph camera action; switching lenses is explicit.
        st.select({ kind: "node", id: hit.id });
        r.focusId(hit.id);
      }
    };
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("dblclick", onDbl);
    return () => {
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("dblclick", onDbl);
    };
  }, []);

  // ---------- mobile sheet insets ----------
  // keyed on morphData too: on cold entry the renderer is created AFTER this
  // effect's first run, and without the extra dep the insets never apply
  // until the user toggles the sheet
  const sheet = useMorph((s) => s.sheet);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    applyMorphViewport(r, sheet, window.innerWidth <= 820);
  }, [sheet, morphData]);

  return (
    <>
      <canvas ref={canvasRef} className="morph-gl" aria-hidden="true" data-testid="morph-canvas" />
      <div ref={labelsRef} className="morph-labels" aria-label="Interactive Morph Lab labels" />
      {rendererFailure && (
        <div className="boot morph-overlay morph-webgl-fallback" role="alert">
          <div className="inner">
            <b>3D renderer unavailable</b>
            <p className="micro">{rendererFailure}</p>
            <button type="button" onClick={() => setRetryToken((n) => n + 1)}>Retry renderer</button>
          </div>
        </div>
      )}
      {contextLost && !rendererFailure && (
        <div className="boot morph-overlay morph-context-lost" role="status">
          <div className="inner"><b>Graphics context lost</b><p className="micro">Waiting for the GPU context to restore…</p></div>
        </div>
      )}
    </>
  );
}

function applyMorphViewport(
  renderer: MorphRenderer,
  sheet: "controls" | "inspector" | "hidden",
  refit: boolean,
): void {
  renderer.resize();
  const narrow = window.innerWidth <= 820;
  renderer.labels.setPinInset(narrow ? 8 : 316);
  renderer.cam.setInsets({
    left: narrow ? 0 : 292,
    right: narrow ? 0 : 316,
    top: 0,
    bottom: narrow && sheet !== "hidden" ? Math.round(window.innerHeight * 0.42) : 0,
  });
  if (refit) {
    renderer.fitLayout(0.4);
    markMorphCameraTouched(false);
  }
}

function applyEmphasisFrom(r: MorphRenderer, hoverRelatedIds: readonly string[] = []): void {
  const st = useStore.getState();
  const semantic = selectSemanticEmphasis(st);
  const data = useMorph.getState().data;
  if (!data) return;
  const idx = (id: string | null): number => {
    if (!id) return -1;
    const i = data.indexOf(id);
    return i === undefined ? -1 : i;
  };
  const slotsAndVirtuals = (ids: readonly string[]) => {
    const slots: number[] = [];
    const virtuals: string[] = [];
    for (const id of ids) {
      const slot = idx(id);
      if (slot >= 0) slots.push(slot);
      else virtuals.push(id);
    }
    return { slots, virtuals };
  };
  const members = slotsAndVirtuals(semantic.members);
  const anchors = slotsAndVirtuals(semantic.anchors);
  const selId = semantic.selected;
  r.applyEmphasis({
    selected: idx(selId),
    hovered: idx(semantic.hovered),
    selectedId: selId && idx(selId) < 0 ? selId : null,
    hoveredId: semantic.hovered && idx(semantic.hovered) < 0 ? semantic.hovered : null,
    pinned: semantic.pinned.map(idx).filter((v) => v >= 0),
    pathNodes: semantic.pathNodes.map(idx).filter((v) => v >= 0),
    hoverMembers: hoverRelatedIds.map(idx).filter((v) => v >= 0),
    members: members.slots,
    anchors: anchors.slots,
    virtualMembers: members.virtuals,
    virtualAnchors: anchors.virtuals,
    memberGroup: semantic.memberGroup,
    basis: semantic.basis,
    caveat: semantic.caveat,
    coverageWarnings: semantic.coverageWarnings,
    dimBackground: semantic.isolate && !useMorph.getState().building,
  });
}
