import { useEffect, useRef } from "react";
import { M, MorphRenderer, rgb } from "@kayfabe/morph-renderer";
import { pairKey } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { markMorphCameraTouched } from "./morphUrl";
import { useMorph } from "./morphStore";

/**
 * Owns the MorphRenderer. React renders exactly two hosts (canvas + label
 * layer) and never re-renders per frame — store subscriptions drive the
 * renderer imperatively, the same contract StageCanvas and AtlasCanvas obey.
 */
export function MorphCanvas({ engine }: { engine: TimelineEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MorphRenderer | null>(null);
  const lastModeRef = useRef<string | null>(null);
  const lastAnchorRef = useRef<string | null>(null);

  // ---------- create / destroy ----------
  // Keyed on `data`: boot resolves after the first mount, and an effect with
  // an empty dep list would wait forever for a corpus that already arrived.
  const morphData = useMorph((s) => s.data);
  useEffect(() => {
    const data = morphData;
    if (!canvasRef.current || !labelsRef.current || rendererRef.current || !data) return;
    const r = new MorphRenderer(canvasRef.current, labelsRef.current);
    rendererRef.current = r;
    (window as { __kayfabeMorph?: MorphRenderer }).__kayfabeMorph = r;
    r.setGraph(data.graph, (slot) => data.idOf(slot));
    r.setReducedMotion(useStore.getState().reducedMotion);

    r.onPick = (hit) => {
      if (!hit) return;
      useMorph.getState().leaveTissue();
      useStore.getState().select({ kind: "node", id: hit.id });
    };
    r.onHover = (id) => useStore.getState().hover(id);
    r.onLabelReport = (rep) => useMorph.getState().setLabelReport(rep.shown, rep.wanted);
    r.onTierChange = (t) => useMorph.getState().setTier(t);
    r.onCameraChange = () => {
      markMorphCameraTouched(true);
      useMorph.getState().setCamera(r.cam.snapshot());
    };

    // replay whatever layout existed before this subscription registered
    const s0 = useMorph.getState();
    if (s0.layout) {
      r.setLayout(s0.layout, true);
      const pending = s0.pendingCamera;
      if (pending) {
        r.cam.restore(pending);
        useMorph.setState({ pendingCamera: null });
      } else {
        r.fitLayout(0);
        markMorphCameraTouched(false);
      }
      lastModeRef.current = s0.layout.mode;
      lastAnchorRef.current = s0.layout.anchorId;
    }
    applyEmphasisFrom(r);
    r.start();

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.dispose();
      rendererRef.current = null;
      delete (window as { __kayfabeMorph?: MorphRenderer }).__kayfabeMorph;
    };
  }, [morphData]);

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
          r.fitLayout(0.85);
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
      if (s.building !== prev.building && !s.building) applyEmphasisFrom(r);
    });
    return unsub;
  }, []);

  // ---------- shared store → emphasis / reduced motion ----------
  useEffect(() => {
    const unsub = useStore.subscribe((s, prev) => {
      const r = rendererRef.current;
      if (!r) return;
      if (
        s.selection !== prev.selection ||
        s.hoverId !== prev.hoverId ||
        s.pinned !== prev.pinned ||
        s.pathResult !== prev.pathResult
      ) {
        applyEmphasisFrom(r);
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
        } else {
          const ia = idx(p.a);
          const ib = idx(p.b);
          if (ia !== undefined && ib !== undefined) {
            r.pulseBetween(ia, ib, color);
            emitted++;
          }
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
      if (hoverPending || e.buttons !== 0) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        const r = rendererRef.current;
        if (!r) return;
        const rect = cv.getBoundingClientRect();
        const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
        useStore.getState().hover(hit?.id ?? null);
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
      if (moved > 5) return; // drag = camera, not selection
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
        // open the full dossier: the connectome owns that reading
        st.select({ kind: "node", id: hit.id });
        st.setLens("connectome");
        if (useStore.getState().model?.indexOfId.has(hit.id)) st.focus(hit.id);
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
    const narrow = window.innerWidth <= 820;
    r.labels.setPinInset(narrow ? 8 : 316);
    r.cam.setBottomInset(narrow && sheet !== "hidden" ? Math.round(window.innerHeight * 0.42) : 0);
    if (narrow) r.fitLayout(0.4);
  }, [sheet, morphData]);

  return (
    <>
      <canvas ref={canvasRef} className="morph-gl" aria-hidden="true" data-testid="morph-canvas" />
      <div ref={labelsRef} className="morph-labels" aria-hidden="true" />
    </>
  );
}

function applyEmphasisFrom(r: MorphRenderer): void {
  const st = useStore.getState();
  const data = useMorph.getState().data;
  if (!data) return;
  const idx = (id: string | null): number => {
    if (!id) return -1;
    const i = data.indexOf(id);
    return i === undefined ? -1 : i;
  };
  const selId = st.selection?.kind === "node" ? st.selection.id : null;
  r.applyEmphasis({
    selected: idx(selId),
    hovered: idx(st.hoverId),
    selectedId: selId && idx(selId) < 0 ? selId : null,
    hoveredId: st.hoverId && idx(st.hoverId) < 0 ? st.hoverId : null,
    pinned: st.pinned.map(idx).filter((v) => v >= 0),
    pathNodes: (st.pathResult?.nodes ?? []).map(idx).filter((v) => v >= 0),
    dimBackground: !useMorph.getState().building,
  });
}
