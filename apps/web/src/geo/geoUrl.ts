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
  if (![...kv.keys()].some((k) => k.startsWith("g") && k !== "graph")) return;
  pending = kv;
}

export async function applyPendingGeoUrl(): Promise<void> {
  const kv = pending;
  if (!kv) return;
  pending = null;
  const g = useGeo.getState();
  if (!g.data) return;

  const num = (k: string): number | null => {
    const v = kv.get(k);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const clock = kv.get("gck");
  if (clock === "calendar" || clock === "record") {
    g.setClock(clock as ClockKind, num("gsp") ?? undefined);
  } else if (num("gsp") !== null) {
    g.setSpeed(num("gsp")!);
  }
  const cam = kv.get("gcam");
  if (cam) g.setCamera(cam as CameraMode);
  const ag = kv.get("gag");
  if (ag) g.setAfterglow(ag as AfterglowMode);
  const wy = num("gwy");
  if (wy !== null) g.setWindowYears(wy);
  const hm = kv.get("ghm");
  if (hm) g.setHeatMetric(hm as HeatMetric);
  if (kv.get("gar") === "1") g.setShowArcs(true);

  const dn = num("gdn");
  const dx = num("gdx");
  const range = g.data.manifest.day_range;
  if (dn !== null || dx !== null) {
    await useGeo.getState().setRange(dn ?? range[0], dx ?? range[1]);
  }

  const kind = kv.get("gs") as GeoScopeKind | undefined;
  const ids = (kv.get("gi") ?? "").split(",").filter(Boolean);
  const firstId = ids[0];
  if (kind && KINDS.includes(kind) && (firstId !== undefined || kind === "corpus")) {
    const scope: GeoScope = { kind, ids, label: labelFor(kind, ids) };
    // A pair scope has no index — its cards live in the evidence store, so a
    // restored link has to rebuild the same list the dossier handoff built.
    await useGeo.getState().setScope(
      scope, kind === "pair" ? await pairCardIds(ids) : undefined,
    );
  }

  const pos = num("gp");
  if (pos !== null && scheduler) {
    scheduler.seek(pos);
    useGeo.getState().syncFromScheduler();
  }
  const placeId = kv.get("gpl");
  if (placeId) {
    const idx = useGeo.getState().data?.placeIndexOf.get(placeId);
    if (idx !== undefined) useGeo.getState().selectPlace(idx);
  }
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
