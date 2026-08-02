import { useStore } from "../state/store";
import { h2hPair, morphModeFor, useMorph } from "./morphStore";

const MODE_NAMES: Record<string, string> = {
  organic: "Organic Tissue",
  loom: "Relationship Array",
  orbit: "Orbit Map",
  motherboard: "Promotion Network",
  career: "Career Spine",
  lineage: "Title Lineage",
  h2h: "Head-to-Head",
  rack: "Organized context",
};

const MODE_EXPLANATIONS: Record<string, string> = {
  organic: "The canonical corpus in its persistent Connectome positions.",
  loom: "Direct opponents, partners, and context organized by role and strength.",
  orbit: "Direct and two-hop bridge relationships organized by graph distance.",
  career: "Documented appearances and relationships organized through time.",
  h2h: "Two selected people, their direct evidence, and shared connections.",
  motherboard: "Documented participants and championships organized around one promotion.",
  lineage: "Documented reign evidence organized along one championship rail.",
};

/** Contextual view controls for the one persistent Morph corpus. */
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
  // comparison identity may change independently of selection
  useStore((s) => s.pathA);
  useStore((s) => s.pathB);
  useStore((s) => s.pinned);
  const selId = selection?.kind === "node" ? selection.id : null;
  const mode = morphModeFor(selId, modeOverride, tissue);
  const pair = h2hPair();
  const personSelected = !!selId?.startsWith("p:");
  const orbitCounts = layout?.mode === "orbit" ? layout.orbitStats ?? null : null;
  const guideCount = layout?.mode === "orbit" ? layout.orbitStats?.guideCount ?? 0 : 0;

  return (
    <div id="morph-controls-panel" className="rail left morph-rail" role="tabpanel" aria-labelledby="morph-tab-controls">
      <div className="panel morph-command-panel">
        <h2>Morph Lab <span className="line" /></h2>
        <p className="micro morph-kicker">
          one corpus · multiple spatial readings{building ? " · resolving structure…" : ""}
        </p>

        {personSelected ? (
          <>
            <h3 className="micro morph-control-heading">View</h3>
            <div className="morph-layouts morph-view-switch" role="group" aria-label="Person view">
              <ModeButton active={mode === "loom"} onClick={() => setModeOverride("loom")}>Array</ModeButton>
              <ModeButton active={mode === "orbit"} onClick={() => setModeOverride("orbit")}>Orbit</ModeButton>
              <ModeButton active={mode === "career"} onClick={() => setModeOverride("career")}>Career</ModeButton>
              <button
                type="button"
                className={mode === "h2h" ? "active" : ""}
                aria-pressed={mode === "h2h"}
                aria-describedby={!pair ? "morph-compare-requirement" : undefined}
                disabled={!pair}
                onClick={() => setModeOverride("h2h")}
              >Compare</button>
            </div>
            {!pair ? <p id="morph-compare-requirement" className="micro morph-requirement">Compare needs people A and B.</p> : null}
          </>
        ) : selId ? (
          <div className="morph-entity-mode" aria-label="Active topology">
            <span className="status-dot" />
            <span>{MODE_NAMES[mode] ?? mode}</span>
          </div>
        ) : null}

        <p className="morph-mode-explanation">{MODE_EXPLANATIONS[mode] ?? MODE_EXPLANATIONS.organic}</p>

        <h3 className="micro morph-control-heading">Scene</h3>
        <div className="morph-spatial-actions">
          <button type="button" onClick={() => useMorph.getState().requestFit()} aria-label="Fit active structure">Fit</button>
          <button
            type="button"
            disabled={!selId}
            onClick={() => (window as { __kayfabeMorph?: { focusSelection(): boolean } }).__kayfabeMorph?.focusSelection()}
            aria-label="Focus selected entity"
          >Focus</button>
          <button
            type="button"
            onClick={() => useMorph.getState().returnToTissue()}
            disabled={mode === "organic" && tissue}
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
        <p className="micro morph-mode-readout"><span className="status-dot" /> {MODE_NAMES[mode] ?? mode}</p>
      </div>

      <div className="panel morph-reading-panel">
        <h2>Reading <span className="line" /></h2>
        <div className="morph-reading-grid" data-testid="morph-counts">
          <ReadingMetric value={layout?.representedCount ?? 0} label="corpus entities" />
          <ReadingMetric value={layout?.expandedCount ?? 0} label="active topology" />
          {orbitCounts ? <ReadingMetric value={orbitCounts.directDisplayed} label="direct nodes" /> : null}
          {orbitCounts ? <ReadingMetric value={orbitCounts.bridgeDisplayed} label="bridge nodes" /> : null}
          {orbitCounts ? <ReadingMetric value={orbitCounts.bridgeRoutesDisplayed} label="bridge routes" /> : null}
          {orbitCounts ? <ReadingMetric value={orbitCounts.guideCount} label="orbit guides" /> : null}
          <ReadingMetric value={Math.max(0, (layout?.routes.length ?? 0) - guideCount)} label="visible evidence routes" />
          <ReadingMetric value={`${labelShown}/${labelWanted}`} label="labels shown/wanted" />
        </div>
        {tier !== "high" ? <p className="micro quality-note">Quality tier: {tier}</p> : null}
        {orbitCounts ? (
          <>
            <p className="micro derivation-note morph-coverage-summary">
              {orbitCounts.directDisplayed}/{orbitCounts.directTotal} direct · {orbitCounts.bridgeDisplayed}/{orbitCounts.bridgeTotal} bridges · {orbitCounts.bridgeRoutesDisplayed} routes{orbitCounts.bridgeRoutesOmitted ? ` · ${orbitCounts.bridgeRoutesOmitted.toLocaleString()} omitted` : ""}
            </p>
            {layout?.notes.length ? (
              <details className="morph-coverage-notes">
                <summary>Method and coverage notes</summary>
                {layout.notes.map((note, i) => <p key={i} className="micro derivation-note">{note}</p>)}
              </details>
            ) : null}
          </>
        ) : layout?.notes.map((note, i) => <p key={i} className="micro derivation-note">{note}</p>)}
        <label className="row">
          <input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} />
          <span>Reduced motion</span>
        </label>
        <button type="button" onClick={() => useStore.getState().setLens("connectome")}>Open in Connectome</button>
      </div>

      <div className="panel morph-spatial-reading">
        <h2>{MODE_NAMES[mode] ?? "Spatial reading"} <span className="line" /></h2>
        <DynamicLegend mode={mode} />
        <details className="morph-help">
          <summary>Controls and shortcuts</summary>
          <p className="micro">
            Drag orbit · right-drag pan · wheel dolly · R fit · F focus · T tissue
            {personSelected ? " · 1 Array · 2 Orbit · 3 Career · C Compare" : ""}
          </p>
        </details>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick(): void; children: string }) {
  return <button type="button" className={active ? "active" : ""} aria-pressed={active} onClick={onClick}>{children}</button>;
}

function ReadingMetric({ value, label }: { value: number | string; label: string }) {
  return <div><span className="num">{typeof value === "number" ? value.toLocaleString() : value}</span><span>{label}</span></div>;
}

function DynamicLegend({ mode }: { mode: string }) {
  if (mode === "orbit") {
    return (
      <div className="morph-legend-grid">
        <Legend swatch="core" text="center · selected person" />
        <Legend swatch="direct" text="inner orbit · direct relationship" />
        <Legend swatch="bridge" text="outer orbit · two-hop bridge" />
        <Legend swatch="cyan" text="cyan · same-side evidence" />
        <Legend swatch="ember" text="ember · opposed evidence" />
        <Legend swatch="mixed" text="split tone · both roles" />
        <Legend swatch="br" text="ochre · battle-royal-only" />
        <Legend swatch="promotion" text="upper halo · documented appearance context" />
        <Legend swatch="gold" text="gold halo · championship context" />
        <Legend swatch="quiet" text="quiet route · bridge or contextual evidence" />
        <p className="micro legend-equation">radius = graph hop · size and route width = evidence strength</p>
      </div>
    );
  }
  if (mode === "career") return <div className="morph-legend-grid"><Legend swatch="route" text="spine · documented career route" /><Legend swatch="promotion" text="lane · promotion context" /><Legend swatch="gold" text="gold · championship context" /><p className="micro legend-equation">time runs left to right · gaps remain unrecorded</p></div>;
  if (mode === "lineage") return <div className="morph-legend-grid"><Legend swatch="gold" text="rail · documented reign evidence" /><Legend swatch="quiet" text="gap · unrecorded, never inferred vacant" /></div>;
  if (mode === "motherboard") return <div className="morph-legend-grid"><Legend swatch="promotion" text="shelves · documented participant eras" /><Legend swatch="gold" text="gold · championship context" /></div>;
  if (mode === "h2h") return <div className="morph-legend-grid"><Legend swatch="ember" text="opposed · direct match evidence" /><Legend swatch="cyan" text="same-side · direct match evidence" /><Legend swatch="quiet" text="shared graph connection · not direct evidence" /></div>;
  if (mode === "loom") return <div className="morph-legend-grid"><Legend swatch="ember" text="left bank · opposed" /><Legend swatch="cyan" text="right bank · same-side" /><Legend swatch="mixed" text="front bank · both roles" /><Legend swatch="br" text="lower bank · battle-royal-only" /><Legend swatch="gold" text="gold · championship context" /><p className="micro legend-equation">height = strength · depth = documented chronology</p></div>;
  return <p className="micro morph-legend">Persistent corpus positions · subdued fibers show the strongest bounded lifetime evidence.</p>;
}

function Legend({ swatch, text }: { swatch: string; text: string }) {
  return <div><span className={`sw ${swatch}`} aria-hidden="true" /><span>{text}</span></div>;
}
