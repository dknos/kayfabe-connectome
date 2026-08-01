import { useMemo, useState } from "react";
import { useStore } from "../state/store";
import { useGeo } from "./geoStore";
import type { GeoScope, GeoScopeKind } from "./geoTypes";

/**
 * Picks what plays. Promotion is first and default-selected because the
 * primary requested workflow is "choose WWF, press Play".
 *
 * Entities are searched against the existing corpus-wide search index, so the
 * same canonical ids that identify a person or title in the connectome
 * identify a geographic scope here — a scope survives a lens switch.
 */

const KINDS: Array<[GeoScopeKind, string]> = [
  ["promotion", "Promotion"],
  ["person", "Wrestler"],
  ["championship", "Championship"],
  ["event", "Event series"],
  ["place", "City"],
  ["corpus", "Entire filtered corpus"],
];

export function GeoScopePicker() {
  const g = useGeo();
  const search = useStore((s) => s.core?.search);
  // Promotion is the landing state even though the corpus scope is what plays
  // until one is chosen: the primary workflow is "choose WWF, press Play", and
  // opening on a picker with no search box hides that.
  const [kind, setKind] = useState<GeoScopeKind>(
    g.scope.kind === "pair" || g.scope.kind === "corpus" ? "promotion" : g.scope.kind,
  );
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    if (kind === "corpus") return [];
    if (kind === "promotion" && g.data) {
      // Promotions come from the geo projection, not the graph: 571 promotions
      // ran cards but only 165 became graph nodes, and every one of them has a
      // geography worth playing.
      const rows = g.data.strings.promotionIds.map((id, i) => ({
        id, name: g.data!.strings.promotionNames[i] ?? id,
      }));
      const q = query.trim().toLowerCase();
      return rows
        .filter((r) => !q || r.name.toLowerCase().includes(q))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 60);
    }
    if (kind === "place" && g.data) {
      const q = query.trim().toLowerCase();
      return g.data.places
        .filter((p) => !q || p.displayName.toLowerCase().includes(q))
        .sort((a, b) => b.cards - a.cards)
        .slice(0, 60)
        .map((p) => ({ id: p.id, name: `${p.displayName} · ${p.cards} cards` }));
    }
    if (!search) return [];
    const want = kind === "person" ? "person" : kind === "championship" ? "title" : "event";
    const q = query.trim().toLowerCase();
    return search
      .filter((e) => e.t === want && (!q || e.n.toLowerCase().includes(q)))
      .sort((a, b) => (b.m ?? 0) - (a.m ?? 0))
      .slice(0, 60)
      .map((e) => ({ id: kind === "event" ? e.n : e.id, name: `${e.n} · ${e.m ?? 0}` }));
  }, [kind, query, search, g.data]);

  const apply = (id: string, label: string) => {
    const scope: GeoScope = { kind, ids: [id], label };
    void g.setScope(scope);
  };

  return (
    <>
      <div className="row">
        <label htmlFor="geo-kind">Scope</label>
        <select
          id="geo-kind" value={kind}
          onChange={(e) => {
            const k = e.target.value as GeoScopeKind;
            setKind(k);
            setQuery("");
            if (k === "corpus") {
              void g.setScope({ kind: "corpus", ids: [], label: "Entire filtered corpus" });
            }
          }}
        >
          {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {kind !== "corpus" && (
        <>
          <div className="row">
            <input
              aria-label={`Search ${kind}`}
              placeholder={kind === "promotion" ? "WWF, NJPW, CMLL…" : "search…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: "100%" }}
            />
          </div>
          <div className="checks scrollable" role="listbox" aria-label={`${kind} options`}>
            {options.map((o) => (
              <button
                key={o.id}
                role="option"
                aria-selected={g.scope.ids[0] === o.id}
                className={`chip ${g.scope.ids[0] === o.id ? "on" : ""}`}
                onClick={() => apply(o.id, o.name)}
              >
                {o.name}
              </button>
            ))}
            {!options.length && <span className="micro">no matches</span>}
          </div>
        </>
      )}
      <p className="micro" data-testid="geo-scope-label">
        {g.scope.kind === "corpus" ? "Entire filtered corpus" : g.scope.label}
        {" — "}
        <b className="num">{g.scopeIndices.length.toLocaleString()}</b> cards in scope
      </p>
    </>
  );
}
