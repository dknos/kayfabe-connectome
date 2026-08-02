import type { RatingsManifest } from "@kayfabe/graph-contract";

const BASE = import.meta.env.BASE_URL;
const TIMEOUT_MS = 30_000;

export type { RatingsManifest } from "@kayfabe/graph-contract";

export interface RatingsDictionaries {
  schema_version: string;
  ordering: string;
  forms: string[];
  matches: { id: string[] };
  participants: { id: string[]; name: string[] };
  promotions: { id: string[]; name: string[] };
  titles: { id: string[]; name: string[] };
  events: { id: string[]; name: string[] };
}

export interface RatingsHistograms {
  schema_version: string;
  algorithm: string;
  global: {
    total: number;
    rated: number;
    values: Record<string, number>;
    bands: Record<string, number>;
  };
  by_year: Record<string, { total: number; rated: number; values: Record<string, number> }>;
}

export interface ExactColumns {
  count: number;
  day: Int32Array;
  rating: Float64Array;
  promotion: Uint32Array;
  participantOffset: Uint32Array;
  participantCount: Uint16Array;
  flags: Uint16Array;
  form: Uint16Array;
  eventIndex: Uint16Array;
  title: Int32Array;
  placement: Int32Array;
  matchIdIndex: Uint32Array;
  titleOffset: Uint32Array;
  titleCount: Uint16Array;
}

export interface CoverageColumns {
  count: number;
  kind: Uint8Array;
  resolution: Uint8Array;
  subject: Uint32Array;
  periodKey: Uint32Array;
  total: Uint32Array;
  rated: Uint32Array;
  titleChanges: Uint32Array;
  approximate: Uint32Array;
}

export interface LodColumns {
  count: number;
  promotion: Uint32Array;
  resolution: Uint8Array;
  startDay: Int32Array;
  endDay: Int32Array;
  periodKey: Uint32Array;
  total: Uint32Array;
  rated: Uint32Array;
  min: Float64Array;
  max: Float64Array;
  sum: Float64Array;
  median: Float64Array;
  fourPlus: Uint32Array;
  fivePlus: Uint32Array;
  approximate: Uint32Array;
}

export interface RatingsData {
  manifest: RatingsManifest;
  dictionaries: RatingsDictionaries;
  histograms: RatingsHistograms | null;
  exact: ExactColumns;
  participants: Uint32Array;
  titles: Uint32Array;
  coverage: CoverageColumns;
  lod: LodColumns;
  exactMatchIds: string[];
  exactIndexById: Map<string, number>;
  promotionIndexById: Map<string, number>;
  participantIndexById: Map<string, number>;
  titleIndexById: Map<string, number>;
  exactByPromotion: Map<number, number[]>;
  exactByParticipant: Map<number, number[]>;
  exactByTitle: Map<number, number[]>;
  decodeDurationMs: number;
  payloadBytes: number;
  coverageRows(kind: number, subject: number, resolution: number): readonly [number, number];
  lodRows(promotion: number, resolution: number): readonly [number, number];
}

let cached: Promise<RatingsData> | null = null;

export function loadRatings(onProgress?: (fraction: number, what: string) => void): Promise<RatingsData> {
  if (cached) return cached;
  const request = load(onProgress);
  cached = request;
  void request.catch(() => {
    if (cached === request) cached = null;
  });
  return request;
}

export function __resetRatingsCache(): void {
  cached = null;
}

async function load(onProgress?: (fraction: number, what: string) => void): Promise<RatingsData> {
  const started = performance.now();
  onProgress?.(0.02, "ratings manifest");
  const manifest = await getJson<RatingsManifest>("ratings/manifest.json");
  assertManifest(manifest);
  onProgress?.(0.08, "ratings dictionaries");
  const [dictionariesRaw, matchesRaw, participantsRaw, titlesRaw, coverageRaw, lodRaw, histogramsRaw] = await Promise.all([
    getRaw("ratings/dictionaries.json"),
    getRaw("ratings/matches.bin"),
    getRaw("ratings/participants.bin"),
    getRaw("ratings/titles.bin"),
    getRaw("ratings/coverage.bin"),
    getRaw("ratings/lod.bin"),
    getRaw("ratings/histograms.json"),
  ]);
  onProgress?.(0.56, "verifying ratings projection");
  const payloads: Record<string, ArrayBuffer> = {
    "dictionaries.json": dictionariesRaw,
    "matches.bin": matchesRaw,
    "participants.bin": participantsRaw,
    "titles.bin": titlesRaw,
    "coverage.bin": coverageRaw,
    "lod.bin": lodRaw,
    "histograms.json": histogramsRaw,
  };
  await verifyChecksums(payloads, manifest.checksums);
  const dictionaries = JSON.parse(new TextDecoder().decode(dictionariesRaw)) as RatingsDictionaries;
  const histograms = JSON.parse(new TextDecoder().decode(histogramsRaw)) as RatingsHistograms;
  assertDictionaries(dictionaries, manifest);
  assertLength(matchesRaw, manifest.binary.matches.record_count, manifest.binary.matches.stride, "matches.bin");
  assertLength(participantsRaw, manifest.binary.participants.record_count, manifest.binary.participants.stride, "participants.bin");
  assertLength(titlesRaw, manifest.binary.titles.record_count, manifest.binary.titles.stride, "titles.bin");
  assertLength(coverageRaw, manifest.binary.coverage.record_count, manifest.binary.coverage.stride, "coverage.bin");
  assertLength(lodRaw, manifest.binary.lod.record_count, manifest.binary.lod.stride, "lod.bin");
  onProgress?.(0.68, "decoding ratings columns");
  const exact = decodeExact(matchesRaw, manifest.binary.matches.record_count);
  const participants = new Uint32Array(participantsRaw);
  const titles = new Uint32Array(titlesRaw);
  const coverage = decodeCoverage(coverageRaw, manifest.binary.coverage.record_count);
  const lod = decodeLod(lodRaw, manifest.binary.lod.record_count);
  validateDecoded(exact, participants, titles, coverage, lod, dictionaries, manifest);
  const exactMatchIds = new Array<string>(exact.count);
  const exactIndexById = new Map<string, number>();
  const exactByPromotion = new Map<number, number[]>();
  const exactByParticipant = new Map<number, number[]>();
  const exactByTitle = new Map<number, number[]>();
  for (let i = 0; i < exact.count; i++) {
    const id = dictionaries.matches.id[exact.matchIdIndex[i]!]!;
    if (exactIndexById.has(id)) throw new Error(`Duplicate canonical rating match id ${id}`);
    exactMatchIds[i] = id;
    exactIndexById.set(id, i);
    pushIndex(exactByPromotion, exact.promotion[i]!, i);
    const t0 = exact.titleOffset[i]!;
    const t1 = t0 + exact.titleCount[i]!;
    for (let t = t0; t < t1; t++) pushIndex(exactByTitle, titles[t]!, i);
    const seen = new Set<number>();
    const p0 = exact.participantOffset[i]!;
    const p1 = p0 + exact.participantCount[i]!;
    for (let p = p0; p < p1; p++) {
      const person = participants[p]!;
      if (seen.has(person)) continue;
      seen.add(person);
      pushIndex(exactByParticipant, person, i);
    }
  }
  const promotionIndexById = indexMap(dictionaries.promotions.id);
  const participantIndexById = indexMap(dictionaries.participants.id);
  const titleIndexById = indexMap(dictionaries.titles.id);
  onProgress?.(0.94, "indexing sparse coverage");
  const coverageRows = makeCoverageRangeFinder(coverage);
  const lodRows = makeLodRangeFinder(lod);
  onProgress?.(1, "ratings ready");
  return {
    manifest,
    dictionaries,
    histograms,
    exact,
    participants,
    titles,
    coverage,
    lod,
    exactMatchIds,
    exactIndexById,
    promotionIndexById,
    participantIndexById,
    titleIndexById,
    exactByPromotion,
    exactByParticipant,
    exactByTitle,
    decodeDurationMs: performance.now() - started,
    payloadBytes: Object.values(payloads).reduce((sum, value) => sum + value.byteLength, 0),
    coverageRows,
    lodRows,
  };
}

async function fetchWithTimeout(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}data/${path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`GET /data/${path} → ${response.status}`);
    return response;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Timed out loading ${path}`);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function getRaw(path: string): Promise<ArrayBuffer> {
  return (await fetchWithTimeout(path)).arrayBuffer();
}

async function getJson<T>(path: string): Promise<T> {
  return (await fetchWithTimeout(path)).json() as Promise<T>;
}

function assertManifest(manifest: RatingsManifest): void {
  if (manifest.schema_version !== "2.0.0" || manifest.projection_version !== "meltzer-ratings@2") {
    throw new Error(`Unsupported ratings projection ${manifest.schema_version}/${manifest.projection_version}`);
  }
  if (!manifest.validation?.passed || Object.values(manifest.validation.checks ?? {}).some((value) => !value)) {
    throw new Error("Ratings projection failed validation — refusing to render it.");
  }
  if (manifest.binary?.endianness !== "little") throw new Error("Ratings projection endianness is unsupported");
  if (manifest.binary.matches.stride !== 48 || manifest.binary.titles.stride !== 4 || manifest.binary.coverage.stride !== 28 || manifest.binary.lod.stride !== 72) {
    throw new Error("Ratings projection binary stride mismatch");
  }
  const range = manifest.rating_value_range;
  if (range !== null && (range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1] || range[0] < -1 || range[1] > 8)) {
    throw new Error("Ratings projection rating range is invalid");
  }
  const coverage = manifest.overall_coverage;
  if (!Number.isInteger(manifest.counts.canonical_matches) || manifest.counts.canonical_matches <= 0
    || !Number.isInteger(manifest.counts.rated_matches) || manifest.counts.rated_matches < 0
    || !coverage || coverage.rated_matches !== manifest.counts.rated_matches
    || coverage.total_documented_matches !== manifest.counts.canonical_matches
    || coverage.rated_matches > coverage.total_documented_matches
    || !Number.isFinite(coverage.fraction)
    || coverage.fraction < 0 || coverage.fraction > 1
    || Math.abs(coverage.fraction - coverage.rated_matches / coverage.total_documented_matches) > Number.EPSILON) {
    throw new Error("Ratings projection overall coverage is inconsistent");
  }
  if ((manifest.counts.rated_matches === 0) !== (range === null)
    || !Number.isInteger(manifest.promotions_with_ratings)
    || manifest.promotions_with_ratings < 0
    || manifest.promotions_with_ratings > manifest.dictionary_counts.promotions) {
    throw new Error("Ratings projection population summary is inconsistent");
  }
  const expectedBins = { year: [0, 12], quarter: [1, 3], month: [2, 1] } as const;
  for (const [name, expected] of Object.entries(expectedBins) as [keyof typeof expectedBins, readonly [number, number]][]) {
    const bin = manifest.aggregate_bin_sizes?.[name];
    if (!bin || bin.resolution_code !== expected[0] || bin.calendar_months !== expected[1]) {
      throw new Error(`Ratings projection ${name} aggregate bin contract is invalid`);
    }
  }
}

function assertDictionaries(d: RatingsDictionaries, manifest: RatingsManifest): void {
  for (const key of ["participants", "promotions", "titles", "events"] as const) {
    if (d[key].id.length !== d[key].name.length || d[key].id.length !== manifest.dictionary_counts[key]) {
      throw new Error(`ratings dictionaries.${key} shape mismatch`);
    }
  }
  if (d.matches.id.length !== manifest.dictionary_counts.matches) throw new Error("ratings match dictionary shape mismatch");
}

function assertLength(buffer: ArrayBuffer, records: number, stride: number, name: string): void {
  if (buffer.byteLength !== records * stride) throw new Error(`${name} byte length ${buffer.byteLength} ≠ ${records * stride}`);
}

async function verifyChecksums(payloads: Record<string, ArrayBuffer>, checksums: Record<string, string>): Promise<void> {
  if (!crypto.subtle) return;
  await Promise.all(Object.entries(payloads).map(async ([name, data]) => {
    const expected = checksums[name];
    if (!expected) throw new Error(`Ratings manifest omitted checksum for ${name}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
    let actual = "";
    for (const byte of digest) actual += byte.toString(16).padStart(2, "0");
    if (actual !== expected) throw new Error(`Ratings projection checksum mismatch for ${name}`);
  }));
}

function decodeExact(buffer: ArrayBuffer, count: number): ExactColumns {
  const view = new DataView(buffer);
  const out: ExactColumns = {
    count,
    day: new Int32Array(count), rating: new Float64Array(count), promotion: new Uint32Array(count),
    participantOffset: new Uint32Array(count), participantCount: new Uint16Array(count), flags: new Uint16Array(count),
    form: new Uint16Array(count), eventIndex: new Uint16Array(count), title: new Int32Array(count), placement: new Int32Array(count),
    matchIdIndex: new Uint32Array(count), titleOffset: new Uint32Array(count), titleCount: new Uint16Array(count),
  };
  for (let i = 0; i < count; i++) {
    const at = i * 48;
    out.day[i] = view.getInt32(at, true);
    out.rating[i] = view.getFloat64(at + 4, true);
    out.promotion[i] = view.getUint32(at + 12, true);
    out.participantOffset[i] = view.getUint32(at + 16, true);
    out.participantCount[i] = view.getUint16(at + 20, true);
    out.flags[i] = view.getUint16(at + 22, true);
    out.form[i] = view.getUint16(at + 24, true);
    out.eventIndex[i] = view.getUint16(at + 26, true);
    out.title[i] = view.getInt32(at + 28, true);
    out.placement[i] = view.getInt32(at + 32, true);
    out.matchIdIndex[i] = view.getUint32(at + 36, true);
    out.titleOffset[i] = view.getUint32(at + 40, true);
    out.titleCount[i] = view.getUint16(at + 44, true);
  }
  return out;
}

function decodeCoverage(buffer: ArrayBuffer, count: number): CoverageColumns {
  const view = new DataView(buffer);
  const out: CoverageColumns = {
    count,
    kind: new Uint8Array(count), resolution: new Uint8Array(count), subject: new Uint32Array(count),
    periodKey: new Uint32Array(count), total: new Uint32Array(count), rated: new Uint32Array(count),
    titleChanges: new Uint32Array(count), approximate: new Uint32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const at = i * 28;
    out.kind[i] = view.getUint8(at);
    out.resolution[i] = view.getUint8(at + 1);
    out.subject[i] = view.getUint32(at + 4, true);
    out.periodKey[i] = view.getUint32(at + 8, true);
    out.total[i] = view.getUint32(at + 12, true);
    out.rated[i] = view.getUint32(at + 16, true);
    out.titleChanges[i] = view.getUint32(at + 20, true);
    out.approximate[i] = view.getUint32(at + 24, true);
  }
  return out;
}

function decodeLod(buffer: ArrayBuffer, count: number): LodColumns {
  const view = new DataView(buffer);
  const out: LodColumns = {
    count,
    promotion: new Uint32Array(count), resolution: new Uint8Array(count), startDay: new Int32Array(count), endDay: new Int32Array(count),
    periodKey: new Uint32Array(count), total: new Uint32Array(count), rated: new Uint32Array(count),
    min: new Float64Array(count), max: new Float64Array(count), sum: new Float64Array(count), median: new Float64Array(count),
    fourPlus: new Uint32Array(count), fivePlus: new Uint32Array(count), approximate: new Uint32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const at = i * 72;
    out.promotion[i] = view.getUint32(at, true);
    out.resolution[i] = view.getUint8(at + 4);
    out.startDay[i] = view.getInt32(at + 8, true);
    out.endDay[i] = view.getInt32(at + 12, true);
    out.periodKey[i] = view.getUint32(at + 16, true);
    out.total[i] = view.getUint32(at + 20, true);
    out.rated[i] = view.getUint32(at + 24, true);
    out.min[i] = view.getFloat64(at + 28, true);
    out.max[i] = view.getFloat64(at + 36, true);
    out.sum[i] = view.getFloat64(at + 44, true);
    out.median[i] = view.getFloat64(at + 52, true);
    out.fourPlus[i] = view.getUint32(at + 60, true);
    out.fivePlus[i] = view.getUint32(at + 64, true);
    out.approximate[i] = view.getUint32(at + 68, true);
  }
  return out;
}

function validateDecoded(exact: ExactColumns, participants: Uint32Array, titles: Uint32Array, coverage: CoverageColumns, lod: LodColumns, d: RatingsDictionaries, manifest: RatingsManifest): void {
  const matchIds = new Set<string>();
  for (let i = 0; i < exact.count; i++) {
    const id = d.matches.id[exact.matchIdIndex[i]!];
    if (!id || matchIds.has(id)) throw new Error("Ratings exact set contains a missing or duplicate canonical id");
    matchIds.add(id);
    if (!Number.isFinite(exact.rating[i]) || exact.promotion[i]! >= d.promotions.id.length || exact.form[i]! >= d.forms.length || exact.eventIndex[i]! >= d.events.id.length) {
      throw new Error(`Ratings exact record ${id} failed bounds validation`);
    }
    if (exact.participantOffset[i]! + exact.participantCount[i]! > participants.length) throw new Error(`Ratings participant range escaped buffer for ${id}`);
    if (exact.titleOffset[i]! + exact.titleCount[i]! > titles.length) throw new Error(`Ratings title range escaped buffer for ${id}`);
  }
  for (const p of participants) if (p >= d.participants.id.length) throw new Error("Ratings participant dictionary index escaped bounds");
  for (const t of titles) if (t >= d.titles.id.length) throw new Error("Ratings title dictionary index escaped bounds");
  for (let i = 0; i < coverage.count; i++) if (coverage.rated[i]! > coverage.total[i]!) throw new Error("Ratings coverage numerator exceeds denominator");
  for (let i = 0; i < lod.count; i++) {
    if (lod.rated[i]! > lod.total[i]! || lod.fivePlus[i]! > lod.fourPlus[i]! || lod.fourPlus[i]! > lod.rated[i]!) {
      throw new Error("Ratings LOD aggregate counts are inconsistent");
    }
  }
  if (exact.count !== manifest.counts.rated_matches) throw new Error("Ratings exact count disagrees with manifest");
  if (exact.count === 0) {
    if (manifest.rating_value_range !== null || manifest.promotions_with_ratings !== 0) throw new Error("Empty ratings projection has a non-empty summary");
  } else {
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    const promotions = new Set<number>();
    for (let i = 0; i < exact.count; i++) {
      minimum = Math.min(minimum, exact.rating[i]!);
      maximum = Math.max(maximum, exact.rating[i]!);
      promotions.add(exact.promotion[i]!);
    }
    if (manifest.rating_value_range?.[0] !== minimum || manifest.rating_value_range?.[1] !== maximum || manifest.promotions_with_ratings !== promotions.size) {
      throw new Error("Ratings exact records disagree with manifest summary");
    }
  }
}

function indexMap(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, i]));
}

function pushIndex(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function makeCoverageRangeFinder(columns: CoverageColumns): (kind: number, subject: number, resolution: number) => readonly [number, number] {
  const compare = (i: number, kind: number, subject: number, resolution: number): number => {
    if (columns.kind[i] !== kind) return columns.kind[i]! < kind ? -1 : 1;
    if (columns.subject[i] !== subject) return columns.subject[i]! < subject ? -1 : 1;
    if (columns.resolution[i] !== resolution) return columns.resolution[i]! < resolution ? -1 : 1;
    return 0;
  };
  return (kind, subject, resolution) => {
    let lo = 0;
    let hi = columns.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(mid, kind, subject, resolution) < 0) lo = mid + 1;
      else hi = mid;
    }
    const start = lo;
    while (lo < columns.count && compare(lo, kind, subject, resolution) === 0) lo++;
    return [start, lo] as const;
  };
}

function makeLodRangeFinder(columns: LodColumns): (promotion: number, resolution: number) => readonly [number, number] {
  const compare = (i: number, promotion: number, resolution: number): number => {
    if (columns.promotion[i] !== promotion) return columns.promotion[i]! < promotion ? -1 : 1;
    if (columns.resolution[i] !== resolution) return columns.resolution[i]! < resolution ? -1 : 1;
    return 0;
  };
  return (promotion, resolution) => {
    let lo = 0;
    let hi = columns.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(mid, promotion, resolution) < 0) lo = mid + 1;
      else hi = mid;
    }
    const start = lo;
    while (lo < columns.count && compare(lo, promotion, resolution) === 0) lo++;
    return [start, lo] as const;
  };
}
