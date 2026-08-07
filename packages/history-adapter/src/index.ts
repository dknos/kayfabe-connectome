export type { CorpusFetch } from "./corpusClient";
export { CorpusClient } from "./corpusClient";
export type {
  CompanyLineage,
  CompanyMeta,
  CompanyMetaFile,
  CrosswalkFile,
  CrosswalkGroup,
  CrosswalkMember,
  LineageFile,
  LineageMember,
  PersonEvidenceBucket,
  PersonMatchRow,
} from "./corpusTypes";
export { canonicalPersonId, loadCrosswalk, type CrosswalkIndex } from "./crosswalk";
export { companyIdFor, eraMember, loadLineages, type LineageIndex } from "./lineage";
export { buildEvidenceSummary, mergeEvidenceRows, type PromoLevelResolver } from "./evidence";
export { loadMarkets, marketForLocation } from "./markets";
export {
  BUILDER_VERSION,
  MAX_DAYS_SINCE_LAST,
  MIN_APPEARANCES,
  ROSTER_METHOD,
  WINDOW_DAYS,
  buildDataHealth,
  buildUniverseSnapshot,
  type BuildSnapshotOptions,
} from "./snapshotBuilder";

import crosswalkJson from "./data/persona-crosswalk.json";
import { loadCrosswalk as _loadCrosswalk, type CrosswalkIndex as _XwIndex } from "./crosswalk";

let _defaultXw: _XwIndex | null = null;

/** The shipped persona-crosswalk@1 overlay, validated and indexed once. */
export function defaultCrosswalk(): _XwIndex {
  if (!_defaultXw) _defaultXw = _loadCrosswalk(crosswalkJson);
  return _defaultXw;
}
