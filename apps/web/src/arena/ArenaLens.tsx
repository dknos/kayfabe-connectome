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
import { useStore } from "../state/store";
import { personScope, promotionScope, promotionTruncation } from "./arenaAdapter";

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

  const anchorId = selection?.kind === "node" ? selection.id : null;
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

  const scope = isPromotion ? promoScope : personScopeMemo;

  useEffect(() => {
    const canvas = canvasRef.current;
    const labels = labelRef.current;
    if (!canvas || !labels) return;
    const renderer = new ArenaRenderer(canvas, labels);
    rendererRef.current = renderer;
    // Reduced motion is a preference, not a performance tier: it shortens the
    // clock rather than degrading the scene.
    renderer.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
          if (hit) renderer.setSelected(hit.id);
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
