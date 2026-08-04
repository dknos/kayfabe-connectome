/**
 * Loads the spacetime projection (data/materialized/spacetime/) and decodes
 * per-person shards into the renderer's scope shape.
 *
 * The projection refuses to lie about coverage: the vertical slice ships
 * curated subjects only (spacetime-alias@1), so `canonicalSubjectOf` maps any
 * persona id to its canonical subject and returns null for everyone else —
 * the lens then says so instead of improvising a worldline.
 *
 * Byte layouts are the materializer's (spacetime_project.py docstring):
 * events.bin 8 u32 LE per record, parts.bin flat u32 node indexes.
 */
import {
  WarpLookup,
  type SpacetimeEvent, type SpacetimeScope,
} from "@kayfabe/spacetime-renderer";

const BASE = import.meta.env.BASE_URL;
const TIMEOUT_MS = 20000;

interface SpacetimeDictionaries {
  promotions: { ids: string[]; names: string[] };
  subjects: {
    canonical: string;
    label: string;
    bucket: string;
    personas: { id: string; label: string }[];
  }[];
}

interface SpacetimeManifest {
  projection_version: string;
  lut: { width: number; height: number };
  counts: Record<string, number>;
  validation: { passed: boolean };
}

async function fetchJson<T>(path: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}data/spacetime/${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBin(path: string): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}data/spacetime/${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

let corePromise: Promise<{ manifest: SpacetimeManifest; dict: SpacetimeDictionaries }> | null = null;

export function loadSpacetimeCore(): Promise<{ manifest: SpacetimeManifest; dict: SpacetimeDictionaries }> {
  corePromise ??= (async () => {
    const manifest = await fetchJson<SpacetimeManifest>("manifest.json");
    if (!manifest.validation?.passed) {
      throw new Error("spacetime projection failed its own validation; refusing to render it");
    }
    const dict = await fetchJson<SpacetimeDictionaries>("dictionaries.json");
    return { manifest, dict };
  })().catch((err) => {
    corePromise = null; // a failed load must be retryable
    throw err;
  });
  return corePromise;
}

let lutPromise: Promise<WarpLookup> | null = null;

export function loadWarpLookup(): Promise<WarpLookup> {
  lutPromise ??= (async () => {
    const { manifest } = await loadSpacetimeCore();
    const [f16, rgba8] = await Promise.all([
      fetchBin("lut/bridge.f16.bin"),
      fetchBin("lut/bridge-rgba8.bin"),
    ]);
    return new WarpLookup(f16, rgba8, manifest.lut.width, manifest.lut.height);
  })().catch((err) => {
    lutPromise = null;
    throw err;
  });
  return lutPromise;
}

/** The canonical subject a person id belongs to, or null when this person is
 *  not yet projected (the honest answer, not a fallback). */
export async function canonicalSubjectOf(id: string): Promise<string | null> {
  const { dict } = await loadSpacetimeCore();
  for (const s of dict.subjects) {
    if (s.canonical === id) return id;
    if (s.personas.some((p) => p.id === id)) return s.canonical;
  }
  return null;
}

export async function projectedSubjects(): Promise<{ id: string; label: string }[]> {
  const { dict } = await loadSpacetimeCore();
  return dict.subjects.map((s) => ({ id: s.canonical, label: s.label }));
}

export async function promoNameOf(promoIdx: number): Promise<string> {
  const { dict } = await loadSpacetimeCore();
  return dict.promotions.names[promoIdx] ?? dict.promotions.ids[promoIdx] ?? "unknown promotion";
}

interface ShardDescriptor {
  label: string;
  nodeIdx: number;
  personas: { id: string; label: string; nodeIdx: number; firstDay: number; lastDay: number }[];
  events: { offset: number; count: number };
  parts: { offset: number; count: number };
  matchRefs: string[];
  eventNames: string[];
  relationships: SpacetimeScope["relationships"];
  promos: { pr: string; n: string; count: number; firstDay: number; lastDay: number }[];
  titles: { t: string; matches: number; changes: number }[];
}

const scopeCache = new Map<string, Promise<SpacetimeScope>>();

export function loadSpacetimeScope(canonicalId: string): Promise<SpacetimeScope> {
  let p = scopeCache.get(canonicalId);
  if (!p) {
    p = buildScope(canonicalId).catch((err) => {
      scopeCache.delete(canonicalId);
      throw err;
    });
    scopeCache.set(canonicalId, p);
  }
  return p;
}

async function buildScope(canonicalId: string): Promise<SpacetimeScope> {
  const { dict } = await loadSpacetimeCore();
  const sub = dict.subjects.find((s) => s.canonical === canonicalId);
  if (!sub) throw new Error(`${canonicalId} is not a projected spacetime subject`);
  const promoIdxOf = new Map(dict.promotions.ids.map((id, i) => [id, i]));

  const [desc, eventsBin, partsBin] = await Promise.all([
    fetchJson<Record<string, ShardDescriptor>>(`people/${sub.bucket}.json`),
    fetchBin(`people/${sub.bucket}.events.bin`),
    fetchBin(`people/${sub.bucket}.parts.bin`),
  ]);
  const d = desc[canonicalId];
  if (!d) throw new Error(`shard bucket ${sub.bucket} has no ${canonicalId}`);

  const words = new Uint32Array(eventsBin);
  const parts = new Int32Array(partsBin);
  const events: SpacetimeEvent[] = [];
  let minDay = Infinity;
  let maxDay = -Infinity;
  for (let i = 0; i < d.events.count; i++) {
    const o = (d.events.offset + i) * 8;
    const day = words[o]!;
    const flags = words[o + 2]!;
    const sameN = words[o + 3]! & 0xffff;
    const oppN = words[o + 3]! >>> 16;
    const ctxN = words[o + 4]!;
    const po = words[o + 5]!;
    events.push({
      day,
      promoIdx: words[o + 1]!,
      form: flags & 0x7,
      result: (flags >>> 3) & 0x3,
      titleMatch: Boolean(flags & (1 << 5)),
      titleChange: Boolean(flags & (1 << 6)),
      apx: Boolean(flags & (1 << 7)),
      ppv: Boolean(flags & (1 << 8)),
      persona: (flags >>> 9) & 0x7,
      unk: Boolean(flags & (1 << 12)),
      same: parts.subarray(po, po + sameN),
      opposed: parts.subarray(po + sameN, po + sameN + oppN),
      context: parts.subarray(po + sameN + oppN, po + sameN + oppN + ctxN),
      matchRef: d.matchRefs[words[o + 6]!] ?? "",
      eventName: d.eventNames[words[o + 6]!] ?? "",
      rating100p1: words[o + 7]!,
    });
    if (day < minDay) minDay = day;
    if (day > maxDay) maxDay = day;
  }

  return {
    subjectId: canonicalId,
    subjectLabel: d.label,
    nodeIdx: d.nodeIdx,
    personas: d.personas,
    events,
    relationships: d.relationships,
    promos: d.promos.map((p) => ({ ...p, promoIdx: promoIdxOf.get(p.pr) })),
    titles: d.titles,
    dayRange: events.length ? [minDay, maxDay] : [0, 1],
  };
}
