import { useEffect, useRef } from "react";
import { A, AtlasRenderer, rgb, type AtlasTier } from "@kayfabe/atlas-renderer";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { useAtlas, semanticStateOf } from "./atlasStore";
import { markCameraTouched } from "./atlasUrl";
import { isReignKey } from "./layout/titleLayout";

/**
 * The ATLAS surface.
 *
 * Owns the renderer's lifetime, bridges the two stores into it, and translates
 * playback into the board's own vocabulary. It holds NO layout knowledge: the
 * scene arrives fully computed from the store, which is why switching semantic
 * state here is one call and not a re-mount.
 */

export function AtlasCanvas({ engine }: { engine: TimelineEngine }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<AtlasRenderer | null>(null);
  const scene = useAtlas((s) => s.scene);
  const controls = useAtlas((s) => s.controls);
  const fitToken = useAtlas((s) => s.fitToken);
  const flashId = useAtlas((s) => s.flashId);
  const reducedMotion = useStore((s) => s.reducedMotion);

  /* ---------- create / destroy ---------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = labelRef.current;
    if (!canvas || !host || rendererRef.current) return;
    const r = new AtlasRenderer(canvas, host);
    rendererRef.current = r;
    (window as { __kayfabeAtlas?: AtlasRenderer }).__kayfabeAtlas = r; // QA seam
    r.setReducedMotion(useStore.getState().reducedMotion);
    r.setLabelDensity(useAtlas.getState().controls.labels);
    r.cam.setTilt(useAtlas.getState().controls.tilted ? 1 : 0);

    r.onPick = (hit) => {
      const a = useAtlas.getState();
      const st = useStore.getState();
      if (!hit) {
        // Background click returns one hierarchy level rather than clearing
        // outright: in a hierarchy, "nothing" is the level above, not nothing.
        a.ascend();
        return;
      }
      if (isReignKey(hit.id)) {
        a.setReignFocus(hit.id);
        void a.rebuild();
        return;
      }
      a.setReignFocus(null);
      st.select({ kind: "node", id: hit.id });
    };
    r.onHover = (id) => {
      if (id && !isReignKey(id)) useStore.getState().hover(id);
      else useStore.getState().hover(null);
    };
    r.onLabelReport = (shown, wanted) => useAtlas.getState().setLabelReport(shown, wanted);
    r.onTierChange = (t: AtlasTier) => useAtlas.getState().setTier(t);
    r.onCameraChange = () => {
      const snap = r.cam.snapshot();
      useAtlas.getState().setCamera(snap);
    };
    r.cam.onChange = () => {
      markCameraTouched(true);
      useAtlas.getState().setCamera(r.cam.snapshot());
    };
    r.start();

    // Pinned lane names have to clear the floating controls rail. On a narrow
    // viewport that rail is a bottom sheet, so the board owns the left edge.
    const setInset = () => {
      r.labels.setPinInset(window.innerWidth > 820 ? 316 : 8);
    };
    setInset();

    const onResize = () => {
      r.resize();
      setInset();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.dispose();
      rendererRef.current = null;
      delete (window as { __kayfabeAtlas?: AtlasRenderer }).__kayfabeAtlas;
    };
  }, []);

  /* ---------- scene ---------- */
  const firstSceneRef = useRef(true);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !scene) return;
    r.setScene(scene);
    const pending = useAtlas.getState().pendingCamera;
    if (pending) {
      // A restored link pins the exact framing it was shared with.
      r.cam.restore(pending);
      useAtlas.setState({ pendingCamera: null });
      firstSceneRef.current = false;
      return;
    }
    if (firstSceneRef.current) {
      // The first overview frames the full time axis and the top of the board
      // rather than all 571 lanes at once, which at that scale is a texture
      // and not a reading. The minimap and R carry the whole thing.
      firstSceneRef.current = false;
      const b = scene.bounds;
      r.cam.restore({
        cx: (b.minX + b.maxX) / 2,
        cy: b.maxY - Math.min(320, (b.maxY - b.minY) / 2),
        half: Math.min(320, Math.max(60, (b.maxY - b.minY) / 2)),
      });
      markCameraTouched(false);
    } else {
      // Re-frame only when the semantic state actually changed; re-running a
      // fit on every control tweak fights the reader for the camera.
      const st = semanticStateOf(
        useStore.getState().selection?.kind === "node"
          ? (useStore.getState().selection as { id: string }).id
          : null,
      );
      if (st !== lastStateRef.current) {
        lastStateRef.current = st;
        r.cam.fit(scene.fitBounds ?? scene.bounds, 0.05, useStore.getState().reducedMotion ? 0 : 0.8);
        markCameraTouched(false);
      }
    }
  }, [scene]);
  const lastStateRef = useRef<string>("overview");

  /* ---------- emphasis ---------- */
  const selection = useStore((s) => s.selection);
  const hoverId = useStore((s) => s.hoverId);
  const pinned = useStore((s) => s.pinned);
  const members = useStore((s) => s.members);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.applyEmphasis({
      selected: selection?.kind === "node" ? selection.id : null,
      hovered: hoverId,
      members: members.ids,
      pinned,
    });
  }, [selection, hoverId, pinned, members]);

  /* ---------- controls ---------- */
  useEffect(() => {
    rendererRef.current?.setLabelDensity(controls.labels);
  }, [controls.labels]);
  useEffect(() => {
    rendererRef.current?.cam.setTilt(controls.tilted ? 1 : 0);
  }, [controls.tilted]);
  useEffect(() => {
    rendererRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);
  useEffect(() => {
    if (fitToken > 0) {
      rendererRef.current?.fitScene();
      markCameraTouched(false);
    }
  }, [fitToken]);
  useEffect(() => {
    if (!flashId) return;
    const r = rendererRef.current;
    if (!r) return;
    r.flash(flashId, 1.6);
    // Move the camera ONLY if the thing is off screen. A state change already
    // framed the new board with a fit; a focusEntity fired straight afterwards
    // replaced that flight mid-way and froze the zoom wherever it had got to,
    // which is what was collapsing the lineage into a band.
    const p = r.scene_?.anchors.get(flashId);
    if (p) {
      const v = r.cam.visibleRect();
      const inside = p[0] > v.x0 && p[0] < v.x1 && p[1] > v.y0 && p[1] < v.y1;
      if (!inside) r.focusEntity(flashId);
    }
    useAtlas.getState().flash(null);
  }, [flashId]);

  /* ---------- playback ---------- */
  // The engine's scope follows the selection, so playing with a promotion
  // selected replays THAT promotion's records and playing with a title
  // selected replays that title's. Registered as a listener, not by claiming
  // `onFire`, so the paused connectome keeps its own subscription.
  useEffect(() => {
    const off = engine.addListener((f) => {
      const r = rendererRef.current;
      const st = useStore.getState();
      if (!r || st.lens !== "atlas") return;
      const sc = r.scene_;
      if (!sc) return;
      const ev = f.ev;

      // The lane the record happened on lights up, whatever state we are in.
      r.flash(ev.pr, 0.6);
      if (ev.t) r.flash(ev.t, ev.tc ? 1.8 : 0.7);
      for (const p of [...ev.w, ...ev.l]) if (sc.anchors.has(p)) r.flash(p, 0.8);

      if (st.reducedMotion) return;
      // Deterministic sampling at speed, mirroring the connectome's rule, so a
      // four-year-per-second run stays a board rather than a smear.
      const mNum = Number(ev.m.slice(2));
      const sampled = st.timeline.speed < 365 || ev.tc === 1 || (Number.isFinite(mNum) ? mNum % 3 === 0 : true);
      if (!sampled) return;
      let emitted = 0;
      for (const p of f.pulses) {
        if (emitted >= 6) break;
        if (!sc.anchors.has(p.a) || !sc.anchors.has(p.b)) continue;
        const col =
          p.kind === "gold" ? rgb(A.gold) : p.kind === "same" ? rgb(A.same) : p.kind === "br" ? rgb(A.br) : rgb(A.opposed);
        r.pulseBetween(p.a, p.b, col);
        emitted++;
      }
      if (!emitted) {
        // Nothing in this scene holds both endpoints — in the overview that is
        // every record — so the event arrives ON its promotion's lane instead.
        const target = ev.t && sc.anchors.has(ev.t) ? ev.t : ev.pr;
        if (sc.anchors.has(target)) r.pulseAt(target, ev.tc ? rgb(A.gold) : rgb(A.same));
      }
    });
    return off;
  }, [engine]);

  /* ---------- playhead follows the clock ---------- */
  const timelineDay = useStore((s) => Math.floor(s.timeline.day / 30));
  const timelineMode = useStore((s) => s.timeline.mode);
  useEffect(() => {
    // Rebuilding the whole scene per frame would be absurd, so the playhead is
    // resampled monthly — enough for the line to travel smoothly at every
    // speed the UI offers, and cheap.
    void timelineDay;
    void timelineMode;
    void useAtlas.getState().rebuild();
  }, [timelineDay, timelineMode]);

  return (
    <>
      <canvas ref={canvasRef} className="atlas-gl" aria-hidden="true" data-testid="atlas-canvas" />
      <div ref={labelRef} className="atlas-labels" />
    </>
  );
}
