import { z } from "zod";
import type {
  ChampionshipsFile,
  CommunitiesFile,
  DensityFile,
  EvidenceBucket,
  Manifest,
  NodesColumnar,
  PeopleBucket,
  PersonMatchesBucket,
  PromotionsFile,
  SearchEntity,
  TimelineEvent,
} from "@kayfabe/graph-contract";
import { bucketOf } from "@kayfabe/graph-contract";

const manifestSchema = z.object({
  schema_version: z.string(),
  source_fingerprint: z.string(),
  layout_version: z.string(),
  projection_version: z.string(),
  algorithms: z.record(z.string()),
  counts: z.record(z.number()),
  date_range: z.tuple([z.string(), z.string()]),
  edges_bin: z.object({
    count: z.number().int().nonnegative(),
    stride_u32: z.literal(10),
    fields: z.array(z.string()).length(10),
  }),
  promo_bits: z.record(z.number()),
  form_bits: z.record(z.number()),
  validation: z.object({ passed: z.boolean() }).passthrough(),
});

/** Deploy base. Vite injects "/" in dev and the configured base in a build,
 * so the same code works at a domain root and under a project subpath. */
const BASE = import.meta.env.BASE_URL;
const LOAD_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Timed out loading ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}data/${path}`);
  if (!res.ok) throw new Error(`GET /data/${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface CoreData {
  manifest: Manifest;
  nodes: NodesColumnar;
  edges: Uint32Array;
  communities: CommunitiesFile;
  density: DensityFile;
  search: SearchEntity[];
  promotions: PromotionsFile;
}

export async function loadCore(onProgress: (frac: number, what: string) => void): Promise<CoreData> {
  onProgress(0.05, "manifest");
  const manifestRaw = await getJSON<unknown>("manifest.json");
  const manifest = manifestSchema.passthrough().parse(manifestRaw) as unknown as Manifest;
  if (!manifest.validation.passed) {
    throw new Error("Materialized data failed its own validation — refusing to render unverified data.");
  }

  onProgress(0.15, "nodes");
  const nodes = await getJSON<NodesColumnar>("graph/nodes.json");
  const n = nodes.count;
  for (const key of ["id", "type", "name", "community", "firstDay", "lastDay", "matches", "degree", "reigns", "promoMask", "resolution"] as const) {
    if (nodes[key].length !== n) throw new Error(`nodes.${key} length ${nodes[key].length} ≠ count ${n}`);
  }
  if (nodes.pos.length !== 3 * n) throw new Error("nodes.pos length mismatch");

  onProgress(0.45, "edges");
  const res = await fetchWithTimeout(`${BASE}data/graph/edges.bin`);
  if (!res.ok) throw new Error(`edges.bin → ${res.status}`);
  const buf = await res.arrayBuffer();
  const edges = new Uint32Array(buf);
  const expected = manifest.edges_bin.count * manifest.edges_bin.stride_u32;
  if (edges.length !== expected) {
    throw new Error(`edges.bin has ${edges.length} u32, manifest says ${expected}`);
  }

  onProgress(0.7, "communities");
  const communities = await getJSON<CommunitiesFile>("graph/communities.json");
  onProgress(0.75, "promotions");
  const promotions = await getJSON<PromotionsFile>("graph/promotions.json").catch(
    () => ({}) as PromotionsFile,
  );
  onProgress(0.8, "timeline density");
  const density = await getJSON<DensityFile>("timeline/density.json");
  onProgress(0.9, "search index");
  const search = await getJSON<SearchEntity[]>("search/entities.json");
  onProgress(1, "ready");
  return { manifest, nodes, edges, communities, density, search, promotions };
}

/* ---------- lazy caches ---------- */

const evidenceCache = new Map<string, Promise<EvidenceBucket>>();
export function loadEvidenceForPair(pairKeyStr: string): Promise<EvidenceBucket> {
  const b = bucketOf(pairKeyStr);
  let p = evidenceCache.get(b);
  if (!p) {
    p = getJSON<EvidenceBucket>(`evidence/pairs/${b}.json`);
    evidenceCache.set(b, p);
    void p.catch(() => {
      if (evidenceCache.get(b) === p) evidenceCache.delete(b);
    });
  }
  return p;
}

/**
 * One person's whole documented career, in one fetch.
 *
 * Bucketed by the person's own id rather than by pair, which is the entire
 * point: assembling a career out of `evidence/pairs` means touching a bucket
 * per opponent, and out of `timeline/by-year` means every year they worked.
 * Cached by BUCKET, so the second person from the same bucket is free.
 */
const personMatchCache = new Map<string, Promise<PersonMatchesBucket>>();
export function loadPersonMatches(id: string): Promise<PersonMatchesBucket> {
  const b = bucketOf(id);
  let p = personMatchCache.get(b);
  if (!p) {
    p = getJSON<PersonMatchesBucket>(`evidence/person/${b}.json`);
    personMatchCache.set(b, p);
    void p.catch(() => {
      if (personMatchCache.get(b) === p) personMatchCache.delete(b);
    });
  }
  return p;
}

const peopleCache = new Map<string, Promise<PeopleBucket>>();
export function loadPersonDossier(id: string): Promise<PeopleBucket> {
  const b = bucketOf(id);
  let p = peopleCache.get(b);
  if (!p) {
    p = getJSON<PeopleBucket>(`entities/people/${b}.json`);
    peopleCache.set(b, p);
    void p.catch(() => {
      if (peopleCache.get(b) === p) peopleCache.delete(b);
    });
  }
  return p;
}

const yearCache = new Map<number, Promise<TimelineEvent[]>>();
export function loadYear(year: number): Promise<TimelineEvent[]> {
  let p = yearCache.get(year);
  if (!p) {
    p = getJSON<TimelineEvent[]>(`timeline/by-year/${year}.json`).catch(() => []);
    yearCache.set(year, p);
  }
  return p;
}

let championships: Promise<ChampionshipsFile> | null = null;
export function loadChampionships(): Promise<ChampionshipsFile> {
  if (!championships) {
    const request = getJSON<ChampionshipsFile>("entities/championships.json");
    championships = request;
    void request.catch(() => {
      if (championships === request) championships = null;
    });
  }
  return championships;
}
