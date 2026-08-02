import { dayToDate } from "@kayfabe/graph-contract";
import { MR, TK, type MorphLayoutResult } from "@kayfabe/morph-renderer";
import { useStore } from "../state/store";
import type { MorphData, NeighborRel } from "./morphAdapter";
import { useMorph } from "./morphStore";

const fmt = (day: number): string => (day < 0 ? "—" : dayToDate(day).toISOString().slice(0, 10));

/**
 * Right rail: what did I just select, in this topology's own terms. Every
 * row is navigation through the shared selection — never local state.
 */
export function MorphInspector() {
  const selection = useStore((s) => s.selection);
  const selId = selection?.kind === "node" ? selection.id : null;
  const data = useMorph((s) => s.data);
  const dossier = useMorph((s) => s.dossier);
  const promotion = useMorph((s) => s.promotion);
  const chronology = useMorph((s) => s.chronology);
  const championships = useMorph((s) => s.championships);
  const building = useMorph((s) => s.building);
  const layout = useMorph((s) => s.layout);
  const members = useStore((s) => s.members);
  const hoverId = useStore((s) => s.hoverId);

  if (!data) return null;
  const select = (id: string) => useStore.getState().select({ kind: "node", id });

  let body: JSX.Element;
  if (!selId) {
    body = (
      <div className="panel">
        <h2>Morph Lab <span className="line" /></h2>
        <p className="micro">
          Click a wrestler for their 3D Relationship Array, a promotion for its
          Promotion Network, or a championship for its Title Lineage. Background click steps
          one level back; “Return to Tissue” restores the organic positions
          exactly.
        </p>
      </div>
    );
  } else if (selId.startsWith("p:")) {
    const residentSlot = data.indexOf(selId);
    const rels = residentSlot !== undefined ? data.relationsOf(residentSlot) : [];
    const orbit = layout?.mode === "orbit" ? summarizeOrbitLayout(layout) : null;
    body = (
      <div className="panel">
        <h2>{data.nameOf(selId) ?? selId} <span className="line" /></h2>
        {residentSlot === undefined ? (
          <p className="micro error-note">
            This selectable person has no graph-resident node. The selection is retained, but no relationship topology is inferred.
          </p>
        ) : null}
        {orbit ? (
          <section className="morph-orbit-summary" aria-label="Orbit Map statistics">
            <h3 className="micro">Orbit Map</h3>
            <div className="statgrid">
              <div className="stat"><div className="v">{orbit.direct}</div><div className="k">direct displayed</div></div>
              <div className="stat"><div className="v">{orbit.bridge}</div><div className="k">two-hop bridges</div></div>
              <div className="stat"><div className="v">{orbit.bridgeRoutes}</div><div className="k">supporting routes</div></div>
            </div>
            <p className="micro derivation-note">
              Direct strength is derived from documented match evidence. Bridge placement uses displayed intermediary routes and never claims a direct relationship.
            </p>
          </section>
        ) : null}
        {residentSlot !== undefined && rels.length === 0 ? (
          <p className="micro derivation-note">
            No graph-resident direct relationships are available for this person in the current corpus. No orbit is fabricated.
          </p>
        ) : null}
        {dossier ? (
          <>
            <div className="statgrid">
              <div className="stat"><div className="v">{dossier.m.toLocaleString()}</div><div className="k">documented matches</div></div>
              <div className="stat"><div className="v">{rels.length}</div><div className="k">direct relationships</div></div>
              <div className="stat"><div className="v">{dossier.titles.length}</div><div className="k">documented titles</div></div>
              <div className="stat"><div className="v">{dossier.first.slice(0, 10)}</div><div className="k">first documented</div></div>
              <div className="stat"><div className="v">{dossier.last.slice(0, 10)}</div><div className="k">latest documented</div></div>
            </div>
            <h3 className="micro">strongest opponents</h3>
            {dossier.top.opponents.slice(0, 8).map(([id, count]) => (
              <button key={id} className="ev-row search-row" onClick={() => select(id)}>
                <span>{data.nameOf(id) ?? id}</span>
                <span className="rel-opposed">opp ×{count}</span>
              </button>
            ))}
            <h3 className="micro">strongest partners</h3>
            {dossier.top.partners.slice(0, 8).map(([id, count]) => (
              <button key={id} className="ev-row search-row" onClick={() => select(id)}>
                <span>{data.nameOf(id) ?? id}</span>
                <span className="rel-same">tag ×{count}</span>
              </button>
            ))}
            <button className="ev-row" onClick={() => useMorph.getState().setModeOverride("career")}>
              Open Career Spine →
            </button>
          </>
        ) : (
          <>
            <p className="micro">{building ? "loading dossier…" : "person detail unavailable"}</p>
            {!building && <button type="button" onClick={() => void useMorph.getState().rebuild()}>Retry person detail</button>}
          </>
        )}
        <p className="micro derivation-note">appearance on a card — not employment.</p>
      </div>
    );
  } else if (selId.startsWith("pr:")) {
    body = (
      <div className="panel">
        <h2>{data.nameOf(selId) ?? selId} <span className="line" /></h2>
        {promotion ? (
          <>
            <div className="statgrid">
              <div className="stat"><div className="v">{promotion.cards.toLocaleString()}</div><div className="k">documented cards</div></div>
              <div className="stat"><div className="v">{promotion.matches.toLocaleString()}</div><div className="k">documented matches</div></div>
              <div className="stat"><div className="v">{promotion.people.toLocaleString()}</div><div className="k">documented participants</div></div>
              <div className="stat"><div className="v">{promotion.titles.length}</div><div className="k">championships</div></div>
              <div className="stat"><div className="v">{fmt(promotion.firstDay)}</div><div className="k">first documented</div></div>
              <div className="stat"><div className="v">{fmt(promotion.lastDay)}</div><div className="k">latest documented</div></div>
            </div>
            <h3 className="micro">championships</h3>
            {promotion.titles.slice(0, 10).map((t) => (
              <button key={t.t} className="ev-row search-row" onClick={() => select(t.t)}>
                <span>{t.n.length > 34 ? t.n.slice(0, 33) + "…" : t.n}</span>
                <span className="rel-title">{t.lineage === "no-changes" ? "no change field" : `${t.reigns} reigns`}</span>
              </button>
            ))}
            {promotion.membersTruncated ? (
              <p className="micro derivation-note">{promotion.membersTruncated} further documented participants beyond the projection cap.</p>
            ) : null}
          </>
        ) : (
          <>
            <p className="micro">{building ? "loading promotion shard…" : "promotion detail unavailable · registry data only"}</p>
            {!building && <button type="button" onClick={() => void useMorph.getState().rebuild()}>Retry promotion detail</button>}
          </>
        )}
        <p className="micro derivation-note">membership = documented appearance on a card, not employment.</p>
      </div>
    );
  } else if (selId.startsWith("t:")) {
    const rec = championships?.[selId] ?? null;
    const ti = chronology?.titleIndex.get(selId);
    body = (
      <div className="panel">
        <h2>{(ti !== undefined ? chronology!.titles.name[ti] : null) ?? data.nameOf(selId) ?? selId} <span className="line" /></h2>
        {ti !== undefined && chronology!.titles.artifact[ti] === 1 && (
          <p className="micro derivation-note">source artifact — the recorded name is preserved, not repaired.</p>
        )}
        {rec && rec.reigns.length > 0 ? (
          <>
            <div className="statgrid">
              <div className="stat"><div className="v">{rec.reigns.length}</div><div className="k">documented reigns</div></div>
              <div className="stat"><div className="v">{rec.changes}</div><div className="k">documented changes</div></div>
              <div className="stat"><div className="v">{rec.titleMatches}</div><div className="k">title matches</div></div>
            </div>
            <h3 className="micro">documented reigns</h3>
            {rec.reigns.slice(0, 24).map((r, i) => (
              <button key={i} className="ev-row search-row" onClick={() => r.holders[0] && select(r.holders[0])}>
                <span>{r.holders.map((h) => data.nameOf(h) ?? h).join(" & ")}</span>
                <span className="rel-title">{r.s.slice(0, 10)} → {r.e ? r.e.slice(0, 10) : "open in corpus"}</span>
              </button>
            ))}
            {rec.reigns.length > 24 && <p className="micro">{rec.reigns.length - 24} more on the rail.</p>}
          </>
        ) : (
          <p className="micro derivation-note">
            {ti !== undefined && chronology!.titles.lineage[ti] === "no-changes"
              ? "this belt's source has no title-change field — reigns are not derived and not guessed."
              : building
                ? "loading championship record…"
                : "no documented reign records in the corpus."}
          </p>
        )}
        <p className="micro derivation-note">gaps between records stay unrecorded — never called vacancies.</p>
        {!building && !championships && (
          <button type="button" onClick={() => void useMorph.getState().rebuild()}>Retry title records</button>
        )}
      </div>
    );
  } else {
    body = <div className="panel"><p className="micro">selected: {selId}</p></div>;
  }

  const residentPreview = members.ids.slice(0, 32);
  const nonResident = members.nonResident ?? [];
  const nonResidentPreview = nonResident.slice(0, 32);
  return (
    <div id="morph-inspector-panel" className="rail right morph-rail" role="tabpanel" aria-labelledby="morph-tab-inspector">
      {hoverId ? <MorphHoverPeek id={hoverId} selectedId={selId} data={data} layout={layout} /> : null}
      {body}
      {(members.basis || nonResident.length > 0 || (members.coverageWarnings?.length ?? 0) > 0) && (
        <div className="panel morph-member-results" aria-label="Semantic member results">
          <h2>Illuminated population <span className="line" /></h2>
          <p className="micro">{members.basis}</p>
          {members.caveat && <p className="micro derivation-note">{members.caveat}</p>}
          {members.coverageWarnings?.map((warning) => (
            <p key={warning} className="micro error-note">{warning}</p>
          ))}
          {residentPreview.length > 0 && (
            <details>
              <summary className="micro">Browse lit nodes ({members.ids.length.toLocaleString()})</summary>
              <div className="morph-member-list">
                {residentPreview.map((id) => (
                  <button key={id} className="ev-row search-row" onClick={() => select(id)}>
                    <span>{data.nameOf(id) ?? id}</span><span className="micro">node lit</span>
                  </button>
                ))}
              </div>
              {members.ids.length > residentPreview.length && (
                <p className="micro">{(members.ids.length - residentPreview.length).toLocaleString()} additional graph-resident members are lit in the visualization.</p>
              )}
            </details>
          )}
          {nonResidentPreview.map((member) => (
            <div key={member.id} className="ev-row morph-nonresident">
              <span>{member.name ?? member.id}</span>
              <span className="micro">documented member · no graph node to light</span>
            </div>
          ))}
          {nonResident.length > nonResidentPreview.length && (
            <p className="micro">
              {(nonResident.length - nonResidentPreview.length).toLocaleString()} additional documented members have no graph node to light.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MorphHoverPeek({
  id,
  selectedId,
  data,
  layout,
}: {
  id: string;
  selectedId: string | null;
  data: MorphData;
  layout: MorphLayoutResult | null;
}) {
  const info = describeHover(id, selectedId, data, layout);
  return (
    <section className="panel morph-hover-peek" aria-label={`Hover peek for ${info.name}`}>
      <h2>Hover Peek <span className="line" /></h2>
      <div className="morph-peek-heading"><strong>{info.name}</strong><span>{info.type}</span></div>
      <p>{info.why}</p>
      {info.evidence.map((line) => <p key={line} className="micro">{line}</p>)}
      {info.caveat ? <p className="micro derivation-note">{info.caveat}</p> : null}
    </section>
  );
}

export interface MorphHoverDescription {
  name: string;
  type: string;
  why: string;
  evidence: string[];
  caveat: string | null;
}

export function summarizeOrbitLayout(layout: MorphLayoutResult): { direct: number; bridge: number; bridgeRoutes: number } {
  if (layout.orbitStats) {
    return {
      direct: layout.orbitStats.directDisplayed,
      bridge: layout.orbitStats.bridgeDisplayed,
      bridgeRoutes: layout.orbitStats.bridgeRoutesDisplayed,
    };
  }
  let direct = 0;
  let bridge = 0;
  for (const role of layout.nodeRole) {
    if (role === MR.OPPONENT || role === MR.PARTNER || role === MR.MIXED || role === MR.BATTLE_ROYAL) direct++;
    else if (role === MR.BRIDGE || role === MR.JUNCTION) bridge++;
  }
  return {
    direct,
    bridge,
    bridgeRoutes: layout.routes.filter((route) => route.kind === TK.BRIDGE).length,
  };
}

/** Shared data-honest copy for the inspector peek and floating hover card. */
export function describeHover(
  id: string,
  selectedId: string | null,
  data: MorphData,
  layout: MorphLayoutResult | null,
): MorphHoverDescription {
  const name = data.nameOf(id) ?? id;
  const selectedName = selectedId ? (data.nameOf(selectedId) ?? selectedId) : "the selection";
  const type = id.startsWith("p:") ? "person" : id.startsWith("pr:") ? "promotion" : id.startsWith("t:") ? "championship" : "entity";
  if (layout?.mode === "orbit" && id.startsWith("p:") && selectedId?.startsWith("p:")) {
    if (id === selectedId) {
      return {
        name,
        type,
        why: "Selected person at the center of Orbit Map",
        evidence: ["Inner radius is one graph hop · outer radius is two graph hops"],
        caveat: null,
      };
    }
    const bridgeDetail = layout.orbitDetails?.bridges.find((bridge) => bridge.id === id);
    if (bridgeDetail) {
      return {
        name,
        type,
        why: `Two hops from ${selectedName}`,
        evidence: [
          `Supported through ${bridgeDetail.routeCount.toLocaleString()} displayed connection${bridgeDetail.routeCount === 1 ? "" : "s"}`,
          `Strongest route through ${bridgeDetail.strongestIntermediaryName}`,
          `${bridgeDetail.displayedRouteCount.toLocaleString()} supporting route${bridgeDetail.displayedRouteCount === 1 ? "" : "s"} visible`,
        ],
        caveat: "No direct relationship is claimed by this placement.",
      };
    }
    const slot = data.indexOf(id);
    const role = slot === undefined ? MR.BACKGROUND : layout.nodeRole[slot];
    const relation = directRelation(data, selectedId, id);
    if ((role === MR.BRIDGE || role === MR.JUNCTION) && !relation) {
      const routes = slot === undefined ? [] : layout.routes
        .filter((route) => route.kind === TK.BRIDGE && (route.a === slot || route.b === slot))
        .sort((a, b) => b.width - a.width || a.key.localeCompare(b.key));
      const intermediaries = [...new Set(routes.map((route) => data.idOf(route.a === slot ? route.b : route.a)).filter((value): value is string => !!value))];
      const strongest = intermediaries[0] ? (data.nameOf(intermediaries[0]) ?? intermediaries[0]) : null;
      return {
        name,
        type,
        why: `Two hops from ${selectedName}`,
        evidence: [
          `Supported through ${intermediaries.length.toLocaleString()} displayed connection${intermediaries.length === 1 ? "" : "s"}`,
          strongest ? `Strongest displayed route through ${strongest}` : "Supporting route detail unavailable",
        ],
        caveat: "No direct relationship is claimed by this placement.",
      };
    }
    if (relation) {
      return {
        name,
        type,
        why: `Direct relationship with ${selectedName}`,
        evidence: [
          relationCounts(relation),
          `${relation.firstDay >= 0 ? `First documented ${fmt(relation.firstDay)}` : "First date unavailable"} · ${relation.lastDay >= 0 ? `latest documented ${fmt(relation.lastDay)}` : "latest date unavailable"}`,
        ],
        caveat: null,
      };
    }
    return {
      name,
      type,
      why: `Quiet corpus context around ${selectedName}`,
      evidence: ["This entity is outside the active direct and bridge orbit."],
      caveat: "Context placement does not claim a relationship.",
    };
  }
  if (id.startsWith("pr:")) {
    return {
      name,
      type,
      why: selectedId?.startsWith("p:") ? `Documented appearance context for ${selectedName}` : "Documented promotion context",
      evidence: [],
      caveat: "A documented appearance does not establish employment.",
    };
  }
  if (id.startsWith("t:")) {
    return {
      name,
      type,
      why: "Documented championship context",
      evidence: [],
      caveat: "Reigns and title changes are shown only when the source records them.",
    };
  }
  const relation = selectedId ? directRelation(data, selectedId, id) : null;
  return {
    name,
    type,
    why: relation ? `Direct documented relationship with ${selectedName}` : `Present in ${layout?.mode ?? "the current topology"}`,
    evidence: relation ? [relationCounts(relation)] : [],
    caveat: null,
  };
}

function directRelation(data: MorphData, selectedId: string, id: string): NeighborRel | null {
  const selected = data.indexOf(selectedId);
  if (selected === undefined) return null;
  return data.relationsOf(selected).find((relation) => relation.id === id) ?? null;
}

function relationCounts(relation: NeighborRel): string {
  return `Opposed ×${relation.opposed} · same-side ×${relation.same} · battle royal ×${relation.br}`;
}
