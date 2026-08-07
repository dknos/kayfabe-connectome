import { useEffect, useMemo, useState } from "react";
import type { SearchEntity, PersonDossier } from "@kayfabe/graph-contract";
import { canonicalPersonId, defaultCrosswalk } from "@kayfabe/history-adapter";
import { corpus } from "../corpus";

/**
 * The immutable historical record, read straight from the corpus. Results
 * are canonicalized through the persona crosswalk: every ring name of one
 * human collapses into a single entry.
 */

interface CanonicalHit {
  canonicalId: string;
  displayName: string;
  personas: { id: string; name: string }[];
  totalMatches: number;
}

export function AlmanacScreen(): JSX.Element {
  const [people, setPeople] = useState<SearchEntity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<CanonicalHit | null>(null);
  const [dossiers, setDossiers] = useState<Map<string, PersonDossier> | null>(null);

  useEffect(() => {
    corpus()
      .searchEntities()
      .then((all) => setPeople(all.filter((e) => e.t === "person")))
      .catch((e) => setError(String(e)));
  }, []);

  const hits: CanonicalHit[] = useMemo(() => {
    if (!people || q.trim().length < 2) return [];
    const xw = defaultCrosswalk();
    const needle = q.trim().toLowerCase();
    const byId = new Map(people.map((p) => [p.id, p]));
    const seen = new Map<string, CanonicalHit>();
    let n = 0;
    for (const p of people) {
      if (!p.n.toLowerCase().includes(needle)) continue;
      const canonical = canonicalPersonId(xw, p.id);
      if (seen.has(canonical)) continue;
      const group = xw.byCanonical.get(canonical);
      const members = group?.members ?? [{ id: p.id, persona: p.n }];
      const canonicalName = group?.displayName ?? byId.get(canonical)?.n ?? p.n;
      seen.set(canonical, {
        canonicalId: canonical,
        displayName: canonicalName,
        personas: members.map((m) => ({ id: m.id, name: m.persona })),
        totalMatches: members.reduce((s, m) => s + (byId.get(m.id)?.m ?? 0), 0),
      });
      if (++n >= 30) break;
    }
    return [...seen.values()].sort((a, b) => b.totalMatches - a.totalMatches);
  }, [people, q]);

  useEffect(() => {
    if (!selected) return;
    setDossiers(null);
    Promise.all(
      selected.personas.map((p) =>
        corpus()
          .personDossier(p.id)
          .then((d) => [p.id, d] as const),
      ),
    )
      .then((entries) => {
        const m = new Map<string, PersonDossier>();
        for (const [id, d] of entries) if (d) m.set(id, d);
        setDossiers(m);
      })
      .catch((e) => setError(String(e)));
  }, [selected]);

  const merged = useMemo(() => {
    if (!dossiers || !selected) return null;
    let matches = 0;
    let first = "";
    let last = "";
    const years = new Map<string, number>();
    const promos = new Map<string, number>();
    const reigns: { title: string; s: string; e: string | null; persona: string }[] = [];
    for (const p of selected.personas) {
      const d = dossiers.get(p.id);
      if (!d) continue;
      matches += d.m;
      if (d.first && (!first || d.first < first)) first = d.first;
      if (d.last && d.last > last) last = d.last;
      for (const [y, c] of Object.entries(d.years ?? {})) years.set(y, (years.get(y) ?? 0) + c);
      for (const [pr, c] of Object.entries(d.promos ?? {})) promos.set(pr, (promos.get(pr) ?? 0) + c);
      for (const t of d.titles ?? []) {
        for (const r of t.reigns ?? []) reigns.push({ title: t.t, s: r.s, e: r.e, persona: p.name });
      }
    }
    reigns.sort((a, b) => a.s.localeCompare(b.s));
    return { matches, first, last, years, promos, reigns };
  }, [dossiers, selected]);

  return (
    <div className="page" data-testid="almanac">
      <div className="page-title">
        <h1>Historical Almanac</h1>
        <span className="sub">the record itself — immutable, whatever happens in your universe</span>
        <span style={{ marginLeft: "auto" }}>
          <input
            data-testid="almanac-search"
            placeholder="Search any ring name in history…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSelected(null);
            }}
            style={{ width: 280 }}
          />
        </span>
      </div>

      {error && (
        <div className="notice error">
          The record is unavailable: {error}. The corpus must be served at /data (see docs/simulator-audit.md).
        </div>
      )}
      {!people && !error && <div className="empty">Consulting the record…</div>}

      {people && !selected && (
        <div className="panel">
          <div className="panel-head">
            {q.trim().length < 2 ? "Type at least two characters" : `${hits.length} people${hits.length === 30 ? " (showing 30)" : ""}`}
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            {hits.length === 0 && q.trim().length >= 2 ? (
              <div className="empty">No one by that name in {people.length.toLocaleString("en-US")} recorded careers.</div>
            ) : (
              <table className="data">
                <tbody>
                  {hits.map((h) => (
                    <tr key={h.canonicalId} className="rowlink" data-testid="almanac-result" onClick={() => setSelected(h)}>
                      <td>
                        <strong>{h.displayName}</strong>{" "}
                        {h.personas.length > 1 &&
                          h.personas.map((p) => (
                            <span key={p.id} className="pill" style={{ marginLeft: 4 }}>
                              {p.name}
                            </span>
                          ))}
                      </td>
                      <td className="num">{h.totalMatches.toLocaleString("en-US")} recorded matches</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {selected && (
        <>
          <button className="quiet" onClick={() => setSelected(null)}>
            ← back to results
          </button>
          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-head">
              {selected.displayName}
              {selected.personas.map((p) => (
                <span key={p.id} className="pill">
                  {p.name}
                </span>
              ))}
              <span style={{ marginLeft: "auto" }} className="confidence">
                one person, {selected.personas.length} recorded identit{selected.personas.length > 1 ? "ies" : "y"}
              </span>
            </div>
            <div className="panel-body">
              {!merged ? (
                <div className="empty">Pulling the file…</div>
              ) : (
                <div className="cols cols-2">
                  <div>
                    <table className="data">
                      <tbody>
                        <tr>
                          <td>Recorded matches</td>
                          <td className="num">{merged.matches.toLocaleString("en-US")}</td>
                        </tr>
                        <tr>
                          <td>First record</td>
                          <td className="num">{merged.first || "—"}</td>
                        </tr>
                        <tr>
                          <td>Last record</td>
                          <td className="num">{merged.last || "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="confidence" style={{ marginTop: 8 }}>
                      Top promotions by recorded matches
                    </div>
                    <table className="data">
                      <tbody>
                        {[...merged.promos.entries()]
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 8)
                          .map(([pr, c]) => (
                            <tr key={pr}>
                              <td>{pr}</td>
                              <td className="num">{c}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <div className="confidence">Activity by year</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                      {[...merged.years.entries()]
                        .sort((a, b) => a[0].localeCompare(b[0]))
                        .map(([y, c]) => (
                          <div key={y} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <span style={{ width: 34 }}>{y}</span>
                            <span
                              style={{
                                display: "inline-block",
                                height: 7,
                                width: Math.min(160, c * 2),
                                background: "var(--crimson-soft)",
                              }}
                            />
                            <span>{c}</span>
                          </div>
                        ))}
                    </div>
                    {merged.reigns.length > 0 && (
                      <>
                        <div className="confidence" style={{ marginTop: 8 }}>
                          Recorded championship reigns
                        </div>
                        <table className="data">
                          <tbody>
                            {merged.reigns.slice(0, 12).map((r, i) => (
                              <tr key={i}>
                                <td>{r.title}</td>
                                <td>
                                  {r.s} → {r.e === null ? "open" : r.e}
                                </td>
                                <td className="confidence">as {r.persona}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="confidence" style={{ marginTop: 10 }}>
                The historical record — immutable. Your universe diverges from it; it never bends to yours.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
