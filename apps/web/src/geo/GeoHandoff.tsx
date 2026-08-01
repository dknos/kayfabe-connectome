import { pairKey } from "@kayfabe/graph-contract";
import { loadEvidenceForPair } from "../data/loader";
import { useStore } from "../state/store";
import { useGeo } from "./geoStore";
import type { GeoScopeKind } from "./geoTypes";

/**
 * Hand a selection from any lens into GEO, and back.
 *
 * Selection travels on canonical ids, so a person opened in the connectome is
 * the same `p:` id the geographic scope takes — nothing is re-resolved and
 * nothing can drift between the two views.
 */

export async function sendToGeo(kind: GeoScopeKind, ids: string[], label: string): Promise<void> {
  const g = useGeo.getState();
  await g.boot();
  if (kind === "pair" && ids.length === 2) {
    // The pair's geography IS its evidence: every supporting match names the
    // card it happened on, so the card list comes straight out of the evidence
    // store rather than from a parallel index that could disagree with it.
    const key = pairKey(ids[0]!, ids[1]!);
    const bucket = await loadEvidenceForPair(key);
    const cardIds = Array.from(new Set((bucket[key] ?? []).map((e) => e.c)));
    await useGeo.getState().setScope({ kind, ids, label }, cardIds);
  } else {
    await useGeo.getState().setScope({ kind, ids, label });
  }
  useStore.getState().setLens("geo");
  useStore.getState().announce(`Geo Replay — ${label}`);
}

/** Dossier action row. Rendered by the connectome's person / pair / promotion
 * / championship dossiers. */
export function GeoHandoffActions({
  kind, ids, label, extra,
}: {
  kind: GeoScopeKind;
  ids: string[];
  label: string;
  extra?: Array<{ text: string; onClick: () => void }>;
}) {
  const verb =
    kind === "person" ? "Play career geography"
      : kind === "pair" ? "Map encounters"
        : kind === "championship" ? "Map title matches"
          : kind === "promotion" ? "Replay shows"
            : kind === "event" ? "Replay event series"
              : "Open in Geo Replay";
  return (
    <div className="actions">
      <button data-testid={`geo-handoff-${kind}`} onClick={() => void sendToGeo(kind, ids, label)}>
        {verb}
      </button>
      {extra?.map((e) => (
        <button key={e.text} onClick={e.onClick}>{e.text}</button>
      ))}
    </div>
  );
}

/** The reverse trip: from a geographic card back to the people on it. */
export function openInConnectome(id: string): void {
  useStore.getState().select({ kind: "node", id });
  useStore.getState().setLens("connectome");
}
