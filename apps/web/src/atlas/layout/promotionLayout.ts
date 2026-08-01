import type {
  AtlasDot,
  AtlasLabelSpec,
  AtlasLane,
  AtlasPath,
  AtlasQuad,
  AtlasScene,
} from "@kayfabe/atlas-renderer";
import { A, DK, QK, activity01, communityColor, mix, rgb } from "@kayfabe/atlas-renderer";
import type { AtlasPromotionDetail } from "@kayfabe/graph-contract";
import type { AtlasData } from "../atlasLoader";
import {
  GROUP_GAP,
  PRIORITY,
  TIME_W,
  Z,
  activityPriority,
  decadeOf,
  focusAxis,
  label,
  laneLabel,
  packRows,
  rulerQuads,
  spanQuad,
  yearOf,
  type AtlasControls,
} from "./layoutTypes";

/**
 * PROMOTION FOCUS — one promotion's historical board.
 *
 * Three zones stacked on one shared time axis, so a reader answers "which
 * belts existed while which roster was working" by drawing a vertical line
 * with their eye:
 *
 *   TOP     championships, one gold lane each, reign markers where derivable
 *   MIDDLE  the promotion's own spine: span, yearly card and match density
 *   BOTTOM  wrestlers documented on its cards, banded by era
 *
 * "Documented appearance", never employment. The corpus records that someone
 * was on a card. It records nothing about contracts, and this lens does not
 * imply otherwise anywhere in its geometry or its wording.
 *
 * Title CATEGORY is deliberately absent. Nothing here decides that a belt is a
 * world title, a tag title or a women's title, because the only available
 * signal is the belt's name and reading a category out of a name is a guess
 * wearing a fact's clothes.
 */

export interface RelSource {
  neighbours(id: string): { id: string; same: number; opposed: number; br: number }[];
  nameOf(id: string): string | null;
  communityOf(id: string): number;
}

export interface PromotionInput {
  data: AtlasData;
  detail: AtlasPromotionDetail;
  controls: AtlasControls;
  dayMin: number;
  dayMax: number;
  selected: string | null;
  hovered: string | null;
  playheadDay: number | null;
  rel: RelSource | null;
}

const TITLE_PITCH = 9;
const MEMBER_PITCH = 1.9;
const SPINE_H = 3.2;
const ZONE_GAP = 14;
/** Direct fibres drawn for one selected wrestler. Disclosed when it bites. */
const FIBER_CAP = 120;

export function buildPromotion(input: PromotionInput): AtlasScene {
  const { data, detail, controls, selected, hovered, playheadDay, rel } = input;
  // The promotion's own span — see focusAxis.
  const axis = focusAxis(detail.firstDay, detail.lastDay, input.dayMin, input.dayMax);
  const quads: AtlasQuad[] = [];
  const dots: AtlasDot[] = [];
  const paths: AtlasPath[] = [];
  const labels: AtlasLabelSpec[] = [];
  const lanes: AtlasLane[] = [];
  const anchors = new Map<string, [number, number, number]>();
  const notes: string[] = [];

  /* ================= MIDDLE — the promotion's own spine ================= */
  const spineY = 0;
  quads.push({
    key: `plat:${detail.id}`,
    x: 0,
    y: spineY,
    z: Z.platform,
    w: TIME_W + 8,
    h: 13,
    color: rgb(A.platformLit),
    alpha: 0.9,
    kind: QK.PLATFORM,
    pick: detail.id,
  });
  if (detail.firstDay >= 0) {
    quads.push(
      spanQuad(
        `rail:${detail.id}`,
        axis,
        detail.firstDay,
        detail.lastDay,
        spineY,
        SPINE_H,
        rgb(A.promotion),
        1,
        QK.RAIL,
        Z.rail,
        detail.id,
      ),
    );
    anchors.set(detail.id, [axis.x((detail.firstDay + detail.lastDay) / 2), spineY, Z.rail]);
  } else {
    anchors.set(detail.id, [0, spineY, Z.rail]);
  }

  // Yearly card and match density, mirrored either side of the spine: cards
  // above, matches below. Two series rather than one because a promotion that
  // ran fewer, bigger cards is a different history from one that ran more,
  // smaller ones, and a single bar cannot say which.
  const maxCards = Math.max(1, ...detail.yearCards);
  const maxMatches = Math.max(1, ...detail.yearMatches);
  const barW = Math.max(
    0.6,
    (TIME_W / Math.max(1, axis.dayMax - axis.dayMin)) * 365.25 * 0.72,
  );
  for (let k = 0; k < detail.yearCards.length; k++) {
    const year = detail.yearFrom + k;
    const x = axis.x(dayOfYear(year) + 182);
    const c = detail.yearCards[k] ?? 0;
    const m = detail.yearMatches[k] ?? 0;
    if (c > 0) {
      const h = Math.max(0.15, activity01(c, maxCards) * 5.2);
      quads.push({
        key: `cards:${year}`,
        x,
        y: spineY + SPINE_H / 2 + h / 2 + 0.4,
        z: Z.hist,
        w: barW,
        h,
        color: mix(A.dim, A.same, 0.5),
        alpha: 0.6,
        kind: QK.TICK,
      });
    }
    if (m > 0) {
      const h = Math.max(0.15, activity01(m, maxMatches) * 5.2);
      quads.push({
        key: `matches:${year}`,
        x,
        y: spineY - SPINE_H / 2 - h / 2 - 0.4,
        z: Z.hist,
        w: barW,
        h,
        color: mix(A.dim, A.opposed, 0.4),
        alpha: 0.5,
        kind: QK.TICK,
      });
    }
  }
  labels.push(
    laneLabel(
`spine:${detail.id}`,
spineY, Z.ruler, detail.n, PRIORITY.breadcrumb, "promotion", {
      sub:
        detail.firstDay >= 0
          ? `${yearOf(detail.firstDay)}–${yearOf(detail.lastDay)} · ${detail.cards.toLocaleString()} cards · ` +
            `${detail.matches.toLocaleString()} matches · ${detail.people.toLocaleString()} documented participants`
          : "no dated record",
      force: true,
      pick: detail.id,
    }),
  );
  labels.push(
    laneLabel(
"zone:activity",
spineY - 8, Z.ruler, "cards ▲ · matches ▼ per year", PRIORITY.header - 60, "muted", {
      force: true,
    }),
  );
  lanes.push({
    key: detail.id,
    label: detail.n,
    y: spineY,
    half: 7,
    group: "Promotion",
    tone: "promotion",
    pick: detail.id,
  });

  /* ================= TOP — championships ================= */
  let y = spineY + ZONE_GAP;
  const titles = [...detail.titles].sort(
    (a, b) =>
      (a.firstDay < 0 ? 1 : 0) - (b.firstDay < 0 ? 1 : 0) ||
      a.firstDay - b.firstDay ||
      (a.n < b.n ? -1 : a.n > b.n ? 1 : 0),
  );
  if (controls.showTitles && titles.length) {
    labels.push(
      laneLabel(
"zone:titles",
y + 4, Z.ruler, `Championships`, PRIORITY.header + 10, "gold", {
        sub: `${titles.length} associated with this promotion`,
        force: true,
      }),
    );
    let derivable = 0;
    for (const t of titles) {
      const cy = y + TITLE_PITCH / 2;
      const isSel = t.t === selected;
      const isHov = t.t === hovered;
      const confident = t.assoc === "registry" || t.assocShare >= 0.85;
      quads.push({
        key: `tplat:${t.t}`,
        x: 0,
        y: cy,
        z: Z.platform,
        w: TIME_W + 8,
        h: TITLE_PITCH * 0.9,
        color: rgb(A.platform),
        alpha: isSel ? 0.95 : 0.4,
        kind: QK.PLATFORM,
        pick: t.t,
      });
      if (t.firstDay >= 0) {
        quads.push(
          spanQuad(
            `title:${t.t}`,
            axis,
            t.firstDay,
            t.lastDay,
            cy,
            isSel ? 4.4 : 3.2,
            isSel ? rgb(A.goldHot) : confident ? rgb(A.gold) : mix(A.goldDeep, A.gold, t.assocShare),
            isSel ? 1 : isHov ? 0.95 : 0.72,
            QK.TITLE,
            Z.title,
            t.t,
          ),
        );
        anchors.set(t.t, [axis.x((t.firstDay + t.lastDay) / 2), cy, Z.title]);
      } else {
        anchors.set(t.t, [0, cy, Z.title]);
      }
      // Documented title-match density along the belt's own lane.
      const maxTM = Math.max(1, ...t.yearCounts);
      for (let k = 0; k < t.yearCounts.length; k++) {
        const n = t.yearCounts[k] ?? 0;
        if (n <= 0) continue;
        const h = Math.max(0.12, activity01(n, maxTM) * (TITLE_PITCH * 0.3));
        quads.push({
          key: `tm:${t.t}:${t.yearFrom + k}`,
          x: axis.x(dayOfYear(t.yearFrom + k) + 182),
          y: cy - TITLE_PITCH * 0.28 - h / 2,
          z: Z.hist,
          w: barW,
          h,
          color: rgb(A.goldDeep),
          alpha: 0.55,
          kind: QK.TICK,
        });
      }
      if (t.lineage === "derived") derivable++;
      const caveats: string[] = [];
      if (t.lineage === "no-changes") caveats.push("no title-change records in this source");
      else caveats.push(`${t.reigns} documented reigns · ${t.holders} holders`);
      // A share of exactly 0.5 is a TIE, not a thin majority: the records did
      // not choose a promotion for this belt, the id ordering did. Saying
      // "50% of title matches" would read as evidence; it is the absence of it.
      if (t.assoc === "dominant" && t.assocShare <= 0.5) {
        caveats.push("promotion undecided by the records — placed by id order");
      } else if (!confident) {
        caveats.push(`${Math.round(t.assocShare * 100)}% of its title matches happened here`);
      }
      labels.push(
        laneLabel(
`titlelab:${t.t}`,
cy,
          Z.ruler,
          t.n,
          isSel ? PRIORITY.selected : isHov ? PRIORITY.hovered : activityPriority(t.titleMatches, data.maxTitleMatches),
          "gold",
          {
            sub: `${t.titleMatches.toLocaleString()} title matches · ${caveats.join(" · ")}`,
            badge: t.artifact
              ? "source artifact"
              : t.assoc === "dominant" && t.assocShare <= 0.5
                ? "undecided"
                : t.assoc === "dominant" && !confident
                  ? "cross-promotion"
                  : undefined,
            force: isSel || isHov,
            pick: t.t,
          },
        ),
      );
      lanes.push({
        key: t.t,
        label: t.n,
        y: cy,
        half: TITLE_PITCH / 2,
        group: "Championships",
        tone: "gold",
        pick: t.t,
      });
      y += TITLE_PITCH;
    }
    if (derivable < titles.length) {
      notes.push(
        `${titles.length - derivable} of ${titles.length} championships come from a source with no ` +
          `title-change field, so their reigns are not derived rather than guessed. Their documented ` +
          `title MATCHES are shown.`,
      );
    }
  }
  const topY = y + GROUP_GAP;

  /* ================= BOTTOM — wrestlers ================= */
  // Where the roster begins. The opening frame stops a little past it:
  // enough to see the era bands exist, not so much that the belts above
  // become a smear.
  const membersTopY = spineY - ZONE_GAP;
  y = membersTopY;
  let memberCount = 0;
  if (controls.showWrestlers && detail.members.length) {
    labels.push(
      laneLabel(
"zone:people",
y - 2, Z.ruler, "Documented participants", PRIORITY.header + 10, "muted", {
        sub: "appearance on a card — not employment",
        force: true,
      }),
    );
    const bands = bandMembers(detail, controls);
    for (const band of bands) {
      y -= GROUP_GAP * 0.5;
      labels.push(
        laneLabel(
`band:${band.key}`,
y, Z.ruler, band.label, PRIORITY.header, "muted", {
          badge: String(band.members.length),
          force: true,
        }),
      );
      quads.push({
        key: `banddiv:${band.key}`,
        x: 0,
        y: y + 1,
        z: Z.backdrop,
        w: TIME_W + 40,
        h: 0.4,
        color: rgb(A.ruleBright),
        alpha: 0.45,
        kind: QK.DIVIDER,
      });
      const packed = packRows(
        band.members.map((m) => ({ firstDay: m.firstDay, lastDay: m.lastDay })),
        120,
      );
      const bandH = packed.count * MEMBER_PITCH;
      for (let k = 0; k < band.members.length; k++) {
        const m = band.members[k]!;
        const cy = y - 2 - (packed.rows[k]! + 0.5) * MEMBER_PITCH;
        const isSel = m.p === selected;
        const isHov = m.p === hovered;
        const act = activity01(m.matches, Math.max(1, detail.matches / 40));
        const col = rel
          ? rgb(communityColor(rel.communityOf(m.p)))
          : mix(A.dim, A.same, 0.4);
        quads.push(
          spanQuad(
            `mem:${m.p}`,
            axis,
            m.firstDay,
            m.lastDay,
            cy,
            Math.max(0.5, MEMBER_PITCH * (0.35 + act * 0.4)),
            isSel ? rgb(A.select) : col,
            isSel ? 1 : isHov ? 0.95 : 0.42 + act * 0.35,
            QK.RAIL,
            Z.rail,
            m.p,
          ),
        );
        anchors.set(m.p, [axis.x((m.firstDay + m.lastDay) / 2), cy, Z.rail]);
        if (m.champ) {
          dots.push({
            key: `champdot:${m.p}`,
            x: axis.x(m.lastDay),
            y: cy,
            z: Z.dot,
            size: MEMBER_PITCH * 0.9,
            color: rgb(A.gold),
            alpha: 0.85,
            shape: DK.TITLE,
            pick: m.p,
          });
        }
        labels.push(
          label(
            `memlab:${m.p}`,
            axis.x(m.lastDay) + 1.5,
            cy,
            Z.ruler,
            m.n,
            isSel ? PRIORITY.selected : isHov ? PRIORITY.hovered : activityPriority(m.matches, Math.max(1, detail.matches / 40)),
            "person",
            {
              sub: `${m.matches.toLocaleString()} documented matches · ${yearOf(m.firstDay)}–${yearOf(m.lastDay)}`,
              force: isSel || isHov,
              pick: m.p,
            },
          ),
        );
        memberCount++;
      }
      lanes.push({
        key: `band:${band.key}`,
        label: band.label,
        y: y - 2 - bandH / 2,
        half: bandH / 2,
        group: "Participants",
        tone: "muted",
        pick: undefined,
      });
      y -= bandH + 3;
    }
    if (detail.membersTruncated) {
      notes.push(
        `${detail.membersTruncated.toLocaleString()} further documented participants are not laid out ` +
          `(roster cap in the projection). They remain counted in the ${detail.people.toLocaleString()} total.`,
      );
    }
  }

  /* ---------- relationships ---------- */
  if (rel && controls.showBundles) {
    const focus = selected && anchors.has(selected) && selected.startsWith("p:") ? selected : hovered;
    if (focus && focus.startsWith("p:") && anchors.has(focus)) {
      const from = anchors.get(focus)!;
      const links = rel
        .neighbours(focus)
        .filter((l) => anchors.has(l.id) && l.same + l.opposed + l.br >= controls.relThreshold)
        .sort((a, b) => b.same + b.opposed + b.br - (a.same + a.opposed + a.br));
      const drawn = links.slice(0, FIBER_CAP);
      for (const l of drawn) {
        const to = anchors.get(l.id)!;
        const total = l.same + l.opposed + l.br || 1;
        const col: [number, number, number] = [
          (A.same.r * l.same + A.opposed.r * l.opposed + A.br.r * l.br) / total,
          (A.same.g * l.same + A.opposed.g * l.opposed + A.br.g * l.br) / total,
          (A.same.b * l.same + A.opposed.b * l.opposed + A.br.b * l.br) / total,
        ];
        paths.push({
          key: `fib:${focus}|${l.id}`,
          points: [from[0], from[1], Z.rail + 0.05, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, Z.rail + 0.05, to[0], to[1], Z.rail + 0.05],
          color: col,
          alpha: 0.4,
          width: 1.4,
        });
      }
      if (links.length > drawn.length) {
        notes.push(
          `${(links.length - drawn.length).toLocaleString()} further documented relationships for the ` +
            `selected wrestler are not drawn (fibre cap ${FIBER_CAP}). Raise the relation threshold to see fewer, stronger links.`,
        );
      }
      notes.push(
        `Fibres shown for one wrestler only, at ${controls.relThreshold}+ documented encounters. ` +
          `Colour mixes opposed (ember), same-side (cyan) and battle-royal (olive) — never merged into one line.`,
      );
    }
  }

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
    state: "promotion",
    breadcrumbs: [
      { id: null, label: "All promotions" },
      { id: detail.id, label: detail.n },
    ],
    quads,
    dots,
    paths,
    labels,
    lanes,
    axis,
    bounds: { minX: axis.x0 - 20, maxX: axis.x1 + 30, minY: bottomY, maxY: topY },
    fitBounds: {
      minX: axis.x0 - 20,
      maxX: axis.x1 + 30,
      minY: Math.max(bottomY, membersTopY - Math.max(60, (topY - spineY) * 0.9)),
      maxY: topY,
    },
    anchors,
    stats: {
      represented: titles.length + memberCount,
      representedNoun: "championships and participants",
      labelled: 0,
      notes,
    },
  };
}

/* ---------- helpers ---------- */

function dayOfYear(year: number): number {
  return Math.round((Date.UTC(year, 0, 1) - Date.UTC(1900, 0, 1)) / 86400000);
}

interface Band {
  key: string;
  label: string;
  order: number;
  members: AtlasPromotionDetail["members"];
}

/**
 * Era bands.
 *
 * Default is the decade of a wrestler's FIRST documented appearance FOR THIS
 * PROMOTION — not their career start, which would put a 1990s WCW veteran in
 * the 1980s band of a promotion they first worked in 2003.
 */
function bandMembers(detail: AtlasPromotionDetail, controls: AtlasControls): Band[] {
  const map = new Map<string, Band>();
  for (const m of detail.members) {
    let key: string;
    let text: string;
    let order: number;
    if (controls.group === "alpha") {
      const c = (m.n[0] ?? "#").toUpperCase();
      key = /[A-Z]/.test(c) ? c : "#";
      text = key;
      order = key.charCodeAt(0);
    } else if (controls.group === "tier") {
      const v = m.matches;
      [key, order] =
        v >= 500 ? ["500+", 0] : v >= 100 ? ["100–499", 1] : v >= 20 ? ["20–99", 2] : v >= 5 ? ["5–19", 3] : ["under 5", 4];
      text = `${key} documented matches here`;
    } else if (controls.group === "firstYear") {
      const yy = m.firstDay >= 0 ? yearOf(m.firstDay) : 0;
      key = String(yy || "undated");
      text = key;
      order = yy || 9999;
    } else {
      const d = m.firstDay >= 0 ? decadeOf(m.firstDay) : 0;
      key = d ? `${d}s` : "undated";
      text = d ? `${d}s — first documented here` : "no dated record";
      order = d || 9999;
    }
    let b = map.get(key);
    if (!b) map.set(key, (b = { key, label: text, order, members: [] }));
    b.members.push(m);
  }
  const bands = [...map.values()].sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
  for (const b of bands) {
    b.members.sort(
      (x, y) => x.firstDay - y.firstDay || y.matches - x.matches || (x.p < y.p ? -1 : 1),
    );
  }
  return bands;
}
