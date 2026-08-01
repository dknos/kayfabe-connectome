import { useStore } from "../state/store";
import { morphModeFor, useMorph } from "./morphStore";

const MODE_LABEL: Record<string, string> = {
  organic: "Tissue",
  loom: "Relationship Loom",
  motherboard: "Promotion Motherboard",
  career: "Career Circuit",
  lineage: "Championship Lineage",
  h2h: "Head-to-Head",
  rack: "Community Rack",
};

/** Tissue › mode › entity — clicks move through the one shared selection. */
export function MorphBreadcrumbs() {
  const selection = useStore((s) => s.selection);
  const selId = selection?.kind === "node" ? selection.id : null;
  const modeOverride = useMorph((s) => s.modeOverride);
  const tissue = useMorph((s) => s.tissue);
  const building = useMorph((s) => s.building);
  const data = useMorph((s) => s.data);
  const mode = morphModeFor(selId, modeOverride, tissue);
  const name = selId ? (data?.nameOf(selId) ?? selId) : null;

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
          <span className="crumb here" aria-current="page">{MODE_LABEL[mode] ?? mode}</span>
        </>
      )}
      {name && (
        <>
          <span className="sep">›</span>
          <span className="crumb here">{name}</span>
        </>
      )}
      {building && <span className="loading-dot micro"> building…</span>}
    </nav>
  );
}
