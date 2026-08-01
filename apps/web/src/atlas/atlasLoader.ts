import { z } from "zod";
import type {
  AtlasManifest,
  AtlasPeopleBucket,
  AtlasPersonRoutes,
  AtlasPromotionDetail,
  AtlasPromotionsBucket,
  AtlasPromotionsFile,
  AtlasTitlesFile,
} from "@kayfabe/graph-contract";
import { bucketOf } from "@kayfabe/graph-contract";

/**
 * ATLAS data, loaded lazily in three tiers.
 *
 * A reader who never opens ATLAS pays nothing. Opening it costs the overview
 * (two compact columnar files); selecting a promotion costs that promotion's
 * shard; selecting a wrestler costs that wrestler's route shard. Nothing here
 * is added to the connectome's boot payload, which is the whole reason the
 * projection is a separate tree rather than more fields on nodes.json.
 */

const BASE = import.meta.env.BASE_URL;

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}data/atlas/${path}`);
  if (!res.ok) throw new Error(`GET /data/atlas/${path} → ${res.status}`);
  return (await res.json()) as T;
}

const manifestSchema = z
  .object({
    schema_version: z.string(),
    projection_version: z.string(),
    counts: z.record(z.number()),
    date_range: z.tuple([z.string(), z.string()]),
    day_range: z.tuple([z.number(), z.number()]),
    buckets: z.number().int().positive(),
    validation: z.object({ passed: z.boolean() }).passthrough(),
  })
  .passthrough();

/** Columnar files are validated by SHAPE and by array-length agreement rather
 *  than element-by-element: 4,389 titles × 13 columns through a per-element
 *  parser is a measurable boot cost for a check that adds nothing a length
 *  assertion does not already catch. */
function assertColumnar(name: string, count: number, cols: Record<string, unknown[]>): void {
  for (const [k, v] of Object.entries(cols)) {
    if (!Array.isArray(v)) throw new Error(`atlas/${name}.${k} is not an array`);
    if (v.length !== count) {
      throw new Error(`atlas/${name}.${k} length ${v.length} ≠ count ${count}`);
    }
  }
}

export interface AtlasData {
  manifest: AtlasManifest;
  promotions: AtlasPromotionsFile;
  titles: AtlasTitlesFile;
  /** promotion id -> row in promotions */
  promoIndex: Map<string, number>;
  /** title id -> row in titles */
  titleIndex: Map<string, number>;
  /** promotion id -> title rows, ordered by (firstDay, name) */
  titlesByPromo: Map<string, number[]>;
  /** Titles the records do not place in any promotion. Shown in their own
   *  band rather than guessed into one. */
  unresolvedTitles: number[];
  /** Largest documented match count, for log scaling. */
  maxPromoMatches: number;
  maxTitleMatches: number;
}

let corePromise: Promise<AtlasData> | null = null;

export function loadAtlasCore(): Promise<AtlasData> {
  corePromise ??= (async () => {
    const manifestRaw = await getJSON<unknown>("manifest.json");
    const manifest = manifestSchema.parse(manifestRaw) as unknown as AtlasManifest;
    if (!manifest.validation.passed) {
      throw new Error(
        "The Atlas projection failed its own validation — refusing to render unverified data.",
      );
    }
    const [promotions, titles] = await Promise.all([
      getJSON<AtlasPromotionsFile>("promotions.json"),
      getJSON<AtlasTitlesFile>("titles.json"),
    ]);
    assertColumnar("promotions", promotions.count, {
      id: promotions.id,
      name: promotions.name,
      firstDay: promotions.firstDay,
      lastDay: promotions.lastDay,
      cards: promotions.cards,
      matches: promotions.matches,
      people: promotions.people,
      titles: promotions.titles,
      src: promotions.src,
      bit: promotions.bit,
      yearFrom: promotions.yearFrom,
      yearCounts: promotions.yearCounts,
    });
    assertColumnar("titles", titles.count, {
      id: titles.id,
      name: titles.name,
      pr: titles.pr,
      assoc: titles.assoc,
      assocShare: titles.assocShare,
      firstDay: titles.firstDay,
      lastDay: titles.lastDay,
      titleMatches: titles.titleMatches,
      reigns: titles.reigns,
      changes: titles.changes,
      holders: titles.holders,
      artifact: titles.artifact,
      src: titles.src,
      lineage: titles.lineage,
    });

    const promoIndex = new Map<string, number>();
    let maxPromoMatches = 1;
    for (let i = 0; i < promotions.count; i++) {
      promoIndex.set(promotions.id[i]!, i);
      if (promotions.matches[i]! > maxPromoMatches) maxPromoMatches = promotions.matches[i]!;
    }
    const titleIndex = new Map<string, number>();
    const titlesByPromo = new Map<string, number[]>();
    const unresolvedTitles: number[] = [];
    let maxTitleMatches = 1;
    for (let i = 0; i < titles.count; i++) {
      titleIndex.set(titles.id[i]!, i);
      if (titles.titleMatches[i]! > maxTitleMatches) maxTitleMatches = titles.titleMatches[i]!;
      const pr = titles.pr[i]!;
      if (!pr || titles.assoc[i] === "unresolved") {
        unresolvedTitles.push(i);
        continue;
      }
      let arr = titlesByPromo.get(pr);
      if (!arr) titlesByPromo.set(pr, (arr = []));
      arr.push(i);
    }
    // Deterministic within a promotion: earliest documented activity first,
    // then name, so the packed title band is identical between loads.
    const byFirst = (a: number, b: number): number =>
      (titles.firstDay[a]! - titles.firstDay[b]!) ||
      (titles.name[a]! < titles.name[b]! ? -1 : titles.name[a]! > titles.name[b]! ? 1 : 0);
    for (const arr of titlesByPromo.values()) arr.sort(byFirst);
    unresolvedTitles.sort(byFirst);

    return {
      manifest,
      promotions,
      titles,
      promoIndex,
      titleIndex,
      titlesByPromo,
      unresolvedTitles,
      maxPromoMatches,
      maxTitleMatches,
    };
  })();
  return corePromise;
}

/* ---------- lazy detail shards ---------- */

const promoBuckets = new Map<string, Promise<AtlasPromotionsBucket>>();
export async function loadPromotionDetail(id: string): Promise<AtlasPromotionDetail | null> {
  const b = bucketOf(id);
  let p = promoBuckets.get(b);
  if (!p) {
    p = getJSON<AtlasPromotionsBucket>(`promotions/${b}.json`);
    promoBuckets.set(b, p);
  }
  return (await p)[id] ?? null;
}

const peopleBuckets = new Map<string, Promise<AtlasPeopleBucket>>();
export async function loadPersonRoutes(id: string): Promise<AtlasPersonRoutes | null> {
  const b = bucketOf(id);
  let p = peopleBuckets.get(b);
  if (!p) {
    p = getJSON<AtlasPeopleBucket>(`people/${b}.json`);
    peopleBuckets.set(b, p);
  }
  return (await p)[id] ?? null;
}

/** Test seam: forget everything so a fixture can be loaded twice. */
export function __resetAtlasCache(): void {
  corePromise = null;
  promoBuckets.clear();
  peopleBuckets.clear();
}
