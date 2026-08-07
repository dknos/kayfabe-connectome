import { CorpusClient, type CorpusFetch } from "@kayfabe/history-adapter";

/** Same-origin fetch of the read-only materialized corpus (see vite.config). */
export const fetchCorpusJson: CorpusFetch = async (relPath) => {
  const res = await fetch(`/data/${relPath}`);
  if (!res.ok) throw new Error(`corpus fetch failed: ${relPath} (${res.status})`);
  return res.json();
};

let client: CorpusClient | null = null;

export function corpus(): CorpusClient {
  if (!client) client = new CorpusClient(fetchCorpusJson);
  return client;
}
