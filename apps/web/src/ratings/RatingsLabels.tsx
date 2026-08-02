import { dayToDate } from "@kayfabe/graph-contract";
import { useRatings } from "./ratingsStore";

/** Accessible axis/scope semantics paired with the aria-hidden WebGL canvas. */
export function RatingsLabels() {
  const layout = useRatings((state) => state.layout);
  const scopeLabel = useRatings((state) => state.scopeLabel);
  const data = useRatings((state) => state.data);
  if (!layout) return null;
  const date = (day: number) => dayToDate(day).toISOString().slice(0, 10);
  const globalChronology = layout.mode === "promotions";
  return (
    <>
      <div className="visually-hidden" id="ratings-axis-description">
        Meltzer Ratings, {scopeLabel}. The x axis is chronological date from {date(layout.dayRange[0])} through {date(layout.dayRange[1])}.
        The y axis is exact reported Meltzer rating from {layout.ratingRange[0]} through {layout.ratingRange[1]}, with zero as baseline.
        Negative ratings extend below baseline and ratings above five extend beyond the five-star threshold plane.
        {globalChronology
          ? " The landing chronology does not encode promotion or another category in depth; position is determined only by time and exact reported rating."
          : ` The z axis contains ${layout.lanes.length} promotion, opponent, or comparison context lanes.`}
        Gray rails show all documented matches; warm rails show records carrying a reported rating. Missing is not zero.
      </div>
      <section className="visually-hidden" aria-label="Visible aggregate ridge semantics">
        <h2>Aggregate rating bins</h2>
        <ul>
          {layout.aggregates.map((bin) => {
            const promotionIndex = bin.promotionId ? data?.promotionIndexById.get(bin.promotionId) : undefined;
            const promotion = bin.promotionId
              ? promotionIndex === undefined ? bin.promotionId : data!.dictionaries.promotions.name[promotionIndex]!
              : null;
            const lane = layout.lanes.find((item) => item.z === bin.z)?.name ?? promotion ?? "Current scope";
            const coverage = bin.coverageBasis === "global-denominator" && bin.coverageRatedCount !== null
              ? `Global coverage is ${bin.coverageRatedCount} source-rated matches of ${bin.totalCount} documented matches.`
              : bin.coverageBasis === "promotion-denominator" && bin.coverageRatedCount !== null
                ? `Promotion coverage is ${bin.coverageRatedCount} source-rated matches of ${bin.totalCount} documented matches.`
              : "A documented denominator is not attributed to this derived context lane; the scope inspector provides the denominator.";
            const identity = bin.coverageBasis === "global-denominator"
              ? "Global chronology"
              : `${lane} context${promotion ? `, ${promotion}` : ""}`;
            const depth = bin.coverageBasis === "global-denominator"
              ? `Depth is neutral; the rated sample contains ${bin.ratedCount} matches.`
              : `Ridge depth represents a rated sample of ${bin.ratedCount} matches.`;
            return <li key={bin.key}>{identity}, {date(bin.startDay)} through {date(bin.endDay)}. Aggregate bin, not one match. Height is maximum reported rating {bin.max}; embedded trace is median {bin.median}; chronological width is the bin span. {depth} {coverage}</li>;
          })}
        </ul>
      </section>
    </>
  );
}
