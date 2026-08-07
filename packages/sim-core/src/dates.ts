/**
 * Pure Gregorian calendar arithmetic on ISO "YYYY-MM-DD" strings.
 *
 * The engine never constructs a JS Date: wall-clock time is a determinism
 * hazard and timezone parsing of date-only strings is a classic off-by-one
 * trap. Days are integers (days since 1970-01-01, civil), via Howard
 * Hinnant's days_from_civil algorithm.
 */

export type IsoDate = string; // "YYYY-MM-DD", validated at boundaries

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function assertIsoDate(s: string): IsoDate {
  if (!isIsoDate(s)) throw new Error(`invalid ISO date: ${JSON.stringify(s)}`);
  return s;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeapYear(y) ? 29 : DIM[m - 1]!;
}

/** Days since 1970-01-01 (civil). Hinnant's days_from_civil. */
export function toEpochDay(iso: IsoDate): number {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`invalid ISO date: ${JSON.stringify(iso)}`);
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of toEpochDay. Hinnant's civil_from_days. */
export function fromEpochDay(z: number): IsoDate {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mo = mp + (mp < 10 ? 3 : -9);
  const year = y + (mo <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return fromEpochDay(toEpochDay(iso) + days);
}

/** b - a in days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  // Canonical ISO strings compare lexicographically.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 0 = Monday … 6 = Sunday. */
export function dayOfWeek(iso: IsoDate): number {
  const z = toEpochDay(iso);
  return ((z + 3) % 7 + 7) % 7; // 1970-01-01 was a Thursday
}

export const WEEKDAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
] as const;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function yearOf(iso: IsoDate): number {
  return Number(iso.slice(0, 4));
}

export function monthOf(iso: IsoDate): number {
  return Number(iso.slice(5, 7));
}

export function dayOf(iso: IsoDate): number {
  return Number(iso.slice(8, 10));
}

/** "Monday, January 6, 1997" */
export function formatLong(iso: IsoDate): string {
  return `${WEEKDAY_NAMES[dayOfWeek(iso)]}, ${MONTH_NAMES[monthOf(iso) - 1]} ${dayOf(iso)}, ${yearOf(iso)}`;
}

/** "Jan 6, 1997" */
export function formatShort(iso: IsoDate): string {
  return `${MONTH_NAMES[monthOf(iso) - 1]!.slice(0, 3)} ${dayOf(iso)}, ${yearOf(iso)}`;
}
