import type {
  AtlasDot,
  AtlasLabelSpec,
  AtlasLane,
  AtlasPath,
  AtlasQuad,
  AtlasScene,
} from "@kayfabe/atlas-renderer";
import { A, DK, QK, activity01, communityColor, mix, rgb } from "@kayfabe/atlas-renderer";
import type { AtlasPersonRoutes, PersonDossier } from "@kayfabe/graph-contract";
import { isoToDay } from "@kayfabe/graph-contract";
import type { AtlasData } from "../atlasLoader";
import {
  GROUP_GAP,
  PRIORITY,
  TIME_W,
  Z,
  activityPriority,
  focusAxis,
  label,
  laneLabel,
  rulerQuads,
  spanQuad,
  yearOf,
  type AtlasControls,
} from "./layoutTypes";

/**
 * CAREER ROUTE — one wrestler as a transit map.
 *
 * Y lanes are promotions in order of first documented appearance; X is time; a
 * band spans that wrestler's first to latest documented appearance in that
 * promotion, thickened by how many documented matches it holds.
 *
 * Overlapping bands are the point, not a defect. A wrestler working three
 * promotions in one year is what the records say, and forcing that into a
 * single-promoter sequence would invent an exclusivity the corpus never
 * claims. For the same reason a band is a documented appearance SPAN and is
 * never called a contract, a run, or a stint.
 *
 * Championships attach to the promotion lane the reign's belt is associated
 * with. Where that association is unresolved — or the belt belongs to a
 * promotion this wrestler has no documented appearances in — the reign goes to
 * its own unresolved lane instead of being pushed into the nearest plausible
 * one.
 */

export interface CareerInput {
  data: AtlasData;
  personId: string;
  routes: AtlasPersonRoutes | null;
  /** The existing person dossier — reused rather than duplicated. */
  dossier: PersonDossier | null;
  controls: AtlasControls;
  dayMin: number;
  dayMax: number;
  selected: string | null;
  hovered: string | null;
  playheadDay: number | null;
  nameOf(id: string): string | null;
  communityOf(id: string): number;
}

/** See the note in titleLayout: the board has to be roughly viewport-shaped
 *  or a fit collapses it. */
const LANE_PITCH = 26;
const REL_PITCH = 8;
const UNRESOLVED_LANE = "atlas:unresolved-title-lane";

export function buildCareer(input: CareerInput): AtlasScene {
  const { data, personId, routes, dossier, controls, selected, hovered, playheadDay } = input;
  // The career's own span — see focusAxis.
  const axis = focusAxis(
    routes?.firstDay ?? -1,
    routes?.lastDay ?? -1,
    input.dayMin,
    input.dayMax,
  );
  const quads: AtlasQuad[] = [];
  const dots: AtlasDot[] = [];
  const paths: AtlasPath[] = [];
  const labels: AtlasLabelSpec[] = [];
  const lanes: AtlasLane[] = [];
  const anchors = new Map<string, [number, number, number]>();
  const notes: string[] = [];

  const personName = routes?.n ?? dossier?.n ?? input.nameOf(personId) ?? personId;
  const route = routes?.routes ?? [];
  const maxRouteMatches = Math.max(1, ...route.map((r) => r.matches));
  const hue = rgb(communityColor(input.communityOf(personId)));

  /* ---------- promotion lanes ---------- */
  let y = 0;
  const laneY = new Map<string, number>();
  for (const r of route) {
    const cy = y;
    laneY.set(r.pr, cy);
    const pi = data.promoIndex.get(r.pr);
    const pname = pi !== undefined ? data.promotions.name[pi]! : r.pr;
    const act = activity01(r.matches, maxRouteMatches);
    const isSel = r.pr === selected;
    const isHov = r.pr === hovered;

    quads.push({
      key: `plat:${r.pr}`,
      x: 0,
      y: cy,
      z: Z.platform,
      w: TIME_W + 8,
      h: LANE_PITCH * 0.86,
      color: isSel ? rgb(A.platformLit) : rgb(A.platform),
      alpha: isSel ? 0.95 : 0.5,
      kind: QK.PLATFORM,
      pick: r.pr,
    });
    quads.push(
      spanQuad(
        `route:${r.pr}`,
        axis,
        r.firstDay,
        r.lastDay,
        cy,
        Math.max(0.9, 1.1 + act * 3.4),
        isSel ? rgb(A.select) : mix(communityColor(input.communityOf(personId)), A.same, 0.15),
        isSel ? 1 : isHov ? 0.95 : 0.55 + act * 0.4,
        QK.RAIL,
        Z.rail,
        r.pr,
      ),
    );
    anchors.set(r.pr, [axis.x((r.firstDay + r.lastDay) / 2), cy, Z.rail]);
    labels.push(
      laneLabel(
`lane:${r.pr}`,
cy, Z.ruler, pname, isSel ? PRIORITY.selected : activityPriority(r.matches, maxRouteMatches), "promotion", {
        sub:
          `${r.matches.toLocaleString()} documented matches · ${r.cards.toLocaleString()} cards · ` +
          `${yearOf(r.firstDay)}–${yearOf(r.lastDay)} — appearances, not employment`,
        force: isSel || isHov,
        pick: r.pr,
      }),
    );
    lanes.push({
      key: r.pr,
      label: pname,
      y: cy,
      half: LANE_PITCH / 2,
      group: "Promotions",
      tone: "promotion",
      pick: r.pr,
    });
    y -= LANE_PITCH;
  }

  /* ---------- the route line ---------- */
  // Successive spans are joined at their midpoints. Restrained on purpose:
  // it is an aid to reading the ORDER, not a claim that the wrestler left one
  // promotion for the next — overlapping spans stay overlapping.
  if (route.length > 1) {
    const pts: number[] = [];
    for (const r of route) {
      const cy = laneY.get(r.pr)!;
      pts.push(axis.x(r.firstDay), cy, Z.rail + 0.08);
      pts.push(axis.x(r.lastDay), cy, Z.rail + 0.08);
    }
    paths.push({ key: `spine:${personId}`, points: pts, color: hue, alpha: 0.45, width: 1.6 });
  }

  /* ---------- championships ---------- */
  const unresolvedReigns: { t: string; s: number; e: number | null; n: string }[] = [];
  let reignCount = 0;
  if (dossier?.titles?.length) {
    for (const t of dossier.titles) {
      const ti = data.titleIndex.get(t.t);
      const belongsTo = ti !== undefined ? data.titles.pr[ti]! : "";
      const tname = ti !== undefined ? data.titles.name[ti]! : t.t;
      const lane = belongsTo && laneY.has(belongsTo) ? belongsTo : null;
      for (let k = 0; k < t.reigns.length; k++) {
        const r = t.reigns[k]!;
        const s = isoToDay(r.s);
        const e = r.e ? isoToDay(r.e) : null;
        reignCount++;
        if (!lane) {
          unresolvedReigns.push({ t: t.t, s, e, n: tname });
          continue;
        }
        const cy = laneY.get(lane)! + LANE_PITCH * 0.3;
        const isSel = t.t === selected;
        quads.push(
          spanQuad(
            `reign:${t.t}:${k}`,
            axis,
            s,
            e ?? input.dayMax,
            cy,
            2.1,
            isSel ? rgb(A.goldHot) : rgb(A.gold),
            0.92,
            e === null ? QK.REIGN_OPEN : QK.REIGN,
            Z.reign,
            t.t,
            1.2,
          ),
        );
        anchors.set(t.t, [axis.x(s), cy, Z.reign]);
        labels.push(
          label(`reignlab:${t.t}:${k}`, axis.x(s) + 1.5, cy, Z.ruler, tname, activityPriority(e ? e - s : 400, 3000), "gold", {
            sub: e ? `${r.s} → ${r.e}` : `${r.s} → open in corpus`,
            force: isSel,
            pick: t.t,
          }),
        );
      }
    }
  }

  if (unresolvedReigns.length) {
    y -= GROUP_GAP * 0.6;
    const cy = y;
    quads.push({
      key: `plat:${UNRESOLVED_LANE}`,
      x: 0,
      y: cy,
      z: Z.platform,
      w: TIME_W + 8,
      h: LANE_PITCH * 0.86,
      color: mix(A.caution, A.platform, 0.7),
      alpha: 0.6,
      kind: QK.PLATFORM,
    });
    for (let k = 0; k < unresolvedReigns.length; k++) {
      const r = unresolvedReigns[k]!;
      quads.push(
        spanQuad(
          `ureign:${r.t}:${k}`,
          axis,
          r.s,
          r.e ?? input.dayMax,
          cy,
          2.1,
          rgb(A.gold),
          0.85,
          r.e === null ? QK.REIGN_OPEN : QK.REIGN,
          Z.reign,
          r.t,
          1.2,
        ),
      );
      labels.push(
        label(`ureignlab:${r.t}:${k}`, axis.x(r.s) + 1.5, cy, Z.ruler, r.n, 300, "gold", { pick: r.t }),
      );
    }
    labels.push(
      laneLabel(
`lane:${UNRESOLVED_LANE}`,
cy, Z.ruler, "Titles outside this route", PRIORITY.header, "warn", {
        sub: "the belt's promotion is unresolved, or this wrestler has no documented appearances there",
        badge: String(unresolvedReigns.length),
        force: true,
      }),
    );
    lanes.push({
      key: UNRESOLVED_LANE,
      label: "Titles outside this route",
      y: cy,
      half: LANE_PITCH / 2,
      group: "Promotions",
      tone: "warn",
    });
    notes.push(
      `${unresolvedReigns.length} documented ${unresolvedReigns.length === 1 ? "reign is" : "reigns are"} ` +
        `not attached to a promotion lane, because the belt's promotion association is not supported by ` +
        `the records or falls outside this wrestler's documented appearances. Guessing a lane would be a claim.`,
    );
    y -= LANE_PITCH;
  }

  /* ---------- relationships ---------- */
  let relCount = 0;
  if (dossier) {
    y -= GROUP_GAP;
    const groups: { key: string; title: string; tone: "opposed" | "same" | "br"; rows: [string, number][] }[] = [
      { key: "opp", title: "Strongest documented opponents", tone: "opposed", rows: dossier.top.opponents },
      { key: "tag", title: "Strongest documented same-side partners", tone: "same", rows: dossier.top.partners },
    ];
    for (const g of groups) {
      const rows = g.rows.filter(([, n]) => n >= controls.relThreshold);
      if (!rows.length) continue;
      labels.push(
        laneLabel(
`relhead:${g.key}`,
y + 2, Z.ruler, g.title, PRIORITY.header, "muted", {
          sub: `${controls.relThreshold}+ documented encounters`,
          force: true,
        }),
      );
      const maxN = Math.max(1, ...rows.map(([, n]) => n));
      for (let k = 0; k < rows.length; k++) {
        const [oid, n] = rows[k]!;
        const cy = y - 2 - k * REL_PITCH;
        const w = 20 + (n / maxN) * 220;
        const tone = g.tone === "opposed" ? A.opposed : g.tone === "same" ? A.same : A.br;
        quads.push({
          key: `rel:${g.key}:${oid}`,
          x: axis.x0 + w / 2,
          y: cy,
          z: Z.rail,
          w,
          h: REL_PITCH * 0.42,
          color: rgb(tone),
          alpha: oid === hovered ? 0.95 : 0.55,
          kind: QK.RAIL,
          pick: oid,
        });
        anchors.set(oid, [axis.x0 + w / 2, cy, Z.rail]);
        labels.push(
          label(`rellab:${g.key}:${oid}`, axis.x0 + w + 2, cy, Z.ruler, input.nameOf(oid) ?? oid, activityPriority(n, maxN), g.tone === "opposed" ? "neutral" : "person", {
            sub: `${n} documented ${g.key === "opp" ? "opposed" : "same-side"} encounters`,
            force: oid === hovered || oid === selected,
            pick: oid,
          }),
        );
        relCount++;
      }
      y -= 4 + rows.length * REL_PITCH;
    }
    notes.push(
      "Opponent, same-side and battle-royal contacts are separate documented relationships and are never " +
        "merged. Clicking a name opens that wrestler's career route.",
    );
  }

  /* ---------- header + ruler ---------- */
  const topY = GROUP_GAP;
  const bottomY = y - GROUP_GAP;
  const ruler = rulerQuads(axis, topY, bottomY, rgb(A.ruleBright));
  quads.unshift(...ruler.quads);
  labels.push(...ruler.labels);

  if (dossier?.first) {
    dots.push({
      key: `start:${personId}`,
      x: axis.x(isoToDay(dossier.first)),
      y: laneY.get(route[0]?.pr ?? "") ?? 0,
      z: Z.dot,
      size: 9,
      color: hue,
      alpha: 0.9,
      shape: DK.PERSON,
      pick: personId,
    });
  }
  anchors.set(personId, [
    axis.x(dossier?.first ? isoToDay(dossier.first) : input.dayMin),
    laneY.get(route[0]?.pr ?? "") ?? 0,
    Z.dot,
  ]);

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

  if (!route.length) {
    notes.push("No documented promotion appearances for this wrestler in the corpus.");
  }
  if (!reignCount) {
    notes.push("No documented championship reigns. Most of this corpus carries no title-change field, so an empty title row is a limit of the source rather than a career without belts.");
  }

  return {
    state: "career",
    breadcrumbs: [
      { id: null, label: "All promotions" },
      { id: personId, label: personName },
    ],
    quads,
    dots,
    paths,
    labels,
    lanes,
    axis,
    bounds: { minX: axis.x0 - 20, maxX: axis.x1 + 40, minY: bottomY, maxY: topY },
    anchors,
    stats: {
      represented: route.length + reignCount + relCount,
      representedNoun: "promotion spans, reigns and relationships",
      labelled: 0,
      notes,
    },
  };
}
