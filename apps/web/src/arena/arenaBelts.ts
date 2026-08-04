/**
 * Per-person championship marks for the Arena Array's card glyphs.
 *
 * `nodes.reigns` is one scalar and cannot answer the question the glyph strip
 * asks — a singles belt and a tag belt are different claims about a career.
 * `entities/championships.json` can: every documented reign carries its
 * `holders`, so a reign held by one person is a singles reign and a reign held
 * by two or more is a tag reign. That is the corpus's own record of the fact,
 * not an inference from match form.
 *
 * The alternative — reading the edge's `title` count beside its `formMask` —
 * was rejected because both are aggregates over the whole pair: a singles
 * title match beside an unrelated tag match would read as a tag title reign
 * that never happened.
 *
 * Reigns from titles the materializer flags as source artifacts (concatenated
 * belt names it refused to split) are counted like any other. They are real
 * documented reigns; only the belt's NAME is unreliable, and the glyph never
 * claims which belt it was.
 */
import type { ChampionshipsFile } from "@kayfabe/graph-contract";
import { loadChampionships } from "../data/loader";

export interface BeltCounts {
  singles: number;
  tag: number;
}

export type BeltIndex = ReadonlyMap<string, BeltCounts>;

export function buildBeltIndex(file: ChampionshipsFile): Map<string, BeltCounts> {
  const index = new Map<string, BeltCounts>();
  for (const record of Object.values(file)) {
    for (const reign of record.reigns) {
      const tag = reign.holders.length > 1;
      for (const holder of reign.holders) {
        const entry = index.get(holder);
        if (entry) {
          if (tag) entry.tag++;
          else entry.singles++;
        } else {
          index.set(holder, { singles: tag ? 0 : 1, tag: tag ? 1 : 0 });
        }
      }
    }
  }
  return index;
}

let pending: Promise<BeltIndex> | null = null;

/** One build per session. The file is ~800 KB and already cached by the shared
 *  loader, so this costs a single pass over the reigns the first time a reader
 *  opens the lens. */
export function loadBeltIndex(): Promise<BeltIndex> {
  if (!pending) {
    const request = loadChampionships().then(buildBeltIndex);
    pending = request;
    void request.catch(() => {
      if (pending === request) pending = null;
    });
  }
  return pending;
}
