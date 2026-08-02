import { useStore } from "../state/store";
import { h2hPair, morphModeFor, useMorph } from "./morphStore";

const MODE_NAMES: Record<string, string> = {
  organic: "Organic Tissue",
  loom: "Relationship Array",
  motherboard: "Promotion Network",
  career: "Career Spine",
  lineage: "Title Lineage",
  h2h: "Head-to-Head",
  rack: "Organized context",
};

/** One automatic topology system with only useful, contextual overrides. */
export function MorphControls() {
  const controls = useMorph((s) => s.controls);
  const setControls = useMorph((s) => s.setControls);
  const modeOverride = useMorph((s) => s.modeOverride);
  const setModeOverride = useMorph((s) => s.setModeOverride);
  const tissue = useMorph((s) => s.tissue);
  const layout = useMorph((s) => s.layout);
  const building = useMorph((s) => s.building);
  const labelShown = useMorph((s) => s.labelShown);
  const labelWanted = useMorph((s) => s.labelWanted);
  const tier = useMorph((s) => s.tier);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const setReducedMotion = useStore((s) => s.setReducedMotion);
  const selection = useStore((s) => s.selection);
  const selId = selection?.kind === "node" ? selection.id : null;
  const mode = morphModeFor(selId, modeOverride, tissue);
  const pathA = useStore((s) => s.pathA);
  const pathB = useStore((s) => s.pathB);
  const pinned = useStore((s) => s.pinned);
  void pathA;
  void pathB;
  void pinned;
  const pair = h2hPair();
  const personSelected = !!selId?.startsWith("p:");

  return (
    <div className="rail left morph-rail">
      <div className="panel morph-command-panel">
        <h2>Morph Lab <span className="line" /></h2>
        <p className="micro">
          the Connectome tissue reorganizes around the current entity
          {building ? " · resolving structure…" : ""}
        </p>
        <div className="morph-layouts" role="group" aria-label="Morph topology">
          <button
            className={modeOverride === "auto" && !tissue ? "active" : ""}
            aria-pressed={modeOverride === "auto" && !tissue}
            onClick={() => setModeOverride("auto")}
          >Auto</button>
          {personSelected && (
            <button
              className={modeOverride === "career" && !tissue ? "active" : ""}
              aria-pressed={modeOverride === "career" && !tissue}
              onClick={() => setModeOverride("career")}
            >Career</button>
          )}
          {pair && (
            <button
              className={modeOverride === "h2h" && !tissue ? "active" : ""}
              aria-pressed={modeOverride === "h2h" && !tissue}
              title={`Compare ${pair[0]} and ${pair[1]}`}
              onClick={() => setModeOverride("h2h")}
            >Compare</button>
          )}
        </div>
        <div className="morph-spatial-actions">
          <button type="button" onClick={() => useMorph.getState().requestFit()} title="Fit active structure [R]">Fit</button>
          <button
            type="button"
            onClick={() => useMorph.getState().returnToTissue()}
            disabled={mode === "organic" && tissue}
            title="Restore exact Connectome positions [T]"
          >Return to Tissue</button>
        </div>
        <label className="row morph-context-toggle">
          <input
            type="checkbox"
            checked={controls.context !== false}
            onChange={(event) => setControls({ context: event.target.checked })}
          />
          <span>Corpus context</span>
        </label>
        <p className="micro morph-mode-readout">
          <span className="status-dot" /> {MODE_NAMES[mode] ?? mode}
        </p>
      </div>

      <div className="panel">
        <h2>Reading <span className="line" /></h2>
        <div className="micro" data-testid="morph-counts">
          {layout ? (
            <>
              {layout.representedCount.toLocaleString()} entities · {layout.expandedCount.toLocaleString()} active ·{" "}
              {layout.routes.length.toLocaleString()} traces · {labelShown}/{labelWanted} labels
              {tier !== "high" ? <> · quality {tier}</> : null}
            </>
          ) : "building the first structure…"}
        </div>
        {layout?.notes.map((note, i) => <p key={i} className="micro derivation-note">{note}</p>)}
        <label className="row">
          <input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} />
          <span>Reduced motion</span>
        </label>
        <button type="button" onClick={() => useStore.getState().setLens("connectome")}>Open in Connectome</button>
      </div>

      <div className="panel">
        <h2>Spatial reading <span className="line" /></h2>
        <div className="micro morph-legend">
          <span className="sw ember" /> opposed · <span className="sw cyan" /> same-side ·{" "}
          <span className="sw br" /> battle royal · <span className="sw gold" /> championship
          <br />
          height = strength · depth = chronology · dashed = contextual evidence
          <br />
          drag orbit · right-drag pan · wheel dolly · WASD/QE move · F focus
        </div>
      </div>
    </div>
  );
}
