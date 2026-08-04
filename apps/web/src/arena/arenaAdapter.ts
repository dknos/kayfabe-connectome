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
