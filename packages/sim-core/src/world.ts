import type { SimState } from "@kayfabe/sim-contract";
import { dayOfWeek, diffDays } from "./dates";
import { nextId } from "./ids";
import { sortedKeys } from "./ids";

/**
 * Daily world upkeep: recovery, decay, expiries, reminders. Runs before AI
 * and shows each day. Everything bounded and deterministic.
 */
export function dailyWorldTick(state: SimState): void {
  const date = state.currentDate;

  for (const pid of sortedKeys(state.workers)) {
    const w = state.workers[pid]!;
    if (!w.active) continue;
    const c = w.condition;
    c.fatigue = Math.max(0, c.fatigue - 6);
    c.daysSinceMatch += 1;
    if (c.injury && c.injury.outUntil <= date) {
      state.news.push({
        id: nextId(state, "news"),
        date,
        kind: "injury",
        headline: `${w.name} cleared to return`,
        body: `${w.name} has recovered from a ${c.injury.severity} ${c.injury.kind} and is available again.`,
        companyId: null,
        personIds: [pid],
        rumor: false,
      });
      c.injury = null;
    }
    // Momentum cools toward zero without exposure.
    if (c.daysSinceMatch > 10) {
      w.momentum = w.momentum > 0 ? Math.max(0, w.momentum - 1) : Math.min(0, w.momentum + 1);
    }
    // Affinity drifts slowly toward zero when unseen (out of sight, out of heart).
    if (c.daysSinceMatch > 45 && dayOfWeek(date) === 0) {
      const s = w.standing;
      s.affinityNational =
        s.affinityNational > 0 ? Math.max(0, s.affinityNational - 1) : Math.min(0, s.affinityNational + 1);
    }
  }

  // Storyline heat decays when nothing has happened lately.
  for (const sid of sortedKeys(state.storylines)) {
    const story = state.storylines[sid]!;
    if (story.phase === "concluded" || story.phase === "abandoned") continue;
    const lastBeat = story.beats.length > 0 ? story.beats[story.beats.length - 1]!.date : story.startDate;
    if (diffDays(lastBeat, date) > 10 && dayOfWeek(date) === 0) {
      story.heat = Math.max(0, story.heat - 3);
    }
  }

  // Contract expiries.
  for (const cid of sortedKeys(state.contracts)) {
    const contract = state.contracts[cid]!;
    if (contract.status !== "active" || contract.endDate === null) continue;
    if (contract.endDate <= date) {
      contract.status = "expired";
      const w = state.workers[contract.personId];
      const company = state.companies[contract.companyId];
      if (w && company) {
        state.news.push({
          id: nextId(state, "news"),
          date,
          kind: "business",
          headline: `${w.name}'s deal with ${company.shortName} is up`,
          body: `${w.name}'s contract with ${company.name} has expired. They are testing the market.`,
          companyId: contract.companyId,
          personIds: [contract.personId],
          rumor: false,
        });
      }
    } else if (
      contract.companyId === state.meta.options.playerCompanyId &&
      diffDays(date, contract.endDate) === 14
    ) {
      const w = state.workers[contract.personId];
      if (w) {
        state.inbox.push({
          id: nextId(state, "inbox"),
          date,
          kind: "contract_expiry",
          title: `${w.name}'s contract expires in two weeks`,
          body: `${w.name} (${w.push.replace("_", " ")}) is due for renewal on ${contract.endDate}. Make an offer from their profile before a rival does.`,
          relatedPersonId: contract.personId,
          relatedShowId: null,
          resolved: false,
        });
      }
    }
  }

  // Remind the player about unbooked shows 3 days out.
  for (const sid of sortedKeys(state.shows)) {
    const show = state.shows[sid]!;
    if (
      show.companyId === state.meta.options.playerCompanyId &&
      show.status === "scheduled" &&
      show.segments.length === 0 &&
      diffDays(date, show.date) === 3
    ) {
      state.inbox.push({
        id: nextId(state, "inbox"),
        date,
        kind: "show_due",
        title: `${show.name} is three days out and unbooked`,
        body: `${show.name} on ${show.date} has no card yet. An empty card means a cancelled show and an unhappy building.`,
        relatedPersonId: null,
        relatedShowId: sid,
        resolved: false,
      });
    }
  }
}
