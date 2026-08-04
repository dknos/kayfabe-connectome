/**
 * The Arena Array lens shell.
 *
 * React owns mounting, the scope and the inspector copy. It never owns a card:
 * the renderer package draws the whole population from typed arrays, which is
 * the same division every other lens in this repository uses.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ARENA_TIERS, ArenaRenderer,
  type ArenaFormation, type ArenaQualityTier, type ArenaScope,
} from "@kayfabe/arena-renderer";
import { useStore, writeUrl } from "../state/store";
import { defaultAnchorId, expandAggregate, personScope, promotionScope, promotionTruncation } from "./arenaAdapter";
import { setArenaUrlState, takePendingArenaUrl } from "./arenaUrl";

const FORMATIONS: { key: ArenaFormation; label: string; hint: string }[] = [
  { key: "echo", label: "Echo", hint: "where these people sit in the connectome" },
  { key: "arena", label: "Arena", hint: "how they relate to the subject" },
  { key: "index", label: "Index", hint: "the complete set, precisely" },
];

export function ArenaLens(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ArenaRenderer | null>(null);
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const announce = useStore((s) => s.announce);
  const [formation, setFormation] = useState<ArenaFormation>("arena");
  const [tier, setTier] = useState<ArenaQualityTier>("high");
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [inspected, setInspected] = useState<string | null>(null);
  /** Aggregates the reader has opened, so a drill-down survives a re-render. */
  const [opened, setOpened] = useState<string[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);

  const select = useStore((s) => s.select);
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;

  // Open on something. A lens that renders an empty canvas until the reader
  // searches reads as broken, and every other lens here starts populated.
  useEffect(() => {
    if (!model || selectedNodeId) return;
    const fallback = defaultAnchorId(model);
    if (fallback) select({ kind: "node", id: fallback });
  }, [model, selectedNodeId, select]);

  const anchorId = selectedNodeId;
  // Promotions and people are different arenas. A person's arena seats by
  // documented relationship; a promotion's seats by era, because its cards have
  // no relationship to a subject — they share a promotion, not an opponent.
  const isPromotion = Boolean(anchorId && model && model.nodes.type[model.indexOfId.get(anchorId) ?? -1] === 1);
  const personScopeMemo = useMemo(
    () => (model && anchorId && !isPromotion ? personScope(model, anchorId) : null),
    [model, anchorId, isPromotion],
  );
  const [promoScope, setPromoScope] = useState<ArenaScope | null>(null);
  const [truncated, setTruncated] = useState(0);

  useEffect(() => {
    if (!model || !anchorId || !isPromotion) { setPromoScope(null); setTruncated(0); return; }
    let cancelled = false;
    void (async () => {
      const built = await promotionScope(model, anchorId, ARENA_TIERS[tier].cards);
      const left = await promotionTruncation(anchorId);
      if (cancelled) return;
      setPromoScope(built);
      setTruncated(left);
    })();
    return () => { cancelled = true; };
  }, [model, anchorId, isPromotion, tier]);

  const baseScope = isPromotion ? promoScope : personScopeMemo;
  // Drill-down is applied on top of the built scope rather than baked into it,
  // so collapsing is just forgetting an id and the underlying projection is
  // never re-fetched.
  const scope = useMemo(() => {
    let next = baseScope;
    for (const id of opened) {
      if (!next) break;
      next = expandAggregate(next, id) ?? next;
    }
    return next;
  }, [baseScope, opened]);

  useEffect(() => { setOpened([]); setBreadcrumb([]); setInspected(null); }, [baseScope]);

  const inspectedCard = inspected ? scope?.cards.find((c) => c.id === inspected) ?? null : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    const labels = labelRef.current;
    if (!canvas || !labels) return;
    const renderer = new ArenaRenderer(canvas, labels);
    rendererRef.current = renderer;
    // Reduced motion is a preference, not a performance tier: it shortens the
    // clock rather than degrading the scene.
    renderer.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The governor can drop the tier on its own; the control must follow it
    // rather than keep displaying a setting the renderer has abandoned.
    renderer.onTierChanged = (next) => setTier(next);
    renderer.start();
    const onResize = (): void => renderer.resize();
    window.addEventListener("resize", onResize);
    // Exposed for the QA probes, matching the __kayfabe* convention.
    (window as unknown as { __kayfabeArena?: ArenaRenderer }).__kayfabeArena = renderer;
    return () => {
      window.removeEventListener("resize", onResize);
      delete (window as unknown as { __kayfabeArena?: ArenaRenderer }).__kayfabeArena;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !scope) return;
    renderer.setScope(scope);
    renderer.setFormation(formation, true);
    announce(
      scope.kind === "promotion"
        ? `Arena Array: ${scope.anchorName}, ${scope.cards.length - 1} cards across its documented eras.`
        : `Arena Array: ${scope.anchorName}, ${scope.cards.length - 1} documented relationships.`,
    );
    // formation is intentionally not a dependency: changing scope should not
    // replay the assembly, and changing formation is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, announce]);

  useEffect(() => {
    rendererRef.current?.setFormation(formation);
  }, [formation]);

  // Publish what a shared link should carry, and consume one that arrived.
  useEffect(() => {
    setArenaUrlState({ formation, opened });
    writeUrl();
  }, [formation, opened]);

  useEffect(() => {
    if (!baseScope) return;
    const restored = takePendingArenaUrl();
    if (!restored) return;
    setFormation(restored.formation);
    setOpened(restored.opened);
    setBreadcrumb(restored.opened.map((id) => baseScope.cards.find((c) => c.id === id)?.name ?? id));
  }, [baseScope]);

  useEffect(() => {
    rendererRef.current?.applyTier(tier);
  }, [tier]);

  return (
    <div className="arena-lens">
      <canvas className="arena-gl" ref={canvasRef}
        onPointerMove={(e) => {
          const renderer = rendererRef.current;
          if (!renderer) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
          renderer.setHover(hit?.id ?? null);
          setHoverName(hit ? (scope?.cards.find((c) => c.id === hit.id)?.name ?? null) : null);
        }}
        onPointerLeave={() => { rendererRef.current?.setHover(null); setHoverName(null); }}
        onClick={(e) => {
          const renderer = rendererRef.current;
          if (!renderer) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
          if (!hit) { setInspected(null); return; }
          const card = scope?.cards.find((c) => c.id === hit.id);
          // Opening an aggregate is a different act from selecting a person:
          // one changes the represented population, the other changes emphasis.
          if (card && card.represents) {
            setOpened((prev) => (prev.includes(card.id) ? prev : [...prev, card.id]));
            setBreadcrumb((prev) => [...prev, card.name]);
            setInspected(null);
            return;
          }
          renderer.setSelected(hit.id);
          setInspected(hit.id);
        }}
      />
      <div className="arena-labels" ref={labelRef} />
      <div className="arena-controls">
        <div className="arena-formations" role="group" aria-label="Formation">
          {FORMATIONS.map((f) => (
            <button key={f.key} title={f.hint}
              className={formation === f.key ? "active" : ""}
              aria-pressed={formation === f.key}
              onClick={() => setFormation(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="arena-tier">
          Quality
          <select value={tier} onChange={(e) => setTier(e.target.value as ArenaQualityTier)}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>
      {breadcrumb.length > 0 && (
        <nav className="arena-crumbs" aria-label="Drill-down">
          <button onClick={() => { setOpened([]); setBreadcrumb([]); }}>All eras</button>
          {breadcrumb.map((label, i) => (
            <span key={`${label}-${i}`}> › {label}</span>
          ))}
        </nav>
      )}
      {inspectedCard && (
        <aside className="arena-inspector" aria-label="Card detail">
          <h2>{inspectedCard.name}</h2>
          <dl>
            <div><dt>Documented span</dt><dd>{inspectedCard.firstYear}–{inspectedCard.lastYear}</dd></div>
            <div>
              <dt>{scope?.kind === "promotion" ? "Matches here" : "Documented encounters"}</dt>
              <dd>{inspectedCard.strength}</dd>
            </div>
            <div><dt>Era</dt><dd>{inspectedCard.era}</dd></div>
            {inspectedCard.reigns > 0 && (
              <div><dt>Championships</dt><dd>{inspectedCard.reigns} documented reign(s)</dd></div>
            )}
          </dl>
          {/* What the number is, so a reader never has to guess its basis. */}
          <p className="arena-basis">
            {scope?.kind === "promotion"
              ? "Documented matches for this person in this promotion."
              : "Documented encounters with the subject: tag partnership, opposition, and battle-royal co-presence at reduced weight."}
          </p>
          <button onClick={() => setInspected(null)}>Close</button>
        </aside>
      )}
      {scope && (
        <div className="arena-readout">
          <strong>{scope.anchorName}</strong>
          <span>
            {scope.kind === "promotion"
              ? `${scope.cards.length - 1} cards across its documented eras`
              : `${scope.cards.length - 1} documented relationships`}
          </span>
          {/* A capped roster that reads as complete is a false claim. */}
          {truncated > 0 && (
            <span className="arena-caveat">
              {truncated} further documented people are not in this projection
            </span>
          )}
          {hoverName && <span className="arena-hover">{hoverName}</span>}
        </div>
      )}
      {!scope && (
        <div className="arena-readout">
          <span>Select a wrestler or a promotion to build an arena around them.</span>
        </div>
      )}
    </div>
  );
}
