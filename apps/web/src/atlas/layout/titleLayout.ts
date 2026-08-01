import type {
  AtlasDot,
  AtlasLabelSpec,
  AtlasLane,
  AtlasPath,
  AtlasQuad,
  AtlasScene,
} from "@kayfabe/atlas-renderer";
import { A, DK, QK, activity01, mix, rgb } from "@kayfabe/atlas-renderer";
import type { ChampionshipRecord } from "@kayfabe/graph-contract";
import { isoToDay } from "@kayfabe/graph-contract";
import type { AtlasData } from "../atlasLoader";
import {
  GROUP_GAP,
  PRIORITY,
  TIME_W,
  Z,
  activityPriority,
  dayOfYear,
  focusAxis,
  label,
  laneLabel,
  rulerQuads,
  spanQuad,
  yearOf,
  type AtlasControls,
} from "./layoutTypes";

/**
 * CHAMPIONSHIP LINEAGE — a belt's chronology.
 *
 * The honest shape of this corpus decides the design. Of 4,389 championships,
 * 94 have a derivable lineage; the other 4,295 come from a source that records
 * title MATCHES but carries no title-change field. A lineage view that renders
 * empty for 98% of belts would be useless, and one that invented reigns to
 * fill the space would be a lie. So there are two readings on one rail:
 *
 *   lineage "derived"    reign blocks, holders, gaps, open ends
 *   lineage "no-changes" the documented title-match record over time, with a
 *                        standing statement that reigns are NOT derived here
 *
 * Four rules that are easy to get wrong:
 *   - A gap between two reigns is drawn as a GAP and called "unrecorded". It
 *     is never called "vacant": the corpus records changes, not vacancies.
 *   - Consecutive reigns are NOT connected. One reign following another is not
 *     evidence that the belt passed directly between those two people.
 *   - An open final reign dissolves at the right edge and says "open in
 *     corpus", because what ends there is the record.
 *   - Derived statistics state their sample. A median reign length computed
 *     from closed reigns only says so, and says how many.
 */

export interface TitleInput {
  data: AtlasData;
  titleId: string;
  record: ChampionshipRecord | null;
  controls: AtlasControls;
  dayMin: number;
  dayMax: number;
  selected: string | null;
  hovered: string | null;
  playheadDay: number | null;
  /** Sibling belts under the same promotion, for comparison rails. */
  siblings: { t: string; n: string; firstDay: number; lastDay: number; reigns: number }[];
  promotionName: string;
  nameOf(id: string): string | null;
  /** Yearly documented title-match counts, from the promotion shard. */
  yearFrom: number;
  yearCounts: number[];
}

/**
 * Vertical scale.
 *
 * Chosen against TIME_W so the laid-out board is roughly viewport-shaped. A
 * lineage 1,000 world units wide and 160 tall fits width-first and collapses
 * every reign into a hairline, however correct the geometry is.
 */
const RAIL_Y = 0;
const RAIL_H = 22;
const HOLDER_OFFSET = 34;
const SPINE_Y = 96;
const SIBLING_PITCH = 13;

export interface LineageStats {
  reigns: number;
  holders: number;
  changes: number;
  titleMatches: number;
  firstDay: number;
  lastDay: number;
  /** Only from reigns with BOTH endpoints known. */
  closedReigns: number;
  longestDays: number | null;
  medianDays: number | null;
  openReigns: number;
  gaps: number;
  lineage: "derived" | "no-changes";
  artifact: boolean;
  assocShare: number;
  assoc: string;
}

export function buildTitle(input: TitleInput): AtlasScene & { lineage: LineageStats } {
  const { data, titleId, record, selected, hovered, playheadDay } = input;
  const ti = data.titleIndex.get(titleId);
  const T = data.titles;
  const quads: AtlasQuad[] = [];
  const dots: AtlasDot[] = [];
  const paths: AtlasPath[] = [];
  const labels: AtlasLabelSpec[] = [];
  const lanes: AtlasLane[] = [];
  const anchors = new Map<string, [number, number, number]>();
  const notes: string[] = [];

  const name = ti !== undefined ? T.name[ti]! : (record?.n ?? titleId);
  const lineageKind = ti !== undefined ? T.lineage[ti]! : "no-changes";
  const artifact = ti !== undefined ? T.artifact[ti]! === 1 : (record?.artifact ?? false);
  const titleMatches = ti !== undefined ? T.titleMatches[ti]! : (record?.titleMatches ?? 0);
  const firstDay = ti !== undefined ? T.firstDay[ti]! : -1;
  const lastDay = ti !== undefined ? T.lastDay[ti]! : -1;
  const assoc = ti !== undefined ? T.assoc[ti]! : "unresolved";
  const assocShare = ti !== undefined ? T.assocShare[ti]! : 0;

  // The axis is the BELT's span, not the corpus's: a title active 2002-2025
  // rendered against 1947-2026 spends most of the board on years it did not
  // exist, and its reigns collapse into a smear.
  const axis = focusAxis(firstDay, lastDay, input.dayMin, input.dayMax);

  /* ---------- contextual promotion spine ---------- */
  quads.push({
    key: "spineplat",
    x: 0,
    y: SPINE_Y,
    z: Z.platform,
    w: TIME_W + 8,
    h: 6,
    color: rgb(A.platform),
    alpha: 0.6,
    kind: QK.PLATFORM,
  });
  if (firstDay >= 0) {
    quads.push(
      spanQuad("spinerail", axis, firstDay, lastDay, SPINE_Y, 1.4, rgb(A.promotion), 0.55, QK.RAIL, Z.rail),
    );
  }
  labels.push(
    laneLabel(
"spinelab",
SPINE_Y, Z.ruler, input.promotionName, PRIORITY.breadcrumb, "promotion", {
      sub:
        assoc === "dominant" && assocShare <= 0.5
          ? "the records do not decide this belt's promotion — placed by id order, not by evidence"
          : assoc === "dominant" && assocShare < 0.85
            ? `${Math.round(assocShare * 100)}% of its documented title matches happened here — defended widely`
            : assoc === "unresolved"
              ? "no promotion is supported by the records"
              : "promotion context",
      force: true,
      pick: ti !== undefined && T.pr[ti] ? T.pr[ti]! : undefined,
    }),
  );

  /* ---------- the lineage rail ---------- */
  quads.push({
    key: "lineplat",
    x: 0,
    y: RAIL_Y,
    z: Z.platform,
    w: TIME_W + 8,
    h: RAIL_H * 2.6,
    color: rgb(A.platformLit),
    alpha: 0.85,
    kind: QK.PLATFORM,
    pick: titleId,
  });
  if (firstDay >= 0) {
    quads.push(
      spanQuad(
        `title:${titleId}`,
        axis,
        firstDay,
        lastDay,
        RAIL_Y,
        RAIL_H * 0.34,
        mix(A.goldDeep, A.gold, 0.35),
        0.5,
        QK.TITLE,
        Z.title - 0.05,
        titleId,
      ),
    );
    anchors.set(titleId, [axis.x((firstDay + lastDay) / 2), RAIL_Y, Z.title]);
  } else {
    anchors.set(titleId, [0, RAIL_Y, Z.title]);
  }
  lanes.push({
    key: titleId,
    label: name,
    y: RAIL_Y,
    half: HOLDER_OFFSET + 2,
    group: "Lineage",
    tone: "gold",
    pick: titleId,
  });

  const reigns = record?.reigns ?? [];
  const stats: LineageStats = {
    reigns: reigns.length,
    holders: 0,
    changes: record?.changes ?? 0,
    titleMatches,
    firstDay,
    lastDay,
    closedReigns: 0,
    longestDays: null,
    medianDays: null,
    openReigns: 0,
    gaps: 0,
    lineage: lineageKind,
    artifact,
    assocShare,
    assoc,
  };

  if (lineageKind === "derived" && reigns.length) {
    const holderSet = new Set<string>();
    const closedDurations: number[] = [];
    let prevEndDay: number | null = null;

    for (let k = 0; k < reigns.length; k++) {
      const r = reigns[k]!;
      const s = isoToDay(r.s);
      const closed = r.e !== null;
      const e = closed ? isoToDay(r.e!) : lastDay >= 0 ? lastDay : s;
      for (const h of r.holders) holderSet.add(h);

      // An unrecorded interval between the end of one reign and the start of
      // the next. Drawn as a hatched gap and named "unrecorded" — the corpus
      // records title CHANGES, so it has nothing to say about vacancy.
      if (prevEndDay !== null && s - prevEndDay > 1) {
        quads.push(
          spanQuad(
            `gap:${titleId}:${k}`,
            axis,
            prevEndDay,
            s,
            RAIL_Y,
            RAIL_H * 0.72,
            rgb(A.caution),
            0.5,
            QK.GAP,
            Z.reign - 0.02,
            `${titleId}#gap${k}`,
          ),
        );
        stats.gaps++;
      }

      const isSel = reignKey(titleId, k) === selected;
      // Inset each block by a hair so consecutive reigns SEPARATE. Butted
      // together, 61 reigns across 23 years render as one continuous gold bar
      // and the thing the view exists to show — that the belt changed hands
      // sixty-one times — disappears into it.
      const inset = Math.min((e - s) * 0.06, 26);
      quads.push(
        spanQuad(
          `reign:${titleId}:${k}`,
          axis,
          s + inset,
          e - inset,
          RAIL_Y,
          isSel ? RAIL_H * 1.15 : RAIL_H,
          isSel ? rgb(A.goldHot) : rgb(A.gold),
          closed ? 0.94 : 0.86,
          closed ? QK.REIGN : QK.REIGN_OPEN,
          Z.reign,
          reignKey(titleId, k),
          1.6,
        ),
      );

      // Holders alternate above and below the rail so two short reigns in the
      // same month do not stack their names on one another.
      const side = k % 2 === 0 ? 1 : -1;
      const hy = RAIL_Y + side * HOLDER_OFFSET;
      const hx = axis.x(s + (e - s) * 0.5);
      for (let hi = 0; hi < r.holders.length; hi++) {
        const h = r.holders[hi]!;
        const hn = input.nameOf(h) ?? h;
        // Tag / group reigns: every holder gets a node, stacked outward.
        const yy = hy + side * hi * 11;
        dots.push({
          key: `holder:${titleId}:${k}:${h}`,
          x: hx,
          y: yy,
          z: Z.dot,
          size: 7,
          color: h === hovered || h === selected ? rgb(A.select) : rgb(A.gold),
          alpha: 0.95,
          shape: DK.HOLDER,
          pick: h,
        });
        anchors.set(h, [hx, yy, Z.dot]);
        paths.push({
          key: `hlink:${titleId}:${k}:${h}`,
          points: [hx, RAIL_Y + (side * RAIL_H) / 2, Z.reign, hx, yy - side * 4, Z.reign],
          color: rgb(A.goldDeep),
          alpha: 0.55,
          width: 1,
        });
        const dur = closed ? e - s : null;
        labels.push(
          label(`hlab:${titleId}:${k}:${h}`, hx + 2, yy, Z.ruler, hn, activityPriority(dur ?? 1, 3000) + (isSel ? 400 : 0), "gold", {
            sub: closed
              ? `${r.s} → ${r.e} · ${dur} days`
              : `${r.s} → open in corpus`,
            anchor: "left",
            force: isSel || h === hovered,
            pick: h,
          }),
        );
      }
      if (closed) {
        closedDurations.push(e - s);
        stats.closedReigns++;
      } else {
        stats.openReigns++;
        labels.push(
          label(`open:${titleId}:${k}`, axis.x(e) + 3, RAIL_Y, Z.ruler, "open in corpus", PRIORITY.header, "warn", {
            sub: "the record stops here, not the reign",
            force: true,
          }),
        );
      }
      prevEndDay = closed ? e : null;
    }

    stats.holders = holderSet.size;
    if (closedDurations.length) {
      const sorted = [...closedDurations].sort((a, b) => a - b);
      stats.longestDays = sorted[sorted.length - 1]!;
      const mid = sorted.length >> 1;
      stats.medianDays =
        sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    }
    notes.push(
      `Reign blocks are intervals between documented title-change matches. Consecutive blocks are ` +
        `not connected: one reign following another is not evidence the belt passed directly between ` +
        `those holders.`,
    );
    if (stats.gaps) {
      notes.push(
        `${stats.gaps} unrecorded ${stats.gaps === 1 ? "gap" : "gaps"} in the lineage. The corpus records ` +
          `title changes, not vacancies — a gap means the record is silent, not that the belt was vacant.`,
      );
    }
  } else {
    // No derivable lineage. Show what the source DOES record: title-match
    // activity over time, on the same rail, so the belt still has a shape.
    const maxTM = Math.max(1, ...input.yearCounts);
    const barW = Math.max(
      1.2,
      (TIME_W / Math.max(1, axis.dayMax - axis.dayMin)) * 365.25 * 0.8,
    );
    for (let k = 0; k < input.yearCounts.length; k++) {
      const n = input.yearCounts[k] ?? 0;
      if (n <= 0) continue;
      const h = Math.max(0.4, activity01(n, maxTM) * RAIL_H * 1.5);
      quads.push({
        key: `tmbar:${titleId}:${input.yearFrom + k}`,
        x: axis.x(dayOfYear(input.yearFrom + k) + 182),
        y: RAIL_Y + h / 2 - RAIL_H * 0.2,
        z: Z.reign,
        w: barW,
        h,
        color: rgb(A.gold),
        alpha: 0.62,
        kind: QK.TICK,
      });
    }
    notes.push(
      `No lineage is derived for this championship: its source records title matches but carries no ` +
        `title-change field. The bars are documented title matches per year. Reigns are absent from the ` +
        `record, not from history — and are not guessed.`,
    );
  }

  if (artifact) {
    notes.push(
      `This belt NAME is a concatenation artifact in the source. The records are kept unsplit and the ` +
        `name is preserved verbatim rather than repaired into two titles that may not exist.`,
    );
  }

  labels.push(
    laneLabel(
"titlehead",
RAIL_Y, Z.ruler, name, PRIORITY.selected, "gold", {
      sub:
        `${titleMatches.toLocaleString()} documented title matches` +
        (lineageKind === "derived"
          ? ` · ${stats.reigns} reigns · ${stats.holders} holders · ${stats.changes} changes`
          : " · no title-change records in this source"),
      badge: artifact ? "source artifact" : undefined,
      force: true,
      pick: titleId,
    }),
  );

  /* ---------- sibling belts, for comparison ---------- */
  let y = RAIL_Y - HOLDER_OFFSET - 46;
  const sibs = input.siblings.filter((s) => s.t !== titleId).slice(0, 24);
  if (sibs.length) {
    labels.push(
      laneLabel(
"sibhead",
y + 3, Z.ruler, "Sibling championships", PRIORITY.header, "muted", {
        sub: `${input.siblings.length - 1} others in ${input.promotionName} — click to compare`,
        force: true,
      }),
    );
    for (const s of sibs) {
      const cy = y;
      if (s.firstDay >= 0) {
        quads.push(
          spanQuad(
            `sib:${s.t}`,
            axis,
            s.firstDay,
            s.lastDay,
            cy,
            1.2,
            mix(A.goldDeep, A.gold, 0.2),
            s.t === hovered ? 0.9 : 0.4,
            QK.TITLE,
            Z.title,
            s.t,
          ),
        );
        anchors.set(s.t, [axis.x((s.firstDay + s.lastDay) / 2), cy, Z.title]);
      }
      labels.push(
        laneLabel(
`siblab:${s.t}`,
cy, Z.ruler, s.n, activityPriority(s.reigns, 160) * 0.4, "muted", {
          force: s.t === hovered,
          pick: s.t,
        }),
      );
      lanes.push({ key: s.t, label: s.n, y: cy, half: SIBLING_PITCH / 2, group: "Siblings", tone: "gold", pick: s.t });
      y -= SIBLING_PITCH;
    }
    if (input.siblings.length - 1 > sibs.length) {
      notes.push(
        `${input.siblings.length - 1 - sibs.length} further sibling championships are not drawn here. ` +
          `All of them are on the promotion board.`,
      );
    }
  }

  const topY = SPINE_Y + GROUP_GAP;
  const bottomY = y - GROUP_GAP;
  const ruler = rulerQuads(axis, topY, bottomY, rgb(A.ruleBright));
  quads.unshift(...ruler.quads);
  labels.push(...ruler.labels);

  if (playheadDay !== null) {
    quads.push({
      key: "playhead",
      x: axis.x(playheadDay),
      y: (topY + bottomY) / 2,
      z: Z.playhead,
      w: 0.8,
      h: Math.max(1, topY - bottomY),
      color: rgb(A.select),
      alpha: 0.55,
      kind: QK.TICK,
    });
  }

  return {
    state: "title",
    breadcrumbs: [
      { id: null, label: "All promotions" },
      ...(ti !== undefined && T.pr[ti] ? [{ id: T.pr[ti]!, label: input.promotionName }] : []),
      { id: titleId, label: name },
    ],
    quads,
    dots,
    paths,
    labels,
    lanes,
    axis,
    bounds: { minX: axis.x0 - 20, maxX: axis.x1 + 30, minY: bottomY, maxY: topY },
    anchors,
    stats: {
      represented: Math.max(reigns.length, 1),
      representedNoun: lineageKind === "derived" ? "documented reigns" : "documented title-match years",
      labelled: 0,
      notes,
    },
    lineage: stats,
  };
}

export function reignKey(titleId: string, i: number): string {
  return `${titleId}#r${i}`;
}

/** True when an id addresses a reign block rather than an entity. */
export function isReignKey(id: string): boolean {
  return id.includes("#r") || id.includes("#gap");
}

export { yearOf };
