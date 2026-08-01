import type { GeoPlace } from "@kayfabe/geo-renderer";
import type { GeoData } from "./geoAdapter";

/**
 * Derived geographic metrics.
 *
 * Each one states its formula and refuses the reading it does not support. A
 * card-weighted centroid is the computed centre of documented cards — not a
 * headquarters. A distance between consecutive plotted records is a
 * straight-line great-circle distance between two points on a modern
 * ellipsoid — not travel, not mileage, not a route.
 */

const R_KM = 6371.0088; // IUGG mean Earth radius

export function greatCircleKm(
  aLat: number, aLon: number, bLat: number, bLon: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface GeoFootprint {
  cards: number;
  matches: number;
  places: number;
  countries: number;
  firstDay: number;
  lastDay: number;
  /** Card-weighted spherical centroid — the computed centre of documented
   * cards, in degrees. Not a headquarters, not a home city. */
  centroid: { latitude: number; longitude: number } | null;
  /** Median great-circle distance from the weighted centroid, km. */
  medianSpreadKm: number;
  /** 90th-percentile great-circle distance from the weighted centroid, km. */
  p90SpreadKm: number;
  /** Largest great-circle separation between any two documented places, km. */
  maxSeparationKm: number;
  topPlaces: Array<{ place: GeoPlace; cards: number }>;
  topCountries: Array<{ country: string; cards: number; places: number }>;
  /** Cumulative straight-line distance between CONSECUTIVE PLOTTED RECORDS.
   * Not known travel distance: the corpus records no itineraries, and two
   * consecutive records need not have involved anyone moving between them. */
  recordSequenceKm: number;
  /** New places discovered per year — the shape of geographic expansion. */
  newPlacesByYear: Array<[string, number]>;
}

export const FORMULAS = {
  centroid:
    "card-weighted spherical centroid: each documented card contributes its " +
    "place's unit vector, the sum is normalised and converted back to lat/lon",
  medianSpread:
    "median great-circle distance from the card-weighted centroid to each " +
    "documented card's place (WGS 84 sphere, R = 6371.0088 km)",
  p90Spread: "90th percentile of the same distance distribution",
  maxSeparation:
    "largest great-circle distance between any two documented places in scope",
  recordSequence:
    "sum of great-circle distances between consecutive plotted records in " +
    "chronological order — a straight-line total between plotted points, NOT " +
    "known travel distance",
} as const;

export function computeFootprint(data: GeoData, cardIndices: number[]): GeoFootprint {
  const stride = data.stride;
  let cards = 0;
  let matches = 0;
  let firstDay = Number.POSITIVE_INFINITY;
  let lastDay = -1;
  const placeCards = new Map<number, number>();
  // Unit vectors, so the centroid is spherical rather than a naive mean of
  // degrees (which puts the centre of a Tokyo/Los Angeles pair in Kazakhstan).
  let x = 0, y = 0, z = 0;
  const plotted: number[] = [];

  for (const i of cardIndices) {
    const b = i * stride;
    const day = data.cards[b] ?? 0;
    const place = (data.cards[b + 2] ?? 0) - 1;
    cards++;
    matches += data.cards[b + 4] ?? 0;
    if (day < firstDay) firstDay = day;
    if (day > lastDay) lastDay = day;
    if (place < 0) continue;
    plotted.push(i);
    placeCards.set(place, (placeCards.get(place) ?? 0) + 1);
    const p = data.places[place];
    if (!p) continue;
    const rad = Math.PI / 180;
    const la = p.latitude * rad;
    const lo = p.longitude * rad;
    x += Math.cos(la) * Math.cos(lo);
    y += Math.cos(la) * Math.sin(lo);
    z += Math.sin(la);
  }

  const total = plotted.length;
  let centroid: { latitude: number; longitude: number } | null = null;
  if (total > 0) {
    const hyp = Math.hypot(x, y);
    // A degenerate sum (points exactly antipodal in every axis) has no defined
    // centre; report none rather than a coordinate that means nothing.
    if (hyp > 1e-9 || Math.abs(z) > 1e-9) {
      centroid = {
        latitude: (Math.atan2(z, hyp) * 180) / Math.PI,
        longitude: (Math.atan2(y, x) * 180) / Math.PI,
      };
    }
  }

  const distances: number[] = [];
  if (centroid) {
    for (const i of plotted) {
      const p = data.places[(data.cards[i * stride + 2] ?? 0) - 1];
      if (p) distances.push(greatCircleKm(centroid.latitude, centroid.longitude, p.latitude, p.longitude));
    }
    distances.sort((a, b) => a - b);
  }
  const pick = (q: number): number =>
    distances.length ? Math.round(distances[Math.min(distances.length - 1, Math.floor(q * distances.length))] ?? 0) : 0;

  const placeList = Array.from(placeCards.keys())
    .map((idx) => data.places[idx])
    .filter((p): p is GeoPlace => !!p);
  let maxSep = 0;
  // O(n^2) over PLACES, not cards — a scope with thousands of places is capped
  // so an analytics panel can never stall the lens.
  const sample = placeList.slice(0, 400);
  for (let a = 0; a < sample.length; a++) {
    for (let b = a + 1; b < sample.length; b++) {
      const d = greatCircleKm(
        sample[a]!.latitude, sample[a]!.longitude, sample[b]!.latitude, sample[b]!.longitude,
      );
      if (d > maxSep) maxSep = d;
    }
  }

  let seqKm = 0;
  let prev: GeoPlace | null = null;
  let prevDay = -1;
  for (const i of plotted) {
    const b = i * stride;
    const p = data.places[(data.cards[b + 2] ?? 0) - 1];
    const day = data.cards[b] ?? 0;
    if (p && prev && prev !== p && day !== prevDay) {
      // Same-day records are skipped: the source gives no show times, so
      // chaining them would invent an order and therefore invent a distance.
      seqKm += greatCircleKm(prev.latitude, prev.longitude, p.latitude, p.longitude);
    }
    if (p) {
      prev = p;
      prevDay = day;
    }
  }

  const countries = new Map<string, { cards: number; places: number }>();
  for (const [idx, n] of placeCards) {
    const p = data.places[idx];
    if (!p) continue;
    const k = p.country ?? "—";
    const e = countries.get(k) ?? { cards: 0, places: 0 };
    e.cards += n;
    e.places++;
    countries.set(k, e);
  }

  const seen = new Set<number>();
  const byYear = new Map<string, number>();
  for (const i of plotted) {
    const b = i * stride;
    const place = (data.cards[b + 2] ?? 0) - 1;
    if (seen.has(place)) continue;
    seen.add(place);
    const year = new Date(Date.UTC(1900, 0, 1) + (data.cards[b] ?? 0) * 86400000)
      .getUTCFullYear()
      .toString();
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }

  return {
    cards,
    matches,
    places: placeCards.size,
    countries: countries.size,
    firstDay: Number.isFinite(firstDay) ? firstDay : -1,
    lastDay,
    centroid,
    medianSpreadKm: pick(0.5),
    p90SpreadKm: pick(0.9),
    maxSeparationKm: Math.round(maxSep),
    topPlaces: Array.from(placeCards.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .flatMap(([idx, n]) => {
        const place = data.places[idx];
        return place ? [{ place, cards: n }] : [];
      }),
    topCountries: Array.from(countries.entries())
      .map(([country, v]) => ({ country, ...v }))
      .sort((a, b) => b.cards - a.cards)
      .slice(0, 10),
    recordSequenceKm: Math.round(seqKm),
    newPlacesByYear: Array.from(byYear.entries()).sort(),
  };
}

export interface GeoComparison {
  aOnly: GeoPlace[];
  bOnly: GeoPlace[];
  shared: GeoPlace[];
  /** |A ∩ B| / |A ∪ B| over canonical places, as computed from the current
   * corpus and filters — not a claim about the promotions in general. */
  overlapFraction: number;
  sharedCountries: string[];
  topShared: Array<{ place: GeoPlace; aCards: number; bCards: number }>;
}

export function comparePlaces(
  data: GeoData, aCards: number[], bCards: number[],
): GeoComparison {
  const count = (idx: number[]): Map<number, number> => {
    const m = new Map<number, number>();
    for (const i of idx) {
      const p = (data.cards[i * data.stride + 2] ?? 0) - 1;
      if (p >= 0) m.set(p, (m.get(p) ?? 0) + 1);
    }
    return m;
  };
  const A = count(aCards);
  const B = count(bCards);
  const place = (i: number): GeoPlace | undefined => data.places[i];
  const aOnly: GeoPlace[] = [];
  const bOnly: GeoPlace[] = [];
  const shared: GeoPlace[] = [];
  for (const i of A.keys()) {
    const p = place(i);
    if (!p) continue;
    (B.has(i) ? shared : aOnly).push(p);
  }
  for (const i of B.keys()) {
    if (A.has(i)) continue;
    const p = place(i);
    if (p) bOnly.push(p);
  }
  const union = A.size + B.size - shared.length;
  const countries = new Set<string>();
  for (const p of shared) if (p.country) countries.add(p.country);
  return {
    aOnly: aOnly.sort((x, y) => y.cards - x.cards),
    bOnly: bOnly.sort((x, y) => y.cards - x.cards),
    shared: shared.sort((x, y) => y.cards - x.cards),
    overlapFraction: union ? shared.length / union : 0,
    sharedCountries: Array.from(countries).sort(),
    topShared: shared
      .map((p) => ({ place: p, aCards: A.get(p.index) ?? 0, bCards: B.get(p.index) ?? 0 }))
      .sort((x, y) => y.aCards + y.bCards - (x.aCards + x.bCards))
      .slice(0, 12),
  };
}
