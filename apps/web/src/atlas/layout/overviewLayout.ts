import type {
  AtlasDot,
  AtlasLabelSpec,
  AtlasLane,
  AtlasQuad,
  AtlasScene,
} from "@kayfabe/atlas-renderer";
import { A, QK, activity01, mix, rgb, scale } from "@kayfabe/atlas-renderer";
import type { AtlasData } from "../atlasLoader";
import {
  GROUP_GAP,
  LANE,
  LANE_MAX,
  LANE_MIN,
  PRIORITY,
  TIME_W,
  Z,
  activityPriority,
  decadeOf,
  label,
  laneLabel,
  makeAxis,
  packRows,
  rulerQuads,
  spanQuad,
  type AtlasControls,
} from "./layoutTypes";

/**
 * OVERVIEW — the promotion timeline matrix.
 *
 * The connectome's outer ring answers "which promotions exist" with a circle
 * of anonymous dots and answers "when were they active" not at all. This
 * answers both by construction: X is the date, one lane per promotion, and a
 * rail that spans exactly the promotion's first to latest documented record.
 *
 * Three decisions worth stating, because each is a rejected alternative:
 *
 * 1. EVERY promotion gets a lane — all 571, not the 165 that earned a graph
 *    node. A promotion with three documented cards is a thin short rail, not
 *    an absence. The `minActivity` control folds the tail into a stated
 *    residual band rather than deleting it.
 *
 * 2. Lane HEIGHT is log-scaled documented volume. Linear would give WWE the
 *    whole board and render 400 promotions at sub-pixel; equal heights would
 *    claim a three-card indie and eighty thousand WWE matches are the same
 *    kind of object.
 *
 * 3. Championships are packed gold rails INSIDE each lane, one per title,
 *    laid out by greedy interval packing so concurrent belts get separate rows
 *    and sequential ones share. A promotion that ran forty belts at once
 *    therefore reads as a solid gold ribbon and one that ran two reads as two
 *    hairlines — the density IS the encoding, every title is drawn, and
 *    zooming resolves the ribbon back into individual rails because the row
 *    height is in world units.
 */

export interface OverviewInput {
  data: AtlasData;
  controls: AtlasControls;
  dayMin: number;
  dayMax: number;
  /** Promotions the promotion filter currently admits, or null for all. */
  promoAllow: Set<string> | null;
  selected: string | null;
  hovered: string | null;
  /** Timeline playhead, or null when playback is off. */
  playheadDay: number | null;
}

interface Row {
  i: number;
  id: string;
  name: string;
  first: number;
  last: number;
  matches: number;
  cards: number;
  people: number;
  titles: number;
  group: string;
  groupOrder: number;
}

const UNRESOLVED_LANE = "atlas:unresolved-titles";

export function buildOverview(input: OverviewInput): AtlasScene {
  const { data, controls, selected, hovered, playheadDay } = input;
  const P = data.promotions;

  const axis = makeAxis(input.dayMin, input.dayMax);
  const quads: AtlasQuad[] = [];
  const dots: AtlasDot[] = [];
  const labels: AtlasLabelSpec[] = [];
  const lanes: AtlasLane[] = [];
  const anchors = new Map<string, [number, number, number]>();
  const notes: string[] = [];

  /* ---------- rows ---------- */
  const rows: Row[] = [];
  let residual = 0;
  let residualMatches = 0;
  for (let i = 0; i < P.count; i++) {
    const id = P.id[i]!;
    if (input.promoAllow && !input.promoAllow.has(id)) continue;
    const matches = P.matches[i]!;
    // The selection always keeps its lane: hiding what the reader just clicked
    // because it fell under a threshold is the worst kind of silent omission.
    if (matches < controls.minActivity && id !== selected) {
      residual++;
      residualMatches += matches;
      continue;
    }
    rows.push({
      i,
      id,
      name: P.name[i]!,
      first: P.firstDay[i]!,
      last: P.lastDay[i]!,
      matches,
      cards: P.cards[i]!,
      people: P.people[i]!,
      titles: P.titles[i]!,
      group: "",
      groupOrder: 0,
    });
  }
  if (residual > 0) {
    notes.push(
      `${residual.toLocaleString()} promotions below the activity floor are folded into the residual band ` +
        `(${residualMatches.toLocaleString()} documented matches). Search still reaches them.`,
    );
  }

  assignGroups(rows, controls);
  sortRows(rows, controls);

  /* ---------- lane geometry ---------- */
  const pitchOf = (r: Row): number =>
    LANE_MIN + (LANE_MAX - LANE_MIN) * activity01(r.matches, data.maxPromoMatches);

  let y = 0;
  let lastGroup: string | null = null;
  const laneY = new Map<string, number>();
  const lanePitch = new Map<string, number>();
  const groupTops: { label: string; y: number }[] = [];

  for (const r of rows) {
    if (r.group !== lastGroup) {
      if (lastGroup !== null) y -= GROUP_GAP;
      groupTops.push({ label: r.group, y: y + GROUP_GAP * 0.35 });
      lastGroup = r.group;
    }
    const pitch = pitchOf(r);
    y -= pitch / 2;
    laneY.set(r.id, y);
    lanePitch.set(r.id, pitch);
    y -= pitch / 2;
  }
  const bottomBeforeExtras = y;

  /* ---------- per-lane geometry ---------- */
  const yearsCeiling = ceilingOfYearCounts(data, rows);

  for (const r of rows) {
    const cy = laneY.get(r.id)!;
    const pitch = lanePitch.get(r.id)!;
    const act = activity01(r.matches, data.maxPromoMatches);
    const isSel = r.id === selected;
    const isHov = r.id === hovered;

    // Platform. The selected lane rises toward the camera and brightens; under
    // the tilted view that lift is what "this lane is the subject" looks like.
    const lift = isSel ? 0.55 : isHov ? 0.25 : 0;
    quads.push({
      key: `plat:${r.id}`,
      x: 0,
      y: cy,
      z: Z.platform + lift,
      w: TIME_W + 8,
      h: pitch * LANE.platformHalf * 2,
      color: isSel ? rgb(A.platformLit) : rgb(A.platform),
      alpha: isSel ? 0.95 : 0.55 + act * 0.2,
      kind: QK.PLATFORM,
      pick: r.id,
    });

    // The documented span. Length = coverage, thickness = volume, brightness =
    // relevance. A promotion with no dated record still gets its platform and
    // its label — it just has no rail to draw, which is the honest picture.
    if (r.first >= 0 && r.last >= 0) {
      const railH = Math.max(0.55, pitch * 0.1 + act * pitch * 0.2);
      const col = isSel
        ? rgb(A.select)
        : mix(A.dim, A.promotion, 0.25 + act * 0.75);
      quads.push(
        spanQuad(
          `rail:${r.id}`,
          axis,
          r.first,
          r.last,
          cy + pitch * LANE.railY,
          railH,
          col,
          isSel ? 1 : 0.45 + act * 0.45,
          QK.RAIL,
          Z.rail + lift,
          r.id,
        ),
      );
      anchors.set(r.id, [axis.x((r.first + r.last) / 2), cy, Z.rail + lift]);

      // Yearly documented-match density, as bars hanging under the rail. This
      // is the difference between "active 1963-2026" and "active, but almost
      // all of it after 1997".
      const from = P.yearFrom[r.i]!;
      const counts = P.yearCounts[r.i]!;
      const histTop = cy + pitch * LANE.histTop;
      const histH = pitch * (LANE.histTop - LANE.histBottom);
      const barW = Math.max(0.5, TIME_W / Math.max(1, axis.dayMax - axis.dayMin) * 365.25 * 0.8);
      for (let k = 0; k < counts.length; k++) {
        const n = counts[k]!;
        if (n <= 0) continue;
        const h = Math.max(0.12, activity01(n, yearsCeiling) * histH);
        quads.push({
          key: `hist:${r.id}:${from + k}`,
          x: axis.x(dayOfYear(from + k) + 182),
          y: histTop - h / 2,
          z: Z.hist + lift,
          w: barW,
          h,
          color: mix(A.dim, A.same, 0.35),
          alpha: isSel ? 0.6 : 0.22,
          kind: QK.TICK,
        });
      }
    } else {
      anchors.set(r.id, [0, cy, Z.rail + lift]);
    }

    // Championships.
    if (controls.showTitles) {
      const tIdx = data.titlesByPromo.get(r.id) ?? [];
      if (tIdx.length) {
        emitTitleBand(
          tIdx,
          r.id,
          cy,
          pitch,
          lift,
          axis,
          data,
          quads,
          labels,
          anchors,
          selected,
          hovered,
        );
      }
    }

    // Lane identity. The name sits at the LEFT EDGE of the axis rather than on
    // the rail, so a lane is named even when its rail is off screen — which is
    // most lanes, most of the time, at this scale.
    const spanText =
      r.first >= 0
        ? `${yearOf(r.first)}–${yearOf(r.last)} · ${r.matches.toLocaleString()} matches`
        : "no dated record";
    labels.push(
      laneLabel(
`promo:${r.id}`,
cy,
        Z.ruler,
        r.name,
        isSel
          ? PRIORITY.selected
          : isHov
            ? PRIORITY.hovered
            : activityPriority(r.matches, data.maxPromoMatches),
        isSel ? "neutral" : "promotion",
        {
          sub: spanText,
          badge: r.titles > 0 ? `${r.titles} ${r.titles === 1 ? "title" : "titles"}` : undefined,
          force: isSel || isHov,
          pick: r.id,
        },
      ),
    );
    lanes.push({
      key: r.id,
      label: r.name,
      y: cy,
      half: pitch / 2,
      group: r.group,
      tone: "promotion",
      x0: r.first >= 0 ? axis.x(r.first) : undefined,
      x1: r.last >= 0 ? axis.x(r.last) : undefined,
      weight: act,
      pick: r.id,
    });
  }

  /* ---------- unresolved / cross-promotion titles ---------- */
  y = bottomBeforeExtras - GROUP_GAP * 1.5;
  if (controls.showTitles && data.unresolvedTitles.length) {
    const pitch = LANE_MAX;
    const cy = y - pitch / 2;
    quads.push({
      key: `plat:${UNRESOLVED_LANE}`,
      x: 0,
      y: cy,
      z: Z.platform,
      w: TIME_W + 8,
      h: pitch * LANE.platformHalf * 2,
      color: scale(rgb(A.caution), 0.22),
      alpha: 0.7,
      kind: QK.PLATFORM,
    });
    emitTitleBand(
      data.unresolvedTitles,
      UNRESOLVED_LANE,
      cy,
      pitch,
      0,
      axis,
      data,
      quads,
      labels,
      anchors,
      selected,
      hovered,
    );
    labels.push(
      laneLabel(
`promo:${UNRESOLVED_LANE}`,
cy,
        Z.ruler,
        "Unresolved / cross-promotion titles",
        PRIORITY.header,
        "warn",
        {
          sub: "no promotion is supported by the records — never guessed into one",
          badge: `${data.unresolvedTitles.length}`,
          force: true,
        },
      ),
    );
    lanes.push({
      key: UNRESOLVED_LANE,
      label: "Unresolved / cross-promotion titles",
      y: cy,
      half: pitch / 2,
      group: "",
      tone: "warn",
    });
    y = cy - pitch / 2;
  }

  const topY = GROUP_GAP;
  const bottomY = y - GROUP_GAP;

  /* ---------- rulers, era dividers, group headers ---------- */
  const ruler = rulerQuads(axis, topY, bottomY, rgb(A.ruleBright));
  quads.unshift(...ruler.quads);
  labels.push(...ruler.labels);

  for (const g of groupTops) {
    if (!g.label) continue;
    quads.push({
      key: `groupdiv:${g.label}`,
      x: 0,
      y: g.y,
      z: Z.backdrop,
      w: TIME_W + 40,
      h: 0.5,
      color: rgb(A.ruleBright),
      alpha: 0.5,
      kind: QK.DIVIDER,
    });
    labels.push(
      laneLabel(
`group:${g.label}`,
g.y + 2.4, Z.ruler, g.label, PRIORITY.header + 10, "muted", {
        force: true,
      }),
    );
  }

  if (playheadDay !== null) {
    quads.push({
      key: "playhead",
      x: axis.x(playheadDay),
      y: (topY + bottomY) / 2,
      z: Z.playhead,
      w: 0.7,
      h: Math.max(1, topY - bottomY),
      color: rgb(A.select),
      alpha: 0.5,
      kind: QK.TICK,
    });
  }

  return {
    state: "overview",
    breadcrumbs: [{ id: null, label: "All promotions" }],
    quads,
    dots,
    paths: [],
    labels,
    lanes,
    axis,
    bounds: { minX: axis.x0 - 20, maxX: axis.x1 + 20, minY: bottomY, maxY: topY + 10 },
    anchors,
    stats: {
      represented: rows.length,
      representedNoun: "promotions",
      labelled: 0,
      notes,
    },
  };
}

/* ---------- helpers ---------- */

function yearOf(day: number): number {
  return new Date(Date.UTC(1900, 0, 1) + day * 86400000).getUTCFullYear();
}
function dayOfYear(year: number): number {
  return Math.round((Date.UTC(year, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000);
}

/** The busiest single promotion-year in view, so the histograms share a scale
 *  and a tall bar means the same thing in every lane. */
function ceilingOfYearCounts(data: AtlasData, rows: Row[]): number {
  let max = 1;
  for (const r of rows) {
    for (const n of data.promotions.yearCounts[r.i]!) if (n > max) max = n;
  }
  return max;
}

function assignGroups(rows: Row[], controls: AtlasControls): void {
  for (const r of rows) {
    if (controls.group === "alpha") {
      const c = (r.name[0] ?? "#").toUpperCase();
      r.group = /[A-Z]/.test(c) ? c : "#";
      r.groupOrder = r.group.charCodeAt(0);
    } else if (controls.group === "tier") {
      const m = r.matches;
      const [g, o] =
        m >= 10000 ? ["10,000+ documented matches", 0]
          : m >= 1000 ? ["1,000–9,999", 1]
            : m >= 100 ? ["100–999", 2]
              : m >= 10 ? ["10–99", 3]
                : ["under 10", 4];
      r.group = g as string;
      r.groupOrder = o as number;
    } else if (controls.group === "firstYear") {
      const y = r.first >= 0 ? yearOf(r.first) : 0;
      r.group = y ? String(y) : "no dated record";
      r.groupOrder = y || 9999;
    } else {
      const d = r.first >= 0 ? decadeOf(r.first) : 0;
      r.group = d ? `${d}s` : "no dated record";
      r.groupOrder = d || 9999;
    }
  }
}

function sortRows(rows: Row[], controls: AtlasControls): void {
  const key = (r: Row): number => {
    switch (controls.sort) {
      case "first":
        return r.first < 0 ? Infinity : r.first;
      case "last":
        return r.last < 0 ? -Infinity : -r.last;
      case "span":
        return -(r.last >= 0 && r.first >= 0 ? r.last - r.first : -1);
      case "alpha":
        return 0;
      default:
        return -r.matches;
    }
  };
  rows.sort(
    (a, b) =>
      a.groupOrder - b.groupOrder ||
      (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) ||
      key(a) - key(b) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * Pack a promotion's championships into its lane's title band.
 *
 * Every title is drawn. Row height falls as concurrency rises, so a
 * title-dense promotion renders as a gold ribbon whose thickness is its title
 * system and a sparse one as separable hairlines — and zooming makes the rows
 * taller in pixels, which is what "at close zoom, reveal individual titles"
 * means when the geometry is in world units.
 */
function emitTitleBand(
  titleRows: number[],
  laneId: string,
  cy: number,
  pitch: number,
  lift: number,
  axis: ReturnType<typeof makeAxis>,
  data: AtlasData,
  quads: AtlasQuad[],
  labels: AtlasLabelSpec[],
  anchors: Map<string, [number, number, number]>,
  selected: string | null,
  hovered: string | null,
): void {
  const T = data.titles;
  const items = titleRows.map((i) => ({
    firstDay: T.firstDay[i]! < 0 ? axis.dayMin : T.firstDay[i]!,
    lastDay: T.lastDay[i]! < 0 ? axis.dayMin : T.lastDay[i]!,
  }));
  const packed = packRows(items, 40);
  const bandTop = cy + pitch * LANE.titleTop;
  const bandBottom = cy + pitch * LANE.titleBottom;
  const bandH = bandTop - bandBottom;
  const rowH = bandH / Math.max(1, packed.count);

  for (let k = 0; k < titleRows.length; k++) {
    const i = titleRows[k]!;
    const id = T.id[i]!;
    const isSel = id === selected;
    const isHov = id === hovered;
    const yy = bandTop - (packed.rows[k]! + 0.5) * rowH;
    const h = Math.max(0.06, rowH * 0.78);
    const share = T.assocShare[i]!;
    // A belt whose promotion is a majority vote rather than a source fact is
    // drawn cooler, so a widely-defended NWA title does not read as an NJPW
    // house belt just because most of its recorded matches happened there.
    const confident = T.assoc[i] === "registry" || share >= 0.85;
    const col = isSel ? rgb(A.goldHot) : confident ? rgb(A.gold) : mix(A.goldDeep, A.gold, share);
    const box = spanBox(axis, items[k]!.firstDay, items[k]!.lastDay);
    quads.push({
      key: `title:${id}`,
      x: box.x,
      y: yy,
      z: Z.title + lift,
      w: box.w,
      h,
      color: col,
      alpha: isSel ? 1 : isHov ? 0.95 : 0.62,
      kind: QK.TITLE,
      param: confident ? 1 : 0.35,
      pick: id,
    });
    anchors.set(id, [axis.x((items[k]!.firstDay + items[k]!.lastDay) / 2), yy, Z.title + lift]);

    // Labels only for what the reader is pointing at plus whatever survives
    // collision by weight — the badge on the lane carries the total, so an
    // unlabelled rail never reads as an absent title.
    labels.push(
      label(
        `titlelab:${id}`,
        axis.x(items[k]!.lastDay) + 2,
        yy,
        Z.ruler,
        T.name[i]!,
        isSel ? PRIORITY.selected : isHov ? PRIORITY.hovered : activityPriority(T.titleMatches[i]!, data.maxTitleMatches) * 0.5,
        "gold",
        {
          force: isSel || isHov,
          badge: T.artifact[i] ? "source artifact" : undefined,
          pick: id,
        },
      ),
    );
  }
  void laneId;
}

/** x/w for a day span, as a partial quad. */
function spanBox(
  axis: ReturnType<typeof makeAxis>,
  a: number,
  b: number,
): { x: number; w: number } {
  const xa = axis.x(Math.max(axis.dayMin, Math.min(a, b)));
  const xb = axis.x(Math.min(axis.dayMax, Math.max(a, b)));
  const w = Math.max(0.6, xb - xa);
  return { x: xa + w / 2, w };
}
