import type { ChampionshipsFile, Manifest, SearchEntity } from "@kayfabe/graph-contract";
import type { GraphModel } from "./model";

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

  if (type === 0) return peopleFor(model, i);
  if (type === 1) return promotionMembers(model, manifest, search, selectedId);
  if (type === 2) return titleHolders(model, selectedId, championships);
  return EMPTY;
}

/** A wrestler: everyone they share a documented match with. */
function peopleFor(model: GraphModel, node: number): MemberResult {
  // model.neighbors walks the FULL adjacency, not the drawn subset. The
  // renderer caps how many ribbons it draws, but capping who is *lit* would
  // mean a wrestler with 500 opponents silently shows 160 of them.
  const ids: string[] = [];
  for (const { node: n } of model.neighbors(node)) {
    const id = model.nodes.id[n];
    if (id) ids.push(id);
  }
  return {
    ids,
    basis: `${ids.length.toLocaleString()} wrestlers share a documented match`,
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
