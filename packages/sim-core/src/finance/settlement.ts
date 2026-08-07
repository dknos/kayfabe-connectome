/**
 * ledger@1, part one: turning shows and weeks into typed transactions.
 *
 * Every revenue/expense line becomes exactly one Transaction (amount
 * positive, direction carries sign), so tests can prove lines and ledger
 * agree to the cent. Zero-amount lines are skipped — a $0 transaction is
 * noise, and applyTransactions rejects non-positive amounts. All rates and
 * shares are documented in docs/simulator/rules/finance.md.
 */

import type {
  CompanyState,
  ContractState,
  EraProfile,
  ExpenseCategory,
  IsoDate,
  PersonId,
  RevenueCategory,
  RevenueLine,
  ShowPlan,
  Transaction,
  Venue,
} from "@kayfabe/sim-contract";
import { addCents, assertCents, scaleCents } from "../money";
import { affinityFactor } from "./attendance";

export const LEDGER_METHOD = "ledger@1";

/** Promoter's share of PPV gross after the carrier split. */
const PPV_CARRIER_SHARE = 0.45;
/** Reachable national PPV audience at 100 awareness, +100 affinity. */
const NATIONAL_PPV_AUDIENCE = 20_000_000;
/** Merch per head = era-typical ticket × (base + affinity share). */
const MERCH_RATE_BASE = 0.08;
const MERCH_RATE_AFFINITY = 0.22;

interface SettledLine {
  label: string;
  amountCents: number;
  category: RevenueCategory | ExpenseCategory;
  personId: PersonId | null;
}

function sumLines(lines: SettledLine[]): number {
  let total = 0;
  for (const line of lines) total = addCents(total, line.amountCents);
  return total;
}

export function settleShow(args: {
  show: ShowPlan;
  company: CompanyState;
  venue: Venue;
  attendance: number;
  era: EraProfile;
  appearanceWorkers: { contract: ContractState }[];
  nextTxId: () => string;
}): {
  revenue: RevenueLine[];
  expenses: RevenueLine[];
  transactions: Transaction[];
  profitCents: number;
} {
  const { show, company, venue, era, attendance, nextTxId } = args;
  if (show.companyId !== company.id) {
    throw new Error(`settleShow: show ${show.id} belongs to ${show.companyId}, not ${company.id}`);
  }
  if (!Number.isSafeInteger(attendance) || attendance < 0) {
    throw new Error(`settleShow: attendance must be a non-negative integer, got ${attendance}`);
  }

  const revenue: SettledLine[] = [];
  const expenses: SettledLine[] = [];

  const tickets = scaleCents(show.ticketPriceCents, attendance);
  if (tickets > 0) {
    revenue.push({ label: "Ticket sales", amountCents: tickets, category: "tickets", personId: null });
  }

  if (show.showType === "ppv" && era.ppvAvailable && era.ppvBuyRateBase > 0 && era.ppvPriceCents > 0) {
    const awareness01 = Math.min(100, Math.max(0, company.standing.awarenessNational)) / 100;
    const audience = NATIONAL_PPV_AUDIENCE * awareness01 * affinityFactor(company.standing.affinityNational);
    // Card appeal proxy: settlement never sees the advertised roster, but a
    // building's fill rate is live evidence of how hot the card was.
    const hotShow = venue.capacity > 0 ? 0.5 + 0.75 * Math.min(1, attendance / venue.capacity) : 0.5;
    const buys = Math.round(audience * era.ppvBuyRateBase * hotShow);
    if (buys > 0) {
      const net = scaleCents(scaleCents(era.ppvPriceCents, buys), PPV_CARRIER_SHARE);
      if (net > 0) {
        revenue.push({
          label: `Pay-per-view (${buys} buys, net of carrier split)`,
          amountCents: net,
          category: "ppv",
          personId: null,
        });
      }
    }
  }

  const affinity01 = (Math.min(100, Math.max(-100, company.standing.affinityNational)) + 100) / 200;
  const merchPerHead = scaleCents(
    era.ticketPriceTypicalCents,
    MERCH_RATE_BASE + MERCH_RATE_AFFINITY * affinity01,
  );
  const merch = scaleCents(merchPerHead, attendance);
  if (merch > 0) {
    revenue.push({ label: "Merchandise", amountCents: merch, category: "merchandise", personId: null });
  }

  const rental = assertCents(venue.rentalCents, `venue ${venue.id} rentalCents`);
  if (rental > 0) {
    expenses.push({
      label: `Venue rental — ${venue.name}`,
      amountCents: rental,
      category: "venue_rental",
      personId: null,
    });
  }

  const overhead = era.showOverheadCents[company.sizeTier];
  if (overhead > 0) {
    expenses.push({
      label: "Production & travel",
      amountCents: assertCents(overhead, "showOverheadCents"),
      category: "production",
      personId: null,
    });
  }

  const appearances = [...args.appearanceWorkers].sort((a, b) =>
    a.contract.id < b.contract.id ? -1 : a.contract.id > b.contract.id ? 1 : 0,
  );
  for (const { contract } of appearances) {
    // Exclusive downside talent is paid through the weekly guarantee, never
    // per show — paying both would double-count the same labor.
    if (contract.exclusive && contract.weeklyDownsideCents > 0) continue;
    const fee = assertCents(contract.perAppearanceCents, `contract ${contract.id} perAppearanceCents`);
    if (fee <= 0) continue;
    expenses.push({
      label: `Appearance fee — ${contract.personId}`,
      amountCents: fee,
      category: "appearance_fees",
      personId: contract.personId,
    });
  }

  const toTransaction = (line: SettledLine, direction: "in" | "out"): Transaction => ({
    id: nextTxId(),
    date: show.date,
    companyId: company.id,
    direction,
    amountCents: line.amountCents,
    category: line.category,
    memo: line.label,
    showId: show.id,
    personId: line.personId,
  });

  const transactions: Transaction[] = [];
  for (const line of revenue) transactions.push(toTransaction(line, "in"));
  for (const line of expenses) transactions.push(toTransaction(line, "out"));

  return {
    revenue: revenue.map((l) => ({ label: l.label, amountCents: l.amountCents })),
    expenses: expenses.map((l) => ({ label: l.label, amountCents: l.amountCents })),
    transactions,
    profitCents: addCents(sumLines(revenue), -sumLines(expenses)),
  };
}

/**
 * The weekly financial tick for one company: downside guarantees for every
 * active contract that carries one, office overhead for the size tier, and
 * TV rights income when a deal exists. Show-driven money never flows here.
 */
export function runWeeklyFinances(args: {
  company: CompanyState;
  activeContracts: ContractState[];
  era: EraProfile;
  date: IsoDate;
  nextTxId: () => string;
}): Transaction[] {
  const { company, era, date, nextTxId } = args;
  const transactions: Transaction[] = [];

  const contracts = [...args.activeContracts].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const contract of contracts) {
    if (contract.companyId !== company.id) {
      throw new Error(
        `runWeeklyFinances: contract ${contract.id} belongs to ${contract.companyId}, not ${company.id}`,
      );
    }
    if (contract.status !== "active") continue;
    const downside = assertCents(contract.weeklyDownsideCents, `contract ${contract.id} weeklyDownsideCents`);
    if (downside <= 0) continue;
    transactions.push({
      id: nextTxId(),
      date,
      companyId: company.id,
      direction: "out",
      amountCents: downside,
      category: "talent_payroll",
      memo: "Weekly downside guarantee",
      showId: null,
      personId: contract.personId,
    });
  }

  const overhead = era.weeklyOverheadCents[company.sizeTier];
  if (overhead > 0) {
    transactions.push({
      id: nextTxId(),
      date,
      companyId: company.id,
      direction: "out",
      amountCents: assertCents(overhead, "weeklyOverheadCents"),
      category: "office_overhead",
      memo: "Office & administrative overhead",
      showId: null,
      personId: null,
    });
  }

  if (company.tvDeal && company.tvDeal.weeklyRightsCents > 0) {
    transactions.push({
      id: nextTxId(),
      date,
      companyId: company.id,
      direction: "in",
      amountCents: assertCents(company.tvDeal.weeklyRightsCents, "tvDeal.weeklyRightsCents"),
      category: "broadcast_rights",
      memo: `TV rights — ${company.tvDeal.programName}`,
      showId: null,
      personId: null,
    });
  }

  return transactions;
}
