import type { PromotionsFile, TimelineEvent } from "@kayfabe/graph-contract";
import { isoToDay } from "@kayfabe/graph-contract";
import type {
  CompanySizeTier,
  DataHealthReport,
  DetailTier,
  DnaAxis,
  EvidenceSummary,
  ProductDna,
  SnapshotCompany,
  SnapshotPersona,
  SnapshotReign,
  SnapshotTitle,
  SnapshotWorker,
  UniverseSnapshot,
  Venue,
  WorkerSeeder,
} from "@kayfabe/sim-contract";
import { DNA_AXES, hashValue } from "@kayfabe/sim-contract";
import type { CorpusFetch } from "./corpusClient";
import { CorpusClient } from "./corpusClient";
import type { CompanyMetaFile, CrosswalkGroup, PersonMatchRow } from "./corpusTypes";
import { canonicalPersonId, loadCrosswalk } from "./crosswalk";
import { companyIdFor as lineageCompanyIdFor, eraMember, loadLineages } from "./lineage";
import { buildEvidenceSummary, mergeEvidenceRows } from "./evidence";
import { loadMarkets, marketForLocation } from "./markets";
import crosswalkJson from "./data/persona-crosswalk.json";
import lineagesJson from "./data/company-lineages.json";
import companyMetaJson from "./data/company-meta.json";

export const BUILDER_VERSION = "snapshot-builder@1";
export const ROSTER_METHOD = "roster-infer@1";
export const WINDOW_DAYS = 540;
export const MIN_APPEARANCES = 6;
export const MAX_DAYS_SINCE_LAST = 120;

const ACTIVE_MIN_WINDOW_MATCHES = 40;
const NATIONAL_MIN_WINDOW_MATCHES = 400;
const REGIONAL_MIN_WINDOW_MATCHES = 120;
const ROSTER_CAP = 80;
const CSV_TITLE_MIN_WINDOW_MATCHES = 50;
const VENUES_PER_COMPANY = 12;
/** Default home market when nothing about a company places it — noted. */
const FALLBACK_MARKET_ID = "mkt:nyc";

const VENUE_CAPACITY: Record<CompanySizeTier, number> = {
  national: 12000,
  regional: 4000,
  indie: 1500,
};
const VENUE_PRESTIGE: Record<CompanySizeTier, number> = {
  national: 60,
  regional: 45,
  indie: 30,
};
/** Rough mid-1990s rental estimate: $2.50 per seat, integer cents. */
const RENTAL_CENTS_PER_SEAT = 250;

export interface BuildSnapshotOptions {
  fetch: CorpusFetch;
  startDate: string;
  seedWorker: WorkerSeeder;
  playableCompanyMin?: number;
}

const sortedKeys = (obj: Record<string, unknown>): string[] => Object.keys(obj).sort();

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** "1204" -> "1,204" without locale involvement. */
function formatInt(n: number): string {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface CompanyActivity {
  companyId: string;
  windowMatches: number;
  sizeTier: CompanySizeTier;
  detailTier: DetailTier;
  playable: boolean;
  /** loc string -> window match count (venue derivation). */
  locCounts: Map<string, number>;
}

interface RosterSeat {
  appearances: number;
  lastDay: number;
}

/**
 * Fallback promotion level for promotions outside the active set, from
 * graph/promotions.json volume. `m` means CARDS for src local_sql promotions
 * but MATCHES for csv promotions (documented corpus caveat), so the two
 * sources use different thresholds (promo-level-fallback@1).
 */
function fallbackPromoLevel(
  promotions: PromotionsFile,
  promotionId: string,
): CompanySizeTier {
  const info = promotions[promotionId];
  if (!info) return "indie";
  if (info.src === "local_sql") {
    return info.m >= 1000 ? "national" : info.m >= 200 ? "regional" : "indie";
  }
  return info.m >= 5000 ? "national" : info.m >= 800 ? "regional" : "indie";
}

function titleTier(
  name: string,
  artifact: boolean,
): SnapshotTitle["tier"] {
  // Simple, commented heuristic per spec: concatenation artifacts are
  // unclassifiable; Tag beats World ("WCW World Tag Team Titles" is a tag
  // title); anything else with World in the name is a world title.
  if (artifact) return "other";
  if (/tag/i.test(name)) return "tag";
  if (/world/i.test(name)) return "world";
  return "secondary";
}

/** Prestige seed from documented title-match volume plus tier standing. */
function titlePrestige(titleMatches: number, tier: SnapshotTitle["tier"]): number {
  const base = 25 + Math.min(40, Math.round(Math.sqrt(titleMatches)));
  const bonus = tier === "world" ? 25 : tier === "other" ? 0 : 10;
  return clamp(base + bonus, 10, 95);
}

export function buildDataHealth(opts: {
  aliasSuspects: DataHealthReport["aliasSuspects"];
  titlesWithoutLineage: number;
  workersLowConfidence: number;
  quarantinedRecords: number;
  notes: string[];
}): DataHealthReport {
  return {
    aliasSuspects: opts.aliasSuspects,
    titlesWithoutLineage: opts.titlesWithoutLineage,
    workersLowConfidence: opts.workersLowConfidence,
    quarantinedRecords: opts.quarantinedRecords,
    notes: opts.notes,
  };
}

/** Name key for alias suspicion: case plus "The " / "Jr." variants collapse. */
function aliasKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[\s,]+jr\.?$/, "")
    .trim();
}

export async function buildUniverseSnapshot(
  opts: BuildSnapshotOptions,
): Promise<UniverseSnapshot> {
  const client = new CorpusClient(opts.fetch);
  const playableCompanyMin = opts.playableCompanyMin ?? 3;

  const manifest = await client.manifest();
  if (!manifest.validation?.passed) {
    throw new Error("corpus manifest validation.passed is false — refusing to build");
  }
  const bundleHash = hashValue({
    schema_version: manifest.schema_version,
    counts: manifest.counts,
    algorithms: manifest.algorithms,
  });

  const startDate = opts.startDate;
  const startDay = isoToDay(startDate);
  if (!Number.isFinite(startDay)) {
    throw new Error(`invalid startDate ${JSON.stringify(startDate)}`);
  }
  const startYear = Number(startDate.slice(0, 4));

  const crosswalk = loadCrosswalk(crosswalkJson);
  const lineages = loadLineages(lineagesJson);
  const companyMeta = companyMetaJson as unknown as CompanyMetaFile;
  const markets = loadMarkets();
  const marketById = new Map(markets.map((m) => [m.id, m]));

  const entities = await client.searchEntities();
  const entityName = new Map<string, string>();
  for (const e of entities) entityName.set(e.id, e.n);

  const promotions = await client.promotions();
  const championships = await client.championships();

  // ---- window scan (anti-look-ahead boundary: d must be <= startDay) ----
  const windowStart = startDay - WINDOW_DAYS;
  const companyWindow = new Map<string, number>();
  const companyLocs = new Map<string, Map<string, number>>();
  const seats = new Map<string, Map<string, RosterSeat>>(); // companyId -> canonical person -> seat
  const memberLastDay = new Map<string, number>(); // corpus person id -> last window day
  const titleWindow = new Map<string, number>();

  for (let y = startYear - 2; y <= startYear; y++) {
    const events: TimelineEvent[] = await client.year(y);
    for (const ev of events) {
      const d = isoToDay(ev.d);
      if (d < windowStart || d > startDay) continue;
      const companyId = lineageCompanyIdFor(lineages, ev.pr);
      companyWindow.set(companyId, (companyWindow.get(companyId) ?? 0) + 1);
      let locs = companyLocs.get(companyId);
      if (!locs) companyLocs.set(companyId, (locs = new Map()));
      if (ev.loc) locs.set(ev.loc, (locs.get(ev.loc) ?? 0) + 1);
      const titleIds = ev.ts ?? (ev.t ? [ev.t] : []);
      for (const t of titleIds) titleWindow.set(t, (titleWindow.get(t) ?? 0) + 1);
      for (const pid of [...ev.w, ...ev.l]) {
        if (!pid.startsWith("p:")) continue; // placeholder / unknown sides
        const canonical = canonicalPersonId(crosswalk, pid);
        let byPerson = seats.get(companyId);
        if (!byPerson) seats.set(companyId, (byPerson = new Map()));
        let seat = byPerson.get(canonical);
        if (!seat) byPerson.set(canonical, (seat = { appearances: 0, lastDay: -1 }));
        seat.appearances += 1;
        if (d > seat.lastDay) seat.lastDay = d;
        const prev = memberLastDay.get(pid);
        if (prev === undefined || d > prev) memberLastDay.set(pid, d);
      }
    }
  }

  // ---- company activity, tiers, playability ----
  const activityById = new Map<string, CompanyActivity>();
  const activeIds = [...companyWindow.keys()]
    .filter((id) => (companyWindow.get(id) ?? 0) >= ACTIVE_MIN_WINDOW_MATCHES)
    .sort(cmp);
  for (const companyId of activeIds) {
    const windowMatches = companyWindow.get(companyId)!;
    const meta = companyMeta.companies[companyId];
    const sizeTier: CompanySizeTier =
      meta?.sizeTier ??
      (windowMatches >= NATIONAL_MIN_WINDOW_MATCHES
        ? "national"
        : windowMatches >= REGIONAL_MIN_WINDOW_MATCHES
          ? "regional"
          : "indie");
    activityById.set(companyId, {
      companyId,
      windowMatches,
      sizeTier,
      detailTier: "abstract",
      playable: false,
      locCounts: companyLocs.get(companyId) ?? new Map(),
    });
  }

  // Playable: the biggest North American companies (curated home market is
  // the North America signal) by window volume, at least playableCompanyMin.
  const playableCandidates = activeIds
    .filter((id) => companyMeta.companies[id]?.homeMarketId !== undefined)
    .sort((a, b) => companyWindow.get(b)! - companyWindow.get(a)! || cmp(a, b));
  for (const id of playableCandidates.slice(0, playableCompanyMin)) {
    const act = activityById.get(id)!;
    act.playable = true;
    act.detailTier = "full";
  }
  for (const act of activityById.values()) {
    if (!act.playable) {
      act.detailTier =
        act.windowMatches >= REGIONAL_MIN_WINDOW_MATCHES ? "standard" : "abstract";
    }
  }

  // ---- rosters (roster-infer@1, crosswalk applied first) ----
  const notes: string[] = [];
  const qualifying = new Map<string, Map<string, RosterSeat>>();
  for (const companyId of activeIds) {
    const byPerson = seats.get(companyId);
    if (!byPerson) continue;
    const kept = new Map<string, RosterSeat>();
    for (const person of [...byPerson.keys()].sort(cmp)) {
      const seat = byPerson.get(person)!;
      if (
        seat.appearances >= MIN_APPEARANCES &&
        seat.lastDay >= startDay - MAX_DAYS_SINCE_LAST
      ) {
        kept.set(person, seat);
      }
    }
    qualifying.set(companyId, kept);
  }
  // Exclusive-leaning era: a person qualifying for several companies keeps
  // the one where their most recent appearance was (ties: lower company id).
  const affiliation = new Map<string, string>();
  for (const companyId of activeIds) {
    for (const [person, seat] of qualifying.get(companyId) ?? []) {
      const currentId = affiliation.get(person);
      if (currentId === undefined) {
        affiliation.set(person, companyId);
        continue;
      }
      const current = qualifying.get(currentId)!.get(person)!;
      if (seat.lastDay > current.lastDay) affiliation.set(person, companyId);
    }
  }

  const rosterByCompany = new Map<string, string[]>();
  for (const companyId of activeIds) {
    const act = activityById.get(companyId)!;
    const members = [...(qualifying.get(companyId) ?? new Map<string, RosterSeat>())]
      .filter(([person]) => affiliation.get(person) === companyId)
      .sort((a, b) => b[1].appearances - a[1].appearances || cmp(a[0], b[0]))
      .map(([person]) => person);
    if (act.detailTier === "full" && members.length > ROSTER_CAP) {
      notes.push(
        `roster-cap: ${companyId} inferred ${members.length} qualifying workers; kept top ${ROSTER_CAP} by window appearances (${members.length - ROSTER_CAP} overflow).`,
      );
      members.length = ROSTER_CAP;
    }
    rosterByCompany.set(companyId, [...members].sort(cmp));
  }

  const rosteredPersons = [...new Set([...rosterByCompany.values()].flat())].sort(cmp);
  const companyOf = new Map<string, string>();
  for (const [companyId, roster] of rosterByCompany) {
    for (const person of roster) companyOf.set(person, companyId);
  }

  // ---- pre-start reign counts per canonical person (for history notes) ----
  const reignCounts = new Map<string, number>();
  for (const titleId of sortedKeys(championships)) {
    const rec = championships[titleId]!;
    for (const reign of rec.reigns) {
      if (isoToDay(reign.s) > startDay) continue;
      for (const holder of reign.holders) {
        const canonical = canonicalPersonId(crosswalk, holder);
        reignCounts.set(canonical, (reignCounts.get(canonical) ?? 0) + 1);
      }
    }
  }

  // ---- per-worker evidence, seeding ----
  const promoLevel = (promotionId: string): CompanySizeTier => {
    const companyId = lineageCompanyIdFor(lineages, promotionId);
    return activityById.get(companyId)?.sizeTier ?? fallbackPromoLevel(promotions, companyId);
  };
  const evidenceCompanyIdFor = (promotionId: string): string =>
    lineageCompanyIdFor(lineages, promotionId);

  const companyLabel = (companyId: string): string => {
    const lineage = lineages.byCanonical.get(companyId);
    if (lineage) return eraMember(lineage, startDate).name;
    return promotions[companyId]?.n ?? entityName.get(companyId) ?? companyId;
  };

  const workers: SnapshotWorker[] = [];
  let sawEvidenceMeltzer = false;
  let seederMethod = "unknown";
  for (const personId of rosteredPersons) {
    const group: CrosswalkGroup | undefined = crosswalk.byCanonical.get(personId);
    const memberIds = group ? group.members.map((m) => m.id) : [personId];
    const rowsPerMember: PersonMatchRow[][] = [];
    for (const id of memberIds) rowsPerMember.push(await client.personEvidence(id));
    const rows = mergeEvidenceRows(rowsPerMember, startDay);
    const evidence: EvidenceSummary = buildEvidenceSummary({
      personId,
      rows,
      startDay,
      promoLevel,
      companyIdFor: evidenceCompanyIdFor,
    });
    if (evidence.meltzer !== null) sawEvidenceMeltzer = true;
    const seeded = opts.seedWorker(evidence);
    if (seederMethod === "unknown") {
      const attrKeys = sortedKeys(seeded.attributes) as (keyof typeof seeded.attributes)[];
      const first = attrKeys[0];
      if (first !== undefined) seederMethod = seeded.attributes[first].method;
    }

    // Display name: persona recorded in the most recent pre-start appearance;
    // fall back to the curated display name, then the canonical corpus name.
    let latestMember: string | undefined;
    let latestDay = -1;
    for (const id of memberIds) {
      const day = memberLastDay.get(id);
      if (day !== undefined && (day > latestDay || (day === latestDay && cmp(id, latestMember ?? "") < 0))) {
        latestDay = day;
        latestMember = id;
      }
    }
    const personaName = (id: string): string =>
      group?.members.find((m) => m.id === id)?.persona ?? entityName.get(id) ?? id;
    const displayName = latestMember
      ? personaName(latestMember)
      : (group?.displayName ?? entityName.get(personId) ?? personId);
    const personas: SnapshotPersona[] = (group
      ? group.members.map((m) => ({ corpusId: m.id, name: m.persona }))
      : [{ corpusId: personId, name: entityName.get(personId) ?? personId }]
    ).sort((a, b) => cmp(a.corpusId, b.corpusId));

    const top = evidence.topPromotions[0];
    const spanText =
      evidence.firstYear !== null && evidence.lastYear !== null
        ? evidence.firstYear === evidence.lastYear
          ? ` in ${evidence.firstYear}`
          : ` ${evidence.firstYear}–${evidence.lastYear}`
        : "";
    const primaryText = top ? `, primarily ${companyLabel(top.promotionId)}` : "";
    const reigns = reignCounts.get(personId) ?? 0;
    const reignText =
      reigns > 0 ? `; ${reigns} recorded title reign${reigns === 1 ? "" : "s"}` : "";
    const historyNote = `${formatInt(evidence.matches)} recorded matches${spanText}${primaryText}${reignText}.`;

    workers.push({
      personId,
      displayName,
      personas,
      seeded: seeded.attributes,
      awarenessNational: seeded.awarenessNational,
      affinityNational: seeded.affinityNational,
      credibility: seeded.credibility,
      prestige: seeded.prestige,
      styles: seeded.styles,
      alignment: seeded.alignment,
      debutYear: evidence.firstYear,
      experienceYears:
        evidence.firstYear !== null ? Math.max(0, startYear - evidence.firstYear) : 0,
      evidence,
      historyNote,
    });
  }

  // ---- titles ----
  const rosteredSet = new Set(rosteredPersons);
  const titles: SnapshotTitle[] = [];
  const titleIdsByCompany = new Map<string, string[]>();
  const unrosteredHolders: string[] = [];
  let csvTitlesActive = 0;
  for (const titleId of sortedKeys(championships)) {
    const rec = championships[titleId]!;
    const companyId = lineageCompanyIdFor(lineages, rec.pr);
    if (!activityById.has(companyId)) continue;
    const isCsvTitle = titleId.startsWith("t:c");
    if (isCsvTitle) csvTitlesActive += 1;
    if (rec.reigns.length === 0) {
      // csv titles have no derivable lineage; include only the actively
      // defended ones, vacant-with-unknown-history.
      if (!isCsvTitle || (titleWindow.get(titleId) ?? 0) < CSV_TITLE_MIN_WINDOW_MATCHES) {
        continue;
      }
      const tier = titleTier(rec.n, rec.artifact);
      titles.push({
        titleId,
        name: rec.n,
        companyId,
        tier,
        holderIds: [],
        holderNames: [],
        preStartReigns: [],
        prestige: titlePrestige(rec.titleMatches, tier),
        lineageComplete: false,
      });
      const list = titleIdsByCompany.get(companyId) ?? [];
      list.push(titleId);
      titleIdsByCompany.set(companyId, list);
      continue;
    }

    const preStart = rec.reigns.filter((r) => isoToDay(r.s) <= startDay);
    const current = preStart.find(
      (r) => r.e === null || isoToDay(r.e) > startDay,
    );
    const toSnapshotReign = (r: (typeof rec.reigns)[number]): SnapshotReign => ({
      holderIds: r.holders.map((h) => canonicalPersonId(crosswalk, h)).sort(cmp),
      holderNames: r.holders.map((h) => entityName.get(h) ?? h).sort(cmp),
      fromDay: isoToDay(r.s),
      // Ends after the start date are unknown as of the start (anti-look-ahead).
      toDay: r.e !== null && isoToDay(r.e) <= startDay ? isoToDay(r.e) : null,
    });
    const preStartReigns = preStart.slice(-8).map(toSnapshotReign);
    const holderIds = current
      ? current.holders.map((h) => canonicalPersonId(crosswalk, h)).sort(cmp)
      : [];
    const holderNames = current
      ? current.holders.map((h) => entityName.get(h) ?? h).sort(cmp)
      : [];
    for (const h of holderIds) {
      if (!rosteredSet.has(h)) {
        unrosteredHolders.push(
          `${entityName.get(h) ?? h} (${h}, ${rec.n})`,
        );
      }
    }
    const tier = titleTier(rec.n, rec.artifact);
    titles.push({
      titleId,
      name: rec.n,
      companyId,
      tier,
      holderIds,
      holderNames,
      preStartReigns,
      prestige: titlePrestige(rec.titleMatches, tier),
      lineageComplete: !isCsvTitle,
    });
    const list = titleIdsByCompany.get(companyId) ?? [];
    list.push(titleId);
    titleIdsByCompany.set(companyId, list);
  }
  titles.sort((a, b) => cmp(a.titleId, b.titleId));

  // ---- venues (playable companies only) ----
  const venueById = new Map<string, Venue>();
  const homeMarketOf = new Map<string, string>();
  for (const companyId of activeIds) {
    const meta = companyMeta.companies[companyId];
    if (meta?.homeMarketId) {
      homeMarketOf.set(companyId, meta.homeMarketId);
      continue;
    }
    // Derive from the company's busiest matched location, else the noted default.
    const locs = [...(activityById.get(companyId)?.locCounts ?? new Map<string, number>())]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    let derived: string | null = null;
    for (const [loc] of locs) {
      derived = marketForLocation(loc);
      if (derived) break;
    }
    homeMarketOf.set(companyId, derived ?? FALLBACK_MARKET_ID);
  }

  for (const companyId of activeIds) {
    const act = activityById.get(companyId)!;
    if (!act.playable) continue;
    const home = homeMarketOf.get(companyId)!;
    const topLocs = [...act.locCounts]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .slice(0, VENUES_PER_COMPANY);
    for (const [loc] of topLocs) {
      const id = `ven:${slugify(loc)}`;
      if (venueById.has(id)) continue;
      venueById.set(id, {
        id,
        name: loc,
        marketId: marketForLocation(loc) ?? home,
        capacity: VENUE_CAPACITY[act.sizeTier],
        prestige: VENUE_PRESTIGE[act.sizeTier],
        rentalCents: VENUE_CAPACITY[act.sizeTier] * RENTAL_CENTS_PER_SEAT,
      });
    }
    if (![...venueById.values()].some((v) => v.marketId === home)) {
      const market = marketById.get(home);
      const id = `ven:home-${slugify(home)}`;
      if (!venueById.has(id)) {
        venueById.set(id, {
          id,
          name: `${market?.name ?? home} Hall`,
          marketId: home,
          capacity: VENUE_CAPACITY[act.sizeTier],
          prestige: VENUE_PRESTIGE[act.sizeTier],
          rentalCents: VENUE_CAPACITY[act.sizeTier] * RENTAL_CENTS_PER_SEAT,
        });
      }
    }
  }
  const venues = [...venueById.values()].sort((a, b) => cmp(a.id, b.id));

  // ---- companies ----
  const companies: SnapshotCompany[] = [];
  for (const companyId of activeIds) {
    const act = activityById.get(companyId)!;
    const meta = companyMeta.companies[companyId];
    const lineage = lineages.byCanonical.get(companyId);
    const name = companyLabel(companyId);
    const dna = {} as ProductDna;
    for (const axis of DNA_AXES) {
      // company-standing-seed@1 defaults: neutral 50 everywhere except the
      // ambition axis, which follows the size tier.
      const fallback =
        axis === "nationalAmbition"
          ? act.sizeTier === "national"
            ? 85
            : act.sizeTier === "regional"
              ? 50
              : 25
          : 50;
      dna[axis as DnaAxis] = meta?.productDna?.[axis] ?? fallback;
    }
    const tierBase =
      act.sizeTier === "national"
        ? { awareness: 75, affinity: 55, prestige: 65 }
        : act.sizeTier === "regional"
          ? { awareness: 45, affinity: 45, prestige: 45 }
          : { awareness: 20, affinity: 35, prestige: 25 };
    companies.push({
      companyId,
      name,
      shortName: meta?.shortName ?? name,
      lineageIds: lineage ? lineage.members.map((m) => m.promotionId) : [companyId],
      sizeTier: act.sizeTier,
      detailTier: act.detailTier,
      homeMarketId: homeMarketOf.get(companyId)!,
      rosterPersonIds: rosterByCompany.get(companyId) ?? [],
      titleIds: (titleIdsByCompany.get(companyId) ?? []).sort(cmp),
      awarenessNational: clamp(tierBase.awareness + Math.min(15, Math.floor(act.windowMatches / 100)), 0, 100),
      affinityNational: clamp(tierBase.affinity + Math.min(10, Math.floor(act.windowMatches / 200)), 0, 100),
      prestige: clamp(tierBase.prestige + Math.min(15, Math.floor(act.windowMatches / 150)), 0, 100),
      productDna: dna,
      playable: act.playable,
    });
  }
  companies.sort((a, b) => cmp(a.companyId, b.companyId));

  // ---- data health ----
  const byAliasKey = new Map<string, string[]>();
  for (const personId of rosteredPersons) {
    const name = entityName.get(personId);
    if (!name) continue;
    const key = aliasKey(name);
    const list = byAliasKey.get(key) ?? [];
    list.push(personId);
    byAliasKey.set(key, list);
  }
  const aliasSuspects: DataHealthReport["aliasSuspects"] = [];
  for (const key of [...byAliasKey.keys()].sort(cmp)) {
    const ids = byAliasKey.get(key)!;
    if (ids.length < 2) continue;
    // All in one crosswalk group would already be merged to one canonical id,
    // so two distinct rostered ids sharing a key are an unresolved suspect.
    aliasSuspects.push({
      reason: "near-duplicate name among rostered workers (not in crosswalk)",
      ids: [...ids].sort(cmp),
      names: ids.map((id) => entityName.get(id) ?? id).sort(cmp),
    });
  }

  const workersLowConfidence = workers.filter((w) => {
    const grades = Object.values(w.seeded).map((a) => a.confidence);
    const low = grades.filter((g) => g === "low" || g === "speculative").length;
    return low * 2 > grades.length;
  }).length;

  const quarantinedRecords =
    (manifest.counts["unresolved_side_parts"] ?? 0) +
    (manifest.counts["matches_csv_excluded"] ?? 0);

  notes.push(
    `roster-infer@1: on-roster iff >= ${MIN_APPEARANCES} appearances in the ${WINDOW_DAYS}-day window and last appearance within ${MAX_DAYS_SINCE_LAST} days of the start date; multi-company workers keep their most recent affiliation.`,
    "main-event-share-unavailable: person-matches@1 rows carry no card placement, so mainEventShare is null (unknown) for every worker.",
    "promo-level-fallback@1: promotions outside the active set are tiered from graph/promotions.json volume (cards for sql promotions, matches for csv).",
    `venue-capacity-estimate@1: venue capacity/prestige/rental are size-tier estimates (national ${VENUE_CAPACITY.national}, regional ${VENUE_CAPACITY.regional}, indie ${VENUE_CAPACITY.indie} seats at ${RENTAL_CENTS_PER_SEAT} cents/seat rental); corpus locations are cities, not buildings.`,
    "company-standing-seed@1: company awareness/affinity/prestige and default DNA are size-tier + window-volume estimates.",
  );
  if (!sawEvidenceMeltzer) {
    notes.push(
      "meltzer-unavailable: no person-matches@1 row carried an mr rating; meltzer evidence is null for every worker.",
    );
  }
  const unmatchedHomes = activeIds.filter(
    (id) =>
      !companyMeta.companies[id]?.homeMarketId &&
      homeMarketOf.get(id) === FALLBACK_MARKET_ID,
  );
  if (unmatchedHomes.length > 0) {
    notes.push(
      `home-market-default: ${unmatchedHomes.join(", ")} matched no market keyword and default to ${FALLBACK_MARKET_ID}; cosmetic for non-playable companies.`,
    );
  }
  if (csvTitlesActive > 0) {
    notes.push(
      `titles-without-lineage: ${csvTitlesActive} csv championships map to active companies; their reigns are underivable (vacant-with-unknown-history), only actively defended ones (>= ${CSV_TITLE_MIN_WINDOW_MATCHES} window title matches) appear in the snapshot.`,
    );
  }
  if (unrosteredHolders.length > 0) {
    notes.push(
      `champions-not-rostered: ${[...unrosteredHolders].sort(cmp).join("; ")} hold titles at the start date without clearing roster inference (stale open reigns or part-time schedules).`,
    );
  }

  const dataHealth = buildDataHealth({
    aliasSuspects,
    titlesWithoutLineage: csvTitlesActive,
    workersLowConfidence,
    quarantinedRecords,
    notes,
  });

  // ---- meta + snapshot hash ----
  const meta = {
    schemaVersion: 1,
    builderVersion: BUILDER_VERSION,
    bundleHash,
    crosswalkVersion: crosswalk.version,
    startDate,
    startDay,
    rosterInference: {
      method: ROSTER_METHOD,
      windowDays: WINDOW_DAYS,
      minAppearances: MIN_APPEARANCES,
      maxDaysSinceLast: MAX_DAYS_SINCE_LAST,
    },
    seederMethod,
    snapshotHash: "",
  };
  const snapshot: UniverseSnapshot = {
    meta,
    markets,
    venues,
    companies,
    workers,
    titles,
    dataHealth,
  };
  meta.snapshotHash = hashValue(snapshot);
  return snapshot;
}
