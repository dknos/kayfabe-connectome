import type {
  AiDecisionRecord,
  ContractId,
  ContractState,
  PersonId,
  WorkerState,
} from "@kayfabe/sim-contract";
import { diffDays } from "../dates";
import { aiOfferFor } from "../market";
import type { AiContractOffer, AiTickContext } from "./types";
import { aiSortedKeys, isAvailable, pushRank } from "./util";

export interface RosterResult {
  offers: AiContractOffer[];
  releases: ContractId[];
  decisions: AiDecisionRecord[];
}

/** Contracts this close to expiry trigger a re-sign attempt. */
const RESIGN_WINDOW_DAYS = 30;
/** Free agents this well-known count as "hot". */
const HOT_AWARENESS = 55;
/** Solvency horizon: cash must cover this many weeks of downside. */
const BUDGET_WEEKS = 8;

interface ProposedOffer {
  offer: AiContractOffer;
  reason: string;
  considered: { option: string; utility: number }[];
}

/**
 * Contract upkeep: re-sign expiring pushed talent, cut unused talent when
 * cash has gone negative, and occasionally chase a hot free agent. Every
 * proposal passes an 8-week solvency check (cash − BUDGET_WEEKS × total
 * weekly downside must stay positive; the projection is deliberately
 * conservative — it double-counts a re-signed deal's overlap weeks).
 */
export function upkeepRoster(ctx: AiTickContext): RosterResult {
  const decisions: AiDecisionRecord[] = [];
  const releases: ContractId[] = [];
  const { company } = ctx;

  const companyContracts = [...(ctx.contractsByCompany[company.id] ?? [])].sort(
    (a, b) => (a.id < b.id ? -1 : 1),
  );
  let committedWeekly = 0;
  for (const c of companyContracts) committedWeekly += c.weeklyDownsideCents;

  // Releases: only under cash pressure, and only workers going unused.
  if (company.cashCents < 0) {
    for (const c of companyContracts) {
      const w = ctx.workers[c.personId];
      if (!w || w.push !== "unused") continue;
      releases.push(c.id);
      committedWeekly -= c.weeklyDownsideCents;
      decisions.push({
        seq: 0,
        date: ctx.date,
        companyId: company.id,
        action: `release:${c.id}`,
        reason: "release:cash-pressure:unused",
        considered: [{ option: c.personId, utility: -c.weeklyDownsideCents }],
      });
    }
  }
  const released = new Set(releases);

  const proposals: ProposedOffer[] = [];

  // Re-sign contracts expiring inside the window, pushed workers only.
  const seen = new Set<PersonId>();
  const expiring = companyContracts
    .filter((c) => {
      if (released.has(c.id) || c.endDate === null) return false;
      const left = diffDays(ctx.date, c.endDate);
      return left >= 0 && left <= RESIGN_WINDOW_DAYS;
    })
    .map((c) => ({ contract: c, worker: ctx.workers[c.personId] }))
    .filter((x): x is { contract: ContractState; worker: WorkerState } => {
      return x.worker !== undefined && x.worker.active && x.worker.push !== "unused";
    })
    .sort(
      (a, b) =>
        pushRank(b.worker.push) - pushRank(a.worker.push) ||
        (a.worker.personId < b.worker.personId ? -1 : 1),
    );
  for (const { worker } of expiring) {
    if (seen.has(worker.personId)) continue;
    seen.add(worker.personId);
    proposals.push({
      offer: { personId: worker.personId, ...aiOfferFor(worker, company, ctx.era) },
      reason: "re-sign:expiring",
      considered: [
        {
          option: worker.personId,
          utility: pushRank(worker.push) + worker.standing.awarenessNational,
        },
      ],
    });
  }

  // Hot free agents: occasionally, appetite scaling with riskTolerance.
  const contracted = new Set<PersonId>();
  for (const cid of aiSortedKeys(ctx.contractsByCompany)) {
    for (const c of ctx.contractsByCompany[cid]!) contracted.add(c.personId);
  }
  const freeAgents: WorkerState[] = [];
  for (const pid of aiSortedKeys(ctx.workers)) {
    const w = ctx.workers[pid]!;
    if (contracted.has(pid) || !isAvailable(w, ctx.date)) continue;
    if (w.standing.awarenessNational > HOT_AWARENESS) freeAgents.push(w);
  }
  if (freeAgents.length > 0) {
    const appetite = 0.03 + company.aiProfile.riskTolerance / 1000;
    if (ctx.rng.chance(appetite)) {
      freeAgents.sort(
        (a, b) =>
          b.standing.awarenessNational - a.standing.awarenessNational ||
          (a.personId < b.personId ? -1 : 1),
      );
      const target = freeAgents[0]!;
      proposals.push({
        offer: { personId: target.personId, ...aiOfferFor(target, company, ctx.era) },
        reason: "sign:free-agent:hot",
        considered: freeAgents.slice(0, 3).map((w) => ({
          option: w.personId,
          utility: w.standing.awarenessNational,
        })),
      });
    }
  }

  // Solvency gate, in priority order (re-signs before free agents).
  const offers: AiContractOffer[] = [];
  let accumWeekly = 0;
  for (const p of proposals) {
    const projected =
      company.cashCents -
      BUDGET_WEEKS * (committedWeekly + accumWeekly + p.offer.weeklyDownsideCents);
    if (projected <= 0) {
      decisions.push({
        seq: 0,
        date: ctx.date,
        companyId: company.id,
        action: `offer-skipped:${p.offer.personId}`,
        reason: "offer-skipped:budget",
        considered: p.considered,
      });
      continue;
    }
    accumWeekly += p.offer.weeklyDownsideCents;
    offers.push(p.offer);
    decisions.push({
      seq: 0,
      date: ctx.date,
      companyId: company.id,
      action: `offer-contract:${p.offer.personId}`,
      reason: p.reason,
      considered: p.considered,
    });
  }

  return { offers, releases, decisions };
}
