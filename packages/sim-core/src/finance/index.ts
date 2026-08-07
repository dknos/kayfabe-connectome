/**
 * Finance systems: attendance-demand@1 + ledger@1.
 * Rules documented in docs/simulator/rules/finance.md.
 */

export { ERA_PROFILES, resolveEra } from "./era";
export { MARKETS } from "./markets";
export {
  ATTENDANCE_METHOD,
  affinityFactor,
  effectiveStanding,
  estimateAttendance,
  forecastShow,
} from "./attendance";
export type { AttendanceInputs } from "./attendance";
export { LEDGER_METHOD, runWeeklyFinances, settleShow } from "./settlement";
export { applyTransactions, auditLedger } from "./ledger";
