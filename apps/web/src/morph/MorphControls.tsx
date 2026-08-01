import { useStore } from "../state/store";
import type { BankGroup, LoomSort } from "./layouts/layoutTypes";
import { morphModeFor, useMorph, type MorphModeOverride } from "./morphStore";

const SORTS: { id: LoomSort; label: string }[] = [
  { id: "strength", label: "Relationship strength" },
  { id: "first", label: "First encounter" },
  { id: "latest", label: "Latest encounter" },
  { id: "median", label: "Median encounter year" },
  { id: "alpha", label: "Alphabetical" },
];

const GROUPS: { id: BankGroup; label: string }[] = [
  { id: "decade", label: "First documented decade" },
  { id: "activity", label: "Documented activity" },
  { id: "alpha", label: "Alphabetical" },
  { id: "champ", label: "Documented title holders" },
];

const LAYOUTS: { id: MorphModeOverride; label: string; needs?: "p" | "pr" | "t" }[] = [
  { id: "auto", label: "Auto" },
  { id: "organic", label: "Organic" },
  { id: "loom", label: "Relationship Loom", needs: "p" },
  { id: "motherboard", label: "Promotion Motherboard", needs: "pr" },
  { id: "career", label: "Career Circuit", needs: "p" },
  { id: "lineage", label: "Championship Lineage", needs: "t" },
];

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

  const allowed = (l: (typeof LAYOUTS)[number]): boolean => {
    if (!l.needs) return true;
    return !!selId && selId.startsWith(l.needs + ":");
  };

  return (
    <div className="rail left morph-rail">
      <div className="panel">
        <h2>Morph Lab β <span className="line" /></h2>
        <p className="micro">
          one corpus, many topologies — click an entity and the tissue
          reorganises around it. {building ? "building…" : ""}
        </p>
        <button
          className="morph-tissue-btn"
          onClick={() => useMorph.getState().returnToTissue()}
          disabled={mode === "organic" && tissue}
          title="Reverse the morph back to the exact organic positions [T]"
        >
          ⟲ Return to tissue
        </button>
      </div>

      <div className="panel">
        <h2>Layout <span className="line" /></h2>
        <div className="morph-layouts" role="group" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              className={"chip " + (modeOverride === l.id && !tissue ? "on" : "")}
              aria-pressed={modeOverride === l.id && !tissue}
              disabled={!allowed(l)}
              title={l.needs && !allowed(l) ? `select a ${l.needs === "p" ? "wrestler" : l.needs === "pr" ? "promotion" : "championship"} first` : undefined}
              onClick={() => setModeOverride(l.id)}
            >
              {l.label}
            </button>
          ))}
          <button className="chip" disabled title="scaffolded — arrives after the core modes">
            Head-to-Head β
          </button>
        </div>
        <p className="micro">showing: <b>{mode}</b>{tissue ? " (tissue)" : ""}</p>
      </div>

      {(mode === "loom" || modeOverride === "loom") && (
        <div className="panel">
          <h2>Loom order <span className="line" /></h2>
          <label className="row">
            <span>Sort</span>
            <select aria-label="Loom sort" value={controls.sort} onChange={(e) => setControls({ sort: e.target.value as LoomSort })}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="row">
            <input
              type="checkbox"
              checked={controls.timeAxis}
              onChange={(e) => setControls({ timeAxis: e.target.checked })}
            />
            <span>Time layout — vertical = first documented encounter</span>
          </label>
        </div>
      )}

      {mode === "motherboard" && (
        <div className="panel">
          <h2>Port banks <span className="line" /></h2>
          <label className="row">
            <span>Group</span>
            <select aria-label="Bank grouping" value={controls.group} onChange={(e) => setControls({ group: e.target.value as BankGroup })}>
              {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
            </select>
          </label>
        </div>
      )}

      <div className="panel">
        <h2>Reading <span className="line" /></h2>
        <div className="micro" data-testid="morph-counts">
          {layout ? (
            <>
              {layout.representedCount.toLocaleString()} entities represented ·{" "}
              {layout.expandedCount} expanded · {layout.routes.length} traces ·{" "}
              {labelShown}/{labelWanted} labels
              {tier !== "high" ? <> · quality {tier}</> : null}
            </>
          ) : (
            "building the first layout…"
          )}
        </div>
        {layout?.notes.map((note, i) => (
          <p key={i} className="micro derivation-note">{note}</p>
        ))}
        <label className="row">
          <input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} />
          <span>Reduced motion</span>
        </label>
        <button
          onClick={() => {
            useStore.getState().setLens("connectome");
          }}
        >
          Open in Connectome
        </button>
      </div>

      <div className="panel">
        <h2>Legend <span className="line" /></h2>
        <div className="micro morph-legend">
          <span className="sw ember" /> opposed · <span className="sw cyan" /> same-side ·{" "}
          <span className="sw br" /> battle royal · <span className="sw gold" /> championship
          <br />
          dashed traces = contextual (documented appearances / reigns), never match relationships
        </div>
      </div>
    </div>
  );
}
