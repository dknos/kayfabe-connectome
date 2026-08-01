import {
  M,
  MR,
  RK,
  hash01,
  rgb,
  type LayoutBounds,
  type MorphLabel,
  type MorphRegion,
} from "@kayfabe/morph-renderer";
import type { MorphData } from "../morphAdapter";
import { PRIORITY, RACK, Z, growBounds } from "./layoutTypes";

/**
 * Deterministic compression of everything that is not part of the active
 * reading. The graph visibly reorganises rather than vanishing: promotions
 * dock into a labeled top shelf, championships into a gold lower shelf, and
 * every remaining person packs into contiguous community grids in a context
 * field below the board — grouped by community (largest first), ordered by
 * degree inside each block. Same corpus, same board → identical packing.
 */
export function packBackground(
  data: MorphData,
  exclude: Set<number>,
  board: LayoutBounds,
  targets: Float32Array,
  opacity: Float32Array,
  scale: Float32Array,
  role: Uint8Array,
  delay: Float32Array,
  bounds: LayoutBounds,
): { regions: MorphRegion[]; labels: MorphLabel[] } {
  const regions: MorphRegion[] = [];
  const labels: MorphLabel[] = [];
  const model = data.model;
  const n = data.count;

  const boardW = board.maxX - board.minX;
  const fieldW = Math.max(1200, boardW + RACK.margin * 2);
  const fieldLeft = (board.minX + board.maxX) / 2 - fieldW / 2;
  const cols = Math.max(40, Math.floor(fieldW / RACK.cell));

  // ---- people: contiguous community blocks in the context field ----
  const byCommunity = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (exclude.has(i) || model.nodes.type[i] !== 0) continue;
    const c = model.nodes.community[i]!;
    let arr = byCommunity.get(c);
    if (!arr) byCommunity.set(c, (arr = []));
    arr.push(i);
  }
  const communities = [...byCommunity.keys()].sort((a, b) => {
    const sa = byCommunity.get(a)!.length;
    const sb = byCommunity.get(b)!.length;
    return sb - sa || a - b;
  });

  const fieldTop = board.minY - RACK.margin;
  let cursor = 0;
  const cellX = (c: number) => fieldLeft + (c + 0.5) * RACK.cell;
  const cellY = (r: number) => fieldTop - (r + 0.5) * RACK.cell;

  let labelled = 0;
  for (const c of communities) {
    const membersArr = byCommunity.get(c)!;
    membersArr.sort((a, b) => model.nodes.degree[b]! - model.nodes.degree[a]! || a - b);
    const startRow = Math.floor(cursor / cols);
    for (const i of membersArr) {
      const col = cursor % cols;
      const row = Math.floor(cursor / cols);
      cursor++;
      const i3 = i * 3;
      targets[i3] = cellX(col);
      targets[i3 + 1] = cellY(row);
      targets[i3 + 2] = Z.rack;
      opacity[i] = RACK.dimAlpha;
      scale[i] = RACK.scale;
      role[i] = MR.BACKGROUND;
      delay[i] = 0.3 + hash01(i) * 0.7;
      growBounds(bounds, targets[i3]!, targets[i3 + 1]!);
    }
    if (labelled < 10 && membersArr.length >= 250) {
      const lab = data.core.communities.label[c];
      if (lab) {
        labels.push({
          key: `rackc:${c}`,
          x: cellX(0) - 10,
          y: cellY(startRow),
          z: Z.rack,
          text: lab,
          priority: PRIORITY.ambient + membersArr.length / 1e6,
          tone: "muted",
          anchor: "left",
        });
        labelled++;
      }
    }
  }
  const fieldRows = Math.ceil(cursor / cols);
  if (fieldRows > 0) {
    regions.push({
      key: "rack:field",
      x: fieldLeft + fieldW / 2,
      y: fieldTop - (fieldRows * RACK.cell) / 2,
      z: Z.backplate,
      w: fieldW + 24,
      h: fieldRows * RACK.cell + 24,
      color: rgb(M.plate),
      alpha: 0.5,
      kind: RK.PLATE,
    });
    labels.push({
      key: "rack:field:h",
      x: fieldLeft,
      y: fieldTop + 12,
      z: Z.rack,
      text: "CONTEXT — COMMUNITIES, COMPRESSED",
      priority: PRIORITY.header - 20,
      tone: "muted",
      anchor: "left",
    });
  }

  // ---- promotions: labeled top shelf ----
  const promos: number[] = [];
  const titles: number[] = [];
  for (let i = 0; i < n; i++) {
    if (exclude.has(i)) continue;
    if (model.nodes.type[i] === 1) promos.push(i);
    else if (model.nodes.type[i] === 2) titles.push(i);
  }
  promos.sort((a, b) => model.nodes.matches[b]! - model.nodes.matches[a]! || a - b);
  titles.sort((a, b) => model.nodes.matches[b]! - model.nodes.matches[a]! || a - b);

  const shelfY = board.maxY + RACK.promoShelfGap;
  const shelfCols = Math.max(20, Math.floor(fieldW / 17));
  promos.forEach((i, k) => {
    const i3 = i * 3;
    targets[i3] = fieldLeft + ((k % shelfCols) + 0.5) * 17;
    targets[i3 + 1] = shelfY + Math.floor(k / shelfCols) * 15;
    targets[i3 + 2] = Z.rack;
    opacity[i] = 0.3;
    scale[i] = 4.4;
    role[i] = MR.BACKGROUND;
    delay[i] = 0.25 + hash01(i) * 0.5;
    growBounds(bounds, targets[i3]!, targets[i3 + 1]!);
  });
  if (promos.length > 0) {
    const rows = Math.ceil(promos.length / shelfCols);
    regions.push({
      key: "rack:promoshelf",
      x: fieldLeft + fieldW / 2,
      y: shelfY + ((rows - 1) * 15) / 2,
      z: Z.backplate,
      w: fieldW + 24,
      h: rows * 15 + 18,
      color: rgb(M.plate),
      alpha: 0.5,
      kind: RK.PLATE,
    });
    labels.push({
      key: "rack:promoshelf:h",
      x: fieldLeft,
      y: shelfY + rows * 15 + 4,
      z: Z.rack,
      text: "PROMOTIONS — shelf",
      priority: PRIORITY.header - 20,
      tone: "muted",
      anchor: "left",
    });
  }

  // ---- championships: gold lower shelf ----
  const goldTop = fieldTop - fieldRows * RACK.cell - 34;
  const goldCols = Math.max(30, Math.floor(fieldW / 9));
  titles.forEach((i, k) => {
    const i3 = i * 3;
    targets[i3] = fieldLeft + ((k % goldCols) + 0.5) * 9;
    targets[i3 + 1] = goldTop - Math.floor(k / goldCols) * 9;
    targets[i3 + 2] = Z.rack;
    opacity[i] = 0.2;
    scale[i] = 2.6;
    role[i] = MR.BACKGROUND;
    delay[i] = 0.3 + hash01(i) * 0.6;
    growBounds(bounds, targets[i3]!, targets[i3 + 1]!);
  });
  if (titles.length > 0) {
    const rows = Math.ceil(titles.length / goldCols);
    labels.push({
      key: "rack:goldshelf:h",
      x: fieldLeft,
      y: goldTop + 10,
      z: Z.rack,
      text: "CHAMPIONSHIPS — shelf",
      priority: PRIORITY.header - 21,
      tone: "gold",
      anchor: "left",
    });
    growBounds(bounds, fieldLeft, goldTop - rows * 9 - 10);
  }

  return { regions, labels };
}
