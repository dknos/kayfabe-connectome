import type { AiDecisionRecord, IsoDate, Venue } from "@kayfabe/sim-contract";
import { addDays, dayOfWeek, diffDays } from "../dates";
import { scaleCents } from "../money";
import type { AiTickContext, NewShow } from "./types";
import { aiSortedKeys, hashPick } from "./util";

/** How far ahead the weekly TV pipeline is kept filled. */
const TV_HORIZON_DAYS = 21;
/** How far ahead the monthly marquee event is placed. */
const PPV_HORIZON_DAYS = 42;

/** Original event-name pool; picked by company/month hash, never rng. */
const PPV_NAME_POOL = [
  "Collision Course",
  "Crowning Glory",
  "Full Throttle",
  "High Stakes",
  "Point of No Return",
  "Uprising",
] as const;

export interface ScheduleResult {
  shows: NewShow[];
  decisions: AiDecisionRecord[];
}

/** Venues in the home market, else same region, else anywhere — sorted. */
function venueCandidates(ctx: AiTickContext): Venue[] {
  const all = aiSortedKeys(ctx.venues).map((id) => ctx.venues[id]!);
  const home = all.filter((v) => v.marketId === ctx.company.homeMarketId);
  if (home.length > 0) return home;
  const homeMarket = ctx.markets[ctx.company.homeMarketId];
  if (homeMarket) {
    const region = all.filter(
      (v) => ctx.markets[v.marketId]?.region === homeMarket.region,
    );
    if (region.length > 0) return region;
  }
  return all;
}

/** Sunday of week-of-month `week` (1-based); steps back if it spills over. */
function ppvDateFor(year: number, month: number, week: number): IsoDate {
  const first: IsoDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
  const firstSunday = addDays(first, (6 - dayOfWeek(first) + 7) % 7);
  let candidate = addDays(firstSunday, (Math.max(1, Math.min(5, week)) - 1) * 7);
  if (candidate.slice(0, 7) !== first.slice(0, 7)) candidate = addDays(candidate, -7);
  return candidate;
}

function venueConsidered(candidates: Venue[]): { option: string; utility: number }[] {
  return [...candidates]
    .sort((a, b) => b.capacity - a.capacity || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((v) => ({ option: v.id, utility: v.capacity }));
}

/**
 * Keep the weekly TV show filled TV_HORIZON_DAYS ahead and place the
 * monthly marquee event (national/regional companies with a ppvWeek).
 * House shows are out of scope for the slice. Consumes no rng draws.
 */
export function planSchedule(ctx: AiTickContext): ScheduleResult {
  const shows: NewShow[] = [];
  const decisions: AiDecisionRecord[] = [];
  const { company, era } = ctx;

  const candidates = venueCandidates(ctx);
  if (candidates.length === 0) return { shows, decisions };

  const bookedDates = new Set<IsoDate>();
  const ppvMonths = new Set<string>();
  for (const id of aiSortedKeys(ctx.shows)) {
    const s = ctx.shows[id]!;
    if (s.companyId !== company.id || s.status !== "scheduled") continue;
    bookedDates.add(s.date);
    if (s.showType === "ppv") ppvMonths.add(s.date.slice(0, 7));
  }

  if (company.tvDeal && era.tvAvailable) {
    for (let d = 1; d <= TV_HORIZON_DAYS; d++) {
      const dt = addDays(ctx.date, d);
      if (dayOfWeek(dt) !== company.tvDeal.dayOfWeek || bookedDates.has(dt)) continue;
      const venue = candidates[hashPick(`${company.id}:${dt}:venue`, candidates.length)]!;
      const show: NewShow = {
        id: ctx.nextId("show"),
        companyId: company.id,
        name: company.tvDeal.programName,
        date: dt,
        venueId: venue.id,
        marketId: venue.marketId,
        showType: "tv",
        ticketPriceCents: era.ticketPriceTypicalCents,
      };
      shows.push(show);
      bookedDates.add(dt);
      decisions.push({
        seq: 0,
        date: ctx.date,
        companyId: company.id,
        action: `schedule-show:${show.id}`,
        reason: `tv-cadence:${dt}`,
        considered: venueConsidered(candidates),
      });
    }
  }

  const wantsPpv =
    company.ppvWeek !== null &&
    era.ppvAvailable &&
    (company.sizeTier === "national" || company.sizeTier === "regional");
  if (wantsPpv) {
    const year = Number(ctx.date.slice(0, 4));
    const month = Number(ctx.date.slice(5, 7));
    let target = ppvDateFor(year, month, company.ppvWeek!);
    if (diffDays(ctx.date, target) < 1) {
      const nextMonth = month === 12 ? 1 : month + 1;
      target = ppvDateFor(month === 12 ? year + 1 : year, nextMonth, company.ppvWeek!);
    }
    const ym = target.slice(0, 7);
    const lead = diffDays(ctx.date, target);
    if (lead >= 1 && lead <= PPV_HORIZON_DAYS && !ppvMonths.has(ym) && !bookedDates.has(target)) {
      const venue = [...candidates].sort(
        (a, b) => b.capacity - a.capacity || (a.id < b.id ? -1 : 1),
      )[0]!;
      const name = `${company.shortName} ${
        PPV_NAME_POOL[hashPick(`${company.id}:${ym}:ppv`, PPV_NAME_POOL.length)]!
      }`;
      const show: NewShow = {
        id: ctx.nextId("show"),
        companyId: company.id,
        name,
        date: target,
        venueId: venue.id,
        marketId: venue.marketId,
        showType: "ppv",
        ticketPriceCents: scaleCents(era.ticketPriceTypicalCents, 1.5),
      };
      shows.push(show);
      decisions.push({
        seq: 0,
        date: ctx.date,
        companyId: company.id,
        action: `schedule-show:${show.id}`,
        reason: `ppv-monthly:${target}`,
        considered: venueConsidered(candidates),
      });
    }
  }

  return { shows, decisions };
}
