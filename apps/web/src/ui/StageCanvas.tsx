import { useEffect, useRef } from "react";
import { ConnectomeRenderer, type ViewEdges } from "@kayfabe/renderer";
import { EF } from "../graph/model";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";

export function StageCanvas({
  engine,
  onRenderer,
  onDropChange,
}: {
  engine: TimelineEngine;
  onRenderer: (r: ConnectomeRenderer) => void;
  onDropChange: (dropped: number, shown: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ConnectomeRenderer | null>(null);
  const model = useStore((s) => s.model);
  const core = useStore((s) => s.core);

  // ---------- create / destroy ----------
  useEffect(() => {
    if (!model || !core || !canvasRef.current || rendererRef.current) return;
    const r = new ConnectomeRenderer(canvasRef.current, {
      count: model.nodes.count,
      pos: model.nodes.pos,
      type: model.nodes.type,
      community: model.nodes.community,
      degree: model.nodes.degree,
      firstDay: model.nodes.firstDay,
      lastDay: model.nodes.lastDay,
      communityCenters: core.communities.center,
      communitySizes: core.communities.size,
    });
    rendererRef.current = r;
    r.onDropChange = onDropChange;
    r.setReducedMotion(useStore.getState().reducedMotion);
    r.start();
    onRenderer(r);

    engine.onFire = (f) => {
      const st = useStore.getState();
      const idx = (id: string) => model.indexOfId.get(id);
      for (const id of f.ignite) {
        const i = idx(id);
        if (i !== undefined) r.igniteNode(i);
      }
      if (!st.reducedMotion) {
        for (const p of f.pulses) {
          const ia = idx(p.a);
          const ib = idx(p.b);
          if (ia !== undefined && ib !== undefined) r.pulseBetween(ia, ib, p.kind);
        }
      }
    };

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      engine.onFire = null;
      r.dispose();
      rendererRef.current = null;
    };
  }, [model, core, engine, onRenderer, onDropChange]);

  // ---------- store → renderer bridges ----------
  useEffect(() => {
    const unsubs = [
      useStore.subscribe((s, prev) => {
        const r = rendererRef.current;
        if (!r || !model) return;

        if (s.view !== prev.view && s.view) {
          const view = s.view;
          const wIndex = new Map<number, number>();
          view.visible.forEach((e, i) => wIndex.set(e, i));
          const adapter: ViewEdges = {
            edges: [...view.visible],
            a: (e) => model.edgeField(e, EF.a),
            b: (e) => model.edgeField(e, EF.b),
            weights: (e) => view.weights[wIndex.get(e)!] ?? { same: 0, opposed: 0, br: 0, title: 0 },
          };
          r.setView(adapter);
        }

        if (
          s.selection !== prev.selection ||
          s.hoverId !== prev.hoverId ||
          s.pathResult !== prev.pathResult ||
          s.pinned !== prev.pinned
        ) {
          const idx = (id: string | null) => (id ? (model.indexOfId.get(id) ?? null) : null);
          r.applyEmphasis({
            selectedNode: s.selection?.kind === "node" ? idx(s.selection.id) : null,
            selectedEdge: s.selection?.kind === "edge" ? s.selection.edge : null,
            hoverNode: idx(s.hoverId),
            pathNodes: (s.pathResult?.nodes ?? []).map((id) => idx(id)).filter((v): v is number => v !== null),
            pathEdges: s.pathResult?.edges ?? [],
            pinned: s.pinned.map((id) => idx(id)).filter((v): v is number => v !== null),
          });
        }

        if (s.focusId !== prev.focusId && s.focusId) {
          const i = model.indexOfId.get(s.focusId);
          if (i !== undefined) r.focusNode(i);
        }

        if (
          s.timeline.mode !== prev.timeline.mode ||
          Math.floor(s.timeline.day) !== Math.floor(prev.timeline.day) ||
          s.timeline.windowDays !== prev.timeline.windowDays
        ) {
          const m = s.timeline.mode;
          r.setTimeVisibility({
            mode: m === "off" || m === "playback" ? "off" : m,
            day: Math.floor(s.timeline.day),
            windowDays: s.timeline.windowDays,
          });
        }

        if (s.reducedMotion !== prev.reducedMotion) r.setReducedMotion(s.reducedMotion);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [model]);

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
        const m = useStore.getState().model;
        if (!r || !m) return;
        const rect = cv.getBoundingClientRect();
        const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
        useStore.getState().hover(hit?.kind === "node" ? (m.nodes.id[hit.index] ?? null) : null);
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
      const m = st.model;
      if (!r || !m) return;
      const rect = cv.getBoundingClientRect();
      const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (!hit) {
        st.select(null);
        return;
      }
      if (hit.kind === "edge") {
        st.select({ kind: "edge", edge: hit.index });
        return;
      }
      const id = m.nodes.id[hit.index]!;
      if (e.shiftKey && m.nodes.type[hit.index] === 0) {
        if (!st.pathA || (st.pathA && st.pathB)) {
          st.setPathEndpoint("a", id);
          st.setPathEndpoint("b", null);
        } else {
          st.setPathEndpoint("b", id);
          setTimeout(() => useStore.getState().runPath(), 0);
        }
        return;
      }
      st.select({ kind: "node", id });
    };
    const onDbl = (e: MouseEvent) => {
      const r = rendererRef.current;
      const st = useStore.getState();
      const m = st.model;
      if (!r || !m) return;
      const rect = cv.getBoundingClientRect();
      const hit = r.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (hit?.kind === "node") st.focus(m.nodes.id[hit.index]!);
    };
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("dblclick", onDbl);
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    return () => {
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("dblclick", onDbl);
    };
  }, [model]);

  // ---------- managed labels (imperative, capped, collision-suppressed) ----------
  useEffect(() => {
    const timer = setInterval(() => {
      const r = rendererRef.current;
      const st = useStore.getState();
      const m = st.model;
      const host = labelsRef.current;
      if (!r || !m || !host || st.lens !== "connectome") {
        if (host) host.replaceChildren();
        return;
      }
      const cap = r.governor.settings.labelCap;
      const wanted: { i: number; cls: string }[] = [];
      const seen = new Set<number>();
      const push = (id: string | null, cls: string) => {
        if (!id) return;
        const i = m.indexOfId.get(id);
        if (i === undefined || seen.has(i)) return;
        seen.add(i);
        wanted.push({ i, cls });
      };
      if (st.selection?.kind === "node") push(st.selection.id, "sel");
      push(st.hoverId, "sel");
      st.pathResult?.nodes.forEach((id) => push(id, ""));
      st.pinned.forEach((id) => push(id, ""));
      if (st.currentEvent) [...st.currentEvent.w, ...st.currentEvent.l].forEach((id) => push(id, ""));
      // promotion anchors then top-degree people
      const order: number[] = [];
      for (let i = 0; i < m.nodes.count; i++) if (m.nodes.type[i] === 1) order.push(i);
      const people: number[] = [];
      for (let i = 0; i < m.nodes.count; i++) if (m.nodes.type[i] === 0) people.push(i);
      people.sort((a, b) => m.nodes.degree[b]! - m.nodes.degree[a]!);
      for (const i of [...order, ...people.slice(0, 60)]) {
        if (wanted.length >= cap) break;
        if (!seen.has(i)) {
          seen.add(i);
          wanted.push({ i, cls: "dim" });
        }
      }

      const w = host.clientWidth;
      const h = host.clientHeight;
      const grid = new Set<string>();
      const frag = document.createDocumentFragment();
      for (const { i, cls } of wanted) {
        const p = r.project(i);
        if (!p.front || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
        const cell = `${Math.round(p.x / 92)}:${Math.round(p.y / 24)}`;
        if (grid.has(cell) && cls === "dim") continue;
        grid.add(cell);
        const div = document.createElement("div");
        div.className = `nlabel ${cls}`;
        div.style.left = `${p.x}px`;
        div.style.top = `${p.y}px`;
        div.textContent = m.nodes.name[i]!;
        if (m.nodes.resolution[i] === 1 && cls === "sel") {
          const flag = document.createElement("span");
          flag.className = "flag";
          flag.textContent = " ◦";
          flag.title = "probable identity (derived from side rows)";
          div.appendChild(flag);
        }
        frag.appendChild(div);
      }
      host.replaceChildren(frag);
    }, 140);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="gl" aria-hidden="true" />
      <div ref={labelsRef} className="labels" aria-hidden="true" />
    </>
  );
}
