import { useEffect, useMemo, useRef } from "react";
import type { MatchMoment } from "@kayfabe/sim-contract";

/**
 * The arena, drawn: a ring, and a crowd whose density is the night's real
 * attendance against the building's capacity. Wrestler tokens act out the
 * current match-engine beat. Canvas 2D, no libraries, honors
 * prefers-reduced-motion (static poses, no flicker).
 */

export interface RingSide {
  label: string;
  initials: string;
}

interface Props {
  sides: RingSide[];
  moment: MatchMoment | null;
  attendance: number;
  capacity: number;
}

const W = 880;
const H = 430;
const SIDE_COLORS = ["#8b1e2d", "#1e3a6b", "#2f6b3a", "#8a6d1f"];

interface Seat {
  x: number;
  y: number;
  r: number;
  order: number;
}

function buildSeats(capacity: number): Seat[] {
  // Bowl rows around the top half; row count scales with the building.
  const rows = Math.max(4, Math.min(9, Math.round(Math.log2(Math.max(200, capacity)) - 4)));
  const seats: Seat[] = [];
  let order = 0;
  for (let r = 0; r < rows; r++) {
    const y = 178 - r * 19;
    const halfWidth = 320 + r * 34;
    const n = Math.floor(halfWidth / 8.2);
    for (let i = 0; i < n; i++) {
      const x = W / 2 - halfWidth + (i * 2 * halfWidth) / (n - 1);
      // Skew the fill order so front rows and center sections fill first.
      const centerBias = Math.abs(x - W / 2) / halfWidth;
      seats.push({ x, y: y + centerBias * 6, r: 2.1 + (rows - r) * 0.16, order: order + r * 900 + centerBias * 400 });
      order += 1;
    }
  }
  return seats.sort((a, b) => a.order - b.order);
}

/** Token target poses per beat kind: [x, y, flat?] for actor and others. */
function poses(kind: MatchMoment["kind"] | "idle", actorSide: number, nSides: number): { x: number; y: number; flat: boolean; lift: number }[] {
  const cx = W / 2;
  const cy = 318;
  const spread = 64;
  const base = Array.from({ length: nSides }, (_, s) => ({
    x: cx + (s - (nSides - 1) / 2) * spread,
    y: cy,
    flat: false,
    lift: 0,
  }));
  const other = (s: number): number => (s === actorSide ? (actorSide + 1) % nSides : s);
  switch (kind) {
    case "entrance":
      base.forEach((p, s) => {
        if (s === actorSide) {
          p.x = W - 90;
          p.y = 250;
        }
      });
      return base;
    case "lockup":
      base.forEach((p, s) => {
        p.x = cx + (s - (nSides - 1) / 2) * 26;
      });
      return base;
    case "control":
    case "cutoff":
      base.forEach((p, s) => {
        if (s === actorSide) {
          p.x = cx - 12;
        } else if (s === other(actorSide)) {
          p.x = cx + 26;
          p.flat = true;
        }
      });
      return base;
    case "comeback":
      base.forEach((p, s) => {
        if (s === actorSide) {
          p.x = cx;
          p.lift = 6;
        } else {
          p.x = cx + (s > actorSide ? 66 : -66);
        }
      });
      return base;
    case "highspot":
      base.forEach((p, s) => {
        if (s === actorSide) {
          p.x = cx - 8;
          p.lift = 46;
        } else if (s === other(actorSide)) {
          p.x = cx + 18;
          p.flat = true;
        }
      });
      return base;
    case "nearfall":
    case "finish":
      base.forEach((p, s) => {
        if (s === actorSide) {
          p.x = cx - 6;
          p.y = cy + 6;
        } else if (s === other(actorSide)) {
          p.x = cx + 14;
          p.y = cy + 10;
          p.flat = true;
        }
      });
      return base;
    default:
      return base;
  }
}

export function RingScene({ sides, moment, attendance, capacity }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const currentPos = useRef<{ x: number; y: number; flat: number; lift: number }[]>([]);
  const seats = useMemo(() => buildSeats(capacity), [capacity]);
  const reduced = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nSides = Math.max(2, sides.length);
    const kind = moment?.kind ?? "idle";
    const actorSide = moment?.side ?? 0;
    const heat = moment?.heat ?? 30;
    const targets = poses(kind, actorSide, nSides);
    if (currentPos.current.length !== nSides) {
      currentPos.current = targets.map((t) => ({ x: t.x, y: t.y, flat: t.flat ? 1 : 0, lift: t.lift }));
    }

    const filled = Math.round(seats.length * Math.min(1, capacity === 0 ? 0 : attendance / capacity));
    let frame = 0;

    const draw = (): void => {
      frame += 1;
      // House.
      ctx.fillStyle = "#171410";
      ctx.fillRect(0, 0, W, H);
      // Hard camera light pool over the ring.
      const glow = ctx.createRadialGradient(W / 2, 300, 30, W / 2, 300, 330);
      glow.addColorStop(0, "rgba(245,238,220,0.16)");
      glow.addColorStop(1, "rgba(245,238,220,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // Crowd: filled seats warm, empty seats dead; hot moments raise arms.
      const excited = reduced ? 0 : Math.round((filled * heat) / 260);
      for (let i = 0; i < seats.length; i++) {
        const s = seats[i]!;
        const isFilled = i < filled;
        if (!isFilled) {
          ctx.fillStyle = "#2a251d";
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        const pop = !reduced && (i * 2654435761 + frame * 7) % 997 < excited;
        ctx.fillStyle = pop ? "#f0e2be" : i % 5 === 0 ? "#c9b98f" : "#a89772";
        ctx.beginPath();
        ctx.arc(s.x, s.y - (pop ? 3 : 0), s.r + (pop ? 0.7 : 0), 0, Math.PI * 2);
        ctx.fill();
      }

      // Ring: apron, mat, posts, ropes.
      const cx = W / 2;
      ctx.fillStyle = "#241f18";
      ctx.beginPath();
      ctx.moveTo(cx - 210, 372);
      ctx.lineTo(cx + 210, 372);
      ctx.lineTo(cx + 168, 262);
      ctx.lineTo(cx - 168, 262);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#d8d2c2";
      ctx.beginPath();
      ctx.moveTo(cx - 186, 356);
      ctx.lineTo(cx + 186, 356);
      ctx.lineTo(cx + 152, 268);
      ctx.lineTo(cx - 152, 268);
      ctx.closePath();
      ctx.fill();
      // Posts + ropes.
      const posts: [number, number][] = [
        [cx - 186, 356],
        [cx + 186, 356],
        [cx + 152, 268],
        [cx - 152, 268],
      ];
      for (const [px, py] of posts) {
        ctx.fillStyle = "#8b1e2d";
        ctx.fillRect(px - 3, py - 46, 6, 46);
      }
      ctx.strokeStyle = "#9c2434";
      ctx.lineWidth = 2;
      for (let ropeI = 1; ropeI <= 3; ropeI++) {
        const ry = 12 * ropeI;
        ctx.beginPath();
        ctx.moveTo(posts[0]![0], posts[0]![1] - ry);
        ctx.lineTo(posts[1]![0], posts[1]![1] - ry);
        ctx.moveTo(posts[3]![0], posts[3]![1] - ry);
        ctx.lineTo(posts[2]![0], posts[2]![1] - ry);
        ctx.moveTo(posts[0]![0], posts[0]![1] - ry);
        ctx.lineTo(posts[3]![0], posts[3]![1] - ry);
        ctx.moveTo(posts[1]![0], posts[1]![1] - ry);
        ctx.lineTo(posts[2]![0], posts[2]![1] - ry);
        ctx.stroke();
      }

      // Wrestler tokens ease toward their pose.
      for (let s = 0; s < nSides; s++) {
        const cur = currentPos.current[s]!;
        const tgt = targets[s]!;
        const ease = reduced ? 1 : 0.14;
        cur.x += (tgt.x - cur.x) * ease;
        cur.y += (tgt.y - cur.y) * ease;
        cur.lift += (tgt.lift - cur.lift) * ease;
        cur.flat += ((tgt.flat ? 1 : 0) - cur.flat) * ease;

        const color = SIDE_COLORS[s % SIDE_COLORS.length]!;
        const y = cur.y - cur.lift;
        ctx.save();
        ctx.translate(cur.x, y);
        ctx.scale(1 + cur.flat * 0.45, 1 - cur.flat * 0.55);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, 17, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#f5f2ea";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = "#f5f2ea";
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(sides[s]?.initials ?? "?", cur.x, y + 4);
        // High spots read as air.
        if (cur.lift > 8) {
          ctx.strokeStyle = "rgba(245,242,234,0.5)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cur.x - 10, y + 24);
          ctx.lineTo(cur.x + 10, y + 24);
          ctx.stroke();
        }
      }

      // Referee's count on near-falls / pin finishes.
      if ((kind === "nearfall" || (kind === "finish" && moment?.description.includes("THREE"))) && !reduced) {
        const count = kind === "finish" ? 3 : Math.min(2, 1 + Math.floor((frame % 90) / 45));
        ctx.fillStyle = "#f0e2be";
        ctx.font = "700 30px Iowan Old Style, Georgia, serif";
        for (let c = 1; c <= count; c++) {
          ctx.fillText(String(c), cx - 40 + c * 26, 232);
        }
      }

      if (!reduced) animRef.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animRef.current);
  }, [sides, moment, attendance, capacity, seats, reduced]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="ring-scene"
      width={W}
      height={H}
      style={{ width: "100%", maxWidth: W, borderRadius: 4, border: "1px solid var(--line-strong)", display: "block", margin: "0 auto" }}
      aria-label={moment ? moment.description : "The arena"}
    />
  );
}
