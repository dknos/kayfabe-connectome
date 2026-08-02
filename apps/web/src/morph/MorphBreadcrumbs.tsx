import { useStore } from "../state/store";
import { h2hPair, morphModeFor, useMorph } from "./morphStore";

const MODE_LABEL: Record<string, string> = {
  organic: "Tissue",
  loom: "Relationship Array",
  orbit: "Orbit Map",
  motherboard: "Promotion Network",
  career: "Career Spine",
  lineage: "Title Lineage",
  h2h: "Head-to-Head",
  rack: "Organized Context",
};

/** Tissue › entity › mode — clicks move through the one shared selection. */
export function MorphBreadcrumbs() {
  const selection = useStore((s) => s.selection);
  // These subscriptions keep the comparison identity current even when the
  // selected node itself does not change.
  useStore((s) => s.pathA);
  useStore((s) => s.pathB);
  useStore((s) => s.pinned);
  const selId = selection?.kind === "node" ? selection.id : null;
  const modeOverride = useMorph((s) => s.modeOverride);
  const tissue = useMorph((s) => s.tissue);
  const building = useMorph((s) => s.building);
  const data = useMorph((s) => s.data);
  const mode = morphModeFor(selId, modeOverride, tissue);
  const name = selId ? (data?.nameOf(selId) ?? selId) : null;
  const pair = mode === "h2h" ? h2hPair() : null;
  const readingName = pair
    ? `${data?.nameOf(pair[0]) ?? pair[0]} ↔ ${data?.nameOf(pair[1]) ?? pair[1]}`
    : name;

  return (
    <nav className="morph-crumbs" aria-label="Morph Lab position">
      <button
        className={"crumb" + (mode === "organic" && !selId ? " here" : "")}
        onClick={() => {
          useStore.getState().select(null);
          useMorph.getState().returnToTissue();
        }}
      >
        Tissue
      </button>
      {mode !== "organic" && (
        <>
          <span className="sep">›</span>
          <span className="crumb entity">{readingName}</span>
        </>
      )}
      {mode !== "organic" && (
        <>
          <span className="sep">›</span>
          <span className="crumb here" aria-current="page">{MODE_LABEL[mode] ?? mode}</span>
        </>
      )}
      {mode === "organic" && readingName ? (
        <><span className="sep">›</span><span className="crumb here">{readingName}</span></>
      ) : null}
      {building && <span className="loading-dot micro"> building…</span>}
    </nav>
  );
}
