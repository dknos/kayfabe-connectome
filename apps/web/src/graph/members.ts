import type { ChampionshipsFile, Manifest, SearchEntity } from "@kayfabe/graph-contract";
import { EF, type GraphModel } from "./model";

/**
 * Who lights up when you select something.
 *
 * The encounter graph's edges are person↔person only, so lighting "incident
 * edges" answers the question for a wrestler and answers *nothing* for a
 * promotion or a championship — those nodes have no edges at all. Selecting
 * AJPW or the WWF Hardcore Title lit an empty set.
 *
 * Membership is therefore resolved per node type, from the strongest signal
 * the corpus actually carries, and each answer states what it is:
 *
 *   person       every wrestler they share a documented match with
 *   promotion    every wrestler documented working for it
 *   championship every wrestler documented holding it
 *
 * Each result carries a `basis` string the dossier shows, because these are
 * three different claims and collapsing them into one glow would imply they
 * are the same claim.
 */

export interface MemberResult {
  /** Canonical ids to light. */
  ids: string[];
  /** What the set means, in the UI's own words. */
  basis: string;
  /** Set when the corpus cannot answer precisely, and why. */
  caveat?: string;
  /** Nodes that stay visible whichever category is active — a wrestler's
   * promotions and championships, which locate the connections rather than
   * being connections. */
  anchors?: string[];
  /** For a wrestler: the same connections split by what KIND of connection it
   * is. Opponent and tag partner are different relationships and a reader
   * asking "who did Evan Bourne team with" is not asking who he fought. */
  groups?: MemberGroup[];
}

export type GroupKey = "all" | "opposed" | "same" | "br" | "promotions" | "titles";

export interface MemberGroup {
  key: GroupKey;
  label: string;
  ids: string[];
  /** Matches the fiber colour for that relationship, so the chip and the
   * thing it selects read as the same object. */
  tone: "neutral" | "opposed" | "same" | "br" | "gold";
}

const EMPTY: MemberResult = { ids: [], basis: "" };

export function resolveMembers(
  model: GraphModel,
  manifest: Manifest,
  search: SearchEntity[],
  selectedId: string | null,
  championships: ChampionshipsFile | null,
): MemberResult {
  if (!selectedId) return EMPTY;
  const i = model.indexOfId.get(selectedId);
  if (i === undefined) return EMPTY;
  const type = model.nodes.type[i];

  if (type === 0) return peopleFor(model, i, search);
  if (type === 1) return promotionMembers(model, manifest, search, selectedId);
  if (type === 2) return titleHolders(model, selectedId, championships);
  return EMPTY;
}

/**
 * A wrestler: everyone they share a documented match with, split by relation.
 *
 * The split is not cosmetic. Opposed, same-side and battle-royal are three
 * different documented relationships with three different evidence bases —
 * battle-royal opposition in particular is a weak, many-to-many signal the
 * canonical model deliberately keeps in its own class rather than mixing into
 * "opponents".
 */
function peopleFor(
  model: GraphModel,
  node: number,
  search: SearchEntity[],
): MemberResult {
  // model.neighbors walks the FULL adjacency, not the drawn subset. The
  // renderer caps how many ribbons it draws, but capping who is *lit* would
  // mean a wrestler with 500 opponents silently shows 160 of them.
  const all: string[] = [];
  const opposed: string[] = [];
  const same: string[] = [];
  const br: string[] = [];
  for (const { node: n, edge } of model.neighbors(node)) {
    const id = model.nodes.id[n];
    if (!id) continue;
    all.push(id);
    if (model.edgeField(edge, EF.opposed) > 0) opposed.push(id);
    if (model.edgeField(edge, EF.same) > 0) same.push(id);
    if (model.edgeField(edge, EF.br) > 0) br.push(id);
  }
  const self = model.nodes.id[node]!;
  const entity = search.find((e) => e.id === self);
  const promotions: string[] = [];
  for (const p of entity?.pm ?? []) {
    const idx = model.nodes.name.findIndex((n, i) => n === p && model.nodes.type[i] === 1);
    if (idx >= 0) promotions.push(model.nodes.id[idx]!);
  }
  return {
    ids: all,
    basis: `${all.length.toLocaleString()} wrestlers share a documented match`,
    groups: [
      { key: "all", label: "All", ids: all, tone: "neutral" },
      { key: "opposed", label: "Opponents", ids: opposed, tone: "opposed" },
      { key: "same", label: "Tag partners", ids: same, tone: "same" },
      { key: "br", label: "Battle royal", ids: br, tone: "br" },
      { key: "promotions", label: "Promotions", ids: promotions, tone: "gold" },
    ],
  };
}

/**
 * A promotion: everyone documented working for it.
 *
 * The precise signal is the per-person promotion bitmask, but the materialized
 * format only assigns distinct bits to the 30 largest promotions — the other
 * 135 share one "other" bit and cannot be told apart by it. For those, the
 * search index's per-person promotion NAMES are the fallback, which the format
 * caps at each person's top six promotions.
 */
function promotionMembers(
  model: GraphModel,
  manifest: Manifest,
  search: SearchEntity[],
  promotionId: string,
): MemberResult {
  const key = promotionId.slice(3);
  const bit = manifest.promo_bits[key];
  const idx = model.indexOfId.get(promotionId)!;
  const name = model.nodes.name[idx] ?? promotionId;

  if (bit !== undefined) {
    const mask = 1 << bit;
    const ids: string[] = [];
    for (let n = 0; n < model.nodes.count; n++) {
      if (model.nodes.type[n] !== 0) continue;
      if ((model.nodes.promoMask[n]! & mask) !== 0) ids.push(model.nodes.id[n]!);
    }
    return { ids, basis: `${ids.length.toLocaleString()} wrestlers documented in ${name}` };
  }

  const ids: string[] = [];
  for (const e of search) {
    if (e.t !== "person" || !e.pm) continue;
    if (e.pm.includes(name)) ids.push(e.id);
  }
  return {
    ids,
    basis: `${ids.length.toLocaleString()} wrestlers documented in ${name}`,
    caveat:
      `${name} is outside the 30 promotions with a dedicated bit in the materialized ` +
      `format, so membership is matched on name against each wrestler's top six ` +
      `promotions — wrestlers for whom ${name} is a minor promotion are missed.`,
  };
}

/** A championship: everyone documented holding it. */
function titleHolders(
  model: GraphModel,
  titleId: string,
  championships: ChampionshipsFile | null,
): MemberResult {
  const idx = model.indexOfId.get(titleId)!;
  const name = model.nodes.name[idx] ?? titleId;
  if (!championships) return { ids: [], basis: "loading reigns…" };
  const rec = championships[titleId];
  if (!rec) return { ids: [], basis: `no documented reigns for ${name}` };
  const seen = new Set<string>();
  for (const reign of rec.reigns) for (const h of reign.holders) seen.add(h);
  const ids = [...seen].filter((id) => model.indexOfId.has(id));
  return {
    ids,
    basis: `${ids.length.toLocaleString()} wrestlers documented holding ${name}`,
    caveat:
      "Holders only. A wrestler who challenged for this title without winning it is " +
      "not lit, because the corpus records title changes rather than title contenders.",
  };
}
