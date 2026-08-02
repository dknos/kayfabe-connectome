import type { AfterglowMode, CameraMode } from "@kayfabe/geo-renderer";
import { registerGeoUrl, useStore, writeUrl } from "../state/store";
import { pairCardIds } from "./GeoHandoff";
import { scheduler, useGeo } from "./geoStore";
import type { ClockKind, GeoScope, GeoScopeKind, HeatMetric } from "./geoTypes";

/**
 * GEO deep links.
 *
 * Everything that changes what a reader is looking at is serialised: scope,
 * range, clock, speed, camera, afterglow, metric, arcs, playback position and
 * the selected city. Reloading a shared link must reproduce the analysis, not
 * just the lens.
 *
 * Keys are namespaced with a leading `g` and ride in the existing v2 fragment.
 * The fragment reader already ignores keys it does not know, so old links keep
 * working and no version bump is needed.
 */

const KINDS: GeoScopeKind[] = [
  "promotion", "person", "pair", "championship", "event", "place", "corpus",
];
const CAMERAS: CameraMode[] = ["world", "follow", "tour", "region", "free", "smart"];
const AFTERGLOWS: AfterglowMode[] = ["none", "short", "long", "accumulate", "window"];
const HEAT_METRICS: HeatMetric[] = ["cards", "matches", "people", "titleMatches", "titleChanges"];

function serialize(): Record<string, string | number | null> {
  const g = useGeo.getState();
  const range = g.data?.manifest.day_range ?? [0, 0];
  const place = g.selectedPlace >= 0 ? g.data?.places[g.selectedPlace]?.id ?? null : null;
  return {
    gs: g.scope.kind !== "corpus" ? g.scope.kind : null,
    gi: g.scope.ids.length ? g.scope.ids.join(",") : null,
    gck: g.clock !== "record" ? g.clock : null,
    gsp: g.speed !== 3 ? g.speed : null,
    gcam: g.camera !== "world" ? g.camera : null,
    gag: g.afterglow !== "accumulate" ? g.afterglow : null,
    gwy: g.afterglow === "window" && g.windowYears !== 5 ? g.windowYears : null,
    ghm: g.heatMetric !== "cards" ? g.heatMetric : null,
    gar: g.showArcs ? 1 : null,
    gdn: g.dayMin !== range[0] ? g.dayMin : null,
    gdx: g.dayMax !== range[1] ? g.dayMax : null,
    gp: g.cursor > 0 ? g.cursor : null,
    gpl: place,
  };
}

/**
 * Restore runs while the geo projection may still be loading, so it stashes
 * the parsed state and `applyPendingGeoUrl` replays it once the data lands.
 * Dropping it on the floor would make every shared link silently open the
 * default scope.
 */
let pending: Map<string, string> | null = null;

function restore(kv: Map<string, string>): void {
  const lens = kv.get("lens");
  const geoLink =
    lens === "geo" ||
    lens === "geoTable" ||
    [...kv.keys()].some((k) => k.startsWith("g") && k !== "graph");
  pending = geoLink ? kv : null;
}

export async function applyPendingGeoUrl(): Promise<void> {
  const kv = pending;
  if (!kv) return;
  const g = useGeo.getState();
  // Keep the fragment staged while the lazy projection is still loading.
  // Geo's activation effect calls this again after boot; clearing it here
  // would lose links pasted while switching into the lens.
  if (!g.data) return;
  pending = null;

  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  g.setPlaying(false);
  const clock = kv.get("gck") === "calendar" ? "calendar" : "record";
  g.setClock(clock as ClockKind, num("gsp") ?? 3);
  const cam = kv.get("gcam");
  g.setCamera(cam && (CAMERAS as string[]).includes(cam) ? cam as CameraMode : "world");
  const ag = kv.get("gag");
  g.setAfterglow(ag && (AFTERGLOWS as string[]).includes(ag) ? ag as AfterglowMode : "accumulate");
  const wy = num("gwy");
  g.setWindowYears(wy ?? 5);
  const hm = kv.get("ghm");
  g.setHeatMetric(hm && (HEAT_METRICS as string[]).includes(hm) ? hm as HeatMetric : "cards");
  g.setShowArcs(kv.get("gar") === "1");

  const dn = num("gdn");
  const dx = num("gdx");
  const range = g.data.manifest.day_range;
  await useGeo.getState().setRange(dn ?? range[0], dx ?? range[1]);

  const kind = kv.get("gs") as GeoScopeKind | undefined;
  const ids = (kv.get("gi") ?? "").split(",").filter(Boolean);
  const firstId = ids[0];
  const validKind = kind && KINDS.includes(kind) && (firstId !== undefined || kind === "corpus")
    ? kind
    : "corpus";
  const scopeIds = validKind === "corpus" ? [] : ids;
  const scope: GeoScope = { kind: validKind, ids: scopeIds, label: labelFor(validKind, scopeIds) };
  // A pair scope has no index — its cards live in the evidence store, so a
  // restored link has to rebuild the same list the dossier handoff built.
  await useGeo.getState().setScope(
    scope, validKind === "pair" ? await pairCardIds(scopeIds) : undefined,
  );

  const pos = num("gp");
  if (scheduler) {
    scheduler.seek(pos ?? 0);
    useGeo.getState().syncFromScheduler();
  }
  const placeId = kv.get("gpl");
  if (placeId) {
    const idx = useGeo.getState().data?.placeIndexOf.get(placeId);
    useGeo.getState().selectPlace(idx ?? -1);
  } else useGeo.getState().selectPlace(-1);
}

function labelFor(kind: GeoScopeKind, ids: string[]): string {
  const g = useGeo.getState();
  const first = ids[0];
  if (kind === "corpus" || first === undefined) return "Entire filtered corpus";
  if (kind === "promotion" && g.data) {
    const i = g.data.strings.promotionIds.indexOf(first);
    if (i >= 0) return g.data.strings.promotionNames[i] ?? first;
  }
  if (kind === "place" && g.data) {
    const i = g.data.placeIndexOf.get(first);
    if (i !== undefined) return g.data.places[i]?.displayName ?? first;
  }
  return searchName(first) ?? ids.join(", ");
}

function searchName(id: string): string | null {
  // The corpus search index is already loaded in the connectome store; read it
  // there rather than through a global, which nothing assigns.
  return useStore.getState().core?.search.find((e) => e.id === id)?.n ?? null;
}

let installed = false;
export function installGeoUrl(): void {
  if (installed) return;
  installed = true;
  registerGeoUrl(serialize, restore);
  // Any geo state change rewrites the fragment through the shared debounced
  // writer, so geo and connectome links stay one URL.
  useGeo.subscribe(() => writeUrl());
}
