import type {
  Command,
  CompanyState,
  ContractState,
  DomainEvent,
  EngineResult,
  Injury,
  IsoDate,
  OfferOutcome,
  ShowPlan,
  ShowReport,
  SimState,
  Transaction,
} from "@kayfabe/sim-contract";
import { RngHub } from "./rng";
import { addDays, dayOfWeek, diffDays } from "./dates";
import { nextId, sortedKeys } from "./ids";
import { dailyWorldTick } from "./world";
import { validateCard } from "./validate";
import { estimateAttendance, applyTransactions, resolveEra, runWeeklyFinances, settleShow } from "./finance";
import { simulateShowPerformance } from "./show";
import { evaluateOffer, askingPrice } from "./market";
import { aiDailyTick } from "./ai";

function emit(state: SimState, type: string, refs: DomainEvent["refs"]): void {
  const seq = (state.counters["event_seq"] ?? 0) + 1;
  state.counters["event_seq"] = seq;
  state.eventLog.push({ seq, date: state.currentDate, type, refs });
}

function activeContractsFor(state: SimState, companyId: string): ContractState[] {
  return sortedKeys(state.contracts)
    .map((id) => state.contracts[id]!)
    .filter((c) => c.companyId === companyId && c.status === "active");
}

function activeContractOf(state: SimState, personId: string): ContractState | null {
  for (const id of sortedKeys(state.contracts)) {
    const c = state.contracts[id]!;
    if (c.personId === personId && c.status === "active") return c;
  }
  return null;
}

function participantsOf(show: ShowPlan): string[] {
  const out = new Set<string>();
  for (const seg of show.segments) {
    if (seg.match) for (const side of seg.match.sides) for (const pid of side.members) out.add(pid);
    if (seg.angle) for (const beat of seg.angle.beats) for (const p of beat.participants) out.add(p.personId);
  }
  return [...out].sort();
}

/**
 * The full show pipeline: attendance → performance → settlement → effects.
 * Mutates state; returns the report. Same path for player and AI shows.
 */
function runShowInternal(state: SimState, show: ShowPlan, rng: RngHub): ShowReport {
  const company = state.companies[show.companyId]!;
  const venue = state.venues[show.venueId]!;
  const market = state.markets[show.marketId]!;
  const era = resolveEra(show.date);

  const participantIds = participantsOf(show);
  const advertisedIds = show.advertised.length > 0 ? show.advertised : participantIds;
  const advertisedWorkers = advertisedIds
    .map((pid) => state.workers[pid])
    .filter((w) => w !== undefined);

  const attendance = estimateAttendance({
    company,
    show,
    venue,
    market,
    advertisedWorkers,
    era,
    rng: rng.stream("attendance"),
  });

  const outcome = simulateShowPerformance({
    show,
    company,
    workers: state.workers,
    titles: state.titles,
    storylines: state.storylines,
    venue,
    market,
    attendance,
    rng: rng.stream("crowd"),
  });

  const appearanceWorkers = participantIds
    .map((pid) => activeContractOf(state, pid))
    .filter((c): c is ContractState => c !== null && c.companyId === show.companyId)
    .map((contract) => ({ contract }));

  const settle = settleShow({
    show,
    company,
    venue,
    attendance,
    era,
    appearanceWorkers,
    nextTxId: () => nextId(state, "tx"),
  });
  state.ledger.push(...settle.transactions);
  applyTransactions(company, settle.transactions);

  // Participant effects (all deltas are bounded by the show module).
  for (const seg of outcome.segments) {
    for (const eff of seg.participantEffects) {
      const w = state.workers[eff.personId];
      if (!w) continue;
      w.momentum = Math.max(-100, Math.min(100, w.momentum + eff.momentumDelta));
      w.morale = Math.max(0, Math.min(100, w.morale + eff.moraleDelta));
      w.credibility = Math.max(0, Math.min(100, w.credibility + eff.credibilityDelta));
      const s = w.standing;
      s.awarenessNational = Math.max(0, Math.min(100, s.awarenessNational + eff.awarenessDelta));
      s.affinityNational = Math.max(-100, Math.min(100, s.affinityNational + eff.affinityDelta));
      w.condition.fatigue = Math.max(0, Math.min(100, w.condition.fatigue + eff.fatigueDelta));
      if (seg.kind === "match") {
        w.condition.daysSinceMatch = 0;
        w.condition.wearMinutes += Math.round(eff.fatigueDelta > 0 ? eff.fatigueDelta : 0);
      }
      if (eff.injury) {
        const injury: Injury = {
          kind: eff.injury.kind,
          severity: eff.injury.severity,
          occurredOn: show.date,
          outUntil: eff.injury.outUntil,
          note: `Suffered at ${show.name}`,
        };
        w.condition.injury = injury;
        state.news.push({
          id: nextId(state, "news"),
          date: show.date,
          kind: "injury",
          headline: `${w.name} injured at ${show.name}`,
          body: `${w.name} suffered a ${injury.severity} ${injury.kind} and is expected out until ${injury.outUntil}.`,
          companyId: show.companyId,
          personIds: [eff.personId],
          rumor: false,
        });
        emit(state, "injury", { personId: eff.personId, until: injury.outUntil, severity: injury.severity });
      }
    }
  }

  // Title changes and defenses.
  const titleMatchIds = new Set(
    show.segments.filter((s) => s.match?.titleId).map((s) => s.match!.titleId as string),
  );
  for (const tc of outcome.titleChanges) {
    const title = state.titles[tc.titleId];
    if (!title) continue;
    const open = title.lineage[title.lineage.length - 1];
    if (open && open.toDate === null) open.toDate = show.date;
    title.lineage.push({
      holderIds: [...tc.newHolderIds].sort(),
      fromDate: show.date,
      toDate: null,
      wonAtShowId: show.id,
      historical: false,
    });
    title.holderIds = [...tc.newHolderIds].sort();
    title.defensesSinceChange = 0;
    title.prestige = Math.min(100, title.prestige + 1);
    const names = title.holderIds.map((p) => state.workers[p]?.name ?? p).join(" & ");
    state.news.push({
      id: nextId(state, "news"),
      date: show.date,
      kind: "title_change",
      headline: `New champion${title.holderIds.length > 1 ? "s" : ""}: ${names}`,
      body: `${names} captured the ${title.name} at ${show.name}.`,
      companyId: show.companyId,
      personIds: title.holderIds,
      rumor: false,
    });
    emit(state, "title_change", { titleId: tc.titleId, showId: show.id, holders: names });
    titleMatchIds.delete(tc.titleId);
  }
  for (const tid of [...titleMatchIds].sort()) {
    const title = state.titles[tid];
    if (title) title.defensesSinceChange += 1;
  }

  // Storyline progression from segments that carry a storyline.
  for (const seg of show.segments) {
    if (!seg.storylineId) continue;
    const story = state.storylines[seg.storylineId];
    if (!story || story.phase === "concluded" || story.phase === "abandoned") continue;
    const report = outcome.segments.find((r) => r.segmentId === seg.id);
    if (!report) continue;
    story.beats.push({
      date: show.date,
      showId: show.id,
      segmentId: seg.id,
      summary: report.headline,
    });
    const delta = Math.max(-5, Math.min(5, Math.round((report.reception - 50) / 10)));
    story.heat = Math.max(0, Math.min(100, story.heat + delta));
  }

  // Company standing responds to the night.
  const s = company.standing;
  const reach = show.showType === "tv" && company.tvDeal ? company.tvDeal.reach : 0;
  const awarenessGain = Math.min(2, attendance / Math.max(1, venue.capacity) + reach / 100);
  s.awarenessNational = Math.min(100, s.awarenessNational + awarenessGain * 0.4);
  const affinityDelta = Math.max(-3, Math.min(3, (outcome.overall - 55) / 12));
  s.affinityNational = Math.max(-100, Math.min(100, s.affinityNational + affinityDelta));
  company.momentum = Math.max(
    -100,
    Math.min(100, company.momentum + Math.max(-6, Math.min(6, (outcome.overall - 55) / 5))),
  );
  const md = s.marketDelta[show.marketId] ?? { awareness: 0, affinity: 0 };
  md.awareness = Math.min(25, md.awareness + 0.5);
  md.affinity = Math.max(-25, Math.min(25, md.affinity + affinityDelta * 0.5));
  s.marketDelta[show.marketId] = md;

  const report: ShowReport = {
    showId: show.id,
    date: show.date,
    attendance,
    capacity: venue.capacity,
    crowdStart: outcome.crowdStart,
    segments: outcome.segments,
    overall: outcome.overall,
    overallComponents: outcome.overallComponents,
    revenue: settle.revenue,
    expenses: settle.expenses,
    profitCents: settle.profitCents,
    notes: outcome.notes,
  };

  show.status = "completed";
  show.report = report;

  const best = [...outcome.segments].sort((a, b) => b.reception - a.reception)[0];
  state.news.push({
    id: nextId(state, "news"),
    date: show.date,
    kind: "show_results",
    headline: `${show.name}: ${outcome.overall >= 75 ? "a night to remember" : outcome.overall >= 55 ? "a solid outing" : "a rough night"} in ${market.name}`,
    body: `${company.name} drew ${attendance.toLocaleString("en-US")} to ${venue.name}.${
      best ? ` Standout: ${best.headline}.` : ""
    }`,
    companyId: show.companyId,
    personIds: [],
    rumor: false,
  });
  emit(state, "show_completed", { showId: show.id, overall: outcome.overall, attendance });

  return report;
}

function applyAiActions(state: SimState, company: CompanyState, rng: RngHub): void {
  const era = resolveEra(state.currentDate);
  const contractsByCompany: Record<string, ContractState[]> = {};
  for (const cid of sortedKeys(state.companies)) {
    contractsByCompany[cid] = activeContractsFor(state, cid);
  }

  const actions = aiDailyTick({
    company,
    date: state.currentDate,
    workers: state.workers,
    contractsByCompany,
    titles: state.titles,
    shows: state.shows,
    venues: state.venues,
    markets: state.markets,
    era,
    rng: rng.stream(`ai:${company.id}`),
    nextId: (prefix) => nextId(state, prefix),
  });

  for (const ns of actions.scheduleShows) {
    state.shows[ns.id] = {
      id: ns.id,
      companyId: ns.companyId,
      name: ns.name,
      date: ns.date,
      venueId: ns.venueId,
      marketId: ns.marketId,
      showType: ns.showType,
      ticketPriceCents: ns.ticketPriceCents,
      segments: [],
      advertised: [],
      status: "scheduled",
      report: null,
    };
  }

  for (const cu of actions.cardUpdates) {
    const show = state.shows[cu.showId];
    if (!show || show.status !== "scheduled") continue;
    const errors = validateCard(state, show, cu.segments);
    if (errors.length > 0) {
      const seq = (state.counters["ai_seq"] ?? 0) + 1;
      state.counters["ai_seq"] = seq;
      state.aiLedger.push({
        seq,
        date: state.currentDate,
        companyId: company.id,
        action: `card-rejected:${cu.showId}`,
        reason: errors[0]!,
        considered: [],
      });
      continue;
    }
    show.segments = cu.segments;
    show.advertised = cu.advertised;
  }

  company.programs = actions.programUpdates;

  for (const contractId of actions.releaseContractIds) {
    const contract = state.contracts[contractId];
    if (!contract || contract.status !== "active" || contract.companyId !== company.id) continue;
    contract.status = "terminated";
    const w = state.workers[contract.personId];
    if (w && w.standing.awarenessNational > 40) {
      state.news.push({
        id: nextId(state, "news"),
        date: state.currentDate,
        kind: "release",
        headline: `${company.shortName} releases ${w.name}`,
        body: `${company.name} has parted ways with ${w.name}.`,
        companyId: company.id,
        personIds: [contract.personId],
        rumor: false,
      });
    }
  }

  for (const offer of actions.offers) {
    const worker = state.workers[offer.personId];
    if (!worker) continue;
    const existing = activeContractOf(state, offer.personId);
    // AI may renegotiate its own deals; it cannot poach exclusive talent.
    if (existing && existing.companyId !== company.id && existing.exclusive) continue;
    const outcome = evaluateOffer({
      worker,
      company,
      offer: {
        kind: offer.kind,
        lengthMonths: offer.lengthMonths,
        perAppearanceCents: offer.perAppearanceCents,
        weeklyDownsideCents: offer.weeklyDownsideCents,
        exclusive: offer.exclusive,
      },
      era,
      rivalInterest: Math.min(100, worker.standing.awarenessNational),
      currentContract: existing,
      rng: rng.stream("negotiation"),
    });
    if (!outcome.accepted) continue;
    if (existing && existing.companyId === company.id) existing.status = "terminated";
    const contract: ContractState = {
      id: nextId(state, "contract"),
      personId: offer.personId,
      companyId: company.id,
      kind: offer.kind,
      exclusive: offer.exclusive,
      startDate: state.currentDate,
      endDate: addDays(state.currentDate, offer.lengthMonths * 30),
      perAppearanceCents: offer.perAppearanceCents,
      weeklyDownsideCents: offer.weeklyDownsideCents,
      promises: [],
      status: "active",
      signedDate: state.currentDate,
    };
    state.contracts[contract.id] = contract;
    if (worker.standing.awarenessNational > 50 && (!existing || existing.companyId !== company.id)) {
      state.news.push({
        id: nextId(state, "news"),
        date: state.currentDate,
        kind: "signing",
        headline: `${worker.name} signs with ${company.shortName}`,
        body: `${company.name} has signed ${worker.name} to a ${offer.exclusive ? "exclusive " : ""}${offer.kind} deal.`,
        companyId: company.id,
        personIds: [offer.personId],
        rumor: false,
      });
    }
    emit(state, "contract_signed", { personId: offer.personId, companyId: company.id, ai: true });
  }

  for (const d of actions.decisions) {
    const seq = (state.counters["ai_seq"] ?? 0) + 1;
    state.counters["ai_seq"] = seq;
    state.aiLedger.push({ ...d, seq });
  }
  // The AI ledger is diagnostic, not archival — cap its growth.
  if (state.aiLedger.length > 400) state.aiLedger.splice(0, state.aiLedger.length - 400);
}

/**
 * Weekly growth check (company-growth@1): a company that draws, banks, and
 * keeps running shows earns its next size tier — and the broadcast deal that
 * comes with it. Applies to player and AI companies alike; overheads scale
 * automatically with the new tier (finance reads sizeTier).
 */
function evaluateCompanyGrowth(state: SimState): void {
  const era = resolveEra(state.currentDate);
  const completedByCompany = new Map<string, number>();
  for (const sid of sortedKeys(state.shows)) {
    const show = state.shows[sid]!;
    if (show.status === "completed") {
      completedByCompany.set(show.companyId, (completedByCompany.get(show.companyId) ?? 0) + 1);
    }
  }
  for (const cid of sortedKeys(state.companies)) {
    const company = state.companies[cid]!;
    if (!company.active) continue;
    const shows = completedByCompany.get(cid) ?? 0;
    const aw = company.standing.awarenessNational;
    let promoted: string | null = null;
    if (company.sizeTier === "indie" && aw >= 35 && company.cashCents >= 25_000_000 && shows >= 10) {
      company.sizeTier = "regional";
      promoted = "regional";
    } else if (
      company.sizeTier === "regional" &&
      aw >= 55 &&
      company.cashCents >= 200_000_000 &&
      shows >= 30
    ) {
      company.sizeTier = "national";
      promoted = "national";
    }
    if (!promoted) continue;
    if (era.tvAvailable && company.tvDeal === null) {
      company.tvDeal = {
        programName: `${company.shortName} Prime`,
        dayOfWeek: promoted === "national" ? 0 : 5,
        weeklyRightsCents: era.weeklyTvRightsCents[company.sizeTier],
        reach: promoted === "national" ? 70 : 30,
      };
    } else if (company.tvDeal) {
      company.tvDeal.weeklyRightsCents = era.weeklyTvRightsCents[company.sizeTier];
      company.tvDeal.reach = promoted === "national" ? 70 : company.tvDeal.reach;
    }
    if (promoted === "national" && era.ppvAvailable) company.ppvWeek = 3;
    company.prestige = Math.min(100, company.prestige + 5);
    state.news.push({
      id: nextId(state, "news"),
      date: state.currentDate,
      kind: "business",
      headline:
        promoted === "regional"
          ? `${company.name} outgrows the armories`
          : `${company.name} goes national`,
      body:
        promoted === "regional"
          ? `${company.name} has broken through as a regional force${company.tvDeal ? `; ${company.tvDeal.programName} lands a weekly television slot` : ""}. Bigger buildings, bigger payrolls, bigger targets.`
          : `${company.name} is now a national promotion${company.ppvWeek ? " with a monthly pay-per-view slot" : ""}. The war has a new front.`,
      companyId: cid,
      personIds: [],
      rumor: false,
    });
    emit(state, "company_tier_change", { companyId: cid, tier: company.sizeTier });
  }
}

function advanceDay(state: SimState, rng: RngHub): void {
  state.currentDate = addDays(state.currentDate, 1);
  const date = state.currentDate;

  dailyWorldTick(state);

  if (dayOfWeek(date) === 0) {
    const era = resolveEra(date);
    for (const cid of sortedKeys(state.companies)) {
      const company = state.companies[cid]!;
      if (!company.active) continue;
      const txs = runWeeklyFinances({
        company,
        activeContracts: activeContractsFor(state, cid),
        era,
        date,
        nextTxId: () => nextId(state, "tx"),
      });
      state.ledger.push(...txs);
      applyTransactions(company, txs);
    }
    evaluateCompanyGrowth(state);
  }

  for (const cid of sortedKeys(state.companies)) {
    const company = state.companies[cid]!;
    if (!company.active || !company.aiControlled) continue;
    if (company.detailTier === "abstract") {
      // Background companies breathe weekly, not daily.
      if (dayOfWeek(date) === 3) {
        const r = rng.stream("abstract");
        company.momentum = Math.max(-40, Math.min(40, company.momentum + r.int(-3, 3)));
      }
      continue;
    }
    applyAiActions(state, company, rng);
  }

  // Run every show due today, in stable company-then-id order.
  const due = sortedKeys(state.shows)
    .map((id) => state.shows[id]!)
    .filter((s) => s.status === "scheduled" && s.date === date)
    .sort((a, b) => (a.companyId === b.companyId ? (a.id < b.id ? -1 : 1) : a.companyId < b.companyId ? -1 : 1));
  for (const show of due) {
    if (show.segments.length === 0) {
      show.status = "cancelled";
      const venue = state.venues[show.venueId];
      const company = state.companies[show.companyId];
      if (venue && company) {
        const penalty: Transaction = {
          id: nextId(state, "tx"),
          date,
          companyId: show.companyId,
          direction: "out",
          amountCents: Math.round(venue.rentalCents / 2),
          category: "venue_rental",
          memo: `Cancellation penalty — ${show.name}`,
          showId: show.id,
          personId: null,
        };
        state.ledger.push(penalty);
        applyTransactions(company, [penalty]);
        state.news.push({
          id: nextId(state, "news"),
          date,
          kind: "business",
          headline: `${show.name} cancelled`,
          body: `${company.name} cancelled ${show.name} at ${venue.name}. The building was never booked.`,
          companyId: show.companyId,
          personIds: [],
          rumor: false,
        });
      }
      emit(state, "show_cancelled", { showId: show.id });
      continue;
    }
    runShowInternal(state, show, rng);
  }

  emit(state, "day_advanced", { date });
}

/**
 * Apply one command. The input state is never mutated: on success the
 * returned state is a new object; on validation errors the ORIGINAL state
 * is returned untouched with `errors` set.
 */
export function applyCommand(prev: SimState, command: Command): EngineResult {
  const state = structuredClone(prev);
  const rng = new RngHub(state.meta.worldSeed);
  rng.restore(state.rng);

  const fail = (...errors: string[]): EngineResult => ({
    state: prev,
    events: [],
    report: null,
    offerOutcome: null,
    errors,
  });

  let report: ShowReport | null = null;
  let offerOutcome: OfferOutcome | null = null;
  const seqBefore = state.eventLog.length;
  const playerId = state.meta.options.playerCompanyId;

  switch (command.type) {
    case "ADVANCE_DAY": {
      advanceDay(state, rng);
      break;
    }
    case "SCHEDULE_SHOW": {
      if (command.companyId !== playerId) return fail("You can only schedule shows for your own company.");
      if (!state.venues[command.venueId]) return fail("Unknown venue.");
      if (command.date < state.currentDate) return fail("Shows cannot be scheduled in the past.");
      if (command.ticketPriceCents <= 0) return fail("Ticket price must be positive.");
      const venue = state.venues[command.venueId]!;
      const show: ShowPlan = {
        id: nextId(state, "show"),
        companyId: command.companyId,
        name: command.name,
        date: command.date,
        venueId: command.venueId,
        marketId: venue.marketId,
        showType: command.showType,
        ticketPriceCents: command.ticketPriceCents,
        segments: [],
        advertised: [],
        status: "scheduled",
        report: null,
      };
      state.shows[show.id] = show;
      emit(state, "show_scheduled", { showId: show.id, date: show.date });
      break;
    }
    case "CANCEL_SHOW": {
      const show = state.shows[command.showId];
      if (!show || show.status !== "scheduled") return fail("That show cannot be cancelled.");
      if (show.companyId !== playerId) return fail("Not your show.");
      show.status = "cancelled";
      emit(state, "show_cancelled", { showId: show.id });
      break;
    }
    case "UPDATE_SHOW_CARD": {
      const show = state.shows[command.showId];
      if (!show || show.status !== "scheduled") return fail("That show cannot be edited.");
      if (show.companyId !== playerId) return fail("Not your show.");
      const errors = validateCard(state, show, command.segments);
      if (errors.length > 0) return fail(...errors);
      show.segments = command.segments;
      show.advertised = command.advertised;
      emit(state, "card_updated", { showId: show.id, segments: command.segments.length });
      break;
    }
    case "RUN_SHOW": {
      const show = state.shows[command.showId];
      if (!show || show.status !== "scheduled") return fail("That show cannot be run.");
      if (show.companyId !== playerId) return fail("Not your show.");
      if (show.date !== state.currentDate) {
        return fail(
          show.date > state.currentDate
            ? `It's ${state.currentDate}; ${show.name} runs on ${show.date}. Advance the calendar.`
            : "That date has already passed.",
        );
      }
      if (show.segments.length === 0) return fail("The card is empty. Book at least one segment.");
      report = runShowInternal(state, show, rng);
      break;
    }
    case "OFFER_CONTRACT": {
      if (command.companyId !== playerId) return fail("You negotiate for your own company.");
      const worker = state.workers[command.personId];
      if (!worker) return fail("Unknown worker.");
      const company = state.companies[command.companyId]!;
      const existing = activeContractOf(state, command.personId);
      if (existing && existing.companyId !== command.companyId && existing.exclusive) {
        return fail(`${worker.name} is under exclusive contract elsewhere.`);
      }
      const era = resolveEra(state.currentDate);
      if (!era.allowedContractKinds.includes(command.kind)) {
        return fail(`${command.kind} contracts don't exist in this era.`);
      }
      if (command.weeklyDownsideCents > 0 && company.cashCents < command.weeklyDownsideCents * 8) {
        return fail("You cannot guarantee money you don't have (8 weeks of downside required in the bank).");
      }
      offerOutcome = evaluateOffer({
        worker,
        company,
        offer: {
          kind: command.kind,
          lengthMonths: command.lengthMonths,
          perAppearanceCents: command.perAppearanceCents,
          weeklyDownsideCents: command.weeklyDownsideCents,
          exclusive: command.exclusive,
        },
        era,
        rivalInterest: Math.min(100, worker.standing.awarenessNational),
        currentContract: existing,
        rng: rng.stream("negotiation"),
      });
      if (offerOutcome.accepted) {
        if (existing && existing.companyId === command.companyId) existing.status = "terminated";
        const contract: ContractState = {
          id: nextId(state, "contract"),
          personId: command.personId,
          companyId: command.companyId,
          kind: command.kind,
          exclusive: command.exclusive,
          startDate: state.currentDate,
          endDate: addDays(state.currentDate, command.lengthMonths * 30),
          perAppearanceCents: command.perAppearanceCents,
          weeklyDownsideCents: command.weeklyDownsideCents,
          promises: [],
          status: "active",
          signedDate: state.currentDate,
        };
        state.contracts[contract.id] = contract;
        worker.morale = Math.min(100, worker.morale + 5);
        emit(state, "contract_signed", { personId: command.personId, companyId: command.companyId, ai: false });
        if (worker.standing.awarenessNational > 50) {
          state.news.push({
            id: nextId(state, "news"),
            date: state.currentDate,
            kind: "signing",
            headline: `${worker.name} signs with ${company.shortName}`,
            body: `${company.name} locked in ${worker.name} on a ${command.lengthMonths}-month ${command.kind} deal.`,
            companyId: company.id,
            personIds: [command.personId],
            rumor: false,
          });
        }
      }
      break;
    }
    case "RELEASE_WORKER": {
      const contract = state.contracts[command.contractId];
      if (!contract || contract.status !== "active") return fail("No active contract to release.");
      if (contract.companyId !== playerId) return fail("Not your contract.");
      contract.status = "terminated";
      const w = state.workers[contract.personId];
      if (w) {
        w.morale = Math.max(0, w.morale - 20);
        // The locker room notices how people are treated.
        for (const pid of sortedKeys(state.workers)) {
          const other = state.workers[pid]!;
          const c = activeContractOf(state, pid);
          if (c?.companyId === playerId && pid !== contract.personId) {
            other.morale = Math.max(0, other.morale - 2);
          }
        }
        state.news.push({
          id: nextId(state, "news"),
          date: state.currentDate,
          kind: "release",
          headline: `${state.companies[playerId]!.shortName} releases ${w.name}`,
          body: `${state.companies[playerId]!.name} has released ${w.name}.`,
          companyId: playerId,
          personIds: [contract.personId],
          rumor: false,
        });
      }
      emit(state, "worker_released", { contractId: command.contractId, personId: contract.personId });
      break;
    }
    case "CREATE_STORYLINE": {
      if (command.companyId !== playerId) return fail("You write for your own company.");
      if (command.participants.length < 2) return fail("A storyline needs at least two participants.");
      for (const p of command.participants) {
        const c = activeContractOf(state, p.personId);
        if (!c || c.companyId !== command.companyId) {
          return fail(`${state.workers[p.personId]?.name ?? p.personId} is not on your roster.`);
        }
      }
      const avgAwareness =
        command.participants.reduce(
          (sum, p) => sum + (state.workers[p.personId]?.standing.awarenessNational ?? 0),
          0,
        ) / command.participants.length;
      const id = nextId(state, "story");
      state.storylines[id] = {
        id,
        companyId: command.companyId,
        name: command.name,
        premise: command.premise,
        participants: command.participants,
        titleId: command.titleId,
        heat: Math.round(15 + avgAwareness / 8),
        phase: "building",
        startDate: state.currentDate,
        targetDate: command.targetDate,
        beats: [],
        milestones: command.milestones.map((m) => ({ ...m, done: false })),
      };
      emit(state, "storyline_created", { storylineId: id, name: command.name });
      break;
    }
    case "CONCLUDE_STORYLINE": {
      const story = state.storylines[command.storylineId];
      if (!story || story.companyId !== playerId) return fail("Not your storyline.");
      story.phase = command.outcome;
      emit(state, "storyline_concluded", { storylineId: story.id, outcome: command.outcome });
      break;
    }
    case "SET_PUSH": {
      const w = state.workers[command.personId];
      if (!w) return fail("Unknown worker.");
      const c = activeContractOf(state, command.personId);
      if (!c || c.companyId !== playerId) return fail(`${w.name} is not on your roster.`);
      w.push = command.push;
      emit(state, "push_changed", { personId: command.personId, push: command.push });
      break;
    }
    case "SET_ALIGNMENT": {
      const w = state.workers[command.personId];
      if (!w) return fail("Unknown worker.");
      const c = activeContractOf(state, command.personId);
      if (!c || c.companyId !== playerId) return fail(`${w.name} is not on your roster.`);
      w.alignment = command.alignment;
      emit(state, "alignment_changed", { personId: command.personId, alignment: command.alignment });
      break;
    }
    case "SET_TITLE_HOLDER": {
      const title = state.titles[command.titleId];
      if (!title || title.companyId !== playerId) return fail("Not your championship.");
      for (const pid of command.holderIds) {
        if (!state.workers[pid]) return fail(`Unknown worker ${pid}.`);
      }
      const open = title.lineage[title.lineage.length - 1];
      if (open && open.toDate === null) open.toDate = state.currentDate;
      title.holderIds = [...command.holderIds].sort();
      if (title.holderIds.length > 0) {
        title.lineage.push({
          holderIds: title.holderIds,
          fromDate: state.currentDate,
          toDate: null,
          wonAtShowId: null,
          historical: false,
        });
      }
      title.defensesSinceChange = 0;
      emit(state, "title_admin_change", { titleId: title.id, reason: command.reason });
      break;
    }
    case "CREATE_TITLE": {
      const name = command.name.trim();
      if (name.length < 3) return fail("A championship needs a real name.");
      const clash = sortedKeys(state.titles).some(
        (tid) => state.titles[tid]!.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) return fail(`A championship named "${name}" already exists.`);
      const company = state.companies[playerId]!;
      const id = nextId(state, "title");
      state.titles[id] = {
        id,
        name,
        companyId: playerId,
        tier: command.tier,
        holderIds: [],
        // A brand-new belt has no aura yet; it earns prestige through defenses.
        prestige: command.tier === "world" ? 40 : 25,
        defensesSinceChange: 0,
        lineage: [],
        active: true,
      };
      company.titleIds.push(id);
      state.news.push({
        id: nextId(state, "news"),
        date: state.currentDate,
        kind: "business",
        headline: `${company.shortName} unveils the ${name}`,
        body: `${company.name} has introduced a new championship: the ${name}. Vacant until someone earns it.`,
        companyId: playerId,
        personIds: [],
        rumor: false,
      });
      emit(state, "title_created", { titleId: id, name, tier: command.tier });
      break;
    }
    case "RESOLVE_INBOX": {
      const item = state.inbox.find((i) => i.id === command.inboxId);
      if (!item) return fail("Unknown inbox item.");
      item.resolved = true;
      break;
    }
  }

  state.rng = rng.serialize();
  const events = state.eventLog.slice(seqBefore);
  return { state, events, report, offerOutcome, errors: [] };
}

/** Convenience for tests and the UI fast-forward: N days in sequence. */
export function advanceDays(state: SimState, days: number): SimState {
  let cur = state;
  for (let i = 0; i < days; i++) {
    cur = applyCommand(cur, { type: "ADVANCE_DAY" }).state;
  }
  return cur;
}

export { activeContractOf, activeContractsFor };
