import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { MorphBreadcrumbs } from "./MorphBreadcrumbs";
import { MorphCanvas } from "./MorphCanvas";
import { MorphControls } from "./MorphControls";
import { MorphInspector } from "./MorphInspector";
import { applyPendingMorphUrl } from "./morphUrl";
import { useMorph } from "./morphStore";

/**
 * MORPH LAB β — one persistent set of corpus entities transforming between
 * readable topologies. Mounted only while the lens is active; its renderer
 * (a second WebGL context) is created on mount and disposed on unmount, so a
 * reader who never opens the lab pays nothing. The connectome underneath
 * stays mounted and suspended, exactly as it does for ATLAS and GEO.
 */
export function MorphLab({ engine }: { engine: TimelineEngine }) {
  const error = useMorph((s) => s.error);
  const loading = useMorph((s) => s.loading);
  const data = useMorph((s) => s.data);
  const sheet = useMorph((s) => s.sheet);

  // lazy boot, then URL replay — the deep-link contract
  useEffect(() => {
    void useMorph.getState().boot().then(() => applyPendingMorphUrl());
  }, []);

  // rebuild on selection change (shared store owns the selection)
  const selection = useStore((s) => s.selection);
  const selId = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    if (!useMorph.getState().data) return;
    void useMorph.getState().rebuild();
  }, [selId]);

  // playback scope: the lab owns it while mounted, and restores the
  // connectome's person-only scope on the way out (the atlas contract)
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
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (useStore.getState().lens !== "morph") return;
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        useMorph.getState().requestFit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        useMorph.getState().ascend();
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        useMorph.getState().returnToTissue();
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
    const name = selId ? (useMorph.getState().data?.nameOf(selId) ?? selId) : null;
    const msg =
      layout.mode === "organic"
        ? "Morph Lab — organic tissue positions."
        : layout.mode === "loom"
          ? `Relationship Loom around ${name}. Opponents left, partners right, promotions above, championships on the gold bus.`
          : layout.mode === "motherboard"
            ? `Promotion Motherboard for ${name}.`
            : layout.mode === "career"
              ? `Career Circuit for ${name} — time runs left to right.`
              : layout.mode === "lineage"
                ? `Championship Lineage for ${name} — documented reigns on the gold rail.`
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
          <div className="brand"><b>MORPH LAB β</b></div>
          <p className="error-note" role="alert">{error}</p>
          <p className="micro">the lab reads the same materialized corpus as the connectome — run `pnpm data:materialize` if it is missing.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <MorphCanvas engine={engine} />
      <MorphBreadcrumbs />
      <MorphControls />
      <MorphInspector />
      <MorphSheetTabs sheet={sheet} />
      {(loading || !data) && (
        <div className="boot morph-overlay">
          <div className="inner">
            <div className="brand"><b>MORPH LAB β</b> <span className="micro">preparing the tissue</span></div>
          </div>
        </div>
      )}
    </>
  );
}

/** narrow-viewport 3-way sheet switcher, mirroring the atlas pattern */
function MorphSheetTabs({ sheet }: { sheet: "controls" | "inspector" | "hidden" }) {
  const setSheet = useMorph((s) => s.setSheet);
  return (
    <div className="morph-sheet-tabs mobile-only" role="tablist" aria-label="Morph Lab panels">
      {(["controls", "inspector", "hidden"] as const).map((k) => (
        <button
          key={k}
          role="tab"
          aria-selected={sheet === k}
          className={sheet === k ? "active" : ""}
          onClick={() => setSheet(k)}
        >
          {k === "controls" ? "Layout" : k === "inspector" ? "Details" : "Map"}
        </button>
      ))}
    </div>
  );
}
