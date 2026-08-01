import { TISSUE, type Tissue } from "@kayfabe/renderer";
import { useStore } from "../state/store";

/**
 * Tissue treatments.
 *
 * Three readings of the same corpus, expressed as renderer parameter sets
 * rather than as new chrome. Nothing here filters or hides a record — every
 * treatment draws the same graph and says something different about what it is
 * for. That is why the note under the chips is part of the control and not a
 * tooltip: choosing a treatment is choosing a claim about the reading.
 */

const ORDER: Array<[Tissue, string]> = [
  ["cortex", "Cortex"],
  ["myelin", "Myelin"],
  ["deep", "Deep field"],
];

export function TissuePanel() {
  const tissue = useStore((s) => s.tissue);
  const setTissue = useStore((s) => s.setTissue);
  const showHaze = useStore((s) => s.showHaze);
  const setShowHaze = useStore((s) => s.setShowHaze);
  const showLabels = useStore((s) => s.showLabels);
  const setShowLabels = useStore((s) => s.setShowLabels);

  return (
    <section className="panel" data-testid="tissue-panel">
      <h2>Tissue <i className="line" /></h2>
      <div className="checks" role="radiogroup" aria-label="Tissue treatment">
        {ORDER.map(([id, label]) => (
          <button
            key={id}
            role="radio"
            aria-checked={tissue === id}
            className={`chip ${tissue === id ? "on" : ""}`}
            onClick={() => setTissue(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="derivation-note" data-testid="tissue-note">{TISSUE[tissue].note}</p>
      <div className="row tissue-toggles">
        <label>
          <input
            type="checkbox" checked={showHaze}
            onChange={(e) => setShowHaze(e.target.checked)}
          />{" "}
          Community haze
        </label>
        <label>
          <input
            type="checkbox" checked={showLabels}
            onChange={(e) => setShowLabels(e.target.checked)}
          />{" "}
          Labels
        </label>
      </div>
    </section>
  );
}
