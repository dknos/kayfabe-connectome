/**
 * The precomputed target formations.
 *
 * Each layout writes position, orientation, scale and a semantic delay band
 * into the transition's target buffers for every card it seats, and marks
 * `present`. Nothing here allocates per card and nothing here is random: the
 * same scope and the same formation always produce byte-identical targets,
 * which is what lets a screenshot, a URL restore and a test agree.
 *
 * The three formations answer three different questions:
 *
 *   ECHO    where these people sit in the canonical connectome
 *   ARENA   how they relate to the selected subject
 *   INDEX   what the complete set is, precisely and readably
 */
import {
  BAND, FORMATION_DELAY_MAX, SlotPool, bandDelay, type FormationTransition,
} from "./formation-transition";
import type { SpikeCard } from "./spike-corpus";

export const CARD_W = 1.55;
export const CARD_H = 0.92;

/** Prominence is bounded on purpose: an unbounded map from match count to
 *  size makes one 170-match card dwarf the field and destroys the reading. */
export function prominence(strength: number, maxStrength: number): number {
  if (maxStrength <= 0) return 1;
  const t = Math.sqrt(Math.min(1, strength / maxStrength));
  return 0.82 + t * 0.62; // 0.82 … 1.44
}

function writeQuat(t: FormationTransition, slot: number, yaw: number, pitch: number): void {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
  const cx = Math.cos(pitch / 2), sx = Math.sin(pitch / 2);
  const o = slot * 4;
  t.quatTo[o] = cy * sx;
  t.quatTo[o + 1] = sy * cx;
  t.quatTo[o + 2] = -sy * sx;
  t.quatTo[o + 3] = cy * cx;
}

function writeCard(
  t: FormationTransition, slot: number,
  x: number, y: number, z: number,
  yaw: number, pitch: number,
  scale: number, band: number,
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
  t.present[slot] = 1;
}

export interface LayoutResult {
  seated: number;
  dropped: number;
  layoutMs: number;
  notes: string[];
}

function beginLayout(t: FormationTransition): void {
  t.present.fill(0);
}

/**
 * ECHO — the entrance topology.
 *
 * Real canonical positions from global-layout@3, compressed into the arena's
 * own scale. The spec's requirement that cards "do not begin thousands of
 * units apart" is already satisfied by the projection, whose coordinates live
 * in roughly a unit box; the compression here is about legibility, not about
 * rescuing a bad source. Cards are subdued and near-uniform because this
 * formation is a *source*, not a reading.
 */
export function layoutEcho(
  t: FormationTransition, pool: SlotPool, cards: SpikeCard[], anchorId: string,
): LayoutResult {
  const t0 = performance.now();
  beginLayout(t);
  const SPREAD = 13;
  let seated = 0;
  let dropped = 0;
  for (const card of cards) {
    const slot = pool.acquire(card.id);
    if (slot < 0) { dropped++; continue; }
    const p = card.pos;
    const x = (p ? p[0]! : 0) * SPREAD;
    const y = (p ? p[1]! - 0.35 : 0) * SPREAD * 0.55;
    const z = (p ? p[2]! : 0) * SPREAD;
    writeCard(t, slot, x, y, z, 0, 0, 0.72, card.id === anchorId ? BAND.CENTER : BAND.AMBIENT);
    seated++;
  }
  return { seated, dropped, layoutMs: performance.now() - t0, notes: ["source topology: global-layout@3 positions, compressed"] };
}

/**
 * ARENA — the semantic horseshoe.
 *
 * Bank is the corpus's own distinction between documented opposition and
 * documented partnership; a pair carrying both is a third thing and gets the
 * front. Tier is strength rank, so prominence is bounded and monotonic rather
 * than a free parameter. Every card is yawed to face the center stage, which
 * is what makes the bank read as seating rather than as a scatter.
 */
export function layoutArena(
  t: FormationTransition, pool: SlotPool, cards: SpikeCard[], anchorId: string,
): LayoutResult {
  const t0 = performance.now();
  beginLayout(t);
  const notes: string[] = [];
  let dropped = 0;
  let seated = 0;

  const anchorSlot = pool.acquire(anchorId);
  if (anchorSlot >= 0) {
    writeCard(t, anchorSlot, 0, 0.55, 2.2, 0, -0.06, 1.7, BAND.CENTER);
    seated++;
  }

  // Front (mixed) reads first, so it takes the shallowest arc; opposition and
  // partnership take the two flanks. Angles are measured from center stage.
  const BANKS: { key: SpikeCard["bank"]; from: number; to: number }[] = [
    { key: "mixed", from: -0.34, to: 0.34 },
    { key: "opposed", from: 0.42, to: 2.44 },
    { key: "same", from: -2.44, to: -0.42 },
  ];
  const maxStrength = cards.reduce((m, c) => Math.max(m, c.strength), 0);

  for (const bank of BANKS) {
    const members = cards.filter((c) => c.bank === bank.key && c.id !== anchorId);
    if (members.length === 0) continue;
    // Widest tier first keeps the strongest cards nearest the stage.
    const perTier = Math.max(6, Math.ceil(Math.sqrt(members.length) * 1.7));
    for (let i = 0; i < members.length; i++) {
      const card = members[i]!;
      const slot = pool.acquire(card.id);
      if (slot < 0) { dropped++; continue; }
      const tier = Math.floor(i / perTier);
      const seat = i % perTier;
      const count = Math.min(perTier, members.length - tier * perTier);
      const f = count === 1 ? 0.5 : seat / (count - 1);
      const angle = bank.from + (bank.to - bank.from) * f;
      const radius = 6.4 + tier * 1.85;
      const x = Math.sin(angle) * radius;
      const z = Math.cos(angle) * radius * 0.82;
      const y = -0.4 + tier * 1.02;
      writeCard(t, slot, x, y, z, angle + Math.PI, -0.13, prominence(card.strength, maxStrength), BAND.DIRECT);
      seated++;
    }
    notes.push(`${bank.key}: ${members.length} across ${Math.ceil(members.length / perTier)} tiers`);
  }
  if (dropped > 0) notes.push(`${dropped} cards exceeded the instance budget and were not seated`);
  return { seated, dropped, layoutMs: performance.now() - t0, notes };
}

/**
 * INDEX — the archival wall.
 *
 * Rows and columns both mean something: a row is one semantic group (bank in
 * a person scope, decade in a promotion scope) and column order is strength
 * rank inside it. Every card converges to the same camera-facing orientation
 * and the same scale, because the point of this formation is comparison, not
 * emphasis — the only card that stays larger is the subject.
 */
export function layoutIndex(
  t: FormationTransition, pool: SlotPool, cards: SpikeCard[], anchorId: string,
  groupOf: (card: SpikeCard) => string,
): LayoutResult {
  const t0 = performance.now();
  beginLayout(t);
  const notes: string[] = [];
  let dropped = 0;
  let seated = 0;

  const groups = new Map<string, SpikeCard[]>();
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
  let row = 0;
  for (const key of keys) {
    const members = groups.get(key)!;
    for (let i = 0; i < members.length; i++) {
      const card = members[i]!;
      const slot = pool.acquire(card.id);
      if (slot < 0) { dropped++; continue; }
      const col = i % COLS;
      const subRow = Math.floor(i / COLS);
      const x = (col - (COLS - 1) / 2) * COL_W;
      const y = -(row + subRow) * ROW_H;
      writeCard(t, slot, x, y, 0, 0, 0, 0.94, BAND.DIRECT);
      seated++;
    }
    row += Math.ceil(members.length / COLS) + 1; // a blank line per heading
    notes.push(`${key}: ${members.length}`);
  }

  const anchorSlot = pool.acquire(anchorId);
  if (anchorSlot >= 0) {
    writeCard(t, anchorSlot, 0, ROW_H * 1.6, 0.4, 0, 0, 1.5, BAND.CENTER);
    seated++;
  }
  if (dropped > 0) notes.push(`${dropped} cards exceeded the instance budget`);
  return { seated, dropped, layoutMs: performance.now() - t0, notes };
}

/** Delays are already normalized 0..1 by band; this exposes the resulting
 *  settle window so a test can assert everything lands on one frame. */
export const settleWindow = (): number => FORMATION_DELAY_MAX;
