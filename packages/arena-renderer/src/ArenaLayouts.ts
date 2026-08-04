/**
 * The precomputed target formations.
 *
 * Each layout writes position, orientation, scale and a semantic delay band
 * into the transition's target buffers and marks `present`. Nothing here is
 * random: the same scope and formation always produce byte-identical targets,
 * which is what lets a screenshot, a URL restore and a test agree.
 *
 *   ECHO    where these people sit in the canonical connectome
 *   ARENA   how they relate to the selected subject
 *   INDEX   what the complete set is, precisely and readably
 */
import type { ArenaTransition, SlotPool } from "./ArenaTransition";
import {
  AB, BAND, CARD_H, CARD_W, bandDelay, prominence,
  type ArenaCard, type ArenaLayoutResult, type ArenaSection,
} from "./types";

function writeQuat(t: ArenaTransition, slot: number, yaw: number, pitch: number): void {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
  const o = slot * 4;
  t.quatTo[o] = cy * sx;
  t.quatTo[o + 1] = sy * cx;
  t.quatTo[o + 2] = -sy * sx;
  t.quatTo[o + 3] = cy * cx;
}

function writeCard(
  t: ArenaTransition, slot: number,
  x: number, y: number, z: number,
  yaw: number, pitch: number,
  scale: number, band: number, bow = 0,
): void {
  const i3 = slot * 3;
  t.posTo[i3] = x;
  t.posTo[i3 + 1] = y;
  t.posTo[i3 + 2] = z;
  t.scaleTo[i3] = CARD_W * scale;
  t.scaleTo[i3 + 1] = CARD_H * scale;
  t.scaleTo[i3 + 2] = 1;
  writeQuat(t, slot, yaw, pitch);
  t.delay[slot] = bandDelay(band);
  t.bow[slot] = bow;
  t.present[slot] = 1;
}

/**
 * ECHO — the entrance topology.
 *
 * Real canonical positions from global-layout@3, compressed into the arena's
 * own scale. The brief's requirement that cards "do not begin thousands of
 * units apart" is already satisfied by the projection, whose coordinates live
 * in roughly a unit box; the compression here is for legibility, not rescue.
 */
export function layoutEcho(
  t: ArenaTransition, pool: SlotPool, cards: readonly ArenaCard[], anchorId: string,
): ArenaLayoutResult {
  const t0 = performance.now();
  t.present.fill(0);
  const SPREAD = 13;
  let seated = 0;
  let dropped = 0;
  for (const card of cards) {
    const slot = pool.acquire(card.id);
    if (slot < 0) { dropped++; continue; }
    const p = card.pos;
    writeCard(
      t, slot,
      (p ? p[0] : 0) * SPREAD,
      (p ? p[1] - 0.35 : 0) * SPREAD * 0.55,
      (p ? p[2] : 0) * SPREAD,
      0, 0, 0.72,
      card.id === anchorId ? BAND.CENTER : BAND.AMBIENT,
    );
    seated++;
  }
  return {
    seated, dropped, layoutMs: performance.now() - t0, sections: [], extent: SPREAD,
    notes: ["source topology: canonical global-layout@3 positions, compressed"],
  };
}

/**
 * ARENA — the semantic horseshoe.
 *
 * Sections are supplied rather than assumed, because a person scope and a
 * promotion scope section on different things. SPIKE 1 caught the cost of
 * assuming: reusing relationship banks for a promotion matched nothing and
 * seated exactly one card while still reporting a full slot count.
 */
export function layoutArena(
  t: ArenaTransition, pool: SlotPool, cards: readonly ArenaCard[], anchorId: string,
  sections: readonly ArenaSection[],
): ArenaLayoutResult {
  const t0 = performance.now();
  t.present.fill(0);
  const notes: string[] = [];
  const sectionCounts: { key: string; label: string; count: number }[] = [];
  let dropped = 0;
  let seated = 0;

  const anchorSlot = pool.acquire(anchorId);
  if (anchorSlot >= 0) {
    writeCard(t, anchorSlot, 0, 0.55, 2.2, 0, -0.06, 1.7, BAND.CENTER);
    seated++;
  }

  let maxStrength = 0;
  for (const c of cards) if (c.strength > maxStrength) maxStrength = c.strength;
  let extent = 8;

  for (const section of sections) {
    let count = 0;
    for (const card of cards) if (card.id !== anchorId && section.match(card)) count++;
    if (count === 0) continue;
    const perTier = Math.max(6, Math.ceil(Math.sqrt(count) * 1.7));
    let i = 0;
    for (const card of cards) {
      if (card.id === anchorId || !section.match(card)) continue;
      const slot = pool.acquire(card.id);
      if (slot < 0) { dropped++; i++; continue; }
      const tier = Math.floor(i / perTier);
      const seat = i % perTier;
      const inTier = Math.min(perTier, count - tier * perTier);
      const f = inTier === 1 ? 0.5 : seat / (inTier - 1);
      const angle = section.from + (section.to - section.from) * f;
      const radius = 6.4 + tier * 1.85;
      if (radius > extent) extent = radius;
      // Size the card to the seat it actually has. A fixed card width against a
      // crowded bank makes neighbours overlap — 197 opponents across this arc
      // gives roughly 0.54 units of pitch per seat against a 1.55-unit card,
      // which merges the whole tier into one continuous slab instead of a row
      // of plaques. Seats set the size; prominence varies it within that.
      const pitch = (Math.abs(section.to - section.from) * radius) / Math.max(1, inTier);
      const fit = Math.min(1, (pitch * 0.82) / CARD_W);
      writeCard(
        t, slot,
        Math.sin(angle) * radius, -0.4 + tier * 1.02, Math.cos(angle) * radius * 0.82,
        angle + Math.PI, -0.13,
        prominence(card.strength, maxStrength) * fit,
        card.bank === AB.AGGREGATE ? BAND.AGGREGATE : BAND.DIRECT,
        1,
      );
      seated++;
      i++;
    }
    sectionCounts.push({ key: section.key, label: section.label, count });
  }
  if (dropped > 0) notes.push(`${dropped} cards exceeded the instance budget and were not seated`);
  return { seated, dropped, layoutMs: performance.now() - t0, sections: sectionCounts, extent, notes };
}

/**
 * INDEX — the archival wall.
 *
 * A row is one semantic group and column order is rank inside it. Every card
 * converges to the same camera-facing orientation and near-uniform scale,
 * because this formation is for comparison rather than emphasis. The subject
 * stays larger; nothing else does.
 */
export function layoutIndex(
  t: ArenaTransition, pool: SlotPool, cards: readonly ArenaCard[], anchorId: string,
  groupOf: (card: ArenaCard) => string,
): ArenaLayoutResult {
  const t0 = performance.now();
  t.present.fill(0);
  const notes: string[] = [];
  let dropped = 0;
  let seated = 0;

  const groups = new Map<string, ArenaCard[]>();
  for (const card of cards) {
    if (card.id === anchorId) continue;
    const key = groupOf(card);
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(card);
  }
  const keys = [...groups.keys()].sort();

  const COLS = 18;
  const COL_W = 1.78;
  const ROW_H = 1.16;
  const sections: { key: string; label: string; count: number }[] = [];
  let row = 0;
  for (const key of keys) {
    const members = groups.get(key)!;
    for (let i = 0; i < members.length; i++) {
      const card = members[i]!;
      const slot = pool.acquire(card.id);
      if (slot < 0) { dropped++; continue; }
      const col = i % COLS;
      const subRow = Math.floor(i / COLS);
      writeCard(
        t, slot,
        (col - (COLS - 1) / 2) * COL_W, -(row + subRow) * ROW_H, 0,
        0, 0, 0.94, BAND.DIRECT,
      );
      seated++;
    }
    sections.push({ key, label: key, count: members.length });
    row += Math.ceil(members.length / COLS) + 1; // a blank line per heading
  }

  const anchorSlot = pool.acquire(anchorId);
  if (anchorSlot >= 0) {
    writeCard(t, anchorSlot, 0, ROW_H * 1.6, 0.4, 0, 0, 1.5, BAND.CENTER);
    seated++;
  }
  if (dropped > 0) notes.push(`${dropped} cards exceeded the instance budget`);
  const extent = Math.max((COLS * COL_W) / 2, (row * ROW_H) / 2 + 2);
  return { seated, dropped, layoutMs: performance.now() - t0, sections, extent, notes };
}

/** A person scope seats by documented relationship. Mixed takes the shallow
 *  front arc because it reads first. */
export function personSections(): ArenaSection[] {
  return [
    { key: "mixed", label: "Fought and teamed", from: -0.34, to: 0.34, match: (c) => c.bank === AB.MIXED },
    { key: "opposed", label: "Opponents", from: 0.42, to: 2.44, match: (c) => c.bank === AB.OPPOSED },
    { key: "same", label: "Tag partners", from: -2.44, to: -0.42, match: (c) => c.bank === AB.SAME },
  ];
}

/** A promotion scope has no relationship banks — its cards carry an era.
 *  Eras fan chronologically across the horseshoe. */
export function eraSections(cards: readonly ArenaCard[]): ArenaSection[] {
  const eras = [...new Set(cards.map((c) => c.era))].sort();
  const FROM = -2.44;
  const TO = 2.44;
  const width = (TO - FROM) / Math.max(1, eras.length);
  return eras.map((era, i) => ({
    key: era,
    label: era,
    from: FROM + i * width + width * 0.06,
    to: FROM + (i + 1) * width - width * 0.06,
    match: (c: ArenaCard) => c.era === era,
  }));
}
