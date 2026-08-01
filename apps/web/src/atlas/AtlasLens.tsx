import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import type { TimelineEngine } from "../timeline/TimelineEngine";
import { AtlasBreadcrumbs } from "./AtlasBreadcrumbs";
import { AtlasCanvas } from "./AtlasCanvas";
import { AtlasControls } from "./AtlasControls";
import { AtlasInspector } from "./AtlasInspector";
import { useAtlas, semanticStateOf } from "./atlasStore";
import { applyPendingAtlasUrl } from "./atlasUrl";

/**
 * The ATLAS lens.
 *
 * Mounted only while the lens is active; the renderer it owns is created on
 * first use and disposed on leave, so a reader who never opens ATLAS never
 * pays for a second WebGL context. The connectome stays mounted but paused
 * underneath, which is what makes the round trip preserve its framing.
 */
export function AtlasLens({ engine }: { engine: TimelineEngine }) {
  const data = useAtlas((s) => s.data);
  const loading = useAtlas((s) => s.loading);
  const error = useAtlas((s) => s.error);
  const scene = useAtlas((s) => s.scene);
  const selection = useStore((s) => s.selection);
  const announce = useStore((s) => s.announce);

  useEffect(() => {
    void useAtlas
      .getState()
      .boot()
      .then(() => applyPendingAtlasUrl());
  }, []);

  /* ---------- selection drives the semantic state ---------- */
  const selId = selection?.kind === "node" ? selection.id : null;
  useEffect(() => {
    if (!data) return;
    useAtlas.getState().setReignFocus(null);
    void useAtlas.getState().rebuild();
  }, [selId, data]);

  /* ---------- playback scope follows the selection ---------- */
  useEffect(() => {
    if (!selId) {
      engine.setScope(null);
      return;
    }
    const kind = semanticStateOf(selId);
    engine.setScope(
      kind === "promotion"
        ? { kind: "promotion", id: selId }
        : kind === "title"
          ? { kind: "title", id: selId }
          : kind === "career"
            ? { kind: "person", id: selId }
            : null,
    );
    // Leaving the lens restores the connectome's person-only scope, so its own
    // playback keeps behaving the way it always has.
    return () => {
      const st = useStore.getState();
      const s = st.selection?.kind === "node" && st.selection.id.startsWith("p:") ? st.selection.id : null;
      engine.setScope(s ? { kind: "person", id: s } : null);
    };
  }, [selId, engine]);

  /* ---------- screen-reader announcements ---------- */
  const lastAnnounce = useRef("");
  useEffect(() => {
    if (!scene) return;
    const crumb = scene.breadcrumbs[scene.breadcrumbs.length - 1]?.label ?? "";
    const head =
      scene.state === "overview"
        ? "Atlas overview"
        : scene.state === "promotion"
          ? `Promotion focus opened for ${crumb}`
          : scene.state === "title"
            ? `Championship lineage opened for ${crumb}`
            : `Career route opened for ${crumb}`;
    const msg =
      `${head}. ${scene.stats.represented.toLocaleString()} ${scene.stats.representedNoun} represented, ` +
      `${useAtlas.getState().labelShown} labels shown.` +
      (scene.stats.notes.length ? ` ${scene.stats.notes[0]}` : "");
    if (msg === lastAnnounce.current) return;
    lastAnnounce.current = msg;
    announce(msg);
  }, [scene, announce]);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") return;
      if (useStore.getState().lens !== "atlas") return;
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        useAtlas.getState().requestFit();
      } else if (e.key === "f" || e.key === "F") {
        const id = useStore.getState().selection;
        if (id?.kind === "node") {
          e.preventDefault();
          useAtlas.getState().flash(id.id);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        useAtlas.getState().ascend();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- search lands on a lane ---------- */
  useEffect(() => {
    if (!selId || !scene) return;
    if (scene.anchors.has(selId)) useAtlas.getState().flash(selId);
  }, [selId, scene]);

  return (
    <>
      <AtlasCanvas engine={engine} />
      <AtlasBreadcrumbs />
      <AtlasControls />
      <AtlasInspector />
      {(loading || !data) && !error && (
        <div className="atlas-boot micro" role="status">loading the atlas projection…</div>
      )}
      {error && (
        <div className="atlas-boot error-note" role="alert">
          {error}
          <div className="micro">run `pnpm atlas:materialize` to build the Atlas projection.</div>
        </div>
      )}
    </>
  );
}
