/**
 * Money is integer cents, always. No floats, no implicit rounding.
 * Every arithmetic helper asserts integer inputs so a stray float fails
 * loudly at the point of corruption instead of drifting a ledger.
 */

export type Cents = number;

export function assertCents(v: number, label = "amount"): Cents {
  if (!Number.isSafeInteger(v)) {
    throw new Error(`money: ${label} must be integer cents, got ${v}`);
  }
  return v;
}

export function addCents(a: Cents, b: Cents): Cents {
  return assertCents(a) + assertCents(b);
}

/** Multiply cents by a real factor, rounding to nearest cent (half away from zero). */
export function scaleCents(a: Cents, factor: number): Cents {
  assertCents(a);
  if (!Number.isFinite(factor)) throw new Error(`money: bad factor ${factor}`);
  const raw = a * factor;
  return raw >= 0 ? Math.round(raw) : -Math.round(-raw);
}

export function dollars(d: number): Cents {
  return scaleCents(100, d);
}

export function formatUSD(cents: Cents, opts?: { compact?: boolean }): string {
  assertCents(cents, "formatUSD");
  const neg = cents < 0;
  const abs = Math.abs(cents);
  if (opts?.compact && abs >= 1_000_000_00) {
    const m = abs / 1_000_000_00;
    return `${neg ? "-" : ""}$${m >= 100 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (opts?.compact && abs >= 10_000_00) {
    const k = abs / 1_000_00;
    return `${neg ? "-" : ""}$${k.toFixed(0)}K`;
  }
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${grouped}.${frac}`;
}
