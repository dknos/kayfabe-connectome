import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchEntity } from "@kayfabe/graph-contract";
import { useStore } from "../state/store";

const KIND_LABEL: Record<SearchEntity["t"], string> = {
  person: "person",
  promotion: "promotion",
  title: "title",
  event: "event",
};

export function SearchBox() {
  const core = useStore((s) => s.core);
  const model = useStore((s) => s.model);
  const focus = useStore((s) => s.focus);
  const select = useStore((s) => s.select);
  const announce = useStore((s) => s.announce);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    if (!core || q.trim().length < 2) return [];
    const needle = q.trim().toLowerCase();
    const scored: [number, SearchEntity][] = [];
    for (const e of core.search) {
      const name = e.n.toLowerCase();
      const idx = name.indexOf(needle);
      if (idx < 0) continue;
      let score = idx === 0 ? 0 : name[idx - 1] === " " ? 1 : 3;
      if (e.t !== "person") score += 0.5;
      score -= Math.min(2, e.m / 400); // heavier record counts float upward
      scored.push([score, e]);
      if (scored.length > 400) break;
    }
    return scored.sort((a, b) => a[0] - b[0]).slice(0, 12).map(([, e]) => e);
  }, [core, q]);

  const choose = (e: SearchEntity) => {
    setOpen(false);
    setQ(e.n);
    if (model?.indexOfId.has(e.id)) {
      select({ kind: "node", id: e.id });
      focus(e.id);
      announce(`Focused ${e.n} (${KIND_LABEL[e.t]})`);
    } else {
      announce(`${e.n} is indexed but not a graph node (${KIND_LABEL[e.t]}).`);
    }
  };

  return (
    <div className="search">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-label="Search people, promotions, titles, events"
        placeholder="Search the corpus…  ( / )"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setSel(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => Math.min(results.length - 1, s + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => Math.max(0, s - 1));
          } else if (e.key === "Enter" && results[sel]) {
            choose(results[sel]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && results.length > 0 && (
        <div className="search-pop" role="listbox">
          {results.map((e, i) => (
            <button
              key={e.id}
              role="option"
              aria-selected={i === sel}
              className={`search-row ${i === sel ? "sel" : ""}`}
              onMouseDown={(ev) => {
                ev.preventDefault();
                choose(e);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <span className="kind micro">{KIND_LABEL[e.t]}</span>
              <span>{e.n}</span>
              <span className="era num">
                {e.first ? `${e.first.slice(0, 4)}–${e.last?.slice(0, 4) ?? ""}` : `${e.m}`}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && q.trim().length >= 2 && results.length === 0 && (
        <div className="search-pop">
          <div className="empty-note" style={{ padding: "8px 10px" }}>
            No record matches "{q.trim()}". The corpus covers WWE-family promotions 1963–2026.
          </div>
        </div>
      )}
    </div>
  );
}
