/**
 * Node-only CorpusFetch over a directory tree — used by tests and node
 * scripts against data/materialized or a fixture corpus. Deliberately NOT
 * exported from index.ts: the browser build must never pull in node:fs.
 */
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import type { CorpusFetch } from "./corpusClient";

export function makeNodeFetch(rootDir: string): CorpusFetch {
  const root = normalize(rootDir).replace(/[\\/]+$/, "");
  return async (relPath: string): Promise<unknown> => {
    const full = normalize(join(root, relPath));
    // Path-jail: a relPath must never escape the corpus root.
    if (!full.startsWith(root + sep)) {
      throw new Error(`corpus fetch escapes root: ${relPath}`);
    }
    const text = await readFile(full, "utf8");
    return JSON.parse(text) as unknown;
  };
}
