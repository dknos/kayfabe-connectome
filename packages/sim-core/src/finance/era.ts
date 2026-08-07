/**
 * Era resolution for the finance systems (and anything else that needs an
 * EraProfile for a date).
 *
 * Era profiles ship as JSON so a 1970 territory save and a 1997 war save
 * differ by parameters, never by forked code. The file is parsed and
 * validated once at module load; malformed data (unknown contract kind,
 * float cents, bad date) fails loudly instead of seeding a ledger with
 * garbage.
 */

import type { ContractKind, EraProfile, IsoDate } from "@kayfabe/sim-contract";
import { assertIsoDate, compareDates } from "../dates";
import { assertCents } from "../money";
import eraProfilesJson from "../data/era-profiles.json";

type RawEra = (typeof eraProfilesJson)["eras"][number];

function toContractKind(s: string): ContractKind {
  if (s === "exclusive" || s === "written" || s === "appearance" || s === "handshake") {
    return s;
  }
  throw new Error(`era-profiles: unknown contract kind ${JSON.stringify(s)}`);
}

function tierCents(
  rec: { national: number; regional: number; indie: number },
  label: string,
): { national: number; regional: number; indie: number } {
  return {
    national: assertCents(rec.national, `${label}.national`),
    regional: assertCents(rec.regional, `${label}.regional`),
    indie: assertCents(rec.indie, `${label}.indie`),
  };
}

function parseEra(raw: RawEra): EraProfile {
  return {
    id: raw.id,
    label: raw.label,
    appliesFrom: assertIsoDate(raw.appliesFrom),
    appliesTo: assertIsoDate(raw.appliesTo),
    tvAvailable: raw.tvAvailable,
    ppvAvailable: raw.ppvAvailable,
    streamingAvailable: raw.streamingAvailable,
    weeklyTvRightsCents: tierCents(raw.weeklyTvRightsCents, `${raw.id}.weeklyTvRightsCents`),
    ppvBuyRateBase: raw.ppvBuyRateBase,
    ppvPriceCents: assertCents(raw.ppvPriceCents, `${raw.id}.ppvPriceCents`),
    ticketPriceTypicalCents: assertCents(
      raw.ticketPriceTypicalCents,
      `${raw.id}.ticketPriceTypicalCents`,
    ),
    allowedContractKinds: raw.allowedContractKinds.map(toContractKind),
    showOverheadCents: tierCents(raw.showOverheadCents, `${raw.id}.showOverheadCents`),
    weeklyOverheadCents: tierCents(raw.weeklyOverheadCents, `${raw.id}.weeklyOverheadCents`),
    newsSpeed: raw.newsSpeed,
  };
}

export const ERA_PROFILES: readonly EraProfile[] = eraProfilesJson.eras
  .map(parseEra)
  .sort((a, b) => compareDates(a.appliesFrom, b.appliesFrom));

/** Pick the era profile whose [appliesFrom, appliesTo] window contains `date`. */
export function resolveEra(date: IsoDate): EraProfile {
  assertIsoDate(date);
  for (const era of ERA_PROFILES) {
    if (compareDates(era.appliesFrom, date) <= 0 && compareDates(date, era.appliesTo) <= 0) {
      return era;
    }
  }
  throw new Error(`no era profile covers ${date}`);
}
