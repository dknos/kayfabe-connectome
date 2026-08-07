/**
 * Hashing lives in @kayfabe/sim-contract (the history adapter needs it too
 * and must not depend on sim-core). Re-exported here so engine code and
 * tests keep a local import path.
 */
export { canonicalJson, hashString, hashValue } from "@kayfabe/sim-contract";
