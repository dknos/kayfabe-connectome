/**
 * The camera director.
 *
 * A small set of named viewpoints over the top of ArenaControls, each solved
 * from the CONTENT rather than from a stored pose — an arena with 382
 * opponents and one with 31 are different rooms, and a fixed camera that
 * frames one cuts the other off.
 *
 * Three rules the brief sets, and how each is kept:
 *
 * **Manual input cancels direction immediately.** ArenaControls bumps
 * `userInputSeq` on every deliberate reader action and never on a directed
 * move. The director records the counter when it starts and abandons the move
 * the moment it differs, so a drag mid-move wins without the two fighting.
 *
 * **No instant cuts.** Every move goes through `controls.moveTo`, which writes
 * only the spherical GOALS and lets the existing damping carry it. SPIKE 1
 * measured what a cut costs: a tracked card jumps 0.786 NDC in one frame
 * against a 0.0003 ordinary step.
 *
 * **No control silently does nothing.** A preset that the current scope cannot
 * honour — the championship rail when the corpus documents no title activity —
 * reports a REASON instead of quietly not moving. The lens surfaces it.
 */
import { Vector3 } from "three";
import type { ArenaControls } from "./ArenaControls";
import type { ArenaFormation, ArenaLayoutResult } from "./types";
import { seatX, seatZ } from "./ArenaStadiumKit";
import { SEAT_INNER_RADIUS } from "./types";

/** Innermost seated row — where a section wedge begins. */
const SECTION_INNER = SEAT_INNER_RADIUS;

/**
 * Centre stage, as a volume.
 *
 * Mirrors ArenaStage and ArenaScoreboard. Duplicated deliberately rather than
 * imported: the director must frame what is THERE, and importing the builders
 * to ask would couple viewpoint solving to geometry construction. The QA probe
 * checks the board is actually in frame, so a drift here is caught rather than
 * merely commented against.
 */
const RING_HALF = 3.0;
const RING_TOP_Y = -1.33;
const BOARD_HALF_W = 3.9;
const BOARD_TOP_Y = 7.1 + 1.95;
const BOARD_BOTTOM_Y = 7.1 - 1.95;

/** What the director needs to know to solve a viewpoint. */
export interface ArenaDirectorContext {
  anchorId: string | null;
  selectedId: string | null;
  hoverId: string | null;
  formation: ArenaFormation;
  layout: ArenaLayoutResult | null;
  /** false when the corpus documents no title activity for this scope */
  hasRail: boolean;
  cardPoints(match: (id: string) => boolean): { points: Float32Array; count: number; center: Vector3 };
  solveFraming(
    points: Float32Array, count: number, target: Vector3, dir: Vector3,
    margin?: number, occlusion?: { x?: number; y?: number },
  ): { position: Vector3; target: Vector3 };
  setFormation(formation: ArenaFormation): void;
}

export interface ArenaPresetResult {
  ok: boolean;
  /** Present when ok is false: why this viewpoint does not exist right now. */
  reason?: string;
}

export type ArenaPresetKey =
  | "establishing" | "ring" | "section" | "relationship"
  | "headToHead" | "rail" | "index";

interface Preset {
  key: ArenaPresetKey;
  digit: number;
  label: string;
  hint: string;
}

/**
 * The presets, in key order. Every one of these is implemented — the brief
 * forbids dead controls, so a viewpoint appears here only once it works.
 */
export const ARENA_PRESETS: readonly Preset[] = [
  { key: "establishing", digit: 1, label: "Establishing", hint: "the whole arena" },
  { key: "ring", digit: 2, label: "Ring", hint: "centre stage and the scoreboard" },
  { key: "section", digit: 3, label: "Section", hint: "the active section" },
  { key: "relationship", digit: 4, label: "Relationship", hint: "subject to selected card" },
  { key: "headToHead", digit: 5, label: "Head to head", hint: "the pair, close" },
  { key: "rail", digit: 6, label: "Championship rail", hint: "documented title activity" },
  { key: "index", digit: 7, label: "Index wall", hint: "the complete set" },
];

/** Viewing angles per preset, as a direction from target to camera. Distance
 *  is always solved from content; only the ANGLE is editorial. */
const ANGLE: Record<ArenaPresetKey, readonly [number, number, number]> = {
  establishing: [0, 7.5, 21],
  ring: [0, 3.4, 13],
  section: [0, 5.0, 15],
  relationship: [0, 5.5, 17],
  headToHead: [0, 2.6, 12],
  rail: [0, 6.5, 14],
  index: [0, -8, 26],
};

export class ArenaCameraDirector {
  /** The preset the reader last asked for, or null once they took the camera. */
  active: ArenaPresetKey | null = null;
  /** Set false to stop the director proposing moves of its own. */
  enabled = true;

  /**
   * Fraction of the frame covered by interface chrome, so a focused card is
   * not framed underneath the inspector. Set by the lens, which is the only
   * thing that knows what is currently open.
   */
  occlusion: { x: number; y: number } = { x: 0, y: 0 };

  private inputSeqAtStart = -1;
  private lastResult: ArenaPresetResult = { ok: true };

  constructor(
    private readonly controls: ArenaControls,
    private readonly context: () => ArenaDirectorContext,
  ) {}

  /** True while a directed move is still the reader's last camera instruction. */
  get directing(): boolean {
    return this.active !== null && this.controls.userInputSeq === this.inputSeqAtStart;
  }

  /** Why the last preset request was refused, if it was. */
  get refusal(): string | null {
    return this.lastResult.ok ? null : this.lastResult.reason ?? "unavailable";
  }

  /**
   * Route a key press.
   *
   * Returns true if the key meant something here, so the caller can tell a
   * handled action from an ignored keystroke. ArenaControls has already
   * applied the typing and modifier guards.
   */
  handleKey(key: string): boolean {
    const preset = ARENA_PRESETS.find((p) => String(p.digit) === key);
    if (preset) { this.apply(preset.key); return true; }
    switch (key) {
      case "f": this.apply("relationship"); return true;
      case "r": this.reset(); return true;
      case "home": this.apply("ring"); return true;
      case "c": this.enabled = !this.enabled; return true;
      default: return false;
    }
  }

  /** Give the camera back to the formation. */
  reset(): void {
    this.active = null;
    this.controls.reset();
  }

  /**
   * Move to a preset, or report why it does not exist for this scope.
   */
  apply(key: ArenaPresetKey): ArenaPresetResult {
    const ctx = this.context();
    const result = this.solve(key, ctx);
    this.lastResult = result;
    if (!result.ok) return result;
    this.active = key;
    // Record the input counter AFTER the move is issued: moveTo does not bump
    // it, so any later change is the reader and cancels this move.
    this.inputSeqAtStart = this.controls.userInputSeq;
    return result;
  }

  /** The reader moved the camera; stop claiming a preset is active. */
  noticeUserInput(): void {
    if (this.active !== null && this.controls.userInputSeq !== this.inputSeqAtStart) {
      this.active = null;
    }
  }

  private move(pose: { position: Vector3; target: Vector3 }, extent: number): void {
    // Never below the floor. ArenaControls clamps the polar angle, but a
    // solved target that sits under the stage would tilt the whole frame into
    // the underside of it.
    const target = pose.target.clone();
    if (target.y < -1.6) target.y = -1.6;
    this.controls.moveTo(pose.position, target, extent);
  }

  private solve(key: ArenaPresetKey, ctx: ArenaDirectorContext): ArenaPresetResult {
    const extent = ctx.layout?.extent ?? 12;
    const dirOf = (k: ArenaPresetKey): Vector3 => {
      const a = ANGLE[k];
      const v = new Vector3(a[0], a[1], a[2]);
      return v.lengthSq() < 1e-8 ? new Vector3(0, 0, 1) : v.normalize();
    };

    switch (key) {
      case "establishing": {
        // Everything seated, framed exactly the way the formation would.
        const all = ctx.cardPoints(() => true);
        if (all.count === 0) return { ok: false, reason: "nothing is seated yet" };
        const pose = ctx.solveFraming(all.points, all.count, all.center, dirOf(key), 1.14, this.occlusion);
        this.move(pose, extent);
        return { ok: true };
      }

      case "ring": {
        const anchor = ctx.anchorId;
        if (!anchor) return { ok: false, reason: "this arena has no subject" };
        const sub = ctx.cardPoints((id) => id === anchor);
        if (sub.count === 0) return { ok: false, reason: "the subject is not seated" };
        // Fit the whole of CENTRE STAGE — the subject card, the ring below it
        // and the scoreboard above it — rather than the subject card alone.
        //
        // Fitting one point solves a distance of roughly nothing, so the pose
        // came out close and low with the board four units above the top of
        // frame: a preset whose stated job is "centre stage and the scoreboard"
        // and which showed neither. The volume has to be named explicitly
        // because two thirds of it is shell geometry, not cards.
        const c = sub.center;
        const volume: number[] = [c.x, c.y, c.z];
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            // ring corners
            volume.push(sx * RING_HALF, RING_TOP_Y, sz * RING_HALF);
            // scoreboard corners
            volume.push(sx * BOARD_HALF_W, BOARD_TOP_Y, sz * BOARD_HALF_W);
            volume.push(sx * BOARD_HALF_W, BOARD_BOTTOM_Y, sz * BOARD_HALF_W);
          }
        }
        const points = new Float32Array(volume);
        const count = volume.length / 3;
        let cy = 0;
        for (let i = 0; i < count; i++) cy += volume[i * 3 + 1]!;
        const target = new Vector3(0, cy / count, 0);
        const pose = ctx.solveFraming(points, count, target, dirOf(key), 1.18, this.occlusion);
        this.move(pose, extent);
        return { ok: true };
      }

      case "section": {
        const sections = (ctx.layout?.sections ?? []).filter((s) => s.arc && s.count > 0);
        if (sections.length === 0) return { ok: false, reason: "this formation has no sections" };
        // The section the selection belongs to, else the largest one.
        const selected = ctx.selectedId;
        let chosen = sections.reduce((a, b) => (b.count > a.count ? b : a));
        if (selected) {
          const here = ctx.cardPoints((id) => id === selected);
          if (here.count > 0) {
            const p = here.center;
            const angle = Math.atan2(p.x, p.z / 0.82);
            const hit = sections.find((s) => angle >= s.arc!.from && angle <= s.arc!.to);
            if (hit) chosen = hit;
          }
        }
        const arc = chosen.arc!;
        const mid = (arc.from + arc.to) / 2;
        const target = new Vector3(
          seatX(mid, arc.outerRadius * 0.62),
          1.2,
          seatZ(mid, arc.outerRadius * 0.62),
        );
        // Look along the section's own radial direction, so the bank fills the
        // frame instead of being seen edge-on.
        const dir = new Vector3(seatX(mid, 1), 0.42, seatZ(mid, 1)).normalize();
        // Fit to the section's WEDGE, sampled from the arc it reported, rather
        // than to the cards inside it. The arc is already the exact volume the
        // seating occupies, and testing every card for membership meant a
        // position lookup per card per card.
        const samples: number[] = [];
        const steps = 8;
        for (let i = 0; i <= steps; i++) {
          const a = arc.from + ((arc.to - arc.from) * i) / steps;
          for (const radius of [SECTION_INNER, arc.outerRadius]) {
            for (const height of [-0.4, -0.4 + arc.rows * 1.02]) {
              samples.push(seatX(a, radius), height, seatZ(a, radius));
            }
          }
        }
        const pose = ctx.solveFraming(
          new Float32Array(samples), samples.length / 3, target, dir, 1.2, this.occlusion,
        );
        this.move(pose, extent);
        return { ok: true };
      }

      case "relationship":
      case "headToHead": {
        const anchor = ctx.anchorId;
        const other = ctx.selectedId && ctx.selectedId !== anchor ? ctx.selectedId
          : ctx.hoverId && ctx.hoverId !== anchor ? ctx.hoverId
          : null;
        if (!anchor) return { ok: false, reason: "this arena has no subject" };
        if (!other) {
          return { ok: false, reason: "select a card first — this frames the subject against one relationship" };
        }
        const pair = ctx.cardPoints((id) => id === anchor || id === other);
        if (pair.count < 2) return { ok: false, reason: "that pair is not both seated" };
        // Head-to-head is the tighter read of the same two cards: less context,
        // more of the pair. They are separate presets because they answer
        // different questions — where does this relationship sit, versus what
        // do these two look like against each other.
        const margin = key === "headToHead" ? 1.05 : 1.55;
        const pose = ctx.solveFraming(pair.points, pair.count, pair.center, dirOf(key), margin, this.occlusion);
        this.move(pose, extent);
        return { ok: true };
      }

      case "rail": {
        // The rail is drawn only where the corpus documents title activity. No
        // rail is not a broken preset, it is an honest absence, and the reader
        // is told which.
        if (!ctx.hasRail) {
          return { ok: false, reason: "the corpus documents no title activity for this scope" };
        }
        if (ctx.formation !== "arena") {
          return { ok: false, reason: "the championship rail belongs to the Arena formation" };
        }
        const all = ctx.cardPoints(() => true);
        const target = new Vector3(0, -1.2, extent * 0.42);
        const pose = ctx.solveFraming(
          all.count > 0 ? all.points : new Float32Array([0, 0, 0]), Math.max(1, all.count),
          target, dirOf(key), 0.68, this.occlusion,
        );
        this.move(pose, extent);
        return { ok: true };
      }

      case "index": {
        // A formation change, not merely a camera move: the Index wall IS a
        // formation, and framing the arena from the Index angle would show the
        // horseshoe from underneath.
        ctx.setFormation("index");
        this.active = "index";
        return { ok: true };
      }
    }
  }
}
