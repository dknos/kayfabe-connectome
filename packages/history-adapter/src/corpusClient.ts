import type {
  ChampionshipsFile,
  Manifest,
  PersonDossier,
  PromotionsFile,
  SearchEntity,
  TimelineEvent,
} from "@kayfabe/graph-contract";
import { bucketOf } from "@kayfabe/graph-contract";
import type { PersonEvidenceBucket, PersonMatchRow } from "./corpusTypes";

/** Pluggable JSON fetch, relPath e.g. "search/entities.json". */
export type CorpusFetch = (relPath: string) => Promise<unknown>;

type PeopleBucket = Record<string, PersonDossier>;

/**
 * Cached, read-only access to data/materialized. Every loader memoizes its
 * promise so repeated calls share one fetch; shard math uses graph-contract's
 * bucketOf so the adapter can never disagree with the materializer's layout.
 */
export class CorpusClient {
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly fetchJson: CorpusFetch) {}

  private load<T>(relPath: string): Promise<T> {
    let p = this.cache.get(relPath);
    if (!p) {
      p = this.fetchJson(relPath);
      this.cache.set(relPath, p);
    }
    return p as Promise<T>;
  }

  manifest(): Promise<Manifest> {
    return this.load<Manifest>("manifest.json");
  }

  searchEntities(): Promise<SearchEntity[]> {
    return this.load<SearchEntity[]>("search/entities.json");
  }

  promotions(): Promise<PromotionsFile> {
    return this.load<PromotionsFile>("graph/promotions.json");
  }

  /** Missing years (the corpus has none for 1958) resolve to []. */
  async year(y: number): Promise<TimelineEvent[]> {
    try {
      return await this.load<TimelineEvent[]>(`timeline/by-year/${y}.json`);
    } catch {
      return [];
    }
  }

  async personDossier(id: string): Promise<PersonDossier | undefined> {
    const bucket = await this.load<PeopleBucket>(
      `entities/people/${bucketOf(id)}.json`,
    );
    return bucket[id];
  }

  async personEvidence(id: string): Promise<PersonMatchRow[]> {
    const bucket = await this.load<PersonEvidenceBucket>(
      `evidence/person/${bucketOf(id)}.json`,
    );
    return bucket[id] ?? [];
  }

  championships(): Promise<ChampionshipsFile> {
    return this.load<ChampionshipsFile>("entities/championships.json");
  }
}
