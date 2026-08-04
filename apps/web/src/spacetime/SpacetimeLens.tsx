/**
 * The Kayfabe Spacetime / Warp Field lens shell.
 *
 * React owns mounting, subject resolution, the inspector copy and URL state.
 * The renderer package draws everything from typed arrays — the same division
 * every other lens in this repository uses. The shared timeline store drives
 * the playhead through an imperative subscription, never through per-frame
 * React renders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SPACETIME_TIERS, SpacetimeRenderer, WarpLookup,
  type SpacetimeMode, type SpacetimePickResult, type SpacetimeQualityTier,
  type SpacetimeScope,
} from "@kayfabe/spacetime-renderer";
import { pushUrl, useStore, writeUrl } from "../state/store";
import {
  canonicalSubjectOf, loadSpacetimeScope, loadWarpLookup, projectedSubjects,
} from "./spacetimeAdapter";
import { SpacetimeInspector, type Inspected } from "./SpacetimeInspector";
import {
  onSpacetimeUrlRestore, setSpacetimeUrlState, takePendingSpacetimeUrl,
} from "./spacetimeUrl";

export function SpacetimeLens(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<SpacetimeRenderer | null>(null);
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const announce = useStore((s) => s.announce);

  const [lut, setLut] = useState<WarpLookup | null>(null);
  const [scope, setScope] = useState<SpacetimeScope | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notProjected, setNotProjected] = useState<{ id: string; name: string } | null>(null);
  const [subjects, setSubjects] = useState<{ id: string; label: string }[]>([]);
  const [mode, setMode] = useState<SpacetimeMode>("exterior");
  const [tier, setTier] = useState<SpacetimeQualityTier>("high");
  const [hoverName, setHoverName] = useState<string | null>(null);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [urlEpoch, setUrlEpoch] = useState(0);
  const pendingUrlRef = useRef<ReturnType<typeof takePendingSpacetimeUrl>>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);

  const selectedNodeId = selection?.kind === "node" ? selection.id : null;

  // Open on something: the default subject is the first projected canonical
  // subject (Matt Sydal in the vertical slice).
  useEffect(() => {
    if (!model || selectedNodeId) return;
    void projectedSubjects().then((subs) => {
      const first = subs[0];
      if (first && !useStore.getState().selection) {
        select({ kind: "node", id: first.id });
      }
    });
  }, [model, selectedNodeId, select]);

  // Resolve whatever is selected to a canonical projected subject, or say
  // honestly that this person has no worldline projection yet.
  useEffect(() => {
    if (!model || !selectedNodeId || !selectedNodeId.startsWith("p:")) return;
    let cancelled = false;
    void (async () => {
      try {
        const canonical = await canonicalSubjectOf(selectedNodeId);
        if (cancelled) return;
        if (!canonical) {
          const i = model.indexOfId.get(selectedNodeId);
          setNotProjected({
            id: selectedNodeId,
            name: (i === undefined ? null : model.nodes.name[i]) ?? selectedNodeId,
          });
          setSubjects(await projectedSubjects());
          return;
        }
        setNotProjected(null);
        const [lookup, built] = await Promise.all([
          loadWarpLookup(),
          loadSpacetimeScope(canonical),
        ]);
        if (cancelled) return;
        setLut(lookup);
        setScope(built);
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [model, selectedNodeId]);

  // Mount the renderer once the lookup exists; dispose on unmount.
  useEffect(() => {
    const canvas = canvasRef.current;
    const labels = labelRef.current;
    if (!canvas || !labels || !lut || rendererRef.current) return;
    const renderer = new SpacetimeRenderer(canvas, labels, lut);
    rendererRef.current = renderer;
    renderer.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    renderer.onTierChanged = (next) => setTier(next);
    renderer.onToggleMode = () => setMode((m) => (m === "bridge" ? "exterior" : "bridge"));
    // The TimelineEngine's rAF loop starts from the bar's own button, so the
    // shortcut presses that button — the same route App's global Space handler
    // takes for the connectome. Setting the store flag alone plays nothing.
    renderer.onPlayPause = () => {
      document.querySelector<HTMLButtonElement>('[aria-label="Play"], [aria-label="Pause"]')?.click();
    };
    renderer.onTimeTravel = (deltaDays) => {
      const st = useStore.getState();
      const [d0, d1] = renderer.scope?.dayRange ?? [st.timeline.day, st.timeline.day];
      st.setTimeline({
        day: Math.min(Math.max(st.timeline.day + deltaDays, d0), d1),
        mode: st.timeline.mode === "off" ? "snapshot" : st.timeline.mode,
      });
    };
    renderer.start();
    const onResize = (): void => renderer.resize();
    window.addEventListener("resize", onResize);
    // Exposed for the QA probes, matching the __kayfabe* convention.
    (window as unknown as { __kayfabeSpacetime?: SpacetimeRenderer }).__kayfabeSpacetime = renderer;
    return () => {
      window.removeEventListener("resize", onResize);
      delete (window as unknown as { __kayfabeSpacetime?: SpacetimeRenderer }).__kayfabeSpacetime;
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [lut]);

  // Scope changes rebuild the field.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !scope) return;
    renderer.setScope(scope);
    const st = useStore.getState();
    renderer.setTimeline(st.timeline.day, st.timeline.playing, st.timeline.speed);
    const aliasNote = scope.personas.length > 1
      ? `, one canonical worldline across ${scope.personas.length} documented ring names`
      : "";
    announce(
      `Kayfabe Spacetime: ${scope.subjectLabel}, ${scope.events.length} documented matches`
      + `${aliasNote}.`,
    );
  }, [scope, announce]);

  // The shared timeline drives the playhead — imperative subscription, no
  // React re-render per playback frame.
  useEffect(() => {
    return useStore.subscribe((s, prev) => {
      if (s.timeline === prev.timeline) return;
      rendererRef.current?.setTimeline(s.timeline.day, s.timeline.playing, s.timeline.speed);
    });
  }, []);

  useEffect(() => {
    rendererRef.current?.setMode(mode);
    // Entering the bridge at the end of a career faces an empty sky — the
    // flight starts at the debut, with every documented match still ahead.
    if (mode === "bridge" && scope) {
      const st = useStore.getState();
      if (st.timeline.day >= scope.dayRange[1] - 1) {
        st.setTimeline({
          day: scope.dayRange[0],
          mode: st.timeline.mode === "off" ? "snapshot" : st.timeline.mode,
        });
      }
    }
  }, [mode, scope]);

  useEffect(() => {
    rendererRef.current?.applyTier(tier);
  }, [tier]);

  // URL restore: cold links and Back presses.
  useEffect(() => {
    onSpacetimeUrlRestore(() => setUrlEpoch((e) => e + 1));
    return () => onSpacetimeUrlRestore(null);
  }, []);
  useEffect(() => {
    if (!pendingUrlRef.current) pendingUrlRef.current = takePendingSpacetimeUrl();
    const restored = pendingUrlRef.current;
    if (!restored || !scope) return;
    if (restored.sel && restored.sel !== scope.subjectId) return; // wait for its subject
    pendingUrlRef.current = null;
    setMode(restored.mode);
    if (restored.inspectedEvent) {
      const idx = scope.events.findIndex((e) => e.matchRef === restored.inspectedEvent);
      if (idx >= 0) setInspected({ kind: "event", index: idx });
    } else if (restored.inspectedPerson) {
      const idx = scope.relationships.findIndex((r) => r.p === restored.inspectedPerson);
      if (idx >= 0) setInspected({ kind: "person", index: idx });
    } else {
      setInspected(null);
    }
  }, [scope, urlEpoch]);

  // Publish shareable state. Mode and inspection are ways of looking at the
  // same subject — replace, don't push (travel already pushes via select()).
  useEffect(() => {
    if (!scope) return;
    setSpacetimeUrlState({
      mode,
      inspectedEvent: inspected?.kind === "event"
        ? scope.events[inspected.index]?.matchRef ?? null : null,
      inspectedPerson: inspected?.kind === "person"
        ? scope.relationships[inspected.index]?.p ?? null : null,
    });
    writeUrl();
  }, [mode, inspected, scope]);

  // Selection/emphasis mirror into the renderer.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    if (!inspected) renderer.setSelected(null, null);
    else if (inspected.kind === "event") renderer.setSelected(null, inspected.index);
    else renderer.setSelected(inspected.index, null);
  }, [inspected, scope]);

  /** Follow a person out of this field: a deliberate move, so it earns a
   *  browser history entry (the arena rule). */
  const choose = useCallback((id: string) => {
    if (!id || id === scope?.subjectId) return;
    setInspected(null);
    select({ kind: "node", id });
    pushUrl();
  }, [scope, select]);

  const onPick = useCallback((hit: SpacetimePickResult | null, dbl: boolean) => {
    if (!hit) {
      setInspected(null);
      return;
    }
    if (hit.kind === "event") {
      setInspected({ kind: "event", index: hit.index });
      return;
    }
    if (hit.index === -1) {
      setInspected(null); // the subject's own line: nothing to compare against
      return;
    }
    if (dbl) choose(hit.id);
    else setInspected({ kind: "person", index: hit.index });
  }, [choose]);

  const hiddenCount = useMemo(
    () => (scope ? Math.max(0, scope.relationships.length - SPACETIME_TIERS[tier].worldlines) : 0),
    [scope, tier],
  );

  return (
    <div className="spacetime-lens">
      <canvas
        className="spacetime-gl"
        ref={canvasRef}
        onPointerDown={(e) => { pressRef.current = { x: e.clientX, y: e.clientY }; }}
        onPointerMove={(e) => {
          const renderer = rendererRef.current;
          if (!renderer || !scope) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const hit = renderer.pick(e.clientX - rect.left, e.clientY - rect.top);
          if (hit?.kind === "person" && hit.index >= 0) {
            renderer.setHover(hit.index);
            setHoverName(scope.relationships[hit.index]?.n ?? null);
          } else {
            renderer.setHover(null);
            setHoverName(hit?.kind === "event"
              ? scope.events[hit.index]?.eventName || "documented match" : null);
          }
        }}
        onPointerLeave={() => { rendererRef.current?.setHover(null); setHoverName(null); }}
        onClick={(e) => {
          const renderer = rendererRef.current;
          if (!renderer) return;
          // A drag is a camera move, not a selection (the arena guard).
          const press = pressRef.current;
          if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onPick(renderer.pick(e.clientX - rect.left, e.clientY - rect.top), false);
        }}
        onDoubleClick={(e) => {
          const renderer = rendererRef.current;
          if (!renderer) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onPick(renderer.pick(e.clientX - rect.left, e.clientY - rect.top), true);
        }}
      />
      <div className="spacetime-labels" ref={labelRef} />

      <div className="spacetime-controls">
        <div className="spacetime-modes" role="group" aria-label="Observer">
          <button
            className={mode === "exterior" ? "active" : ""}
            aria-pressed={mode === "exterior"}
            title="Worldlines from outside — X is calendar time, the bubble expands the playhead"
            onClick={() => setMode("exterior")}
          >
            Exterior
          </button>
          <button
            className={mode === "bridge" ? "active" : ""}
            aria-pressed={mode === "bridge"}
            title="Ride the career worldline — play the timeline to warp (B)"
            onClick={() => setMode("bridge")}
          >
            Bridge
          </button>
        </div>
        <label className="spacetime-tier">
          Quality
          <select value={tier} onChange={(e) => setTier(e.target.value as SpacetimeQualityTier)}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <span className="spacetime-keys micro" aria-hidden="true">
          B observer · U hold to unwarp · Space play · {mode === "bridge" ? "W/S time · A/D events" : "WASDQE walk"} · R reset
        </span>
      </div>

      {inspected && scope && model && (
        <SpacetimeInspector
          scope={scope}
          model={model}
          inspected={inspected}
          onClose={() => setInspected(null)}
          onChoose={choose}
          onTravel={(day) => {
            const st = useStore.getState();
            st.setTimeline({
              day,
              mode: st.timeline.mode === "off" ? "snapshot" : st.timeline.mode,
            });
          }}
        />
      )}

      {scope && (
        <div className="spacetime-readout">
          <strong>{scope.subjectLabel}</strong>
          <span className="num">{scope.events.length} documented matches</span>
          {scope.personas.length > 1 && (
            <span className="micro">
              one canonical worldline · {scope.personas.slice(1).map((p) => `competed as ${p.label}`).join(" · ")}
            </span>
          )}
          {hiddenCount > 0 && (
            <span className="spacetime-caveat">
              {hiddenCount} further documented relationships beyond the drawn budget
            </span>
          )}
          {hoverName && <span className="spacetime-hover">{hoverName}</span>}
        </div>
      )}

      {notProjected && (
        <div className="spacetime-empty">
          <p>
            <strong>{notProjected.name}</strong> has no spacetime projection yet — the warp
            field's vertical slice materializes curated subjects only, and inventing a
            worldline is exactly what this lens refuses to do.
          </p>
          {subjects.length > 0 && (
            <p>
              Projected subjects:{" "}
              {subjects.map((s) => (
                <button key={s.id} className="crumb" onClick={() => choose(s.id)}>{s.label}</button>
              ))}
            </p>
          )}
        </div>
      )}
      {loadError && (
        <div className="spacetime-empty" role="alert">
          <p>The spacetime projection failed to load: {loadError}</p>
          <p className="micro">run `pnpm spacetime:materialize`, then reload.</p>
        </div>
      )}
      {!scope && !notProjected && !loadError && (
        <div className="spacetime-empty"><p>Assembling the warp field…</p></div>
      )}
    </div>
  );
}
