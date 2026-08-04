/**
 * The spacetime inspector: exact records only.
 *
 * Language rules bind here (docs/CANONICAL-MODEL.md): repeated opposition is
 * "opposed encounters", never a feud; promotion appearance is never
 * employment; a missing rating is missing, not zero; csv titles carry no
 * change data, so nothing here invents a reign.
 */
import { useEffect, useState } from "react";
import { EventField, type SpacetimeScope } from "@kayfabe/spacetime-renderer";
import { fmtDay, useStore } from "../state/store";
import type { GraphModel } from "../graph/model";
import { promoNameOf } from "./spacetimeAdapter";

export type Inspected =
  | { kind: "event"; index: number }
  | { kind: "person"; index: number };

const FORM_LABEL = ["singles", "tag team", "multi-way", "battle royal", "team (implied)", "unrecorded form"];

export function SpacetimeInspector({
  scope, model, inspected, onClose, onChoose, onTravel,
}: {
  scope: SpacetimeScope;
  model: GraphModel;
  inspected: Inspected;
  onClose: () => void;
  onChoose: (id: string) => void;
  onTravel: (day: number) => void;
}): JSX.Element | null {
  const setLens = useStore((s) => s.setLens);
  const select = useStore((s) => s.select);
  const [promoName, setPromoName] = useState<string>("");

  const event = inspected.kind === "event" ? scope.events[inspected.index] ?? null : null;
  useEffect(() => {
    if (!event) return;
    let cancelled = false;
    void promoNameOf(event.promoIdx).then((n) => { if (!cancelled) setPromoName(n); });
    return () => { cancelled = true; };
  }, [event]);

  const nameOf = (idx: number): string => model.nodes.name[idx] ?? `#${idx}`;
  const idOf = (idx: number): string => model.nodes.id[idx] ?? "";

  if (inspected.kind === "event") {
    if (!event) return null;
    const persona = scope.personas[event.persona];
    const rating = event.rating100p1 > 0 ? (event.rating100p1 - 1) / 100 : null;
    return (
      <aside className="spacetime-inspector" aria-label="Documented match">
        <button className="close" onClick={onClose} aria-label="Close inspector">×</button>
        <h3>{fmtDay(event.day)}{event.apx ? " (approximate date)" : ""}</h3>
        {event.eventName && <p className="micro">{event.eventName}</p>}
        <p className="micro">{promoName} · {FORM_LABEL[event.form] ?? "unrecorded form"}</p>
        <p>
          {persona && event.persona > 0
            ? `${scope.subjectLabel} — competed as ${persona.label} — `
            : `${scope.subjectLabel} `}
          {EventField.resultLabel(event.result)}
        </p>
        {event.same.length > 0 && (
          <p className="spacetime-parts">
            <span className="micro">alongside</span>{" "}
            {[...event.same].map((idx) => (
              <button key={idx} className="crumb same" onClick={() => onChoose(idOf(idx))}>
                {nameOf(idx)}
              </button>
            ))}
          </p>
        )}
        {event.opposed.length > 0 && (
          <p className="spacetime-parts">
            <span className="micro">opposed</span>{" "}
            {[...event.opposed].map((idx) => (
              <button key={idx} className="crumb opposed" onClick={() => onChoose(idOf(idx))}>
                {nameOf(idx)}
              </button>
            ))}
          </p>
        )}
        {event.context.length > 0 && (
          <p className="spacetime-parts micro">
            also on the card record: {[...event.context].map((idx) => nameOf(idx)).join(", ")}
          </p>
        )}
        {event.titleMatch && (
          <p className="spacetime-title">
            {event.titleChange
              ? "Documented title change."
              : "Title match — no documented change of hands."}
          </p>
        )}
        {rating !== null && (
          <p className="micro">reported rating {rating.toFixed(2)} (source-reported, not derived)</p>
        )}
        <div className="spacetime-actions">
          <button onClick={() => onTravel(event.day)}>Center bubble here</button>
        </div>
      </aside>
    );
  }

  const rel = scope.relationships[inspected.index];
  if (!rel) return null;
  const total = rel.same + rel.opposed + rel.br;
  return (
    <aside className="spacetime-inspector" aria-label="Documented relationship">
      <button className="close" onClick={onClose} aria-label="Close inspector">×</button>
      <h3>{rel.n}</h3>
      <p className="micro">
        {scope.subjectLabel} · {total} documented shared matches ·{" "}
        {fmtDay(rel.firstDay)} → {fmtDay(rel.lastDay)}
      </p>
      <p className="spacetime-facts">
        {rel.opposed > 0 && <span className="opposed num">{rel.opposed} opposed</span>}
        {rel.same > 0 && <span className="same num">{rel.same} same-side</span>}
        {rel.br > 0 && <span className="br num">{rel.br} battle-royal co-presence</span>}
      </p>
      {rel.buckets.length > 0 && (
        <div className="spacetime-echoes">
          <span className="micro">documented era echoes — click to travel</span>
          {rel.buckets.map(([y, n]) => (
            <button
              key={y}
              className="crumb"
              onClick={() => onTravel(Math.round((Date.UTC(y + 2, 6, 1) - Date.UTC(1900, 0, 1)) / 86400000))}
            >
              records {y}–{y + 4} · {n}
            </button>
          ))}
        </div>
      )}
      <div className="spacetime-actions">
        <button onClick={() => onTravel(rel.firstDay)}>First documented meeting</button>
        <button onClick={() => onChoose(rel.p)}>Make them the subject</button>
        <button
          onClick={() => {
            select({ kind: "node", id: rel.p });
            setLens("arena");
          }}
        >
          Open their arena
        </button>
      </div>
    </aside>
  );
}
