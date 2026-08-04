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
import { loadChampionships, loadPersonDossier } from "../data/loader";
import { useStore } from "../state/store";

interface Dossier {
  matches: number;
  promos: { name: string; matches: number }[];
  opponents: { name: string; matches: number }[];
  partners: { name: string; matches: number }[];
  titles: { name: string; reigns: number }[];
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
  const [dossier, setDossier] = useState<Dossier | null>(null);
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
      const pairs = (list: [string, number][]): { name: string; matches: number }[] =>
        list
          .map(([id, matches]) => ({ name: nameOf(id), matches }))
          .filter((e): e is { name: string; matches: number } => e.name !== null)
          .slice(0, 4);
      setDossier({
        matches: record.m,
        promos: Object.entries(record.promos)
          .map(([id, matches]) => ({ name: core?.promotions?.[id]?.n ?? null, matches }))
          .filter((e): e is { name: string; matches: number } => e.name !== null)
          .sort((a, b) => b.matches - a.matches)
          .slice(0, 4),
        opponents: pairs(record.top.opponents),
        partners: pairs(record.top.partners),
        titles: record.titles
          .map((t) => ({
            name: championships?.[t.t]?.n ?? null,
            reigns: t.reigns.length,
          }))
          .filter((e): e is { name: string; reigns: number } => e.name !== null)
          .sort((a, b) => b.reigns - a.reigns)
          .slice(0, 4),
      });
    })();
    return () => { cancelled = true; };
  }, [card.id, isPerson, model, core]);

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
        <section>
          <h3>Worked most in</h3>
          <ul className="arena-facts">
            {dossier.promos.map((p) => (
              <li key={p.name}><span>{p.name}</span><b>{p.matches}</b></li>
            ))}
          </ul>
        </section>
      )}
      {dossier && dossier.opponents.length > 0 && (
        <section>
          <h3>Most-documented opponents</h3>
          <ul className="arena-facts">
            {dossier.opponents.map((p) => (
              <li key={p.name}><span>{p.name}</span><b>{p.matches}</b></li>
            ))}
          </ul>
        </section>
      )}
      {dossier && dossier.partners.length > 0 && (
        <section>
          <h3>Most-documented partners</h3>
          <ul className="arena-facts">
            {dossier.partners.map((p) => (
              <li key={p.name}><span>{p.name}</span><b>{p.matches}</b></li>
            ))}
          </ul>
        </section>
      )}
      {dossier && dossier.titles.length > 0 && (
        <section>
          <h3>Championships</h3>
          <ul className="arena-facts">
            {dossier.titles.map((t) => (
              <li key={t.name}>
                <span>{t.name}</span><b>{t.reigns} reign{t.reigns === 1 ? "" : "s"}</b>
              </li>
            ))}
          </ul>
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
