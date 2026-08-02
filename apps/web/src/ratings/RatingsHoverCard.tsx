import { forwardRef, useEffect, useMemo, useState } from "react";
import type { TimelineEvent } from "@kayfabe/graph-contract";
import { dayToDate } from "@kayfabe/graph-contract";
import { loadYear } from "../data/loader";
import { useStore } from "../state/store";
import { exactRecord, formatCoverage, ratingStars, RF } from "./ratingsAdapter";
import { useRatings } from "./ratingsStore";

interface Props {
  onEnter: (id: string) => void;
  onLeave: (id: string) => void;
  onFocusRequested: (id: string) => void;
}

export const RatingsHoverCard = forwardRef<HTMLDivElement, Props>(function RatingsHoverCard(
  { onEnter, onLeave, onFocusRequested },
  ref,
) {
  const hovered = useRatings((state) => state.hovered);
  const data = useRatings((state) => state.data);
  const layout = useRatings((state) => state.layout);
  const threshold = useRatings((state) => state.controls.threshold);
  const [detail, setDetail] = useState<TimelineEvent | null>(null);
  const exact = useMemo(() => {
    if (!data || hovered?.kind !== "match") return null;
    const index = data.exactIndexById.get(hovered.id);
    return index === undefined ? null : exactRecord(data, index);
  }, [data, hovered]);
  const aggregate = hovered?.kind === "aggregate"
    ? layout?.aggregates.find((bin) => bin.key === hovered.id) ?? null
    : null;
  const aggregateLane = aggregate
    ? layout?.lanes.find((lane) => lane.z === aggregate.z) ?? null
    : null;
  const promotionLane = hovered?.kind === "promotion"
    ? layout?.lanes.find((lane) => `promotion:${lane.id}` === hovered.id) ?? null
    : null;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    if (!exact) return;
    const year = dayToDate(exact.day).getUTCFullYear();
    void loadYear(year).then((records) => {
      if (!cancelled) setDetail(records.find((record) => record.m === exact.id) ?? null);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [exact]);

  if (!hovered || (!exact && !aggregate && !promotionLane)) return null;
  const identity = hovered.id;
  return (
    <div
      ref={ref}
      className="ratings-hover-card"
      data-rating-hover={identity}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") onEnter(identity); }}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") onLeave(identity); }}
    >
      {exact ? (
        <>
          <div className="rating-card-calibration">
            <strong className="num">{ratingStars(exact.rating)}</strong>
            <span>reported</span>
          </div>
          <div className="ratings-card-title">
            {detail?.w.concat(detail.l).map((id) => personName(data!, id)).join(" · ") ?? exact.participantNames.join(" · ")}
          </div>
          <div className="ratings-card-meta num">
            {exact.date}{exact.flags & RF.APPROXIMATE ? " · approximate date" : ""} · {exact.promotionName}
          </div>
          {detail && (
            <dl className="ratings-card-dl">
              <dt>Event</dt><dd>{detail.en || exact.eventName || "Not reported"}</dd>
              <dt>Location</dt><dd>{detail.loc || "Not reported"}</dd>
              <dt>Participants</dt><dd>{detail.w.map((id) => personName(data!, id)).join(" · ")} vs {detail.l.map((id) => personName(data!, id)).join(" · ")}</dd>
              <dt>Form</dt><dd>{humanForm(detail.form)}{detail.stip ? ` · ${detail.stip}` : ""}</dd>
              <dt>Result</dt><dd>{detail.w.map((id) => personName(data!, id)).join(" · ")} {detail.res || "vs"} {detail.l.map((id) => personName(data!, id)).join(" · ")}{detail.fin ? ` · ${detail.fin}` : ""}</dd>
              <dt>Title</dt><dd>{exact.titleNames.length ? `${exact.titleNames.join(" · ")}${detail.tc ? " · documented title change" : " · title match"}` : "No title recorded"}</dd>
              <dt>PPV</dt><dd>{exact.flags & RF.PPV ? "Reported PPV match" : "Not flagged as PPV"}</dd>
              <dt>Duration</dt><dd>{detail.dur === null ? "Not reported" : formatDuration(detail.dur)}</dd>
            </dl>
          )}
          <p className="ratings-emphasis-note">
            {exact.id === useRatings.getState().selectedMatchId
              ? "Emphasized because this match is locked."
              : exact.rating >= threshold
                ? `Emphasized because it crosses the ${threshold}★ datum.`
                : "Emphasized by pointer or keyboard focus."}
          </p>
          <div className="ratings-card-actions">
            <button type="button" onClick={() => useRatings.getState().selectMatch(exact.id)}>Lock selection</button>
            <button type="button" onClick={() => onFocusRequested(exact.id)}>Focus peak</button>
            <button type="button" onClick={() => useRatings.getState().togglePinMatch(exact.id)}>Pin peak</button>
            <button type="button" onClick={() => setComparison("a", exact.participantIds[0] ?? exact.promotionId)}>Set A</button>
            <button type="button" onClick={() => setComparison("b", exact.participantIds[1] ?? exact.promotionId)}>Set B</button>
            {exact.participantIds[0] && <button type="button" onClick={() => openEntity(exact.participantIds[0]!, "morph")}>Participant in Morph Lab</button>}
            {exact.participantIds[0] && <button type="button" onClick={() => openEntity(exact.participantIds[0]!, "connectome")}>Participant in Connectome</button>}
            <button type="button" onClick={() => copyLink(exact.id)}>Copy deep link</button>
          </div>
          <p className="ratings-source-note">Reported Meltzer rating as supplied by the canonical CSV enrichment. Missing ratings are not zero.</p>
        </>
      ) : aggregate ? (
        <>
          <div className="rating-card-calibration"><strong>{aggregate.startDay === aggregate.endDay ? exactDate(aggregate.startDay) : `${yearOf(aggregate.startDay)} bin`}</strong><span>aggregate</span></div>
          <div className="ratings-card-title">{aggregate.promotionId
            ? promotionName(data!, aggregate.promotionId)
            : aggregate.coverageBasis === "global-denominator"
              ? "All reported ratings"
              : aggregateLane?.name ?? "Current scope"}</div>
          <div className="ratings-card-meta num">{exactDate(aggregate.startDay)} → {exactDate(aggregate.endDay)}</div>
          <dl className="ratings-card-dl">
            <dt>Rated sample</dt><dd>{aggregate.ratedCount.toLocaleString()} matches</dd>
            <dt>Coverage</dt><dd>{aggregate.coverageBasis !== "derived-context-no-denominator" && aggregate.coverageRatedCount !== null
              ? formatCoverage(aggregate.coverageRatedCount, aggregate.totalCount)
              : "Not attributable to this derived context lane; see the scope denominator."}</dd>
            <dt>Reported range</dt><dd>{ratingStars(aggregate.min)} → {ratingStars(aggregate.max)}</dd>
            <dt>Median</dt><dd>{ratingStars(aggregate.median)} · n={aggregate.ratedCount}</dd>
            <dt>Mean</dt><dd>{ratingStars(aggregate.mean)} · n={aggregate.ratedCount}</dd>
            <dt>Thresholds</dt><dd>{aggregate.fourPlus} at 4★+ · {aggregate.fivePlus} at 5★+</dd>
            <dt>Dates</dt><dd>{aggregate.approximateCount} approximate</dd>
          </dl>
          <p className="ratings-emphasis-note">{aggregate.coverageBasis === "global-denominator"
            ? "Height is the maximum reported rating. The thin embedded trace is the median. Chronological width is the bin span; depth is neutral in the global view. The rated sample and coverage counts are disclosed above. This is not one match."
            : "Height is the maximum reported rating. The thin embedded trace is the median. Chronological width is the bin span; ridge depth reflects rated-match density. This is not one match."}</p>
          <div className="ratings-card-actions">
            <button type="button" onClick={() => zoomAggregate(aggregate.startDay, aggregate.endDay)}>Open exact matches</button>
          </div>
        </>
      ) : promotionLane ? (
        <>
          <div className="rating-card-calibration"><strong>{promotionLane.name}</strong><span>coverage rail</span></div>
          <dl className="ratings-card-dl">
            <dt>Visible rated</dt><dd>{promotionLane.visibleRatedCount.toLocaleString()}</dd>
            <dt>Source-rated</dt><dd>{promotionLane.ratedCount.toLocaleString()}</dd>
            <dt>Documented</dt><dd>{promotionLane.totalCount.toLocaleString()}</dd>
            <dt>Coverage</dt><dd>{formatCoverage(promotionLane.ratedCount, promotionLane.totalCount)}</dd>
            <dt>Encoding</dt><dd>Muted gray is all documented matches; the warm overlay is the subset carrying a reported rating.</dd>
          </dl>
          <p className="ratings-emphasis-note">An empty or faint warm rail means weak reported-rating coverage, not a low match rating. Missing is not zero.</p>
          <div className="ratings-card-actions">
            <button type="button" onClick={() => openPromotion(promotionLane.id)}>Focus promotion</button>
            <button type="button" onClick={() => setComparison("a", promotionLane.id)}>Set comparison A</button>
            <button type="button" onClick={() => setComparison("b", promotionLane.id)}>Set comparison B</button>
            <button type="button" onClick={() => openEntity(promotionLane.id, "connectome")}>Open in Connectome</button>
          </div>
        </>
      ) : null}
    </div>
  );
});

function personName(data: NonNullable<ReturnType<typeof useRatings.getState>["data"]>, id: string): string {
  const index = data.participantIndexById.get(id);
  return index === undefined ? id : data.dictionaries.participants.name[index]!;
}

function promotionName(data: NonNullable<ReturnType<typeof useRatings.getState>["data"]>, id: string): string {
  const index = data.promotionIndexById.get(id);
  return index === undefined ? id : data.dictionaries.promotions.name[index]!;
}

function humanForm(value: string): string {
  return value.replaceAll("_", " ");
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function yearOf(day: number): number { return dayToDate(day).getUTCFullYear(); }
function exactDate(day: number): string { return dayToDate(day).toISOString().slice(0, 10); }

function setComparison(which: "a" | "b", id: string): void {
  useRatings.getState().setCompare(which, id);
}

function openPromotion(id: string): void {
  useStore.getState().select({ kind: "node", id });
}

function openEntity(id: string, lens: "morph" | "connectome"): void {
  const shared = useStore.getState();
  shared.select({ kind: "node", id });
  shared.setLens(lens);
  if (lens === "connectome" && shared.model?.indexOfId.has(id)) shared.focus(id);
}

async function copyLink(id: string): Promise<void> {
  useRatings.getState().selectMatch(id);
  await new Promise((resolve) => setTimeout(resolve, 180));
  try {
    await navigator.clipboard.writeText(location.href);
    useStore.getState().announce("Ratings match link copied.");
  } catch {
    useStore.getState().announce(`Copy failed — the ratings link is ${location.href}`);
  }
}

function zoomAggregate(dayMin: number, dayMax: number): void {
  useStore.getState().setFilters({ dayMin, dayMax });
  void useRatings.getState().rebuild();
  useRatings.getState().requestFit();
}
