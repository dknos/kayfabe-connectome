import type { CrosswalkFile, CrosswalkGroup } from "./corpusTypes";

/**
 * Loaded persona-crosswalk@1 overlay: corpus person ids -> canonical sim
 * person. Groups never invent people; ids absent from a given corpus are
 * simply inert (fixtures use a subset of the real universe).
 */
export interface CrosswalkIndex {
  version: number;
  groups: CrosswalkGroup[];
  /** member corpus id -> canonical corpus id (canonical maps to itself). */
  memberToCanonical: Map<string, string>;
  /** canonical id -> its group. */
  byCanonical: Map<string, CrosswalkGroup>;
}

/**
 * Validate and index a persona-crosswalk file. A corpus id in more than one
 * group (or twice in one) is a load error, as is a canonical id missing from
 * its own member list — silent merges are exactly what the overlay exists to
 * prevent.
 */
export function loadCrosswalk(data: unknown): CrosswalkIndex {
  const file = data as CrosswalkFile;
  if (!file || typeof file.version !== "number" || !Array.isArray(file.groups)) {
    throw new Error("persona-crosswalk: malformed file");
  }
  const memberToCanonical = new Map<string, string>();
  const byCanonical = new Map<string, CrosswalkGroup>();
  for (const group of file.groups) {
    if (typeof group.canonical !== "string" || !Array.isArray(group.members)) {
      throw new Error("persona-crosswalk: malformed group");
    }
    if (byCanonical.has(group.canonical)) {
      throw new Error(`persona-crosswalk: duplicate canonical ${group.canonical}`);
    }
    if (!group.members.some((m) => m.id === group.canonical)) {
      throw new Error(
        `persona-crosswalk: canonical ${group.canonical} not among its members`,
      );
    }
    for (const member of group.members) {
      if (typeof member.id !== "string" || typeof member.persona !== "string") {
        throw new Error(`persona-crosswalk: malformed member in ${group.canonical}`);
      }
      if (memberToCanonical.has(member.id)) {
        throw new Error(`persona-crosswalk: duplicate membership ${member.id}`);
      }
      memberToCanonical.set(member.id, group.canonical);
    }
    byCanonical.set(group.canonical, group);
  }
  return { version: file.version, groups: file.groups, memberToCanonical, byCanonical };
}

/** Canonical id for any corpus person id (identity for unmapped people). */
export function canonicalPersonId(xw: CrosswalkIndex, corpusId: string): string {
  return xw.memberToCanonical.get(corpusId) ?? corpusId;
}
