import { useEffect, useRef, type FocusEvent, type RefObject } from "react";
import type { MorphRenderer } from "@kayfabe/morph-renderer";
import { useStore } from "../state/store";
import { describeHover } from "./MorphInspector";
import { useMorph } from "./morphStore";

/** Stable node-anchored actions. Position updates stay imperative during camera/morph motion. */
export function MorphHoverCard({ rendererRef }: { rendererRef: RefObject<MorphRenderer | null> }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const hoverId = useStore((s) => s.hoverId);
  const selection = useStore((s) => s.selection);
  const selectedId = selection?.kind === "node" ? selection.id : null;
  const pinned = useStore((s) => s.pinned);
  const pathA = useStore((s) => s.pathA);
  const pathB = useStore((s) => s.pathB);
  const data = useMorph((s) => s.data);
  const layout = useMorph((s) => s.layout);
  const sheet = useMorph((s) => s.sheet);
  const quadrant = useRef<{ id: string; x: -1 | 1; y: -1 | 1 } | null>(null);

  useEffect(() => {
    if (!hoverId || !cardRef.current) return;
    let raf = 0;
    const position = () => {
      const renderer = rendererRef.current;
      const card = cardRef.current;
      const point = renderer?.projectedNodeMetricsById(hoverId) ?? null;
      if (!renderer || !card) return;
      const hoverState = renderer.hover.snapshot();
      if (!point || hoverState.cameraDragging || hoverState.touchActive) {
        if (card) card.style.visibility = "hidden";
        raf = requestAnimationFrame(position);
        return;
      }
      const w = renderer.canvas.clientWidth || 2;
      const h = renderer.canvas.clientHeight || 2;
      const mobile = w <= 820;
      const left = mobile ? 8 : 312;
      const right = mobile ? w - 8 : w - 356;
      const top = 48;
      const activePanel = mobile && sheet !== "hidden"
        ? document.querySelector<HTMLElement>(sheet === "controls" ? "#morph-controls-panel" : "#morph-inspector-panel")
        : null;
      const canvasRect = renderer.canvas.getBoundingClientRect();
      const panelRect = activePanel?.getBoundingClientRect();
      const bottom = panelRect ? Math.max(top + 80, panelRect.top - canvasRect.top - 8) : h - 10;
      const cw = Math.min(card.offsetWidth || 286, Math.max(80, right - left));
      const ch = Math.min(card.offsetHeight || 190, Math.max(80, bottom - top));
      if (!quadrant.current || quadrant.current.id !== hoverId) {
        const label = document.querySelector<HTMLElement>(`.mlabel[data-morph-id="${CSS.escape(hoverId)}"]`);
        const labelRect = label?.getBoundingClientRect();
        const source = labelRect ? {
          left: labelRect.left - canvasRect.left - 8,
          right: labelRect.right - canvasRect.left + 8,
          top: labelRect.top - canvasRect.top - 8,
          bottom: labelRect.bottom - canvasRect.top + 46,
        } : null;
        const nodeOffset = Math.max(22, point.pointSizePx * 0.5 + 12);
        const outwardX: -1 | 1 = point.x < (left + right) * 0.5 ? -1 : 1;
        const outwardY: -1 | 1 = point.y < (top + bottom) * 0.5 ? -1 : 1;
        const choices = ([1, -1] as const).flatMap((x) => ([1, -1] as const).map((y) => {
          const rawX = x > 0 ? point.x + nodeOffset : point.x - cw - nodeOffset;
          const rawY = y > 0 ? point.y + nodeOffset : point.y - ch - nodeOffset;
          const cx = Math.max(left, Math.min(right - cw, rawX));
          const cy = Math.max(top, Math.min(bottom - ch, rawY));
          const overlap = source && cx < source.right && cx + cw > source.left && cy < source.bottom && cy + ch > source.top;
          const clampCost = Math.abs(cx - rawX) + Math.abs(cy - rawY);
          const roomBias = (x > 0 ? right - point.x : point.x - left) + (y > 0 ? bottom - point.y : point.y - top);
          // Spatial boards concentrate their evidence around the selected
          // core. Prefer the outward quadrant unless rails or the source label
          // make it unusable, keeping the card off the routes it explains.
          const inwardCost = (x === outwardX ? 0 : 14_000) + (y === outwardY ? 0 : 2_500);
          return { x, y, score: (overlap ? 100_000 : 0) + clampCost * 100 + inwardCost - roomBias };
        }));
        choices.sort((a, b) => a.score - b.score || b.x - a.x || b.y - a.y);
        quadrant.current = { id: hoverId, x: choices[0]!.x, y: choices[0]!.y };
      }
      const q = quadrant.current;
      const nodeOffset = Math.max(22, point.pointSizePx * 0.5 + 12);
      let x = q.x > 0 ? point.x + nodeOffset : point.x - cw - nodeOffset;
      let y = q.y > 0 ? point.y + nodeOffset : point.y - ch - nodeOffset;
      x = Math.max(left, Math.min(right - cw, x));
      y = Math.max(top, Math.min(bottom - ch, y));
      card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      card.style.visibility = "visible";
      raf = requestAnimationFrame(position);
    };
    raf = requestAnimationFrame(position);
    return () => cancelAnimationFrame(raf);
  }, [hoverId, rendererRef, sheet]);

  if (!hoverId || !data) return null;
  const info = describeHover(hoverId, selectedId, data, layout);
  const isPinned = pinned.includes(hoverId);
  const leaveKeyboard = (event?: FocusEvent<HTMLDivElement>) => {
    if (event?.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    rendererRef.current?.hover.leaveSurface("keyboard", hoverId);
  };
  const shared = () => useStore.getState();
  const select = () => {
    useMorph.getState().leaveTissue();
    shared().select({ kind: "node", id: hoverId });
  };

  return (
    <div
      ref={cardRef}
      className="morph-hover-card"
      data-morph-id={hoverId}
      role="group"
      aria-label={`Actions and evidence for ${info.name}`}
      onPointerEnter={() => rendererRef.current?.hover.enterSurface("card", hoverId)}
      onPointerLeave={() => rendererRef.current?.hover.leaveSurface("card", hoverId)}
      onFocus={() => rendererRef.current?.hover.enterSurface("keyboard", hoverId)}
      onBlur={leaveKeyboard}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="morph-hover-card-heading">
        <strong>{info.name}</strong><span>{info.type}</span>
      </div>
      <p className="morph-hover-why">{info.why}</p>
      {info.evidence.map((line) => <p key={line} className="micro">{line}</p>)}
      {info.caveat ? <p className="micro morph-hover-caveat">{info.caveat}</p> : null}
      <div className="morph-hover-actions" aria-label={`Actions for ${info.name}`}>
        <button type="button" onClick={select}>{layout?.mode === "orbit" && hoverId.startsWith("p:") ? "Select / Recenter" : "Select"}</button>
        <button type="button" onClick={() => rendererRef.current?.focusId(hoverId)}>Focus</button>
        <button type="button" aria-pressed={isPinned} onClick={() => shared().togglePin(hoverId)}>{isPinned ? "Unpin" : "Pin"}</button>
        {hoverId.startsWith("p:") ? (
          <>
            <button type="button" aria-pressed={pathA === hoverId} onClick={() => shared().setPathEndpoint("a", pathA === hoverId ? null : hoverId)}>Set comparison A</button>
            <button type="button" aria-pressed={pathB === hoverId} onClick={() => shared().setPathEndpoint("b", pathB === hoverId ? null : hoverId)}>Set comparison B</button>
          </>
        ) : null}
        <button type="button" onClick={() => {
          shared().select({ kind: "node", id: hoverId });
          shared().setLens("connectome");
          if (shared().model?.indexOfId.has(hoverId)) shared().focus(hoverId);
        }}>Open in Connectome</button>
      </div>
    </div>
  );
}
