/**
 * The Arena Array lens shell.
 *
 * React owns mounting, the scope and the inspector copy. It never owns a card:
 * the renderer package draws the whole population from typed arrays, which is
 * the same division every other lens in this repository uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARENA_TIERS, ArenaRenderer,
  type ArenaFormation, type ArenaQualityTier, type ArenaScope,
} from "@kayfabe/arena-renderer";
import { pushUrl, useStore, writeUrl } from "../state/store";
import { ArenaInspector } from "./ArenaInspector";
import { defaultAnchorId, expandAggregate, personScope, promotionScope, promotionTruncation } from "./arenaAdapter";
import { onArenaUrlRestore, setArenaUrlState, takePendingArenaUrl } from "./arenaUrl";

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
  /** Subjects visited in this lens, oldest first. Following someone out of an
   *  arena is the whole point of the lens, so where you came from has to stay
   *  on screen — a Back button alone tells you nothing about where back IS. */
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  /** Bumped whenever a fragment arrives, so the restore effect re-runs for a
   *  Back press that lands on the SAME subject with a different drill-down. */
  const [urlEpoch, setUrlEpoch] = useState(0);
  const pendingUrlRef = useRef<ReturnType<typeof takePendingArenaUrl>>(null);
  /** The drill-down the address bar already reflects. A change the reader made
   *  is navigation and earns a history entry; a change that CAME from the
   *  address bar must not push one, or pressing Back appends a new entry and
   *  the reader can never leave. */
  const lastOpenedKey = useRef("");
  const pressRef = useRef<{ x: number; y: number } | null>(null);

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

  // One effect owns both halves of "the subject changed": clearing the previous
  // drill-down, and applying one that arrived in the URL. They were two effects
  // and the clear could run last, which silently threw away a restored link.
  useEffect(() => {
    if (!pendingUrlRef.current) pendingUrlRef.current = takePendingArenaUrl();
    const restored = pendingUrlRef.current;
    setInspected(null);
    // A fragment names its subject. Holding the drill-down until the scope for
    // that subject exists keeps a link from opening one person's era summaries
    // on top of another person's arena.
    const forThisSubject = restored && (!restored.sel || restored.sel === anchorId);
    if (restored && forThisSubject) {
      pendingUrlRef.current = null;
      lastOpenedKey.current = restored.opened.join(",");
      setFormation(restored.formation);
      setOpened(restored.opened);
      setBreadcrumb(restored.opened.map((id) => baseScope?.cards.find((c) => c.id === id)?.name ?? id));
      return;
    }
    lastOpenedKey.current = "";
    setOpened([]);
    setBreadcrumb([]);
  }, [baseScope, anchorId, urlEpoch]);

  // A pasted or Back-navigated fragment reaches an already-mounted lens.
  useEffect(() => {
    onArenaUrlRestore(() => setUrlEpoch((e) => e + 1));
    return () => onArenaUrlRestore(null);
  }, []);

  // The trail follows the subject rather than being pushed by the click that
  // changed it, so browser Back and Forward heal it for free: returning to a
  // subject already on the trail truncates back to it instead of repeating it.
  useEffect(() => {
    if (!anchorId || !model) return;
    const i = model.indexOfId.get(anchorId);
    const name = (i === undefined ? null : model.nodes.name[i]) ?? anchorId;
    setTrail((prev) => {
      const at = prev.findIndex((t) => t.id === anchorId);
      if (at >= 0) return at === prev.length - 1 ? prev : prev.slice(0, at + 1);
      return [...prev, { id: anchorId, name }].slice(-16);
    });
  }, [anchorId, model]);

  /** Follow a card to its own arena. A deliberate move, so it gets a history
   *  entry and the browser's Back button returns here. */
  const openArray = useCallback((id: string) => {
    if (!id || id === anchorId) return;
    setInspected(null);
    select({ kind: "node", id });
    pushUrl();
  }, [anchorId, select]);

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

  // Publish what a shared link should carry. Entering or leaving a drill-down
  // is somewhere the reader went, so it earns a history entry; changing the
  // formation is a way of looking at where they already are, so it does not.
  const openedKey = opened.join(",");
  useEffect(() => {
    setArenaUrlState({ formation, opened });
    if (openedKey !== lastOpenedKey.current) {
      lastOpenedKey.current = openedKey;
      pushUrl();
    } else {
      writeUrl();
    }
  }, [formation, opened, openedKey]);

  useEffect(() => {
    rendererRef.current?.applyTier(tier);
  }, [tier]);

  return (
    <div className="arena-lens">
      <canvas className="arena-gl" ref={canvasRef}
        onPointerDown={(e) => { pressRef.current = { x: e.clientX, y: e.clientY }; }}
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
          // A drag is a camera move, not a selection. Without this, orbiting
          // the arena opens an inspector for whatever card the pointer landed
          // on, which is both wrong and startling.
          const press = pressRef.current;
          if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
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
        onDoubleClick={(e) => {
          // A shortcut for the inspector's own action, for readers who are
          // travelling rather than reading.
          const renderer = rendererRef.current;
          if (!renderer) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
          const card = hit ? scope?.cards.find((c) => c.id === hit.id) : null;
          if (card && !card.represents && card.id.startsWith("p:")) openArray(card.id);
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
      <nav className="arena-trail" aria-label="Subjects visited">
        <button
          className="arena-back"
          // The browser owns the history: every deliberate move pushed an entry,
          // so this is the same step the Back button takes. Keeping one history
          // instead of a parallel one is why Back and this button can never
          // disagree about where back is.
          onClick={() => history.back()}
          disabled={trail.length < 2}
          aria-label="Back to the previous subject"
        >
          ‹ Back
        </button>
        {trail.map((t, i) => (
          <span key={`${t.id}-${i}`} className="arena-trail-step">
            {i > 0 && <span className="sep"> › </span>}
            {i === trail.length - 1 ? (
              <span className="here" aria-current="page">{t.name}</span>
            ) : (
              <button className="crumb" onClick={() => openArray(t.id)}>{t.name}</button>
            )}
          </span>
        ))}
      </nav>
      {breadcrumb.length > 0 && (
        <nav className="arena-crumbs" aria-label="Drill-down">
          <button onClick={() => { setOpened([]); setBreadcrumb([]); }}>All eras</button>
          {breadcrumb.map((label, i) => (
            <span key={`${label}-${i}`}> › {label}</span>
          ))}
        </nav>
      )}
      {inspectedCard && (
        <ArenaInspector
          card={inspectedCard}
          scope={scope}
          onClose={() => setInspected(null)}
          onOpenArray={openArray}
        />
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
