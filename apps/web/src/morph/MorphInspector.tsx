import { dayToDate } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
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
  const members = useStore((s) => s.members);

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
    const rels = data.indexOf(selId) !== undefined ? data.relationsOf(data.indexOf(selId)!) : [];
    body = (
      <div className="panel">
        <h2>{data.nameOf(selId) ?? selId} <span className="line" /></h2>
        {dossier ? (
          <>
            <div className="statgrid">
              <div className="stat"><div className="v">{dossier.m.toLocaleString()}</div><div className="k">documented matches</div></div>
              <div className="stat"><div className="v">{rels.length}</div><div className="k">connections</div></div>
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
    <div className="rail right morph-rail">
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
