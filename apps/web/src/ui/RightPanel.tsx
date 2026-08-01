import { useEffect, useState } from "react";
import type { ChampionshipsFile, EvidenceEntry, PersonDossier } from "@kayfabe/graph-contract";
import { dayToDate, pairKey } from "@kayfabe/graph-contract";
import { loadChampionships, loadEvidenceForPair, loadPersonDossier } from "../data/loader";
import { GeoHandoffActions } from "../geo/GeoHandoff";

/** What the glow currently means. Three node types answer "who lights up" from
 * three different signals, and saying which one is in play is the difference
 * between a reading and a decoration. */
/** Step back along the trail of selections. Following a connection is how this
 * app is read, so returning has to be one action. */
function BackButton() {
  const history = useStore((s) => s.history);
  const back = useStore((s) => s.back);
  const model = useStore((s) => s.model);
  const prev = history[history.length - 1];
  if (!prev || !model) return null;
  const i = model.indexOfId.get(prev);
  const name = i !== undefined ? model.nodes.name[i] : prev;
  return (
    <button
      className="collapse-btn ghost back-btn"
      data-testid="dossier-back"
      title={`Back to ${name}`}
      aria-label={`Back to ${name}`}
      onClick={back}
    >
      ← {name}
    </button>
  );
}

function LitSetNote() {
  const members = useStore((s) => s.members);
  const group = useStore((s) => s.memberGroup);
  const setGroup = useStore((s) => s.setMemberGroup);
  const isolate = useStore((s) => s.isolate);
  const setIsolate = useStore((s) => s.setIsolate);
  if (!members.basis) return null;
  const active = members.groups?.find((g) => g.key === group);
  return (
    <>
      {members.groups && (
        <div className="checks relation-groups" role="radiogroup" aria-label="Connection kind">
          {members.groups.map((g) => (
            <button
              key={g.key}
              role="radio"
              aria-checked={group === g.key}
              disabled={g.ids.length === 0}
              className={`chip tone-${g.tone} ${group === g.key ? "on" : ""}`}
              onClick={() => setGroup(g.key)}
              data-testid={`group-${g.key}`}
            >
              {g.label} <b className="num">{g.ids.length.toLocaleString()}</b>
            </button>
          ))}
        </div>
      )}
      <p className="micro" data-testid="lit-basis">
        {active && active.key !== "all"
          ? `${active.ids.length.toLocaleString()} ${active.label.toLowerCase()}`
          : members.basis}
      </p>
      <label className="micro isolate-toggle">
        <input
          type="checkbox" checked={isolate}
          onChange={(e) => setIsolate(e.target.checked)}
        />{" "}
        Isolate — hide everything else
      </label>
      {members.caveat && <p className="derivation-note">{members.caveat}</p>}
    </>
  );
}
import { EF } from "../graph/model";
import { isoToDay, useStore } from "../state/store";

export function RightPanel() {
  const selection = useStore((s) => s.selection);
  if (!selection) return null;
  return (
    <div className="rail right">
      <div className="panel" style={{ flex: 1 }}>
        {selection.kind === "node" ? <NodeDossier id={selection.id} /> : <EdgeDossier edge={selection.edge} />}
      </div>
    </div>
  );
}

function useActions() {
  const focus = useStore((s) => s.focus);
  const togglePin = useStore((s) => s.togglePin);
  const pinned = useStore((s) => s.pinned);
  const setPathEndpoint = useStore((s) => s.setPathEndpoint);
  const select = useStore((s) => s.select);
  return { focus, togglePin, pinned, setPathEndpoint, select };
}

function NodeDossier({ id }: { id: string }) {
  const model = useStore((s) => s.model)!;
  const core = useStore((s) => s.core);
  const select = useStore((s) => s.select);
  const { focus, togglePin, pinned, setPathEndpoint } = useActions();
  const i = model.indexOfId.get(id);
  const [dossier, setDossier] = useState<PersonDossier | null>(null);
  const [champs, setChamps] = useState<ChampionshipsFile | null>(null);
  const type = i !== undefined ? model.nodes.type[i]! : 0;

  useEffect(() => {
    setDossier(null);
    if (id.startsWith("p:")) {
      void loadPersonDossier(id).then((bucket) => setDossier(bucket[id] ?? null));
    } else if (id.startsWith("t:")) {
      void loadChampionships().then(setChamps);
    }
  }, [id]);

  if (i === undefined) return <div className="error-note">Unknown entity {id}.</div>;
  const name = model.nodes.name[i]!;
  const resolution = model.nodes.resolution[i]!;
  const promoName = (pid: string) =>
    model.nodes.name[model.indexOfId.get(pid) ?? -1] ?? core?.promotions[pid]?.n ?? pid;

  const openPair = (otherId: string) => {
    const other = model.indexOfId.get(otherId);
    if (other === undefined) return;
    for (const { node, edge } of model.neighbors(i)) {
      if (node === other) {
        select({ kind: "edge", edge });
        return;
      }
    }
  };

  return (
    <>
      <h2>
        {type === 0 ? "Person" : type === 1 ? "Promotion" : "Championship"} dossier <span className="line" />
        <BackButton />
        <button className="collapse-btn ghost" aria-label="Close dossier" onClick={() => select(null)}>✕</button>
      </h2>
      <div className="dossier-title">
        {name}
        {resolution === 1 && <span className="flag" title="Derived from side rows only — probable identity"> ◦probable</span>}
      </div>
      <div className="dossier-sub micro">
        {model.nodes.firstDay[i]! >= 0
          ? `first known record ${fmt(model.nodes.firstDay[i]!)} · latest ${fmt(model.nodes.lastDay[i]!)}`
          : "no dated records"}
      </div>
      <div className="statgrid">
        <div className="stat"><div className="v">{model.nodes.matches[i]!.toLocaleString()}</div><div className="k">{type === 1 ? "cards" : "matches"}</div></div>
        <div className="stat"><div className="v">{model.nodes.degree[i]!.toLocaleString()}</div><div className="k">connections</div></div>
        <div className="stat"><div className="v">{model.nodes.reigns[i]!.toLocaleString()}</div><div className="k">reigns*</div></div>
      </div>

      <LitSetNote />

      <GeoHandoffActions
        kind={type === 0 ? "person" : type === 1 ? "promotion" : "championship"}
        ids={[id]}
        label={model.nodes.name[i] ?? id}
      />

      {type === 0 && (
        <div className="actions">
          <button onClick={() => focus(id)}>Focus</button>
          <button className={pinned.includes(id) ? "active" : ""} onClick={() => togglePin(id)}>
            {pinned.includes(id) ? "Unpin" : "Pin"}
          </button>
          <button onClick={() => setPathEndpoint("a", id)}>Path A</button>
          <button onClick={() => setPathEndpoint("b", id)}>Path B</button>
        </div>
      )}

      {dossier && (
        <>
          <div className="evidence">
            <h2>Promotions <span className="line" /></h2>
            {Object.entries(dossier.promos).sort((a, b) => b[1] - a[1]).map(([pid, n]) => (
              <div key={pid} className="ev-row">
                <span className="d num">{n}</span>
                <span>{promoName(pid)}</span>
                <span className="micro">appearances</span>
              </div>
            ))}
            <div className="micro" style={{ marginTop: 4 }}>appearance on a card — not employment</div>
          </div>

          <div className="evidence">
            <h2>Strongest links <span className="line" /></h2>
            {dossier.top.opponents.slice(0, 8).map(([pid, n]) => (
              <button key={`o${pid}`} className="ev-row search-row" onClick={() => openPair(pid)}>
                <span className="rel-tag rel-opposed">opp ×{n}</span>
                <span>{promoName(pid)}</span>
                <span className="micro">open evidence</span>
              </button>
            ))}
            {dossier.top.partners.slice(0, 8).map(([pid, n]) => (
              <button key={`p${pid}`} className="ev-row search-row" onClick={() => openPair(pid)}>
                <span className="rel-tag rel-same">same ×{n}</span>
                <span>{promoName(pid)}</span>
                <span className="micro">open evidence</span>
              </button>
            ))}
          </div>

          {dossier.titles.length > 0 && (
            <div className="evidence">
              <h2>Championships <span className="line" /></h2>
              {dossier.titles.map((t) => (
                <div key={t.t} className="ev-row">
                  <span className="d num">{t.reigns.length}×</span>
                  <span className="gold-tag">{promoName(t.t)}</span>
                  <span className="micro">{t.reigns[0] ? `${t.reigns[0].s}${t.reigns[0].e ? ` → ${t.reigns[0].e}` : " → open"}` : ""}</span>
                </div>
              ))}
              <div className="micro" style={{ marginTop: 4 }}>
                *reigns derived from recorded title changes — vacancies invisible to this corpus are not invented
              </div>
            </div>
          )}

          {dossier.teams.length > 0 && (
            <div className="evidence">
              <h2>Appeared in sides <span className="line" /></h2>
              {dossier.teams.slice(0, 6).map((t) => (
                <div key={t} className="ev-row"><span className="d" /><span>{t}</span><span /></div>
              ))}
            </div>
          )}
          <div className="micro" style={{ marginTop: 8 }}>
            source record: {JSON.stringify(dossier.src)}
          </div>
        </>
      )}

      {type === 2 && champs && champs[id] && (
        <div className="evidence">
          <h2>Lineage (derived) <span className="line" /></h2>
          {champs[id]!.reigns.slice(0, 30).map((r, k) => (
            <div key={k} className="ev-row">
              <span className="d num">{r.s}</span>
              <span>{r.holders.map((h) => model.nodes.name[model.indexOfId.get(h) ?? -1] ?? h).join(" & ")}</span>
              <span className="micro">{r.e ?? "open"}</span>
            </div>
          ))}
          {champs[id]!.reigns.length === 0 && (
            <div className="derivation-note">
              The csv source records title matches but carries no title-change flag — reigns are
              not derived for this championship rather than guessed.
            </div>
          )}
          {champs[id]!.artifact && (
            <div className="derivation-note">
              This belt name is a concatenation artifact in the source; records kept unsplit rather than guessed.
            </div>
          )}
        </div>
      )}
    </>
  );
}

function EdgeDossier({ edge }: { edge: number }) {
  const model = useStore((s) => s.model)!;
  const select = useStore((s) => s.select);
  const setTimeline = useStore((s) => s.setTimeline);
  const [evidence, setEvidence] = useState<EvidenceEntry[] | null>(null);
  const ia = model.edgeField(edge, EF.a);
  const ib = model.edgeField(edge, EF.b);
  const idA = model.nodes.id[ia]!;
  const idB = model.nodes.id[ib]!;
  const key = pairKey(idA, idB);

  useEffect(() => {
    setEvidence(null);
    void loadEvidenceForPair(key).then((bucket) => setEvidence(bucket[key] ?? []));
  }, [key]);

  const same = model.edgeField(edge, EF.same);
  const opposed = model.edgeField(edge, EF.opposed);
  const br = model.edgeField(edge, EF.br);
  const title = model.edgeField(edge, EF.title);

  return (
    <>
      <h2>
        Relationship dossier <span className="line" />
        <BackButton />
        <button className="collapse-btn ghost" aria-label="Close dossier" onClick={() => select(null)}>✕</button>
      </h2>
      <div className="dossier-title">
        {model.nodes.name[ia]} <span style={{ color: "var(--text-faint)" }}>×</span> {model.nodes.name[ib]}
      </div>
      <div className="dossier-sub micro">
        first {fmt(model.edgeField(edge, EF.firstDay))} · latest {fmt(model.edgeField(edge, EF.lastDay))}
      </div>
      <div className="statgrid">
        <div className="stat"><div className="v" style={{ color: "var(--opposed)" }}>{opposed}</div><div className="k">opposed</div></div>
        <div className="stat"><div className="v" style={{ color: "var(--same)" }}>{same}</div><div className="k">same-side</div></div>
        <div className="stat"><div className="v" style={{ color: br ? "var(--caution)" : undefined }}>{br}</div><div className="k">battle royal</div></div>
      </div>
      {title > 0 && <div className="gold-tag micro">{title} title-match encounters</div>}

      <div className="actions">
        <button onClick={() => select({ kind: "node", id: idA })}>{model.nodes.name[ia]}</button>
        <button onClick={() => select({ kind: "node", id: idB })}>{model.nodes.name[ib]}</button>
      </div>

      <GeoHandoffActions
        kind="pair"
        ids={[idA, idB]}
        label={`${model.nodes.name[ia]} × ${model.nodes.name[ib]}`}
      />

      <div className="evidence">
        <h2>Supporting records <span className="line" /></h2>
        {evidence === null && <div className="micro">loading evidence…</div>}
        {evidence !== null && evidence.length === 0 && (
          <div className="error-note">
            No evidence rows found for this pair — this is a data-quality defect, please report it.
          </div>
        )}
        {evidence?.map((e) => (
          <button
            key={e.m}
            className="ev-row search-row"
            title="Reveal in timeline"
            onClick={() => setTimeline({ mode: "playback", day: isoToDay(e.d), playing: false })}
          >
            <span className="d">{e.d}</span>
            <span>
              <span className={`rel-tag rel-${e.rel === "same" ? "same" : e.rel === "br" ? "br" : "opposed"}`}>
                {e.rel === "same" ? "same-side" : e.rel === "br" ? "battle royal" : "opposed"}
              </span>{" "}
              {e.form.replace("_", " ")} · {e.res}
              {e.t && <span className="gold-tag"> · title{e.tc ? " CHANGE" : ""}</span>}
              {e.mr !== undefined && (
                <span className="gold-tag" title={`Meltzer rating ${e.mr}`}> · {stars(e.mr)}</span>
              )}
            </span>
            <span className="micro">{e.m}</span>
          </button>
        ))}
      </div>
      <div className="derivation-note">
        Derived per encounters@2: opposed = across competitive units; same-side only within
        genuine teams (never within multi-way loser groups collapsed by the source); battle-royal
        opposition tracked separately and never presented as rivalry. Every row above is a source
        match record.
      </div>
    </>
  );
}

const fmt = (day: number): string => {
  if (day < 0) return "—";
  return dayToDate(day).toISOString().slice(0, 10);
};

/** Meltzer star rating: 4.75 -> '★★★★¾' */
export const stars = (mr: number): string => {
  if (mr < 0) return `−★`;
  const whole = Math.floor(mr);
  const frac = mr - whole;
  const q = frac >= 0.75 ? "¾" : frac >= 0.5 ? "½" : frac >= 0.25 ? "¼" : "";
  return "★".repeat(whole) + q || "0★";
};
