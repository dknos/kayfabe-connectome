import { useMemo, useState } from "react";
import { dayToDate } from "@kayfabe/graph-contract";
import { isoToDay, useStore, type PathMode } from "../state/store";

const FORM_LABELS: Record<string, string> = {
  singles: "Singles",
  tag_team: "Tag / team",
  multi_way: "Multi-way",
  battle_royal: "Battle royal",
  team_implied: "Team (inferred)",
  unknown: "Unclassified",
};

export function LeftPanel({ shownEdges, droppedEdges, tier }: {
  shownEdges: number;
  droppedEdges: number;
  tier: string;
}) {
  const model = useStore((s) => s.model);
  const core = useStore((s) => s.core);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const view = useStore((s) => s.view);
  const viewPending = useStore((s) => s.viewPending);
  const pathA = useStore((s) => s.pathA);
  const pathB = useStore((s) => s.pathB);
  const pathMode = useStore((s) => s.pathMode);
  const setPathMode = useStore((s) => s.setPathMode);
  const runPath = useStore((s) => s.runPath);
  const clearPath = useStore((s) => s.clearPath);
  const pathResult = useStore((s) => s.pathResult);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const setReducedMotion = useStore((s) => s.setReducedMotion);
  const [collapsed, setCollapsed] = useState(false);

  const promotions = useMemo(() => {
    if (!model) return [];
    const out: { bit: number; name: string; m: number }[] = [];
    const seen = new Set<number>();
    const add = (bit: number, name: string, m: number) => {
      if (!seen.has(bit)) {
        seen.add(bit);
        out.push({ bit, name, m });
      }
    };
    if (core) {
      for (const [, info] of Object.entries(core.promotions)) {
        if (info.bit !== undefined) add(info.bit, info.n, info.m);
      }
    } else {
      for (let i = 0; i < model.nodes.count; i++) {
        if (model.nodes.type[i] === 1) {
          const bit = model.manifest.promo_bits[model.nodes.id[i]!.slice(3)];
          if (bit !== undefined) add(bit, model.nodes.name[i]!, model.nodes.matches[i]!);
        }
      }
    }
    out.sort((a, b) => b.m - a.m || a.bit - b.bit);
    const otherBit = model.manifest.promo_other_bit;
    if (otherBit !== undefined) out.push({ bit: otherBit, name: "Other promotions", m: 0 });
    return out;
  }, [model, core]);

  if (!model) return null;
  const [d0, d1] = model.fullDayRange;
  const y0 = dayToDate(filters.dayMin).getUTCFullYear();
  const y1 = dayToDate(filters.dayMax).getUTCFullYear();
  const name = (id: string) => model.nodes.name[model.indexOfId.get(id) ?? -1] ?? id;

  return (
    <div className="rail left">
      <div className="panel" style={{ flex: collapsed ? "0 0 auto" : 1 }}>
        <h2>
          Filters <span className="line" />
          <button className="collapse-btn ghost" onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed} aria-label="Toggle filter panel">
            {collapsed ? "+" : "–"}
          </button>
        </h2>
        {!collapsed && (
          <>
            <div className="row">
              <label htmlFor="f-y0">Years</label>
              <input id="f-y0" type="number" min={dayToDate(d0).getUTCFullYear()} max={dayToDate(d1).getUTCFullYear()}
                value={y0} style={{ width: 64 }}
                onChange={(e) => setFilters({ dayMin: Math.max(d0, isoToDay(`${e.target.value}-01-01`)) })} />
              <span>–</span>
              <input aria-label="End year" type="number" min={dayToDate(d0).getUTCFullYear()} max={dayToDate(d1).getUTCFullYear()}
                value={y1} style={{ width: 64 }}
                onChange={(e) => setFilters({ dayMax: Math.min(d1, isoToDay(`${e.target.value}-12-31`)) })} />
            </div>
            <div className="row">
              <input aria-label="Start year slider" type="range" min={d0} max={d1} value={filters.dayMin}
                style={{ flex: 1 }} onChange={(e) => setFilters({ dayMin: Number(e.target.value) })} />
              <input aria-label="End year slider" type="range" min={d0} max={d1} value={filters.dayMax}
                style={{ flex: 1 }} onChange={(e) => setFilters({ dayMax: Number(e.target.value) })} />
            </div>
            {viewPending && <div className="micro">re-aggregating from match records…</div>}
            {!model.isFullRange(filters) && !viewPending && (
              <div className="micro" style={{ color: "var(--same)" }}>
                record-accurate range · weights recomputed from matches
              </div>
            )}

            <h2 style={{ marginTop: 10 }}>Promotions <span className="line" /></h2>
            <div className="checks scrollable" role="group" aria-label="Promotion filter">
              {promotions.map((p) => (
                <button key={p.bit}
                  className={`chip ${filters.promoMask & (1 << p.bit) ? "on" : ""}`}
                  aria-pressed={!!(filters.promoMask & (1 << p.bit))}
                  title={p.m > 0 ? `${p.m.toLocaleString()} matches` : "every promotion without its own filter bit"}
                  onClick={() => setFilters({ promoMask: filters.promoMask ^ (1 << p.bit) })}>
                  {p.name}
                </button>
              ))}
            </div>

            <h2 style={{ marginTop: 10 }}>Match forms <span className="line" /></h2>
            <div className="checks" role="group" aria-label="Match form filter">
              {Object.entries(model.manifest.form_bits).map(([form, bit]) => (
                <button key={form}
                  className={`chip ${filters.formMask & (1 << bit) ? "on" : ""}`}
                  aria-pressed={!!(filters.formMask & (1 << bit))}
                  onClick={() => setFilters({ formMask: filters.formMask ^ (1 << bit) })}>
                  {FORM_LABELS[form] ?? form}
                </button>
              ))}
            </div>

            <h2 style={{ marginTop: 10 }}>Relationships <span className="line" /></h2>
            <div className="checks">
              <button className={`chip ${filters.showOpposed ? "on" : ""}`} aria-pressed={filters.showOpposed}
                onClick={() => setFilters({ showOpposed: !filters.showOpposed })}>Opposed</button>
              <button className={`chip ${filters.showSame ? "on" : ""}`} aria-pressed={filters.showSame}
                onClick={() => setFilters({ showSame: !filters.showSame })}>Same-side</button>
              <button className={`chip ${filters.showBr ? "on" : ""}`} aria-pressed={filters.showBr}
                onClick={() => setFilters({ showBr: !filters.showBr })}>Battle-royal</button>
            </div>
            <div className="row">
              <label htmlFor="f-minE">Min encounters</label>
              <input id="f-minE" type="number" min={1} max={50} value={filters.minEncounters} style={{ width: 56 }}
                onChange={(e) => setFilters({ minEncounters: Math.max(1, Number(e.target.value)) })} />
            </div>
            {view && (
              <div className="micro">
                {view.visibleNodeCount.toLocaleString()} entities · {view.visible.length.toLocaleString()} relationships
                {droppedEdges > 0 && (
                  <span style={{ color: "var(--caution)" }}>
                    {" "}· {droppedEdges.toLocaleString()} thinnest hidden by quality cap ({tier}) — raise min encounters to see all
                  </span>
                )}
                {droppedEdges === 0 && shownEdges > 0 && <span> · all drawn</span>}
              </div>
            )}
            {view && view.visible.length === 0 && (
              <div className="empty-note">
                Nothing satisfies these filters. Widen the years, enable more promotions, or lower min encounters.
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel">
        <h2>Six degrees <span className="line" /></h2>
        <div className="micro">shift-click two people, or use dossier buttons</div>
        <div className="row">
          <label>A</label>
          <span>{pathA ? name(pathA) : "—"}</span>
        </div>
        <div className="row">
          <label>B</label>
          <span>{pathB ? name(pathB) : "—"}</span>
        </div>
        <div className="row">
          <label htmlFor="pmode">Mode</label>
          <select id="pmode" value={pathMode} onChange={(e) => setPathMode(e.target.value as PathMode)}>
            <option value="fewest">Fewest hops</option>
            <option value="strongest">Strongest documented</option>
            <option value="opponents">Opponent-only</option>
            <option value="partners">Partner-only</option>
          </select>
        </div>
        <div className="actions">
          <button onClick={runPath} disabled={!pathA || !pathB}>Find path</button>
          <button className="ghost" onClick={clearPath} disabled={!pathA && !pathB}>Clear</button>
        </div>
        {pathResult && (
          <div className="derivation-note" aria-live="polite">
            {pathResult.nodes.map(name).join(" → ")}
          </div>
        )}
        {pathA && pathB && pathResult === null && (
          <div className="empty-note">No path under the current filters.</div>
        )}
      </div>

      <div className="panel">
        <h2>Legend <span className="line" /></h2>
        <div className="legend">
          <span className="swatch dot" style={{ background: "#7fa8ff" }} />
          <span>person — hue = computed community</span>
          <span className="swatch dot" style={{ background: "transparent", border: "2px solid #cfe0f4", width: 8, height: 8 }} />
          <span>promotion anchor</span>
          <span className="swatch dot" style={{ background: "#ffd166", transform: "rotate(45deg)", borderRadius: 1 }} />
          <span>championship</span>
          <span className="swatch" style={{ background: "var(--opposed)" }} />
          <span>opposed encounters</span>
          <span className="swatch" style={{ background: "var(--same)" }} />
          <span>same-side encounters</span>
          <span className="swatch" style={{ background: "var(--caution)" }} />
          <span>battle-royal opposition</span>
          <span className="swatch" style={{ background: "var(--gold)" }} />
          <span>title involvement / change</span>
        </div>
        <div className="micro" style={{ marginTop: 6 }}>
          communities are computed (louvain) — not editorial groupings
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <label htmlFor="rm">Reduced motion</label>
          <input id="rm" type="checkbox" checked={reducedMotion}
            onChange={(e) => setReducedMotion(e.target.checked)} />
        </div>
      </div>
    </div>
  );
}
