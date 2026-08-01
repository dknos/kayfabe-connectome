import { bucketOf } from "@kayfabe/graph-contract";
import type { GeoPlace } from "@kayfabe/geo-renderer";
import type {
  GeoCard, GeoManifest, GeoPlacesFile, GeoQualityFile, GeoScope, GeoStringsFile,
  GeoUnresolvedRow, SourceLocationRow,
} from "./geoTypes";

/**
 * Loads the geographic projection and answers scope queries against it.
 *
 * Scope resolution returns CARD INDICES into one shared, date-sorted table.
 * Every scope therefore plays in the same chronological order, and switching
 * scope is an index-list swap rather than a reload.
 */

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`/data/geo/${path}`);
  if (!res.ok) throw new Error(`GET /data/geo/${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface GeoData {
  manifest: GeoManifest;
  places: GeoPlace[];
  placeIndexOf: Map<string, number>;
  strings: GeoStringsFile;
  cards: Uint32Array;
  cardCount: number;
  stride: number;
  quality: GeoQualityFile;
  yearIndex: Record<string, [number, number]>;
}

const FLAG_UNRESOLVED_PARTICIPANT = 1;
const FLAG_CSV = 2;

export async function loadGeo(onProgress?: (frac: number, what: string) => void): Promise<GeoData> {
  onProgress?.(0.1, "geo manifest");
  const manifest = await getJSON<GeoManifest>("manifest.json");
  onProgress?.(0.3, "places");
  const raw = await getJSON<GeoPlacesFile>("places.json");
  onProgress?.(0.55, "cards");
  const res = await fetch("/data/geo/cards.bin");
  if (!res.ok) throw new Error(`cards.bin → ${res.status}`);
  const cards = new Uint32Array(await res.arrayBuffer());
  const expected = manifest.cards_bin.count * manifest.cards_bin.stride_u32;
  if (cards.length !== expected) {
    throw new Error(`cards.bin has ${cards.length} u32, manifest says ${expected}`);
  }
  onProgress?.(0.8, "card index");
  const strings = await getJSON<GeoStringsFile>("cards-strings.json");
  const quality = await getJSON<GeoQualityFile>("quality.json");
  const yearIndex = await getJSON<Record<string, [number, number]>>("by-year/index.json");

  const places: GeoPlace[] = [];
  const placeIndexOf = new Map<string, number>();
  for (let i = 0; i < raw.count; i++) {
    const id = raw.id[i];
    if (id === undefined) continue;
    places.push({
      index: i,
      id,
      displayName: raw.displayName[i] ?? id,
      city: raw.city[i] ?? null,
      admin1: raw.admin1[i] ?? null,
      country: raw.country[i] ?? null,
      countryCode: raw.countryCode[i] ?? null,
      latitude: raw.lat[i] ?? 0,
      longitude: raw.lon[i] ?? 0,
      precision: (raw.precision[i] ?? "city") as GeoPlace["precision"],
      resolution: (raw.resolution[i] ?? "probable") as GeoPlace["resolution"],
      confidence: raw.confidence[i] ?? 0,
      source: raw.source[i] ?? "",
      cards: raw.cards[i] ?? 0,
      matches: raw.matches[i] ?? 0,
      titleMatches: raw.titleMatches[i] ?? 0,
      titleChanges: raw.titleChanges[i] ?? 0,
      firstDay: raw.firstDay[i] ?? -1,
      lastDay: raw.lastDay[i] ?? -1,
    });
    placeIndexOf.set(id, i);
  }
  onProgress?.(1, "ready");
  return {
    manifest, places, placeIndexOf, strings, cards,
    cardCount: manifest.cards_bin.count, stride: manifest.cards_bin.stride_u32,
    quality, yearIndex,
  };
}

/** Decode one card record. Cheap enough to call per frame for the current card. */
export function readCard(data: GeoData, index: number): GeoCard {
  const b = index * data.stride;
  const c = data.cards;
  const titles = c[b + 6] ?? 0;
  const flags = c[b + 7] ?? 0;
  return {
    index,
    cardId: data.strings.cardIds[index] ?? "",
    day: c[b] ?? 0,
    promotionIdx: c[b + 1] ?? 0,
    placeIdx: (c[b + 2] ?? 0) - 1,
    eventNameIdx: c[b + 3] ?? 0,
    matchCount: c[b + 4] ?? 0,
    personCount: c[b + 5] ?? 0,
    titleMatchCount: titles & 0xffff,
    titleChangeCount: (titles >>> 16) & 0xffff,
    unresolvedParticipant: (flags & FLAG_UNRESOLVED_PARTICIPANT) !== 0,
    csvSource: (flags & FLAG_CSV) !== 0,
  };
}

/* ------------------------------------------------------------------ scopes */

const promoScope = lazy<Record<string, number[]>>("scopes/promotions.json");
const placeScope = lazy<Record<string, number[]>>("scopes/places.json");
const eventScope = lazy<Record<string, number[]>>("scopes/events.json");
const titleScope = lazy<Record<string, number[]>>("scopes/titles.json");
const unresolvedFile = lazy<GeoUnresolvedRow[]>("unresolved.json");
const sourceMap = lazy<Record<string, SourceLocationRow>>("source-location-map.json");

function lazy<T>(path: string): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= getJSON<T>(path));
}

const peopleShards = new Map<string, Promise<Record<string, number[]>>>();
function loadPersonShard(id: string): Promise<Record<string, number[]>> {
  const b = bucketOf(id);
  let p = peopleShards.get(b);
  if (!p) {
    p = getJSON<Record<string, number[]>>(`scopes/people/${b}.json`).catch(() => ({}));
    peopleShards.set(b, p);
  }
  return p;
}

export const loadUnresolved = unresolvedFile;
export const loadSourceLocationMap = sourceMap;

/**
 * Card indices for a scope, already sorted (the projection emits sorted lists
 * and the union below re-sorts).
 *
 * A PAIR scope is intentionally derived from the existing pair evidence store
 * rather than from a new index: the evidence entries already name the card of
 * every supporting match, so the geography of an encounter is exactly the
 * geography of its evidence — there is no second source of truth to drift.
 */
export async function resolveScope(
  data: GeoData,
  scope: GeoScope,
  pairCardIds?: string[],
): Promise<number[]> {
  switch (scope.kind) {
    case "corpus":
      return range(data.cardCount);
    case "promotion":
      return union(await promoScope(), scope.ids);
    case "place":
      return union(await placeScope(), scope.ids);
    case "event":
      return union(await eventScope(), scope.ids);
    case "championship":
      return union(await titleScope(), scope.ids);
    case "person": {
      const out: number[][] = [];
      for (const id of scope.ids) out.push((await loadPersonShard(id))[id] ?? []);
      return dedupeSorted(out);
    }
    case "pair": {
      if (!pairCardIds?.length) return [];
      const pos = cardPosition(data);
      const idx: number[] = [];
      for (const cid of pairCardIds) {
        const i = pos.get(cid);
        if (i !== undefined) idx.push(i);
      }
      return Array.from(new Set(idx)).sort((a, b) => a - b);
    }
    default:
      return [];
  }
}

let posCache: Map<string, number> | null = null;
function cardPosition(data: GeoData): Map<string, number> {
  if (!posCache) {
    posCache = new Map();
    for (let i = 0; i < data.strings.cardIds.length; i++) {
      posCache.set(data.strings.cardIds[i]!, i);
    }
  }
  return posCache;
}

function range(n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

function union(table: Record<string, number[]>, ids: string[]): number[] {
  const first = ids[0];
  if (ids.length === 1 && first !== undefined) return table[first] ?? [];
  return dedupeSorted(ids.map((id) => table[id] ?? []));
}

function dedupeSorted(lists: number[][]): number[] {
  if (lists.length === 1) return lists[0]!;
  const seen = new Set<number>();
  for (const l of lists) for (const v of l) seen.add(v);
  return Array.from(seen).sort((a, b) => a - b);
}

/** Restrict a scope's cards to a day range. Cards are day-sorted, so this is a
 * filter rather than a scan of the whole corpus. */
export function clampToRange(
  data: GeoData, indices: number[], dayMin: number, dayMax: number,
): number[] {
  const out: number[] = [];
  for (const i of indices) {
    const d = data.cards[i * data.stride] ?? 0;
    if (d >= dayMin && d <= dayMax) out.push(i);
  }
  return out;
}
