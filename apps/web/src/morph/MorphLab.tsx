import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { MorphBreadcrumbs } from "./MorphBreadcrumbs";
import { MorphCanvas } from "./MorphCanvas";
import { MorphControls } from "./MorphControls";
import { MorphInspector } from "./MorphInspector";
import { applyPendingMorphUrl } from "./morphUrl";
import { h2hPair, useMorph } from "./morphStore";

/**
 * MORPH LAB — one persistent set of corpus entities transforming between
 * readable topologies. Mounted only while the lens is active; its renderer
 * (a second WebGL context) is created on mount and disposed on unmount, so a
 * reader who never opens the lab pays nothing. The connectome underneath
 * stays mounted and suspended while this secondary renderer is active.
 */
export function MorphLab({ engine }: { engine: TimelineEngine }) {
  const error = useMorph((s) => s.error);
  const loading = useMorph((s) => s.loading);
  const data = useMorph((s) => s.data);
  const sheet = useMorph((s) => s.sheet);
  const [ready, setReady] = useState(false);

  // lazy boot, then URL replay — the deep-link contract
  useEffect(() => {
    let cancelled = false;
    void useMorph.getState().boot()
      .then(() => applyPendingMorphUrl())
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // rebuild on selection change (shared store owns the selection)
  const selection = useStore((s) => s.selection);
  const selId = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    if (!useMorph.getState().data) return;
    void useMorph.getState().rebuild();
  }, [selId]);

  // Orbit budgets must retain durable semantic people. Hover is intentionally
  // excluded: rebuilding a topology on pointer travel would be both unstable
  // and expensive, while pins/comparison/path nodes are explicit reader state.
  const requiredTopologyKey = useStore((s) => [
    ...s.pinned,
    s.pathA ?? "",
    s.pathB ?? "",
    ...(s.pathResult?.nodes ?? []),
  ].join("\u0000"));
  const previousRequired = useRef<Set<string>>(new Set());
  useEffect(() => {
    const morph = useMorph.getState();
    const next = new Set(requiredTopologyKey.split("\u0000").filter(Boolean));
    const removed = [...previousRequired.current].some((id) => !next.has(id));
    const addedOutsideOrbit = [...next].some((id) => {
      if (previousRequired.current.has(id)) return false;
      const slot = morph.data?.indexOf(id);
      return slot !== undefined && morph.layout?.nodeRole[slot] === 0;
    });
    previousRequired.current = next;
    if (!morph.data || morph.layout?.mode !== "orbit" || (!removed && !addedOutsideOrbit)) return;
    void morph.rebuild();
  }, [requiredTopologyKey]);

  // playback scope: the lab owns it while mounted, and restores the
  // connectome's person-only scope on the way out
  useEffect(() => {
    if (!selId) {
      engine.setScope(null);
      return;
    }
    if (selId.startsWith("pr:")) engine.setScope({ kind: "promotion", id: selId });
    else if (selId.startsWith("t:")) engine.setScope({ kind: "title", id: selId });
    else if (selId.startsWith("p:")) engine.setScope({ kind: "person", id: selId });
    return () => {
      const cur = useStore.getState().selection;
      const pid = cur?.kind === "node" && cur.id.startsWith("p:") ? cur.id : null;
      engine.setParticipant(pid);
    };
  }, [engine, selId]);

  // lens-local keyboard (guarded so the global map cannot double-handle)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest("input, select, textarea, [contenteditable='true'], [role='textbox']")) return;
      const shared = useStore.getState();
      if (shared.lens !== "morph") return;
      const keyboardSelection = shared.selection?.kind === "node" ? shared.selection.id : null;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const renderer = (window as { __kayfabeMorph?: { cancelHover?(reason?: "cancel"): void; hover?: { clear(reason: "cancel"): void } } }).__kayfabeMorph;
        if (useStore.getState().hoverId) {
          if (renderer?.cancelHover) renderer.cancelHover();
          else renderer?.hover?.clear("cancel");
        }
        else useMorph.getState().ascend();
        return;
      }
      const nativeActivationTarget = active?.closest("button, a, summary, [role='button'], [role='tab']");
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().requestFit();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        e.stopImmediatePropagation();
        (window as { __kayfabeMorph?: { focusSelection(): boolean } }).__kayfabeMorph?.focusSelection();
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().returnToTissue();
      } else if (e.key === " ") {
        // Space must retain its native activation meaning when an actual
        // control owns focus; letter shortcuts remain lens-local elsewhere.
        if (nativeActivationTarget) return;
        if (!useMorph.getState().layout?.timeAxis) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        document.querySelector<HTMLButtonElement>('[aria-label="Play"], [aria-label="Pause"]')?.click();
      } else if (keyboardSelection?.startsWith("p:") && e.key === "1") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().setModeOverride("loom");
      } else if (keyboardSelection?.startsWith("p:") && e.key === "2") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().setModeOverride("orbit");
      } else if (keyboardSelection?.startsWith("p:") && e.key === "3") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().setModeOverride("career");
      } else if ((e.key === "c" || e.key === "C") && h2hPair()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().setModeOverride("h2h");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // screen-reader announcements per mode
  const layout = useMorph((s) => s.layout);
  const lastAnnounce = useRef("");
  useEffect(() => {
    if (!layout) return;
    const data = useMorph.getState().data;
    const name = selId ? (data?.nameOf(selId) ?? selId) : null;
    const pair = layout.mode === "h2h" ? h2hPair() : null;
    const msg =
      layout.mode === "organic"
        ? "Morph Lab — organic tissue positions."
        : layout.mode === "loom"
          ? `3D Relationship Array around ${name}. Height represents relationship strength and depth represents first documented encounter.`
          : layout.mode === "orbit"
            ? `Orbit Map around ${name}. The inner orbit contains direct documented relationships and the outer orbit contains two-hop bridge people. No direct relationship is claimed by bridge placement.`
          : layout.mode === "motherboard"
            ? `3D Promotion Network for ${name}.`
            : layout.mode === "career"
              ? `Career Spine for ${name} — time runs left to right.`
              : layout.mode === "lineage"
                ? `Championship Lineage for ${name} — documented reigns on the gold rail.`
                : layout.mode === "h2h" && pair
                  ? `Head-to-Head comparison: ${data?.nameOf(pair[0]) ?? pair[0]} and ${data?.nameOf(pair[1]) ?? pair[1]}. Direct documented matches are chronological rungs; shared graph connections are labeled separately.`
                  : "Morph Lab.";
    if (msg !== lastAnnounce.current) {
      lastAnnounce.current = msg;
      useStore.getState().announce(msg);
    }
  }, [layout, selId]);

  if (error) {
    return (
      <div className="boot morph-overlay">
        <div className="inner">
          <div className="brand"><b>MORPH LAB</b></div>
          <p className="error-note" role="alert">{error}</p>
          <p className="micro">the lab reads the same materialized corpus as the connectome — run `pnpm data:materialize` if it is missing.</p>
          <button
            type="button"
            onClick={() => {
              useMorph.setState({ data: null, error: null, loading: false });
              void useMorph.getState().boot();
            }}
          >Retry data</button>
        </div>
      </div>
    );
  }

  return (
    <>
      {ready ? <MorphCanvas engine={engine} /> : null}
      <MorphBreadcrumbs />
      <MorphControls />
      <MorphInspector />
      <MorphSheetTabs sheet={sheet} />
      {(loading || !data || !ready) && (
        <div className="boot morph-overlay">
          <div className="inner">
            <div className="brand"><b>MORPH LAB</b> <span className="micro">preparing the tissue</span></div>
          </div>
        </div>
      )}
    </>
  );
}

/** narrow-viewport 3-way sheet switcher */
function MorphSheetTabs({ sheet }: { sheet: "controls" | "inspector" | "hidden" }) {
  const setSheet = useMorph((s) => s.setSheet);
  const tabs = ["controls", "inspector", "hidden"] as const;
  const focusTab = (index: number) => {
    const key = tabs[(index + tabs.length) % tabs.length]!;
    setSheet(key);
    document.getElementById(`morph-tab-${key}`)?.focus();
  };
  return (
    <div className="morph-sheet-tabs mobile-only" role="tablist" aria-label="Morph Lab panels">
      {tabs.map((k, index) => (
        <button
          key={k}
          id={`morph-tab-${k}`}
          role="tab"
          aria-selected={sheet === k}
          aria-controls={k === "controls" ? "morph-controls-panel" : k === "inspector" ? "morph-inspector-panel" : "morph-map-surface"}
          tabIndex={sheet === k ? 0 : -1}
          className={sheet === k ? "active" : ""}
          onClick={() => setSheet(k)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              focusTab(index + 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              focusTab(index - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusTab(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusTab(tabs.length - 1);
            }
          }}
        >
          {k === "controls" ? "Layout" : k === "inspector" ? "Details" : "Map"}
        </button>
      ))}
    </div>
  );
}
