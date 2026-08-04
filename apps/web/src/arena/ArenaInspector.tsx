/**
 * What the corpus knows about one card, and what you can do about it.
 *
 * The card itself carries only what the seating needed — a name, a span, an
 * encounter count. That is enough to draw someone and not enough to decide
 * whether to go and look at them, which is the actual question a reader has
 * when they click. So this pulls the person's dossier: where they worked, who
 * they worked with most, what they held.
 *
 * Everything here is documented-or-absent. A promotion with no recorded matches
 * does not appear as a zero, and a person with no recorded reigns gets no
 * championship row at all, because "none recorded" and "none" are different
 * claims and this corpus can only make the first one.
 */
import { useEffect, useState } from "react";
import type { ArenaCard, ArenaScope } from "@kayfabe/arena-renderer";
import type { EvidenceEntry } from "@kayfabe/graph-contract";
import { pairKey } from "@kayfabe/graph-contract";
import { loadChampionships, loadEvidenceForPair, loadPersonDossier } from "../data/loader";
import { pushUrl, useStore } from "../state/store";

interface Linked { id: string; name: string; count: number }

interface Dossier {
  matches: number;
  promos: Linked[];
  opponents: Linked[];
  partners: Linked[];
  titles: Linked[];
}

export function ArenaInspector({
  card, scope, onClose, onOpenArray,
}: {
  card: ArenaCard;
  scope: ArenaScope | null;
  onClose: () => void;
  onOpenArray: (id: string) => void;
}): JSX.Element {
  const model = useStore((s) => s.model);
  const core = useStore((s) => s.core);
  const select = useStore((s) => s.select);
  const setLens = useStore((s) => s.setLens);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  /** The matches these two are actually documented in together. */
  const [meetings, setMeetings] = useState<EvidenceEntry[] | null>(null);
  const [titleNames, setTitleNames] = useState<Record<string, string>>({});
  const isAnchor = card.id === scope?.anchorId;
  const isPerson = card.id.startsWith("p:");

  useEffect(() => {
    setDossier(null);
    if (!isPerson || !model) return;
    let cancelled = false;
    void (async () => {
      const [bucket, championships] = await Promise.all([
        loadPersonDossier(card.id).catch(() => null),
        loadChampionships().catch(() => null),
      ]);
      const record = bucket?.[card.id];
      if (cancelled || !record) return;
      // A name we cannot resolve is dropped rather than shown as a raw id: an
      // id on screen is noise to a reader and tells them nothing true.
      const nameOf = (id: string): string | null => {
        const i = model.indexOfId.get(id);
        return i === undefined ? null : model.nodes.name[i] ?? null;
      };
      const pairs = (list: [string, number][]): Linked[] =>
        list
          .map(([id, count]) => ({ id, name: nameOf(id), count }))
          .filter((e): e is Linked => e.name !== null)
          .slice(0, 4);
      setDossier({
        matches: record.m,
        promos: Object.entries(record.promos)
          .map(([id, count]) => ({ id, name: core?.promotions?.[id]?.n ?? null, count }))
          .filter((e): e is Linked => e.name !== null)
          .sort((a, b) => b.count - a.count)
          .slice(0, 4),
        opponents: pairs(record.top.opponents),
        partners: pairs(record.top.partners),
        titles: record.titles
          .map((t) => ({ id: t.t, name: championships?.[t.t]?.n ?? null, count: t.reigns.length }))
          .filter((e): e is Linked => e.name !== null)
          .sort((a, b) => b.count - a.count)
          .slice(0, 4),
      });
    })();
    return () => { cancelled = true; };
  }, [card.id, isPerson, model, core]);

  // The record between these two specifically. This is the question a reader is
  // asking when they click somebody in an arena built around someone else, and
  // it is the one thing the card itself can never carry: a card is a summary,
  // and "48 encounters" is not the same claim as forty-eight dated matches.
  const anchorId = scope?.anchorId ?? null;
  const pair = anchorId && anchorId !== card.id && anchorId.startsWith("p:") && isPerson
    ? pairKey(anchorId, card.id)
    : null;
  useEffect(() => {
    setMeetings(null);
    if (!pair) return;
    let cancelled = false;
    void (async () => {
      const [bucket, championships] = await Promise.all([
        loadEvidenceForPair(pair).catch(() => null),
        loadChampionships().catch(() => null),
      ]);
      if (cancelled) return;
      const rows = bucket?.[pair] ?? [];
      setMeetings(rows);
      // Titles are resolved here rather than per row so a hundred-match rivalry
      // does not do a hundred lookups while rendering.
      const names: Record<string, string> = {};
      for (const row of rows) {
        if (row.t && championships?.[row.t]) names[row.t] = championships[row.t]!.n;
      }
      setTitleNames(names);
    })();
    return () => { cancelled = true; };
  }, [pair]);

  /** A promotion builds its own arena, so it is a link like any wrestler. */
  const openPromotion = (id: string): void => {
    onClose();
    select({ kind: "node", id });
    pushUrl();
  };

  /**
   * A championship has no arena of its own — an arena seats people around a
   * subject, and a belt is not someone anybody wrestled. Morph Lab already
   * reads a title as its lineage, so a title link goes there rather than
   * pretending this lens can answer it.
   */
  const openTitle = (id: string): void => {
    onClose();
    select({ kind: "node", id });
    setLens("morph");
    pushUrl();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="arena-inspector" aria-label={`${card.name} detail`}>
      <header>
        <h2>{card.name}</h2>
        <button className="arena-close" aria-label="Close detail" onClick={onClose}>×</button>
      </header>
      <dl>
        <div><dt>Documented span</dt><dd>{card.firstYear}–{card.lastYear}</dd></div>
        {!isAnchor && (
          <div>
            <dt>{scope?.kind === "promotion" ? "Matches here" : "With the subject"}</dt>
            <dd>{card.strength}</dd>
          </div>
        )}
        <div><dt>Era</dt><dd>{card.era}</dd></div>
        {dossier && (
          <div><dt>Documented matches</dt><dd>{dossier.matches.toLocaleString()}</dd></div>
        )}
      </dl>

      {dossier && dossier.promos.length > 0 && (
        <FactList title="Worked most in" rows={dossier.promos} unit="matches" onOpen={openPromotion} />
      )}
      {dossier && dossier.opponents.length > 0 && (
        <FactList title="Most-documented opponents" rows={dossier.opponents} unit="matches" onOpen={onOpenArray} />
      )}
      {dossier && dossier.partners.length > 0 && (
        <FactList title="Most-documented partners" rows={dossier.partners} unit="matches" onOpen={onOpenArray} />
      )}
      {dossier && dossier.titles.length > 0 && (
        <FactList title="Championships" rows={dossier.titles} unit="reigns" onOpen={openTitle} />
      )}

      {pair && (
        <section className="arena-h2h">
          <h3>
            Together with {scope?.anchorName}
            {meetings && meetings.length > 0 && <span className="micro"> · {meetings.length} documented</span>}
          </h3>
          {meetings === null && <p className="micro">reading the record…</p>}
          {meetings !== null && meetings.length === 0 && (
            <p className="micro">
              The seating counts an encounter here, but no source match rows were found for the
              pair — that is a data defect rather than an absence of history.
            </p>
          )}
          <ul className="arena-meetings">
            {meetings?.slice(0, 40).map((m) => (
              <li key={m.m}>
                <span className="d">{m.d}</span>
                <span className={`rel-tag rel-${m.rel === "same" ? "same" : m.rel === "br" ? "br" : "opposed"}`}>
                  {m.rel === "same" ? "same-side" : m.rel === "br" ? "battle royal" : "opposed"}
                </span>
                <span className="ev-what">
                  {m.form.replace("_", " ")} · {m.res}
                  {core?.promotions?.[m.pr] && (
                    <>
                      {" · "}
                      <button className="link" onClick={() => openPromotion(m.pr)}>
                        {core.promotions[m.pr]!.n}
                      </button>
                    </>
                  )}
                  {m.t && (
                    <>
                      {" · "}
                      <button className="link gold-tag" onClick={() => openTitle(m.t!)}>
                        {titleNames[m.t] ?? "title"}{m.tc ? " CHANGE" : ""}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {meetings && meetings.length > 40 && (
            <p className="micro">{meetings.length - 40} further documented meetings not listed</p>
          )}
        </section>
      )}

      {/* What the seating number counts, so a reader never has to guess. */}
      <p className="arena-basis">
        {scope?.kind === "promotion"
          ? "Documented matches for this person in this promotion."
          : "Documented encounters with the subject: tag partnership, opposition, and battle-royal co-presence at reduced weight."}
      </p>

      <div className="arena-actions">
        {isPerson && !isAnchor && (
          <button className="primary" onClick={() => onOpenArray(card.id)}>
            Open {card.name}’s array
          </button>
        )}
        {isAnchor && <span className="arena-here">This is the current subject.</span>}
      </div>
    </aside>
  );
}

/** A short list of corpus facts, each one somewhere the reader can go. */
function FactList({
  title, rows, unit, onOpen,
}: {
  title: string;
  rows: Linked[];
  unit: "matches" | "reigns";
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <section>
      <h3>{title}</h3>
      <ul className="arena-facts">
        {rows.map((r) => (
          <li key={r.id}>
            <button className="link" onClick={() => onOpen(r.id)}>{r.name}</button>
            <b>{unit === "reigns" ? `${r.count} reign${r.count === 1 ? "" : "s"}` : r.count}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}
