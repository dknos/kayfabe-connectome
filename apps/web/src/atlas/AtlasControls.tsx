import { useState } from "react";
import { useStore } from "../state/store";
import { AtlasMinimap } from "./AtlasMinimap";
import { useAtlas } from "./atlasStore";
import type { GroupMode, SortMode } from "./layout/layoutTypes";

/**
 * Atlas controls.
 *
 * Compact by design: disclosure sections rather than a panel that covers the
 * board. Every control here changes what the LAYOUT means, not how it is
 * decorated — grouping and sorting are readings of the corpus, and the
 * thresholds are the honest knobs on how much is drawn.
 */

const GROUPS: { id: GroupMode; label: string }[] = [
  { id: "decade", label: "First active decade" },
  { id: "alpha", label: "Alphabetical" },
  { id: "tier", label: "Activity tier" },
  { id: "firstYear", label: "First documented year" },
];

const SORTS: { id: SortMode; label: string }[] = [
  { id: "volume", label: "Match volume" },
  { id: "first", label: "First record" },
  { id: "last", label: "Latest record" },
  { id: "alpha", label: "Alphabetical" },
  { id: "span", label: "Active span" },
];

export function AtlasControls() {
  const controls = useAtlas((s) => s.controls);
  const setControls = useAtlas((s) => s.setControls);
  const requestFit = useAtlas((s) => s.requestFit);
  const scene = useAtlas((s) => s.scene);
  const labelShown = useAtlas((s) => s.labelShown);
  const tier = useAtlas((s) => s.tier);
  const select = useStore((s) => s.select);
  const setLens = useStore((s) => s.setLens);
  const selection = useStore((s) => s.selection);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const setReducedMotion = useStore((s) => s.setReducedMotion);
  const [open, setOpen] = useState(true);

  const state = scene?.state ?? "overview";
  const selId = selection?.kind === "node" ? selection.id : null;

  return (
    <div className="rail left atlas-rail">
      <div className="panel">
        <h2>
          Atlas <span className="line" />
          <button
            className="collapse-btn ghost"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label="Toggle atlas controls"
          >
            {open ? "–" : "+"}
          </button>
        </h2>
        <div className="actions">
          <button
            data-testid="atlas-overview"
            onClick={() => select(null)}
            disabled={state === "overview"}
          >
            {state === "overview" ? "Overview" : "← Back to overview"}
          </button>
          <button onClick={requestFit} title="Fit the whole board (R)">Fit view</button>
        </div>

        {open && (
          <>
            <div className="row">
              <label htmlFor="a-group">Group</label>
              <select
                id="a-group"
                value={controls.group}
                onChange={(e) => setControls({ group: e.target.value as GroupMode })}
              >
                {GROUPS.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            </div>
            <div className="row">
              <label htmlFor="a-sort">Sort</label>
              <select
                id="a-sort"
                value={controls.sort}
                onChange={(e) => setControls({ sort: e.target.value as SortMode })}
              >
                {SORTS.map((g) => (
                  <option key={g.id} value={g.id}>{g.label}</option>
                ))}
              </select>
            </div>
            <div className="row">
              <label htmlFor="a-min">Min activity</label>
              <input
                id="a-min"
                type="number"
                min={0}
                step={10}
                value={controls.minActivity}
                style={{ width: 72 }}
                onChange={(e) => setControls({ minActivity: Math.max(0, Number(e.target.value) || 0) })}
              />
              <span className="micro">documented matches</span>
            </div>
            <div className="row">
              <label htmlFor="a-rel">Relation floor</label>
              <input
                id="a-rel"
                type="number"
                min={1}
                max={200}
                value={controls.relThreshold}
                style={{ width: 60 }}
                onChange={(e) => setControls({ relThreshold: Math.max(1, Number(e.target.value) || 1) })}
              />
              <span className="micro">encounters</span>
            </div>

            <div className="checks" role="group" aria-label="Atlas layers">
              <button
                className={`chip ${controls.showTitles ? "on" : ""}`}
                aria-pressed={controls.showTitles}
                onClick={() => setControls({ showTitles: !controls.showTitles })}
              >
                Championships
              </button>
              <button
                className={`chip ${controls.showWrestlers ? "on" : ""}`}
                aria-pressed={controls.showWrestlers}
                onClick={() => setControls({ showWrestlers: !controls.showWrestlers })}
              >
                Wrestlers
              </button>
              <button
                className={`chip ${controls.showBundles ? "on" : ""}`}
                aria-pressed={controls.showBundles}
                onClick={() => setControls({ showBundles: !controls.showBundles })}
              >
                Relationships
              </button>
            </div>

            <div className="row">
              <label htmlFor="a-labels">Labels</label>
              <select
                id="a-labels"
                value={controls.labels}
                onChange={(e) =>
                  setControls({ labels: e.target.value as "sparse" | "normal" | "dense" })
                }
              >
                <option value="sparse">Sparse</option>
                <option value="normal">Normal</option>
                <option value="dense">Dense</option>
              </select>
              <button
                className={`chip ${controls.tilted ? "on" : ""}`}
                aria-pressed={controls.tilted}
                onClick={() => setControls({ tilted: !controls.tilted })}
                title="Axonometric tilt"
              >
                {controls.tilted ? "Tilted" : "Flat"}
              </button>
            </div>

            <div className="row">
              <label htmlFor="a-rm">Reduced motion</label>
              <input
                id="a-rm"
                type="checkbox"
                checked={reducedMotion}
                onChange={(e) => setReducedMotion(e.target.checked)}
              />
            </div>
          </>
        )}

        {scene && (
          <div className="micro" data-testid="atlas-counts">
            {scene.stats.represented.toLocaleString()} {scene.stats.representedNoun} represented ·{" "}
            {labelShown.toLocaleString()} labels shown
            {tier !== "high" && <span style={{ color: "var(--caution)" }}> · quality {tier}</span>}
          </div>
        )}
        {scene?.stats.notes.map((n, i) => (
          <p className="derivation-note" key={i}>{n}</p>
        ))}
      </div>

      {state === "overview" && (
        <div className="panel">
          <h2>Board <span className="line" /></h2>
          <AtlasMinimap />
        </div>
      )}

      <div className="panel">
        <h2>Legend <span className="line" /></h2>
        <div className="legend">
          <span className="swatch" style={{ background: "#cfe0f4" }} />
          <span>promotion span — first to latest documented record</span>
          <span className="swatch" style={{ background: "var(--gold)" }} />
          <span>championship span / reign</span>
          <span
            className="swatch"
            style={{ background: "repeating-linear-gradient(45deg,var(--caution) 0 2px,transparent 2px 4px)" }}
          />
          <span>unrecorded gap — not a vacancy</span>
          <span className="swatch" style={{ background: "var(--same)" }} />
          <span>cards / same-side encounters</span>
          <span className="swatch" style={{ background: "var(--opposed)" }} />
          <span>matches / opposed encounters</span>
        </div>
        <div className="micro" style={{ marginTop: 6 }}>
          drag to pan · scroll to zoom · click a lane to focus · esc goes up one level
        </div>
        {selId && (
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              data-testid="open-in-connectome"
              onClick={() => setLens("connectome")}
              title="Read the same entity as a network instead of a chronology"
            >
              Open in Connectome
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
