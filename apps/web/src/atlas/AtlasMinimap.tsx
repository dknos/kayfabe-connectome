import { useEffect, useRef } from "react";
import type { AtlasRenderer } from "@kayfabe/atlas-renderer";
import { useStore } from "../state/store";
import { useAtlas } from "./atlasStore";

/**
 * The overview minimap.
 *
 * 571 lanes do not fit on a screen at a readable scale, so without this the
 * reader has no way to know how much board is off screen or where they are in
 * it — which turns "every promotion is represented" into a claim they have to
 * take on trust. It draws every lane, the current camera window, the selection
 * and the playhead, and clicking it moves the camera there.
 */
export function AtlasMinimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const scene = useAtlas((s) => s.scene);
  const camera = useAtlas((s) => s.camera);
  const selection = useStore((s) => s.selection);
  const timeline = useStore((s) => s.timeline);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !scene) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const b = scene.bounds;
    const sx = (x: number) => ((x - b.minX) / Math.max(1e-6, b.maxX - b.minX)) * w;
    const sy = (y: number) => ((b.maxY - y) / Math.max(1e-6, b.maxY - b.minY)) * h;

    ctx.fillStyle = "rgba(10,15,24,0.9)";
    ctx.fillRect(0, 0, w, h);

    // Each lane draws its documented SPAN, not a full-width bar. Full-width
    // bars at 571 lanes and 0.3 px per lane integrate into one grey slab that
    // says nothing; spans reproduce the cascade of promotions entering history
    // decade by decade, which is the shape the board is actually in.
    const selId = selection?.kind === "node" ? selection.id : null;
    let lastGroup = "";
    for (const lane of scene.lanes) {
      const y = sy(lane.y);
      const hh = Math.max(0.8, (lane.half * 2 * h) / Math.max(1e-6, b.maxY - b.minY));
      const sel = lane.key === selId;
      const wt = lane.weight ?? 0.5;
      ctx.fillStyle = sel
        ? "#ffffff"
        : lane.tone === "gold"
          ? `rgba(255,209,102,${0.35 + wt * 0.5})`
          : lane.tone === "warn"
            ? "rgba(179,172,111,0.7)"
            : `rgba(140,190,240,${0.25 + wt * 0.6})`;
      const x0 = lane.x0 !== undefined ? Math.max(2, sx(lane.x0)) : 4;
      const x1 = lane.x1 !== undefined ? Math.min(w - 2, sx(lane.x1)) : w - 4;
      ctx.fillRect(x0, y - hh / 2, Math.max(sel ? 2 : 1, x1 - x0), Math.max(0.8, hh * 0.75));
      if (lane.group && lane.group !== lastGroup) {
        lastGroup = lane.group;
        ctx.fillStyle = "rgba(90,104,128,0.6)";
        ctx.fillRect(0, y - hh, w, 0.5);
      }
    }

    if (timeline.mode !== "off") {
      const x = sx(scene.axis.x(timeline.day));
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.fillRect(x, 0, 1, h);
    }

    if (camera) {
      const aspect = 16 / 9;
      const hw = camera.half * aspect;
      const x0 = sx(camera.cx - hw);
      const x1 = sx(camera.cx + hw);
      const y0 = sy(camera.cy + camera.half);
      const y1 = sy(camera.cy - camera.half);
      ctx.strokeStyle = "rgba(63,211,255,0.9)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.max(0.5, x0),
        Math.max(0.5, y0),
        Math.min(w - 1, x1 - x0),
        Math.min(h - 1, y1 - y0),
      );
    }
  }, [scene, camera, selection, timeline.mode, timeline.day]);

  if (!scene) return null;

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = (window as { __kayfabeAtlas?: AtlasRenderer }).__kayfabeAtlas;
    if (!r || !scene) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const b = scene.bounds;
    r.cam.centerOn(b.minX + fx * (b.maxX - b.minX), b.maxY - fy * (b.maxY - b.minY), 0.4);
  };

  return (
    <div className="atlas-minimap" aria-hidden="true">
      <canvas ref={ref} onPointerDown={jump} data-testid="atlas-minimap" />
      <div className="micro">{scene.lanes.length.toLocaleString()} lanes</div>
    </div>
  );
}
