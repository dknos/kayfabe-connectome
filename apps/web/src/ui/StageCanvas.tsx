import { useEffect, useRef, useState } from "react";
import { dayToDate } from "@kayfabe/graph-contract";
import { ConnectomeRenderer, type ViewEdges } from "@kayfabe/renderer";
import { EF, type FilteredView, type GraphModel } from "../graph/model";
import { selectSemanticEmphasis, semanticEmphasisChanged } from "../graph/semanticEmphasis";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";

/**
 * The map tier: the twelve heaviest promotion anchors then the highest-degree
 * people, computed ONCE per corpus.
 *
 * All 165 anchors would eat the whole label budget, and neither ranking
 * changes — re-sorting 30,000 nodes on the 140 ms label cadence (which is what
 * this replaced) was pure waste.
 */
function makeMapTier(): (m: GraphModel) => number[] {
  let key: GraphModel | null = null;
  let val: number[] = [];
  return (m: GraphModel): number[] => {
    if (m === key) return val;
    const promos: number[] = [];
    const people: number[] = [];
    for (let i = 0; i < m.nodes.count; i++) {
      if (m.nodes.type[i] === 1) promos.push(i);
      else if (m.nodes.type[i] === 0) people.push(i);
    }
    promos.sort((a, b) => m.nodes.matches[b]! - m.nodes.matches[a]! || a - b);
    people.sort((a, b) => m.nodes.degree[b]! - m.nodes.degree[a]! || a - b);
    key = m;
    val = [...promos.slice(0, 12), ...people.slice(0, 60)];
    return val;
  };
}

function buildAdapter(model: GraphModel, view: FilteredView): ViewEdges {
  const wIndex = new Map<number, number>();
  view.visible.forEach((e, i) => wIndex.set(e, i));
  return {
    edges: [...view.visible],
    a: (e) => model.edgeField(e, EF.a),
    b: (e) => model.edgeField(e, EF.b),
    weights: (e) => view.weights[wIndex.get(e)!] ?? { same: 0, opposed: 0, br: 0, title: 0 },
  };
}

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
  const [rendererFailure, setRendererFailure] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const model = useStore((s) => s.model);
  const core = useStore((s) => s.core);

  // ---------- create / destroy ----------
  useEffect(() => {
    if (!model || !core || !canvasRef.current || rendererRef.current) return;
    let r: ConnectomeRenderer;
    try {
      r = new ConnectomeRenderer(canvasRef.current, {
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
      setRendererFailure(null);
    } catch (error) {
      setRendererFailure(
        `Connectome could not create a WebGL renderer. ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    rendererRef.current = r;
    (window as { __kayfabeRenderer?: ConnectomeRenderer }).__kayfabeRenderer = r; // QA instrumentation
    r.onDropChange = onDropChange;
    r.setReducedMotion(useStore.getState().reducedMotion);
    r.setTissue(useStore.getState().tissue);
    r.setHazeVisible(useStore.getState().showHaze);
    r.start();
    onRenderer(r);

    const unlisten = engine.addListener((f) => {
      const st = useStore.getState();
      // A paused connectome must not process pulses for a lens that is not on
      // screen: the work is invisible and the ignite decay keeps a rAF-free
      // renderer's arrays hot for nothing.
      if (st.lens !== "connectome") return;
      const idx = (id: string) => model.indexOfId.get(id);
      for (const id of f.ignite) {
        const i = idx(id);
        if (i !== undefined) r.igniteNode(i);
      }
      if (!st.reducedMotion) {
        // At high playback speeds, sample non-title events (deterministically by
        // match id) so the pulse field stays legible instead of saturating.
        const mNum = Number(f.ev.m.slice(2));
        const sampled = st.timeline.speed < 365 || f.ev.tc === 1 || mNum % 3 === 0;
        if (sampled) {
          for (const p of f.pulses) {
            const ia = idx(p.a);
            const ib = idx(p.b);
            if (ia !== undefined && ib !== undefined) r.pulseBetween(ia, ib, p.kind);
          }
        }
      }
    });

    // Push whatever state existed BEFORE this subscription registered — the boot
    // sequence computes the first view synchronously, so without this the
    // renderer would wait forever for a change that already happened.
    const s0 = useStore.getState();
    if (s0.view) r.setView(buildAdapter(model, s0.view));
    const semantic0 = selectSemanticEmphasis(s0);
    const idx0 = (id: string | null) => (id ? (model.indexOfId.get(id) ?? null) : null);
    r.applyEmphasis({
      selectedNode: idx0(semantic0.selected),
      selectedEdge: s0.selection?.kind === "edge" ? s0.selection.edge : null,
      hoverNode: idx0(semantic0.hovered),
      pathNodes: semantic0.pathNodes.map(idx0).filter((v): v is number => v !== null),
      pathEdges: s0.pathResult?.edges ?? [],
      pinned: semantic0.pinned.map(idx0).filter((v): v is number => v !== null),
      members: semantic0.members.map(idx0).filter((v): v is number => v !== null),
    });
    if (s0.timeline.mode !== "off" && s0.timeline.mode !== "playback") {
      r.setTimeVisibility({
        mode: s0.timeline.mode,
        day: Math.floor(s0.timeline.day),
        windowDays: s0.timeline.windowDays,
      });
    }
    if (s0.focusId) {
      const i = model.indexOfId.get(s0.focusId);
      if (i !== undefined) r.focusNode(i);
    }

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      unlisten();
      r.dispose();
      rendererRef.current = null;
      delete (window as { __kayfabeRenderer?: ConnectomeRenderer }).__kayfabeRenderer;
    };
  }, [model, core, engine, onRenderer, onDropChange, retryToken]);

  // ---------- lens lifecycle ----------
  // The connectome stays MOUNTED under every lens so its camera framing and
  // GPU buffers survive the round trip; only the frame loop is suspended.
  // Switching Connectome -> another lens -> Connectome must therefore restore the
  // previous framing rather than performing an unexpected fit-all.
  const lens = useStore((s) => s.lens);
  useEffect(() => {
    rendererRef.current?.setActive(lens === "connectome");
  }, [lens]);

  // ---------- store → renderer bridges ----------
  useEffect(() => {
    const unsubs = [
      useStore.subscribe((s, prev) => {
        const r = rendererRef.current;
        if (!r || !model) return;

        if (s.view !== prev.view && s.view) {
          r.setView(buildAdapter(model, s.view));
        }

        if (semanticEmphasisChanged(s, prev)) {
          const semantic = selectSemanticEmphasis(s);
          const idx = (id: string | null) => (id ? (model.indexOfId.get(id) ?? null) : null);
          r.applyEmphasis({
            selectedNode: idx(semantic.selected),
            selectedEdge: s.selection?.kind === "edge" ? s.selection.edge : null,
            hoverNode: idx(semantic.hovered),
            pathNodes: semantic.pathNodes.map((id) => idx(id)).filter((v): v is number => v !== null),
            pathEdges: s.pathResult?.edges ?? [],
            pinned: semantic.pinned.map((id) => idx(id)).filter((v): v is number => v !== null),
            members: semantic.members.map((id) => idx(id)).filter((v): v is number => v !== null),
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

  // ---------- isolate to the selected relation ----------
  /** The ids currently isolated, read by the label builder so an isolated
   * selection names every node it leaves on screen. */
  const isolateIdsRef = useRef<string[] | null>(null);
  const members = useStore((s) => s.members);
  const memberGroup = useStore((s) => s.memberGroup);
  const isolate = useStore((s) => s.isolate);
  const selection = useStore((s) => s.selection);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !model) return;
    const selId = selection?.kind === "node" ? selection.id : null;
    const group = members.groups?.find((g) => g.key === memberGroup);
    // Anchors ride along with every category: seeing WWE and the belts beside a
    // wrestler's opponents is what makes the set legible as a career.
    const ids = [...new Set([...(group ? group.ids : members.ids), ...(members.anchors ?? [])])];
    if (!isolate || !selId || !ids.length) {
      r.setIsolate(null);
      isolateIdsRef.current = null;
      return;
    }
    isolateIdsRef.current = [selId, ...ids];
    // The selection itself stays visible — isolating a wrestler and then
    // hiding the wrestler would be a strange reading.
    const idx = [selId, ...ids]
      .map((id) => model.indexOfId.get(id))
      .filter((v): v is number => v !== undefined);
    r.setIsolate(idx);
  }, [model, members, memberGroup, isolate, selection]);

  // ---------- tissue treatment ----------
  const tissue = useStore((s) => s.tissue);
  const showHaze = useStore((s) => s.showHaze);
  const showLabels = useStore((s) => s.showLabels);
  useEffect(() => {
    rendererRef.current?.setTissue(tissue);
  }, [tissue]);
  useEffect(() => {
    rendererRef.current?.setHazeVisible(showHaze);
  }, [showHaze]);
  useEffect(() => {
    const host = labelsRef.current;
    if (host) host.style.display = showLabels ? "" : "none";
  }, [showLabels]);

  // ---------- managed labels (imperative, capped, collision-suppressed) ----------
  // The label layer is rebuilt on an interval, which would destroy hover state
  // seven times a second — so the hovered node is held in a ref and its contact
  // strip is re-attached on every rebuild.
  const probeRef = useRef<number | null>(null);
  const labelEls = useRef(new Map<number, HTMLDivElement>());
  const mapTierRef = useRef(makeMapTier());
  useEffect(() => {
    /** The documented relationship between the current selection and one other
     * node, in the fiber palette's own terms. Hovering a name while someone is
     * selected is a question about the CONNECTION, not about the node. */
    const relationLine = (other: number): HTMLElement | null => {
      const st = useStore.getState();
      const m = st.model;
      if (!m || st.selection?.kind !== "node") return null;
      const selIdx = m.indexOfId.get(st.selection.id);
      if (selIdx === undefined || selIdx === other) return null;

      const line = document.createElement("div");
      line.className = "nprobe-rel";
      const hit = m.neighbors(selIdx).find((n) => n.node === other);
      if (!hit) {
        const none = document.createElement("span");
        none.className = "rel-none";
        none.textContent = "no documented match";
        line.appendChild(none);
        return line;
      }
      const f = (k: number) => m.edgeField(hit.edge, k);
      const part = (cls: string, label: string, n: number) => {
        if (n <= 0) return;
        const el = document.createElement("span");
        el.className = `rel-${cls}`;
        el.textContent = `${label} ×${n}`;
        line.appendChild(el);
      };
      part("opposed", "opp", f(EF.opposed));
      part("same", "tag", f(EF.same));
      part("br", "br", f(EF.br));
      part("title", "title", f(EF.title));
      const y = (d: number) => dayToDate(d).getUTCFullYear();
      const span = document.createElement("span");
      span.className = "rel-span";
      const a = y(f(EF.firstDay));
      const b = y(f(EF.lastDay));
      span.textContent = a === b ? `${a}` : `${a}–${b}`;
      line.appendChild(span);
      return line;
    };

    const buildProbe = (i: number, id: string): HTMLElement => {
      const strip = document.createElement("div");
      strip.className = "nprobe";
      const rel = relationLine(i);
      if (rel) strip.appendChild(rel);
      const pads = document.createElement("div");
      pads.className = "nprobe-pads";
      strip.appendChild(pads);
      // A pad reflects live state: pinning a wrestler has to light the PIN pad
      // while the cursor is still on it, without rebuilding the element the
      // cursor is resting on.
      const syncs: Array<() => void> = [];
      const pad = (
        text: string,
        title: string,
        isOn: () => boolean,
        run: () => void,
      ) => {
        const b = document.createElement("button");
        const paint = () => {
          const on = isOn();
          b.classList.toggle("on", on);
          b.setAttribute("aria-pressed", String(on));
        };
        syncs.push(paint);
        b.className = "nprobe-pad";
        b.textContent = text;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.onmousedown = (e) => e.stopPropagation();
        b.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          run();
          paint();
        };
        paint();
        pads.appendChild(b);
      };
      const name = useStore.getState().model!.nodes.name[i]!;
      pad("PIN", `Pin ${name}`, () => useStore.getState().pinned.includes(id), () =>
        useStore.getState().togglePin(id),
      );
      pad("A", "Lock as path A", () => useStore.getState().pathA === id, () =>
        useStore.getState().setPathEndpoint("a", useStore.getState().pathA === id ? null : id),
      );
      pad("B", "Lock as path B", () => useStore.getState().pathB === id, () =>
        useStore.getState().setPathEndpoint("b", useStore.getState().pathB === id ? null : id),
      );
      pad("OPEN", "Open dossier", () => false, () => {
        useStore.getState().select({ kind: "node", id });
        useStore.getState().focus(id);
      });
      (strip as HTMLElement & { _sync?: () => void })._sync = () => {
        syncs.forEach((f) => f());
        const next = relationLine(i);
        const current = strip.querySelector(".nprobe-rel");
        if (next && current) current.replaceWith(next);
        else if (next && !current) strip.prepend(next);
        else if (!next && current) current.remove();
      };
      return strip;
    };

    const timer = setInterval(() => {
      const r = rendererRef.current;
      const st = useStore.getState();
      const m = st.model;
      const host = labelsRef.current;
      if (!r || !m || !host || st.lens !== "connectome") {
        if (host) host.replaceChildren();
        labelEls.current.clear();
        return;
      }
      // Isolating a selection is a request to READ it, so every node still on
      // screen gets its name. The cap exists to stop 30,000 labels; an isolated
      // set is bounded by construction.
      // A selection makes the label layer answer ONE question: who is
      // connected to this node. The ambient tier — top promotion anchors and
      // top-degree people — is the answer to a different question, so Liger,
      // Janela and Ultimo Dragon leave the screen unless they are part of the
      // connection. The cap exists to stop 30,000 labels; a connection set is
      // bounded by construction.
      const selected = st.selection?.kind === "node" ? st.selection.id : null;
      const connection = selected
        ? [selected,
           ...(st.members.groups?.find((g) => g.key === st.memberGroup)?.ids ?? st.members.ids),
           ...(st.members.anchors ?? [])]
        : null;
      const isoIds = isolateIdsRef.current ?? connection;
      const cap = isoIds ? isoIds.length + 4 : r.governor.settings.labelCap;
      const wanted: { i: number; cls: string; t: number }[] = [];
      const seen = new Set<number>();
      const push = (id: string | null, cls: string) => {
        if (!id) return;
        const i = m.indexOfId.get(id);
        if (i === undefined || seen.has(i)) return;
        seen.add(i);
        wanted.push({ i, cls, t: 1 });
      };
      if (st.selection?.kind === "node") push(st.selection.id, "sel");
      push(st.hoverId, "sel");
      st.pathResult?.nodes.forEach((id) => push(id, ""));
      st.pinned.forEach((id) => push(id, ""));
      if (st.currentEvent) [...st.currentEvent.w, ...st.currentEvent.l].forEach((id) => push(id, ""));
      if (isoIds) {
        for (const id of isoIds) push(id, "iso");
      } else {
        // Ambient tier, in two parts.
        //
        // 1. The map tier: the largest promotion anchors and the highest-degree
        //    people. Fixed, and what makes the fit-all view readable as a map
        //    rather than a nebula. The ranking never changes, so it is computed
        //    once per corpus instead of re-sorting 30,000 nodes seven times a
        //    second, which is what this replaced.
        for (const i of mapTierRef.current(m)) {
          if (wanted.length >= cap) break;
          if (seen.has(i)) continue;
          seen.add(i);
          wanted.push({ i, cls: "dim", t: 1 });
        }
        // 2. The proximity tier: whatever the camera is actually among.
        //
        //    An ABSOLUTE reveal radius, because "light up as I get closer" is a
        //    claim about distance, not about rank. At the default framing the
        //    camera sits 1.8 units off the near surface of a corpus 1 unit in
        //    radius, so nothing qualifies and the view is exactly the map tier
        //    it has always been. Fly or zoom in and names resolve out of the
        //    tissue as they enter the shell, brightest nearest.
        const reveal = Math.min(1.25, Math.max(0.26, 0.6 * r.cameraDistance));
        const budget = cap + 60;
        for (const { i, t } of r.nearestNodes(reveal, 160)) {
          if (wanted.length >= budget) break;
          if (seen.has(i)) continue;
          seen.add(i);
          wanted.push({ i, cls: "dim", t });
        }
      }

      const w = host.clientWidth;
      const h = host.clientHeight;
      const grid = new Set<string>();
      const live = new Set<number>();
      for (const { i, cls, t } of wanted) {
        const p = r.project(i);
        if (!p.front || p.x < 0 || p.x > w || p.y < 0 || p.y > h) continue;
        // Collision suppression drops the lower-priority label in a cell. In
        // isolate mode that would hide members the reader explicitly asked to
        // see, so the grid only thins the ambient "dim" tier.
        const cell = `${Math.round(p.x / 92)}:${Math.round(p.y / 24)}`;
        if (grid.has(cell) && cls === "dim") continue;
        grid.add(cell);
        live.add(i);

        // Reuse the element rather than rebuilding it. replaceChildren every
        // 140ms swaps the node out from under the cursor, so a click aimed at
        // a contact pad can land on a detached element.
        let div = labelEls.current.get(i);
        if (!div) {
          div = document.createElement("div");
          const nodeId = m.nodes.id[i]!;
          div.onclick = (e) => {
            e.stopPropagation();
            useStore.getState().select({ kind: "node", id: nodeId });
          };
          div.onmouseenter = () => {
            probeRef.current = i;
            if (!div!.querySelector(".nprobe")) div!.appendChild(buildProbe(i, nodeId));
            div!.classList.add("probing");
          };
          div.onmouseleave = () => {
            if (probeRef.current === i) probeRef.current = null;
            div!.querySelector(".nprobe")?.remove();
            div!.classList.remove("probing");
          };
          const text = document.createElement("span");
          text.className = "nlabel-name";
          text.textContent = m.nodes.name[i]!;
          div.appendChild(text);
          if (m.nodes.resolution[i] === 1) {
            const flag = document.createElement("span");
            flag.className = "flag";
            flag.textContent = " ◦";
            flag.title = "probable identity (derived from side rows)";
            text.appendChild(flag);
          }
          labelEls.current.set(i, div);
          host.appendChild(div);
        }
        const probing = probeRef.current === i;
        if (probing) {
          const strip = div.querySelector<HTMLElement & { _sync?: () => void }>(".nprobe");
          strip?._sync?.();
        }
        // Proximity reveal: an ambient name fades up as the camera approaches
        // instead of popping in at a threshold. Selection, hover and isolate
        // labels are answers to a direct question and stay at full strength.
        const near = cls === "dim" && t < 0.999;
        div.className = `nlabel ${cls}${probing ? " probing" : ""}${near ? " near" : ""}`;
        div.style.opacity = near ? String(0.22 + 0.78 * Math.min(1, t / 0.7)) : "";
        div.style.left = `${p.x}px`;
        div.style.top = `${p.y}px`;
      }
      for (const [i, el] of labelEls.current) {
        // Never retire the label the cursor is currently on.
        if (live.has(i) || probeRef.current === i) continue;
        el.remove();
        labelEls.current.delete(i);
      }
    }, 140);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className="gl" aria-hidden="true" />
      <div ref={labelsRef} className="labels" aria-hidden="true" />
      {rendererFailure && lens === "connectome" && (
        <div className="boot connectome-webgl-fallback" role="alert">
          <div className="inner">
            <b>3D renderer unavailable</b>
            <p className="micro">{rendererFailure}</p>
            <button type="button" onClick={() => setRetryToken((token) => token + 1)}>Retry renderer</button>
          </div>
        </div>
      )}
    </>
  );
}
