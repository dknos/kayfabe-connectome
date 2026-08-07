import type { SimState } from "@kayfabe/sim-contract";
import { hashValue } from "./hash";
import { SCHEMA_VERSION } from "./init";

/**
 * Save envelope (save-format@1). See docs/simulator/SAVE_FORMAT.md.
 * The engine never reads a wall clock: `createdAt` is supplied by the app
 * shell at save time and lives only in the manifest, never in hashed state.
 */
export interface SaveManifest {
  save_id: string;
  created_at: string;
  current_game_date: string;
  original_start_date: string;
  world_seed: string;
  engine_version: string;
  schema_version: number;
  data_bundle_hash: string;
  mod_manifest: string[];
  simulation_options: SimState["meta"]["options"];
  current_state_hash: string;
}

export interface SaveEnvelope {
  manifest: SaveManifest;
  state: SimState;
}

/** The deterministic fingerprint of a universe. */
export function stateHash(state: SimState): string {
  return hashValue(state);
}

export function buildSaveEnvelope(state: SimState, createdAt: string): SaveEnvelope {
  return {
    manifest: {
      save_id: state.meta.saveId,
      created_at: createdAt,
      current_game_date: state.currentDate,
      original_start_date: state.meta.startDate,
      world_seed: state.meta.worldSeed,
      engine_version: state.meta.engineVersion,
      schema_version: state.meta.schemaVersion,
      data_bundle_hash: state.meta.bundleHash,
      mod_manifest: [],
      simulation_options: state.meta.options,
      current_state_hash: stateHash(state),
    },
    state,
  };
}

export interface LoadResult {
  state: SimState;
  warnings: string[];
}

/**
 * Validate and open a save envelope. Refuses corrupted saves (hash
 * mismatch) and future schema versions; warns on bundle drift.
 */
export function openSaveEnvelope(envelope: SaveEnvelope, localBundleHash: string | null): LoadResult {
  const { manifest, state } = envelope;
  if (manifest.schema_version > SCHEMA_VERSION) {
    throw new Error(
      `Save schema v${manifest.schema_version} is newer than this build (v${SCHEMA_VERSION}). Update the game.`,
    );
  }
  const actual = stateHash(state);
  if (actual !== manifest.current_state_hash) {
    throw new Error(
      "Save state hash mismatch — the save file is corrupted or was edited outside the game.",
    );
  }
  const warnings: string[] = [];
  if (localBundleHash !== null && localBundleHash !== manifest.data_bundle_hash) {
    warnings.push(
      "This save was created from a different historical data bundle. The universe will continue from its own state, but the Almanac may not match.",
    );
  }
  return { state, warnings };
}
