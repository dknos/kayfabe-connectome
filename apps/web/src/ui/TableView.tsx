import { useMemo, useState } from "react";
import { useStore } from "../state/store";

type SortKey = "n" | "first" | "last" | "m" | "deg";

/** Accessible 2D fallback: the same corpus as a sortable table. */
export function TableView() {
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const [sortKey, setSortKey] = useState<SortKey>("m");
  const [desc, setDesc] = useState(true);
  const [page, setPage] = useState(0);
  const PAGE = 40;

  const rows = useMemo(() => {
    if (!model) return [];
    const out: { id: string; n: string; first: number; last: number; m: number; deg: number }[] = [];
    for (let i = 0; i < model.nodes.count; i++) {
      if (model.nodes.type[i] !== 0) continue;
      out.push({
        id: model.nodes.id[i]!,
        n: model.nodes.name[i]!,
        first: model.nodes.firstDay[i]!,
        last: model.nodes.lastDay[i]!,
        m: model.nodes.matches[i]!,
        deg: model.nodes.degree[i]!,
      });
    }
    const dir = desc ? -1 : 1;
    out.sort((a, b) => {
      const va = sortKey === "n" ? a.n : a[sortKey === "deg" ? "deg" : sortKey];
      const vb = sortKey === "n" ? b.n : b[sortKey === "deg" ? "deg" : sortKey];
      return va < vb ? -dir : va > vb ? dir : 0;
    });
    return out;
  }, [model, sortKey, desc]);

  if (!model) return null;
  const fmt = (day: number) =>
    day < 0 ? "—" : new Date(Date.UTC(1950, 0, 1) + day * 86400000).toISOString().slice(0, 4);
  const header = (key: SortKey, label: string) => (
    <th
      scope="col"
      aria-sort={sortKey === key ? (desc ? "descending" : "ascending") : "none"}
      onClick={() => {
        if (sortKey === key) setDesc(!desc);
        else {
          setSortKey(key);
          setDesc(true);
        }
        setPage(0);
      }}
      onKeyDown={(e) => e.key === "Enter" && (sortKey === key ? setDesc(!desc) : setSortKey(key))}
      tabIndex={0}
    >
      {label} {sortKey === key ? (desc ? "▾" : "▴") : ""}
    </th>
  );

  const slice = rows.slice(page * PAGE, (page + 1) * PAGE);
  return (
    <div className="tableview" role="region" aria-label="People table — accessible fallback">
      <table>
        <caption>
          {rows.length.toLocaleString()} people in the corpus. Select a row to open its dossier;
          switch back to the Connectome lens for the spatial view. Page {page + 1} of{" "}
          {Math.ceil(rows.length / PAGE)}.
        </caption>
        <thead>
          <tr>
            {header("n", "Name")}
            {header("first", "First known")}
            {header("last", "Latest known")}
            {header("m", "Matches")}
            {header("deg", "Connections")}
          </tr>
        </thead>
        <tbody>
          {slice.map((r) => (
            <tr
              key={r.id}
              className={selection?.kind === "node" && selection.id === r.id ? "sel" : ""}
              onClick={() => select({ kind: "node", id: r.id })}
              onKeyDown={(e) => e.key === "Enter" && select({ kind: "node", id: r.id })}
              tabIndex={0}
              aria-selected={selection?.kind === "node" && selection.id === r.id}
            >
              <td>{r.n}</td>
              <td className="num">{fmt(r.first)}</td>
              <td className="num">{fmt(r.last)}</td>
              <td className="num">{r.m.toLocaleString()}</td>
              <td className="num">{r.deg.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions" style={{ margin: "12px 0" }}>
        <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>← Prev</button>
        <button
          onClick={() => setPage(Math.min(Math.ceil(rows.length / PAGE) - 1, page + 1))}
          disabled={(page + 1) * PAGE >= rows.length}
        >
          Next →
        </button>
      </div>
    </div>
  );
}
