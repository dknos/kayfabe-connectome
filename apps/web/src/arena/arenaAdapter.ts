/**
 * Canonical graph → Arena Array cards.
 *
 * The semantic model here is derived from the corpus, and it is worth stating
 * plainly because the brief specifies the graphics and leaves this implied:
 *
 *   bank      the corpus's own distinction. `same` counts documented tag
 *             partnership, `opposed` counts documented opposition, and a pair
 *             carrying both is a third relationship rather than an average.
 *             Battle-royal co-presence is kept at low weight because a battle
 *             royal does not document a specific meeting.
 *   strength  documented encounters behind the seating, so prominence is
 *             evidence and not decoration.
 *   era       the person's span INSIDE the active scope. A wrestler who
 *             debuted in 1978 and worked AAA in 2005 belongs to AAA's 2000s,
 *             not to a 1970s section AAA never had.
 *
 * See docs/ARENA_ARRAY.md.
 */
import { AB, type ArenaCard } from "@kayfabe/arena-renderer";
import type { ArenaScope } from "@kayfabe/arena-renderer";
import { loadChronologyPromotionDetail } from "../data/chronology/loader";
import { EF, STRIDE, type GraphModel } from "../graph/model";

/** The corpus epoch is 1900-01-01 (docs/DECISIONS.md D-008). */
const EPOCH_MS = Date.UTC(1900, 0, 1);
const dayToYear = (day: number): number => new Date(EPOCH_MS + day * 86400000).getUTCFullYear();
const decadeOf = (year: number): string => `${Math.floor(year / 10) * 10}s`;

function cardFromNode(model: GraphModel, index: number, bank: number, strength: number,
  firstYear: number, lastYear: number): ArenaCard {
  const nodes = model.nodes;
  return {
    id: nodes.id[index]!,
    name: nodes.name[index] ?? nodes.id[index]!,
    bank: bank as ArenaCard["bank"],
    strength,
    era: decadeOf(firstYear),
    firstYear,
    lastYear,
    pos: [nodes.pos[index * 3]!, nodes.pos[index * 3 + 1]!, nodes.pos[index * 3 + 2]!],
    reigns: nodes.reigns[index] ?? 0,
  };
}

/**
 * A person scope: everyone the subject shares a documented match with,
 * seated by what kind of relationship the evidence supports.
 */
export function personScope(model: GraphModel, anchorId: string): ArenaScope | null {
  const ai = model.indexOfId.get(anchorId);
  if (ai === undefined) return null;
  const cards: ArenaCard[] = [];
  for (const { node, edge } of model.neighbors(ai)) {
    const o = edge * STRIDE;
    const same = model.edges[o + EF.same]!;
    const opposed = model.edges[o + EF.opposed]!;
    const br = model.edges[o + EF.br]!;
    if (same + opposed + br === 0) continue;
    const bank = same > 0 && opposed > 0 ? AB.MIXED : same > 0 ? AB.SAME : AB.OPPOSED;
    cards.push(cardFromNode(
      model, node, bank, same + opposed + br * 0.25,
      dayToYear(model.edges[o + EF.firstDay]!),
      dayToYear(model.edges[o + EF.lastDay]!),
    ));
  }
  // matches-desc-then-id, the stable order the atlas projection uses, so any
  // budget slice is deterministic rather than adjacency-order dependent.
  cards.sort((a, b) => b.strength - a.strength || (a.id < b.id ? -1 : 1));
  const anchorIndex = ai;
  const anchorName = model.nodes.name[anchorIndex] ?? anchorId;
  cards.unshift(cardFromNode(
    model, anchorIndex, AB.CENTER, cards[0]?.strength ?? 1,
    dayToYear(model.nodes.firstDay[anchorIndex]!),
    dayToYear(model.nodes.lastDay[anchorIndex]!),
  ));
  return { kind: "person", anchorId, anchorName, cards };
}


/**
 * A promotion scope, from the chronology projection.
 *
 * Two reasons this does not come from the graph. The edge `promoMask` cannot
 * express it: only 30 promotions own a bit and the other 541 share bit 30, so
 * filtering pr:c8 by its bit would silently mean "AAA or any of 540 others".
 * And the era a card belongs to is its span INSIDE this promotion, which the
 * atlas already carries per person per promotion — using a career debut
 * instead would mis-seat 326 of AAA's 1,087 people into decades the promotion
 * never had.
 */
export async function promotionScope(
  model: GraphModel, promotionId: string, budget: number,
): Promise<ArenaScope | null> {
  const detail = await loadChronologyPromotionDetail(promotionId);
  if (!detail) return null;

  const cards: ArenaCard[] = [];
  for (const member of detail.members) {
    const firstYear = dayToYear(member.firstDay);
    const index = model.indexOfId.get(member.p);
    cards.push({
      id: member.p,
      name: member.n,
      // A promotion scope has no relationship banks: these people are seated
      // by when they worked here, not by how they related to a subject.
      bank: AB.MIXED,
      strength: member.matches,
      era: decadeOf(firstYear),
      firstYear,
      lastYear: dayToYear(member.lastDay),
      pos: index === undefined ? null : [
        model.nodes.pos[index * 3]!, model.nodes.pos[index * 3 + 1]!, model.nodes.pos[index * 3 + 2]!,
      ],
      reigns: member.champ ? 1 : 0,
    });
  }

  // Reserve slots for the anchor AND for one summary per era before deciding
  // how many people fit. Appending summaries after a full budget put them past
  // the renderer's own slice, so the drill-down affordance existed in the data
  // and never once reached the screen.
  const eraCount = new Set(cards.map((c) => c.era)).size;
  const reserved = 1 + eraCount;
  const seated = cards.slice(0, Math.max(0, budget - reserved));
  const remainder = cards.slice(seated.length);
  // Aggregation is forced by the corpus, not chosen: AAA alone is 1,087 people
  // against a 600-card budget and 417 of them have a single documented match.
  // The tail becomes one clearly-labelled summary per era rather than being
  // dropped silently, and the projection's own truncation is added to it so a
  // capped roster never reads as a complete one.
  const byEra = new Map<string, { count: number; matches: number }>();
  for (const card of remainder) {
    const agg = byEra.get(card.era) ?? { count: 0, matches: 0 };
    agg.count++;
    agg.matches += card.strength;
    byEra.set(card.era, agg);
  }
  const aggregates: ArenaCard[] = [...byEra.entries()].sort().map(([era, agg]) => ({
    id: `agg:${promotionId}:${era}`,
    name: `+${agg.count} more · ${era}`,
    bank: AB.AGGREGATE,
    strength: Math.max(1, Math.round(agg.matches / Math.max(1, agg.count))),
    era,
    firstYear: Number(era.slice(0, 4)),
    lastYear: Number(era.slice(0, 4)) + 9,
    pos: null,
    reigns: 0,
    represents: agg.count,
  }));

  // The aggregate has to remember WHO it stands for, or drilling into it can
  // only ever be a label change. Kept beside the scope rather than on the card,
  // so the renderer's card type stays a pure transform-and-semantics record.
  const represented = new Map<string, ArenaCard[]>();
  for (const card of remainder) {
    const key = `agg:${promotionId}:${card.era}`;
    const list = represented.get(key) ?? [];
    list.push(card);
    represented.set(key, list);
  }

  const anchorIndex = model.indexOfId.get(promotionId);
  const anchor: ArenaCard = {
    id: promotionId,
    name: detail.n,
    bank: AB.CENTER,
    strength: seated[0]?.strength ?? 1,
    era: decadeOf(dayToYear(detail.firstDay)),
    firstYear: dayToYear(detail.firstDay),
    lastYear: dayToYear(detail.lastDay),
    pos: anchorIndex === undefined ? null : [
      model.nodes.pos[anchorIndex * 3]!, model.nodes.pos[anchorIndex * 3 + 1]!, model.nodes.pos[anchorIndex * 3 + 2]!,
    ],
    reigns: 0,
  };

  return {
    kind: "promotion",
    anchorId: promotionId,
    anchorName: detail.n,
    cards: [anchor, ...seated, ...aggregates],
    represented,
  };
}

/**
 * Open one aggregate: its members take its place, and every other aggregate
 * stays put. Returning a NEW scope rather than mutating keeps the renderer's
 * slot pool honest — retained cards keep their instances and only the opened
 * group enters.
 */
export function expandAggregate(scope: ArenaScope, aggregateId: string): ArenaScope | null {
  const members = scope.represented?.get(aggregateId);
  if (!members || members.length === 0) return null;
  const cards: ArenaCard[] = [];
  for (const card of scope.cards) {
    if (card.id === aggregateId) cards.push(...members);
    else cards.push(card);
  }
  const represented = new Map(scope.represented);
  represented.delete(aggregateId);
  return { ...scope, cards, represented };
}

/** How many people the projection itself left out, if any. Never hidden. */
export async function promotionTruncation(promotionId: string): Promise<number> {
  const detail = await loadChronologyPromotionDetail(promotionId);
  return detail?.membersTruncated ?? 0;
}
