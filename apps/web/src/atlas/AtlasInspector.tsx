import { dayToDate } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";
import { useAtlas, semanticStateOf } from "./atlasStore";

/**
 * What the board is currently saying, in words.
 *
 * Every visual encoding in ATLAS has to be readable as text — partly for
 * screen readers, and partly because several of the claims here are subtle
 * enough that the geometry alone would be read too strongly. A gold rail with
 * no reign blocks means "this source cannot record title changes", and no
 * amount of shading says that.
 */

const fmt = (day: number): string =>
  day < 0 ? "—" : dayToDate(day).toISOString().slice(0, 10);
const yr = (day: number): string => (day < 0 ? "—" : String(dayToDate(day).getUTCFullYear()));

export function AtlasInspector() {
  const data = useAtlas((s) => s.data);
  const promotion = useAtlas((s) => s.promotion);
  const person = useAtlas((s) => s.person);
  const lineage = useAtlas((s) => s.lineage);
  const reignFocus = useAtlas((s) => s.reignFocus);
  const championships = useAtlas((s) => s.championships);
  const setReignFocus = useAtlas((s) => s.setReignFocus);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const id = selection?.kind === "node" ? selection.id : null;
  const state = semanticStateOf(id);

  if (!data) return null;
  if (state === "overview") {
    return (
      <div className="rail right atlas-rail">
        <div className="panel">
          <h2>Atlas <span className="line" /></h2>
          <div className="dossier-title">The corpus as chronology</div>
          <div className="statgrid">
            <div className="stat">
              <div className="v">{data.promotions.count.toLocaleString()}</div>
              <div className="k">promotions</div>
            </div>
            <div className="stat">
              <div className="v">{data.titles.count.toLocaleString()}</div>
              <div className="k">championships</div>
            </div>
            <div className="stat">
              <div className="v">
                {data.manifest.date_range[0].slice(0, 4)}–{data.manifest.date_range[1].slice(0, 4)}
              </div>
              <div className="k">documented</div>
            </div>
          </div>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
            Every promotion has a lane and every championship has a rail — including the{" "}
            {(data.promotions.count - 165).toLocaleString()} promotions and{" "}
            {(data.titles.count - 741).toLocaleString()} titles that sit below the connectome's node
            threshold. Lane height is log-scaled documented volume; rail length is the span between
            first and latest documented record.
          </p>
          {data.unresolvedTitles.length > 0 && (
            <p className="derivation-note">
              {data.unresolvedTitles.length.toLocaleString()} championships are not placed under any
              promotion, because the records do not support one. They have their own band rather
              than being guessed into a lane.
            </p>
          )}
          <p className="derivation-note">
            {data.manifest.counts.titlesWithReigns?.toLocaleString() ?? "—"} of{" "}
            {data.titles.count.toLocaleString()} championships have a derivable lineage. The rest
            come from a source that records title matches but carries no title-change field, so
            their reigns are absent from the record — not from history — and are not guessed.
          </p>
        </div>
      </div>
    );
  }

  if (state === "promotion" && promotion) {
    return (
      <div className="rail right atlas-rail">
        <div className="panel">
          <h2>Promotion <span className="line" /></h2>
          <div className="dossier-title">{promotion.n}</div>
          <div className="dossier-sub micro">
            {promotion.firstDay >= 0
              ? `first documented record ${fmt(promotion.firstDay)} · latest ${fmt(promotion.lastDay)}`
              : "no dated record"}
          </div>
          <div className="statgrid">
            <div className="stat"><div className="v">{promotion.cards.toLocaleString()}</div><div className="k">cards</div></div>
            <div className="stat"><div className="v">{promotion.matches.toLocaleString()}</div><div className="k">matches</div></div>
            <div className="stat"><div className="v">{promotion.people.toLocaleString()}</div><div className="k">participants</div></div>
          </div>
          <div className="statgrid">
            <div className="stat"><div className="v">{promotion.titles.length.toLocaleString()}</div><div className="k">championships</div></div>
            <div className="stat"><div className="v">{promotion.yearCards.length}</div><div className="k">active years</div></div>
            <div className="stat"><div className="v">{promotion.src === "local_sql" ? "SQL" : "CSV"}</div><div className="k">source</div></div>
          </div>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
            "Participants" counts people documented on one of this promotion's cards. The corpus
            records appearances, not contracts — nothing here is a claim about employment.
          </p>
        </div>
        {promotion.titles.length > 0 && (
          <div className="panel">
            <h2>Championships <span className="line" /></h2>
            {promotion.titles.slice(0, 40).map((t) => (
              <button
                key={t.t}
                className="ev-row search-row"
                onClick={() => select({ kind: "node", id: t.t })}
              >
                <span className="d num">{t.firstDay >= 0 ? yr(t.firstDay) : "—"}</span>
                <span>
                  <span className="gold-tag">{t.n}</span>
                  {t.artifact === 1 && <span className="flag" title="Concatenation artifact in the source"> ◦artifact</span>}
                </span>
                <span className="micro">
                  {t.lineage === "derived" ? `${t.reigns} reigns` : "no change records"}
                </span>
              </button>
            ))}
            {promotion.titles.length > 40 && (
              <div className="micro">
                {(promotion.titles.length - 40).toLocaleString()} more on the board above.
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (state === "title" && lineage) {
    const rec = id ? championships?.[id] : null;
    const focusIdx = reignFocus?.includes("#r")
      ? Number(reignFocus.split("#r")[1])
      : null;
    const focused = focusIdx !== null && rec ? rec.reigns[focusIdx] : null;
    return (
      <div className="rail right atlas-rail">
        <div className="panel">
          <h2>Championship <span className="line" /></h2>
          <div className="dossier-title">{rec?.n ?? id}</div>
          <div className="dossier-sub micro">
            {lineage.firstDay >= 0
              ? `first documented title match ${fmt(lineage.firstDay)} · latest ${fmt(lineage.lastDay)}`
              : "no dated title match"}
          </div>
          <div className="statgrid">
            <div className="stat"><div className="v">{lineage.titleMatches.toLocaleString()}</div><div className="k">title matches</div></div>
            <div className="stat"><div className="v">{lineage.reigns.toLocaleString()}</div><div className="k">documented reigns</div></div>
            <div className="stat"><div className="v">{lineage.holders.toLocaleString()}</div><div className="k">unique holders</div></div>
          </div>
          {lineage.lineage === "derived" ? (
            <>
              <div className="statgrid">
                <div className="stat">
                  <div className="v">{lineage.longestDays !== null ? `${lineage.longestDays}d` : "—"}</div>
                  <div className="k">longest*</div>
                </div>
                <div className="stat">
                  <div className="v">{lineage.medianDays !== null ? `${lineage.medianDays}d` : "—"}</div>
                  <div className="k">median*</div>
                </div>
                <div className="stat"><div className="v">{lineage.changes.toLocaleString()}</div><div className="k">changes</div></div>
              </div>
              <p className="derivation-note">
                *from {lineage.closedReigns} reigns with both endpoints known
                {lineage.openReigns > 0 && `; ${lineage.openReigns} open reign${lineage.openReigns === 1 ? "" : "s"} excluded`}.
                Reigns are intervals between documented title-change matches. Consecutive reigns are
                not connected: one following another is not evidence of a direct transfer.
              </p>
            </>
          ) : (
            <p className="derivation-note">
              No lineage is derived for this championship. Its source records title matches but
              carries no title-change field, so reigns would have to be guessed — they are not. The
              board shows documented title matches per year instead.
            </p>
          )}
          {lineage.artifact && (
            <p className="derivation-note">
              This belt name is a concatenation artifact in the source. The records are kept unsplit
              and the name preserved verbatim rather than repaired into two titles that may not exist.
            </p>
          )}
          {lineage.assoc === "dominant" && lineage.assocShare <= 0.5 && (
            <p className="derivation-note">
              The records do not decide which promotion this belt belongs to — its documented title
              matches split evenly. It is placed by promotion-id ordering, which is a tie-break and
              not evidence. Anything downstream of that placement, including champion markers on the
              promotion board, inherits the tie.
            </p>
          )}
          {lineage.assoc === "dominant" && lineage.assocShare > 0.5 && lineage.assocShare < 0.85 && (
            <p className="derivation-note">
              This belt's promotion is where most of its documented title matches happened
              ({Math.round(lineage.assocShare * 100)}%), not something the source states. It was
              defended across promotions.
            </p>
          )}
          {lineage.gaps > 0 && (
            <p className="derivation-note">
              {lineage.gaps} unrecorded gap{lineage.gaps === 1 ? "" : "s"} in the lineage. The corpus
              records title changes, not vacancies — a gap means the record is silent.
            </p>
          )}
        </div>
        {focused && (
          <div className="panel">
            <h2>
              Selected reign <span className="line" />
              <button className="collapse-btn ghost" aria-label="Clear reign" onClick={() => setReignFocus(null)}>✕</button>
            </h2>
            <div className="dossier-sub micro">
              {focused.s} → {focused.e ?? "open in corpus"}
            </div>
            {focused.holders.map((h) => (
              <button key={h} className="ev-row search-row" onClick={() => select({ kind: "node", id: h })}>
                <span className="d" />
                <span>{useStore.getState().model?.nodes.name[useStore.getState().model!.indexOfId.get(h) ?? -1] ?? h}</span>
                <span className="micro">career route</span>
              </button>
            ))}
            <div className="micro">won in {focused.m}{focused.endM ? ` · lost in ${focused.endM}` : ""}</div>
          </div>
        )}
        {rec && rec.reigns.length > 0 && (
          <div className="panel">
            <h2>Reigns <span className="line" /></h2>
            {rec.reigns.slice(0, 60).map((r, k) => (
              <button
                key={k}
                className="ev-row search-row"
                onClick={() => {
                  setReignFocus(`${id}#r${k}`);
                  void useAtlas.getState().rebuild();
                }}
              >
                <span className="d num">{r.s}</span>
                <span>{r.holders.map((h) => useStore.getState().model?.nodes.name[useStore.getState().model!.indexOfId.get(h) ?? -1] ?? h).join(" & ")}</span>
                <span className="micro">{r.e ?? "open"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (state === "career" && person) {
    const d = person.dossier;
    const routes = person.routes?.routes ?? [];
    return (
      <div className="rail right atlas-rail">
        <div className="panel">
          <h2>Career route <span className="line" /></h2>
          <div className="dossier-title">{person.routes?.n ?? d?.n ?? id}</div>
          <div className="dossier-sub micro">
            {d?.first ? `first documented record ${d.first} · latest ${d.last}` : "no dated record"}
          </div>
          <div className="statgrid">
            <div className="stat"><div className="v">{(d?.m ?? 0).toLocaleString()}</div><div className="k">matches</div></div>
            <div className="stat"><div className="v">{routes.length.toLocaleString()}</div><div className="k">promotions</div></div>
            <div className="stat"><div className="v">{(d?.titles.length ?? 0).toLocaleString()}</div><div className="k">titles held</div></div>
          </div>
          <p className="micro" style={{ textTransform: "none", letterSpacing: 0 }}>
            Each band is the span between this wrestler's first and latest documented appearance for
            that promotion. Overlapping bands are real — the corpus never claims exclusivity — and a
            band is not a contract.
          </p>
        </div>
        {routes.length > 0 && (
          <div className="panel">
            <h2>Promotion routes <span className="line" /></h2>
            {routes.map((r) => {
              const pi = data.promoIndex.get(r.pr);
              return (
                <button
                  key={r.pr}
                  className="ev-row search-row"
                  onClick={() => select({ kind: "node", id: r.pr })}
                >
                  <span className="d num">{r.matches}</span>
                  <span>{pi !== undefined ? data.promotions.name[pi] : r.pr}</span>
                  <span className="micro">{yr(r.firstDay)}–{yr(r.lastDay)}</span>
                </button>
              );
            })}
            <div className="micro" style={{ marginTop: 4 }}>documented appearances — not employment</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rail right atlas-rail">
      <div className="panel">
        <h2>Atlas <span className="line" /></h2>
        <div className="micro">loading detail…</div>
      </div>
    </div>
  );
}
