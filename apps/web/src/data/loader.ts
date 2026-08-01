import { z } from "zod";
import type {
  ChampionshipsFile,
  CommunitiesFile,
  DensityFile,
  EvidenceBucket,
  Manifest,
  NodesColumnar,
  PeopleBucket,
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

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`/data/${path}`);
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
  const res = await fetch("/data/graph/edges.bin");
  if (!res.ok) throw new Error(`edges.bin → ${res.status}`);
  const buf = await res.arrayBuffer();
  const edges = new Uint32Array(buf);
  const expected = manifest.edges_bin.count * manifest.edges_bin.stride_u32;
  if (edges.length !== expected) {
    throw new Error(`edges.bin has ${edges.length} u32, manifest says ${expected}`);
  }

  onProgress(0.7, "communities");
  const communities = await getJSON<CommunitiesFile>("graph/communities.json");
  onProgress(0.8, "timeline density");
  const density = await getJSON<DensityFile>("timeline/density.json");
  onProgress(0.9, "search index");
  const search = await getJSON<SearchEntity[]>("search/entities.json");
  onProgress(1, "ready");
  return { manifest, nodes, edges, communities, density, search };
}

/* ---------- lazy caches ---------- */

const evidenceCache = new Map<string, Promise<EvidenceBucket>>();
export function loadEvidenceForPair(pairKeyStr: string): Promise<EvidenceBucket> {
  const b = bucketOf(pairKeyStr);
  let p = evidenceCache.get(b);
  if (!p) {
    p = getJSON<EvidenceBucket>(`evidence/pairs/${b}.json`);
    evidenceCache.set(b, p);
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
  championships ??= getJSON<ChampionshipsFile>("entities/championships.json");
  return championships;
}
