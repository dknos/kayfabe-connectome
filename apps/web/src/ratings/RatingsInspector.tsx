import { useEffect, useMemo, useRef, useState } from "react";
import { dayToDate } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
import { COVERAGE_KIND, exactRecord, formatCoverage, GLOBAL_SUBJECT, coverageTotals, ratingStars, RF } from "./ratingsAdapter";
import type { RatingsData } from "./ratingsLoader";
import { exactMedian } from "./layouts";
import { mean } from "./layouts/ratingMath";
import { useRatings, type RatingListSort } from "./ratingsStore";

const ROW_HEIGHT = 58;
const VIEWPORT_HEIGHT = 330;

export function RatingsInspector() {
  const data = useRatings((state) => state.data);
  const stats = useRatings((state) => state.stats);
  const scope = useRatings((state) => state.scope);
  const scopeLabel = useRatings((state) => state.scopeLabel);
  const selected = useRatings((state) => state.selectedExact);
  const detail = useRatings((state) => state.selectedDetail);
  const detailLoading = useRatings((state) => state.detailLoading);
  const layout = useRatings((state) => state.layout);
  const listSort = useRatings((state) => state.listSort);
  const indices = useRatings((state) => state.scopeExactIndices);
  const shownLabels = useRatings((state) => state.shownLabels);
  const [scrollTop, setScrollTop] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  const selectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sorted = useMemo(() => sortIndices(data, indices, listSort), [data, indices, listSort]);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 3);
  const end = Math.min(sorted.length, start + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 7);

  useEffect(() => {
    // Browser focus/Playwright can scroll the outer ledger to a virtual row.
    // A new semantic scope starts at its heading; retaining the old scroll
    // would make the new title/promotion/career identity appear clipped.
    if (panelRef.current) panelRef.current.scrollTop = 0;
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [scope.mode, scope.id, scope.compareA, scope.compareB]);

  useEffect(() => {
    if (!selected || !panelRef.current || !selectionRef.current) return;
    // On the mobile sheet, the evidence summary is taller than the viewport.
    // Confirm the reader's lock action by bringing persistent match detail
    // into view after focus has finished its own browser scrolling.
    const frame = requestAnimationFrame(() => {
      if (panelRef.current && selectionRef.current) {
        panelRef.current.scrollTop = Math.max(0, selectionRef.current.offsetTop - 10);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [selected?.id]);

  return (
    <aside ref={panelRef} className="ratings-panel ratings-inspector" id="ratings-inspector-panel" aria-label="Ratings inspector">
      <header className="ratings-inspector-head">
        <span>Evidence ledger</span>
        <h2>{scopeLabel}</h2>
        <p>{modeDescription(scope.mode)}</p>
      </header>

      {stats && (
        <section className="ratings-inspector-summary" aria-label="Current scope statistics">
          <div className="ratings-ledger-row"><span>Rated matches</span><strong className="num">{stats.ratedMatches.toLocaleString()}</strong></div>
          <div className="ratings-ledger-row"><span>Rating coverage</span><strong className="num">{(stats.coverage * 100).toFixed(1)}%</strong></div>
          <div className="ratings-ledger-denominator">{formatCoverage(stats.coverageRatedMatches, stats.totalDocumentedMatches)}{stats.coverageBoundaryApproximate ? " · calendar-month boundary estimate" : ""}</div>
          <div className="ratings-mini-grid">
            <SmallStat label="Median reported" value={stats.median === null ? "—" : ratingStars(stats.median)} />
            <SmallStat label="Mean reported" value={stats.mean === null ? "—" : ratingStars(stats.mean)} />
            <SmallStat label="Maximum reported" value={stats.maximum === null ? "—" : ratingStars(stats.maximum)} />
            <SmallStat label="4★+" value={`${stats.fourPlus.toLocaleString()} · ${stats.ratedMatches ? (stats.fourPlus / stats.ratedMatches * 100).toFixed(1) : "0.0"}%`} />
            <SmallStat label="5★+" value={`${stats.fivePlus.toLocaleString()} · ${stats.ratedMatches ? (stats.fivePlus / stats.ratedMatches * 100).toFixed(1) : "0.0"}%`} />
            <SmallStat label="Date span" value={stats.dateSpan ? `${dayToDate(stats.dateSpan[0]).getUTCFullYear()}–${dayToDate(stats.dateSpan[1]).getUTCFullYear()}` : "—"} />
          </div>
          <p className="ratings-denominator-note">Quality metrics use n={stats.ratedMatches.toLocaleString()}; {stats.coverageAccounting === "subject-exposures"
            ? `comparison coverage uses ${stats.totalDocumentedMatches.toLocaleString()} A+B documented match exposures, with shared matches counted once for each side`
            : `coverage uses all ${stats.totalDocumentedMatches.toLocaleString()} documented matches in the time/scope denominator`}.</p>
        </section>
      )}

      {scope.mode === "compare" && data && <ComparisonLedger data={data} />}

      <section ref={selectionRef} className="ratings-selection" aria-labelledby="ratings-selection-heading">
        <h3 id="ratings-selection-heading">Locked match</h3>
        {!selected ? (
          <p className="ratings-empty">Select a peak or a row. Hover remains transient; this detail stays locked during playback.</p>
        ) : (
          <>
            <div className="ratings-selection-rating"><strong className="num">{ratingStars(selected.rating)}</strong><span>Reported Meltzer rating</span></div>
            <h4>{detail ? participantResult(data!, detail.w, detail.l) : selected.participantNames.join(" · ")}</h4>
            <div className="ratings-selection-date num">{selected.date}{selected.flags & RF.APPROXIMATE ? " · approximate date" : ""}</div>
            <dl className="ratings-detail-list">
              <dt>Promotion</dt><dd>{selected.promotionName}</dd>
              <dt>Event</dt><dd>{detail?.en || selected.eventName || (detailLoading ? "Loading canonical event…" : "Not reported")}</dd>
              <dt>Card position</dt><dd>{selected.placement === null ? "Not reported; stable match-id offset used for same-day separation" : `Documented position ${selected.placement}`}</dd>
              <dt>Location</dt><dd>{detail?.loc || "Not reported"}</dd>
              <dt>Participants</dt><dd>{selected.participantNames.join(" · ")}</dd>
              <dt>Match form</dt><dd>{(detail?.form ?? selected.form).replaceAll("_", " ")}{detail?.stip ? ` · ${detail.stip}` : ""}</dd>
              <dt>Result</dt><dd>{detail ? `${namesOf(data!, detail.w).join(" · ")} ${detail.res || "vs"} ${namesOf(data!, detail.l).join(" · ")}${detail.fin ? ` · ${detail.fin}` : ""}` : "Loading canonical result…"}</dd>
              <dt>Title state</dt><dd>{selected.titleNames.length ? `${selected.titleNames.join(" · ")} · ${selected.flags & RF.TITLE_CHANGE ? "documented title change" : "title match; no change reported"}` : "No title match reported"}</dd>
              <dt>PPV</dt><dd>{selected.flags & RF.PPV ? "Reported PPV match" : "Not flagged as PPV"}</dd>
              <dt>Duration</dt><dd>{detail?.dur === null || detail?.dur === undefined ? "Not reported" : `${Math.floor(detail.dur / 60)}:${String(detail.dur % 60).padStart(2, "0")}`}</dd>
              <dt>Canonical id</dt><dd className="num">{selected.id}</dd>
            </dl>
            <div className="ratings-selection-actions">
              <button type="button" onClick={() => window.__kayfabeRatings?.focusSelection()}>Focus peak</button>
              <button type="button" onClick={() => useRatings.getState().togglePinMatch(selected.id)}>{useRatings.getState().pinnedMatchIds.includes(selected.id) ? "Unpin peak" : "Pin peak"}</button>
              {selected.participantIds[0] && <button type="button" onClick={() => openIn(selected.participantIds[0]!, "morph")}>Open participant in Morph Lab</button>}
              <button type="button" onClick={() => useRatings.getState().selectMatch(null)}>Clear lock</button>
            </div>
            <p className="ratings-source-note">The exact numeric source value is preserved. This is a reported rating, not an objective or consensus score.</p>
          </>
        )}
      </section>

      {layout?.notes.length ? (
        <section className="ratings-disclosure" aria-label="Display disclosures">
          <h3>Display accounting</h3>
          {layout.notes.map((note) => <p key={note}>{note}</p>)}
          <p>{layout.visibleExactMatches.toLocaleString()} exact peaks · {layout.visibleAggregateBins.toLocaleString()} aggregate bins · {layout.omittedPromotions.toLocaleString()} omitted promotion lanes · {shownLabels}/{layout.wantedLabels} labels shown.</p>
        </section>
      ) : null}

      <section className="ratings-match-list" aria-labelledby="ratings-match-list-heading">
        <div className="ratings-list-head">
          <h3 id="ratings-match-list-heading">Exact matches</h3>
          <label>Sort
            <select value={listSort} onChange={(event) => useRatings.getState().setListSort(event.target.value as RatingListSort)}>
              <option value="date">Date</option>
              <option value="rating">Reported rating</option>
              <option value="promotion">Promotion</option>
              <option value="event">Event</option>
            </select>
          </label>
        </div>
        <p className="ratings-list-count">{sorted.length.toLocaleString()} exact canonical rated matches. The list is the keyboard-accessible equivalent of the ridge.</p>
        <div
          ref={listRef}
          className="ratings-virtual-list"
          role="listbox"
          aria-label={`Rated matches in ${scopeLabel}`}
          style={{ height: VIEWPORT_HEIGHT }}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div style={{ height: sorted.length * ROW_HEIGHT, position: "relative" }}>
            {sorted.slice(start, end).map((index, offset) => {
              const record = data ? exactRecord(data, index) : null;
              if (!record) return null;
              const locked = record.id === selected?.id;
              return (
                <button
                  key={record.id}
                  type="button"
                  role="option"
                  aria-selected={locked}
                  className={locked ? "active" : ""}
                  style={{ position: "absolute", top: (start + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
                  onClick={() => {
                    useRatings.getState().selectMatch(record.id);
                    window.setTimeout(() => window.__kayfabeRatings?.focusMatch(record.id), 0);
                  }}
                >
                  <span className="ratings-list-rating num">{ratingStars(record.rating)}</span>
                  <span className="ratings-list-identity">{record.participantNames.slice(0, 3).join(" · ")}{record.participantNames.length > 3 ? ` +${record.participantNames.length - 3}` : ""}</span>
                  <span className="ratings-list-meta num">{record.date} · {record.promotionName}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {scope.mode === "title" && <p className="ratings-title-caveat">Title focus uses every title identity documented on the canonical match. Source title-change history can still be incomplete; this lens does not infer missing changes.</p>}
    </aside>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong className="num">{value}</strong></div>;
}

function modeDescription(mode: ReturnType<typeof useRatings.getState>["scope"]["mode"]): string {
  if (mode === "promotions") return "Stable promotion lanes ordered by full-corpus rated-match count.";
  if (mode === "promotion") return "One expanded promotion on the same absolute chronological and rating scales.";
  if (mode === "career") return "Direct singles opponents receive named lanes; team and multi-person matches stay explicit context.";
  if (mode === "title") return "Rated title matches only; title match and documented title change remain distinct.";
  return "A and B share one chronological axis and one absolute reported-rating scale.";
}

function sortIndices(data: RatingsData | null, indices: readonly number[], sort: RatingListSort): number[] {
  if (!data) return [];
  return [...indices].sort((a, b) => {
    if (sort === "rating") return data.exact.rating[b]! - data.exact.rating[a]! || data.exact.day[a]! - data.exact.day[b]!;
    if (sort === "promotion") {
      const pa = data.dictionaries.promotions.name[data.exact.promotion[a]!]!;
      const pb = data.dictionaries.promotions.name[data.exact.promotion[b]!]!;
      return pa.localeCompare(pb) || data.exact.day[a]! - data.exact.day[b]!;
    }
    if (sort === "event") {
      const ea = data.dictionaries.events.name[data.exact.eventIndex[a]!]!;
      const eb = data.dictionaries.events.name[data.exact.eventIndex[b]!]!;
      return ea.localeCompare(eb) || data.exact.day[a]! - data.exact.day[b]! || data.exactMatchIds[a]!.localeCompare(data.exactMatchIds[b]!);
    }
    return data.exact.day[a]! - data.exact.day[b]! || data.exactMatchIds[a]!.localeCompare(data.exactMatchIds[b]!);
  });
}

function namesOf(data: RatingsData, ids: readonly string[]): string[] {
  return ids.map((id) => {
    const index = data.participantIndexById.get(id);
    return index === undefined ? id : data.dictionaries.participants.name[index]!;
  });
}

function participantResult(data: RatingsData, winners: readonly string[], losers: readonly string[]): string {
  return `${namesOf(data, winners).join(" · ")} vs ${namesOf(data, losers).join(" · ")}`;
}

function openIn(id: string, lens: "morph" | "connectome") {
  const shared = useStore.getState();
  shared.select({ kind: "node", id });
  shared.setLens(lens);
  if (lens === "connectome" && shared.model?.indexOfId.has(id)) shared.focus(id);
}

function ComparisonLedger({ data }: { data: RatingsData }) {
  const a = useRatings((state) => state.compareA);
  const b = useRatings((state) => state.compareB);
  const filtered = useRatings((state) => state.scopeExactIndices);
  const dayMin = useStore((state) => state.filters.dayMin);
  const dayMax = useStore((state) => state.filters.dayMax);
  const promotionComparison = !!a?.startsWith("pr:") && !!b?.startsWith("pr:");
  return (
    <section className="ratings-comparison-ledger" aria-label="Comparison summary">
      <h3>Absolute-scale comparison</h3>
      <ComparisonSide label="A" id={a} data={data} filtered={filtered} dayMin={dayMin} dayMax={dayMax} />
      <ComparisonSide label="B" id={b} data={data} filtered={filtered} dayMin={dayMin} dayMax={dayMax} />
      <p>{promotionComparison
        ? "Promotion A and B occupy adjacent tracks on one absolute scale; similar dates never imply a shared match."
        : "Center-track records involve both A and B. Similar dates alone never create a shared record."}</p>
    </section>
  );
}

function ComparisonSide({ label, id, data, filtered, dayMin, dayMax }: {
  label: string;
  id: string | null;
  data: RatingsData;
  filtered: readonly number[];
  dayMin: number;
  dayMax: number;
}) {
  const summary = useMemo(() => {
    const promotion = id?.startsWith("pr:") ?? false;
    const subject = promotion
      ? data.promotionIndexById.get(id ?? "")
      : data.participantIndexById.get(id ?? "");
    const name = subject === undefined ? null : promotion
      ? data.dictionaries.promotions.name[subject]!
      : data.dictionaries.participants.name[subject]!;
    if (subject === undefined) return { name, values: [] as number[], denominator: { rated: 0, total: 0 }, days: [] as number[] };
    const owned = new Set(promotion ? data.exactByPromotion.get(subject) ?? [] : data.exactByParticipant.get(subject) ?? []);
    const indices = filtered.filter((index) => owned.has(index));
    const denominator = coverageTotals(data, promotion ? COVERAGE_KIND.promotion : COVERAGE_KIND.person, subject ?? GLOBAL_SUBJECT, dayMin, dayMax);
    return {
      name,
      values: indices.map((index) => data.exact.rating[index]!),
      denominator,
      days: indices.map((index) => data.exact.day[index]!),
    };
  }, [data, dayMax, dayMin, filtered, id]);
  const median = exactMedian(summary.values);
  const average = mean(summary.values);
  const maximum = summary.values.length ? Math.max(...summary.values) : null;
  const fourPlus = summary.values.filter((value) => value >= 4).length;
  const fivePlus = summary.values.filter((value) => value >= 5).length;
  const span = summary.days.length
    ? `${dayToDate(Math.min(...summary.days)).getUTCFullYear()}–${dayToDate(Math.max(...summary.days)).getUTCFullYear()}`
    : "—";
  return (
    <div className="ratings-comparison-side">
      <b>{label} · {summary.name ?? "Unset"}</b>
      <span className="num">Rated n={summary.values.length.toLocaleString()} · documented {summary.denominator.total.toLocaleString()} · coverage {(summary.denominator.total ? summary.denominator.rated / summary.denominator.total * 100 : 0).toFixed(1)}%</span>
      <span className="num">median {median === null ? "—" : ratingStars(median)} · mean {average === null ? "—" : ratingStars(average)} · max {maximum === null ? "—" : ratingStars(maximum)}</span>
      <span className="num">4★+ {fourPlus.toLocaleString()} · 5★+ {fivePlus.toLocaleString()} · {span}</span>
    </div>
  );
}
