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
  const atlas = useMorph((s) => s.atlas);
  const championships = useMorph((s) => s.championships);
  const building = useMorph((s) => s.building);

  if (!data) return null;
  const select = (id: string) => useStore.getState().select({ kind: "node", id });

  let body: JSX.Element;
  if (!selId) {
    body = (
      <div className="panel">
        <h2>Morph Lab <span className="line" /></h2>
        <p className="micro">
          Click a wrestler for their Relationship Loom, a promotion for its
          Motherboard, a championship for its Lineage. Background click steps
          one level back; “Return to tissue” restores the organic positions
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
              Open Career Circuit →
            </button>
          </>
        ) : (
          <p className="micro">{building ? "loading dossier…" : "no dossier for this id"}</p>
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
          <p className="micro">{building ? "loading promotion shard…" : "registry data only"}</p>
        )}
        <p className="micro derivation-note">membership = documented appearance on a card, never a contract claim.</p>
      </div>
    );
  } else if (selId.startsWith("t:")) {
    const rec = championships?.[selId] ?? null;
    const ti = atlas?.titleIndex.get(selId);
    body = (
      <div className="panel">
        <h2>{(ti !== undefined ? atlas!.titles.name[ti] : null) ?? data.nameOf(selId) ?? selId} <span className="line" /></h2>
        {ti !== undefined && atlas!.titles.artifact[ti] === 1 && (
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
            {ti !== undefined && atlas!.titles.lineage[ti] === "no-changes"
              ? "this belt's source has no title-change field — reigns are not derived and not guessed."
              : building
                ? "loading championship record…"
                : "no documented reign records in the corpus."}
          </p>
        )}
        <p className="micro derivation-note">gaps between records stay unrecorded — never called vacancies.</p>
      </div>
    );
  } else {
    body = <div className="panel"><p className="micro">selected: {selId}</p></div>;
  }

  return <div className="rail right morph-rail">{body}</div>;
}
