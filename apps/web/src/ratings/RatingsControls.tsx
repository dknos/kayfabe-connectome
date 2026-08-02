import { useMemo, useState } from "react";
import { dayToDate } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
import { ratingStars } from "./ratingsAdapter";
import { type RatingFormFilter, type RatingLaneOrder } from "./layouts";
import { useRatings } from "./ratingsStore";

const THRESHOLDS = [3, 4, 4.5, 5, 5.5] as const;
const ORDERS: { value: RatingLaneOrder; label: string }[] = [
  { value: "stable", label: "Stable corpus order" },
  { value: "rated", label: "Rated-match count" },
  { value: "total", label: "Total match volume" },
  { value: "coverage", label: "Rating coverage" },
  { value: "median", label: "Median reported rating" },
  { value: "mean", label: "Mean reported rating" },
  { value: "fourPlus", label: "4★+ count" },
  { value: "fivePlus", label: "5★+ count" },
  { value: "maximum", label: "Maximum reported rating" },
  { value: "alphabetical", label: "Promotion name" },
];

export function RatingsControls() {
  const data = useRatings((state) => state.data);
  const controls = useRatings((state) => state.controls);
  const stats = useRatings((state) => state.stats);
  const scope = useRatings((state) => state.scope);
  const scopeLabel = useRatings((state) => state.scopeLabel);
  const compareA = useRatings((state) => state.compareA);
  const compareB = useRatings((state) => state.compareB);
  const tier = useRatings((state) => state.tier);
  const qualityOverride = useRatings((state) => state.qualityOverride);
  const decodeDurationMs = useRatings((state) => state.decodeDurationMs);
  const layoutBuildDurationMs = useRatings((state) => state.layoutBuildDurationMs);
  const shownLabels = useRatings((state) => state.shownLabels);
  const wantedLabels = useRatings((state) => state.wantedLabels);
  const selected = useStore((state) => state.selection);
  const selectedId = selected?.kind === "node" ? selected.id : null;
  const [promotionQuery, setPromotionQuery] = useState("");
  const actualMin = data ? Math.min(...data.exact.rating) : -1;
  const actualMax = data ? Math.max(...data.exact.rating) : 7;
  const ratedPromotions = useMemo(() => {
    if (!data) return [];
    return [...data.exactByPromotion.entries()]
      .map(([index, matches]) => ({ id: data.dictionaries.promotions.id[index]!, name: data.dictionaries.promotions.name[index]!, count: matches.length }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }, [data]);
  const matchingPromotions = useMemo(() => {
    const query = promotionQuery.trim().toLocaleLowerCase();
    const matches = query ? ratedPromotions.filter((promotion) => promotion.name.toLocaleLowerCase().includes(query)).slice(0, 40) : ratedPromotions;
    const selectedPromotion = ratedPromotions.find((promotion) => promotion.id === controls.filters.promotionId);
    return selectedPromotion && !matches.some((promotion) => promotion.id === selectedPromotion.id)
      ? [selectedPromotion, ...matches]
      : matches;
  }, [controls.filters.promotionId, promotionQuery, ratedPromotions]);

  const setRatingFloor = (value: number) => useRatings.getState().setFilters({ ratingMin: value, ratingMax: actualMax });
  return (
    <aside className="ratings-panel ratings-controls" id="ratings-controls-panel" aria-label="Meltzer Ratings controls">
      <div className="ratings-masthead">
        <span className="ratings-kicker">Reported ratings across wrestling history</span>
        <h1><span>Meltzer</span><span>Ridge</span></h1>
        <p>{scope.mode === "promotions"
          ? "Time runs left to right. Exact reported rating rises vertically. The opening chronology does not sort by promotion."
          : "Time runs left to right. Exact reported rating rises vertically. Focused match context occupies depth."}</p>
      </div>

      <section className="ratings-control-section" aria-labelledby="ratings-view-heading">
        <h2 id="ratings-view-heading">Reading</h2>
        <div className="ratings-mode-grid" role="group" aria-label="Ratings arrangement">
          <button type="button" className={scope.mode === "promotions" ? "active" : ""} onClick={() => useRatings.getState().returnGlobal()}>1 · Time + rating</button>
          <button
            type="button"
            className={scope.mode === "career" ? "active" : ""}
            disabled={!selectedId?.startsWith("p:")}
            onClick={() => selectedId?.startsWith("p:") && useRatings.getState().setScope({ mode: "career", id: selectedId })}
          >2 · Career ridge</button>
          <button
            type="button"
            className={scope.mode === "compare" ? "active" : ""}
            disabled={!compareA || !compareB || compareA === compareB}
            onClick={() => useRatings.getState().activateCompare()}
          >C · Compare A/B</button>
        </div>
        <div className="ratings-scope-line"><span>Current scope</span><strong>{scopeLabel}</strong></div>
      </section>

      <section className="ratings-control-section" aria-labelledby="ratings-filter-heading">
        <h2 id="ratings-filter-heading">Reported rating</h2>
        <div className="ratings-threshold-strip" role="group" aria-label="Quick rating filters">
          {[
            [actualMin, "All rated"], [3, "3★+"], [4, "4★+"], [4.5, "4.5★+"], [5, "5★+"], [5.000001, "Above 5★"],
          ].map(([value, label]) => (
            <button
              key={String(label)}
              type="button"
              className={Math.abs(controls.filters.ratingMin - Number(value)) < 0.00001 ? "active" : ""}
              onClick={() => setRatingFloor(Number(value))}
            >{label}</button>
          ))}
        </div>
        <div className="ratings-dual-input">
          <label>Minimum<input aria-label="Minimum reported rating" type="number" min={actualMin} max={controls.filters.ratingMax} step="0.01" value={controls.filters.ratingMin} onChange={(event) => useRatings.getState().setFilters({ ratingMin: Number(event.target.value) })} /></label>
          <label>Maximum<input aria-label="Maximum reported rating" type="number" min={controls.filters.ratingMin} max={actualMax} step="0.01" value={controls.filters.ratingMax} onChange={(event) => useRatings.getState().setFilters({ ratingMax: Number(event.target.value) })} /></label>
        </div>
        <div className="ratings-datum-control">
          <span>Threshold plane</span>
          <div role="group" aria-label="Threshold plane presets">
            {THRESHOLDS.map((value) => <button key={value} type="button" className={controls.threshold === value ? "active" : ""} onClick={() => useRatings.getState().setControls({ threshold: value })}>{value}★</button>)}
          </div>
          <label className="ratings-inline-number">Custom<input aria-label="Custom threshold plane" type="number" min={actualMin} max="8" step="0.1" value={controls.threshold} onChange={(event) => useRatings.getState().setControls({ threshold: Number(event.target.value) })} /></label>
        </div>
      </section>

      <section className="ratings-control-section" aria-labelledby="ratings-scope-filter-heading">
        <h2 id="ratings-scope-filter-heading">Evidence filters</h2>
        <label className="ratings-field">Search promotions
          <input
            type="search"
            value={promotionQuery}
            placeholder="Name or promotion fragment"
            onChange={(event) => setPromotionQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !matchingPromotions[0]) return;
              event.preventDefault();
              useRatings.getState().setFilters({ promotionId: matchingPromotions[0].id });
            }}
          />
        </label>
        <label className="ratings-field">Promotion
          <select value={controls.filters.promotionId ?? ""} onChange={(event) => useRatings.getState().setFilters({ promotionId: event.target.value || null })}>
            <option value="">All promotions</option>
            {matchingPromotions.map((promotion) => <option key={promotion.id} value={promotion.id}>{promotion.name} · {promotion.count}</option>)}
          </select>
        </label>
        <label className="ratings-field">Match form
          <select value={controls.filters.form} onChange={(event) => useRatings.getState().setFilters({ form: event.target.value as RatingFormFilter })}>
            <option value="all">All documented forms</option>
            {(data?.dictionaries.forms ?? []).map((form) => <option key={form} value={form}>{form.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <div className="ratings-check-grid">
          <Check label="PPV only" value={controls.filters.ppvOnly} onChange={(ppvOnly) => useRatings.getState().setFilters({ ppvOnly })} />
          <Check label="Title matches" value={controls.filters.titleMatchOnly} onChange={(titleMatchOnly) => useRatings.getState().setFilters({ titleMatchOnly })} />
          <Check label="Title changes" value={controls.filters.titleChangeOnly} onChange={(titleChangeOnly) => useRatings.getState().setFilters({ titleChangeOnly })} />
          <Check label="Exact dates" value={controls.filters.includeExactDates} onChange={(includeExactDates) => useRatings.getState().setFilters({ includeExactDates })} />
          <Check label="Approximate dates" value={controls.filters.includeApproximateDates} onChange={(includeApproximateDates) => useRatings.getState().setFilters({ includeApproximateDates })} />
        </div>
        <label className="ratings-range-field">
          <span>Minimum rating coverage <b className="num">{(controls.filters.coverageMinimum * 100).toFixed(1)}%</b></span>
          <input type="range" min="0" max="0.5" step="0.005" value={controls.filters.coverageMinimum} onChange={(event) => useRatings.getState().setFilters({ coverageMinimum: Number(event.target.value) })} />
        </label>
      </section>

      <section className="ratings-control-section" aria-labelledby="ratings-structure-heading">
        <h2 id="ratings-structure-heading">Structure</h2>
        {scope.mode !== "promotions" && (
          <label className="ratings-field">Lane ordering
            <select value={controls.laneOrder} onChange={(event) => useRatings.getState().setControls({ laneOrder: event.target.value as RatingLaneOrder })}>
              {ORDERS.map((order) => <option key={order.value} value={order.value}>{order.label}</option>)}
            </select>
          </label>
        )}
        <div className="ratings-check-grid">
          <Check label="Individual peaks" value={controls.showExact} onChange={(showExact) => useRatings.getState().setControls({ showExact })} />
          <Check label="Aggregate ridges" value={controls.showAggregates} onChange={(showAggregates) => useRatings.getState().setControls({ showAggregates })} />
          <Check label="Median trend · n≥3" value={controls.showTrend} onChange={(showTrend) => useRatings.getState().setControls({ showTrend })} />
        </div>
        {scope.mode !== "promotions" && (
          <label className="ratings-range-field">
            <span>Context amount <b className="num">{Math.round(controls.context * 100)}%</b></span>
            <input type="range" min="0" max="1" step="0.05" value={controls.context} onChange={(event) => useRatings.getState().setControls({ context: Number(event.target.value) })} />
          </label>
        )}
        <div className="ratings-camera-actions">
          <button type="button" onClick={() => useRatings.getState().requestFit()}>Fit visible</button>
          <button type="button" onClick={() => useRatings.getState().requestFocus()} disabled={!useRatings.getState().selectedMatchId}>Focus selection</button>
          <button type="button" onClick={() => window.__kayfabeRatings?.analystView()}>Top / analyst</button>
          <button type="button" onClick={() => useRatings.getState().returnGlobal()}>Overview</button>
        </div>
      </section>

      {stats && (
        <section className="ratings-control-section ratings-scope-stats" aria-labelledby="ratings-stat-heading">
          <h2 id="ratings-stat-heading">Current evidence</h2>
          <div className="ratings-stat-ledger">
            <Stat value={stats.ratedMatches.toLocaleString()} label="Rated matches visible" />
            <Stat value={`${(stats.coverage * 100).toFixed(1)}%`} label={`Rating coverage · ${stats.coverageRatedMatches.toLocaleString()}/${stats.totalDocumentedMatches.toLocaleString()}`} />
            <Stat value={stats.median === null ? "—" : ratingStars(stats.median)} label={`Median · n=${stats.ratedMatches.toLocaleString()}`} />
            <Stat value={stats.mean === null ? "—" : ratingStars(stats.mean)} label={`Mean · n=${stats.ratedMatches.toLocaleString()}`} />
            <Stat value={stats.maximum === null ? "—" : ratingStars(stats.maximum)} label="Maximum reported" />
            <Stat value={stats.fivePlus.toLocaleString()} label={`Reported 5★+ · ${stats.ratedMatches ? (stats.fivePlus / stats.ratedMatches * 100).toFixed(1) : "0.0"}%`} />
          </div>
          <RatingsHistogram />
          <p className="ratings-count-note">{stats.promotions} promotions · {stats.wrestlers.toLocaleString()} wrestlers · {stats.fourPlus.toLocaleString()} at 4★+ · {stats.approximateDates.toLocaleString()} approximate dates · {stats.displayedMatches.toLocaleString()} displayed / {stats.omittedMatches.toLocaleString()} omitted.</p>
        </section>
      )}

      <section className="ratings-caveat" aria-label="Rating source caveat">
        <strong>Missing is not zero.</strong>
        <p>Ratings are present where the source reports them. Coverage varies by era and promotion. This field is a reported Meltzer rating, not objective quality or fan consensus.</p>
      </section>

      <details className="ratings-diagnostics">
        <summary>Diagnostics</summary>
        <label>Quality override
          <select value={qualityOverride} onChange={(event) => useRatings.getState().setQualityOverride(event.target.value as typeof qualityOverride)}>
            <option value="auto">Adaptive · current {tier}</option>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
        </label>
        <div className="num">decode {decodeDurationMs.toFixed(1)} ms · layout {layoutBuildDurationMs.toFixed(1)} ms · labels {shownLabels}/{wantedLabels}</div>
        <button type="button" onClick={() => useRatings.getState().resetControls()}>Reset ratings controls</button>
      </details>
    </aside>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <label className="ratings-check"><input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div><strong className="num">{value}</strong><span>{label}</span></div>;
}

function RatingsHistogram() {
  const data = useRatings((state) => state.data);
  const controls = useRatings((state) => state.controls);
  const indices = useRatings((state) => state.scopeExactIndices);
  const entries = useMemo(() => {
    if (!data) return [] as [number, number][];
    const counts = new Map<number, number>();
    for (const index of indices) {
      const value = data.exact.rating[index]!;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => a[0] - b[0]);
  }, [data, indices]);
  if (!data) return <div className="ratings-histogram-empty">Distribution strip unavailable; exact records remain available.</div>;
  const max = Math.max(1, ...entries.map(([, count]) => count));
  return (
    <div className="ratings-histogram" role="img" aria-label={`Distribution of ${entries.reduce((sum, [, count]) => sum + count, 0).toLocaleString()} reported ratings. Bars are counts by exact source value.`}>
      {entries.map(([value, count]) => <i key={value} style={{ height: `${Math.max(2, Math.sqrt(count / max) * 100)}%` }} title={`${value} stars: ${count} matches`} data-negative={value < 0 || undefined} />)}
      <span>{ratingStars(controls.filters.ratingMin)}</span><span>{ratingStars(controls.filters.ratingMax)}</span>
    </div>
  );
}

export function ratingsAnnouncement(): string {
  const state = useRatings.getState();
  const stats = state.stats;
  const layout = state.layout;
  if (!stats || !layout) return "Meltzer Ratings is loading.";
  const years = `${dayToDate(layout.dayRange[0]).getUTCFullYear()} through ${dayToDate(layout.dayRange[1]).getUTCFullYear()}`;
  const spatial = layout.mode === "promotions"
    ? "Promotion does not determine position in this chronology."
    : `${layout.lanes.length} context lanes occupy depth.`;
  return `Meltzer Ratings — ${state.scopeLabel}. Time runs left to right and reported rating runs vertically from ${layout.ratingRange[0]} to ${layout.ratingRange[1]}. ${spatial} ${stats.ratedMatches.toLocaleString()} rated matches are visible from ${years}, covering ${(stats.coverage * 100).toFixed(1)} percent of documented matches in this scope.`;
}
