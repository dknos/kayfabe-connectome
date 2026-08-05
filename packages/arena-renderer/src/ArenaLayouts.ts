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
  // Spread and card size are one decision, not two. At SPREAD 13 and scale
  // 0.72, 519 cards each about a unit wide sat inside a twelve-unit box: every
  // card overlapped several others and the topology this formation exists to
  // show was a solid grey slab. Cards read as POINTS here — the reading is
  // where these people sit in the connectome, not what any one card says — so
  // the field opens up and the card shrinks to match.
  const SPREAD = 34;
  const CARD_SCALE = 0.3;
  let seated = 0;
  let dropped = 0;
  for (const card of cards) {
    const slot = pool.acquire(card.id);
    if (slot < 0) { dropped++; continue; }
    const p = card.pos;
    const isAnchor = card.id === anchorId;
    writeCard(
      t, slot,
      (p ? p[0] : 0) * SPREAD,
      (p ? p[1] - 0.35 : 0) * SPREAD * 0.55,
      (p ? p[2] : 0) * SPREAD,
      // The subject stays findable in its own topology.
      0, 0, isAnchor ? CARD_SCALE * 3.4 : CARD_SCALE,
      isAnchor ? BAND.CENTER : BAND.AMBIENT,
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
  viewportAspect = 1.78,
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

  const COL_W = 1.78;
  const ROW_H = 1.16;
  // Columns follow the VIEWPORT, not a constant. A fixed 18 built a wall
  // roughly as tall as three screens and a third of one wide: the camera then
  // has to fit the height, so two thirds of the frame is empty and the cards
  // are small in the strip that is left. Solving for a grid whose proportions
  // match the frame is what makes "the complete set, precisely" readable.
  const population = cards.reduce((n, c) => (c.id === anchorId ? n : n + 1), 0);
  const COLS = Math.max(
    8,
    Math.min(48, Math.round(Math.sqrt(Math.max(1, population) * viewportAspect * (ROW_H / COL_W)))),
  );
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

/**
 * STADIUM — the subject headlining a stadium show.
 *
 * Same semantics as the Arena horseshoe — the sections are supplied, so a
 * person seats by relationship and a promotion by era — but the seating is the
 * composed environment's real bowl: the tier ellipses below ride the seating
 * measured from the Stad de Tanger GLB (manifest2: seat inner (17.1, 26.4)
 * rising to (29.2, 39.7) at y 1.5..11.0 — the bowl is strongly elliptical,
 * which is why rx and rz differ throughout). The strongest relationships
 * stand on the field as boards around the ring, the way a show's top matches
 * are billed, and the subject floats over the ring under the jumbotron.
 */
/**
 * Max |angle| a bowl seat is placed at; the gap it leaves at the back is the
 * entrance.
 *
 * Sized by the ENTRANCE STRUCTURE, not by taste. `ArenaStadium` parks an 11-unit
 * tron at z −26.0 with truss posts out to x ±6.2, and the innermost tier sits at
 * rx 18.2 — so at the old 2.85 the first seat each side landed at x ±5.23,
 * z −26.24: behind the screen and inside its width, which hid three people at
 * the low tier and more at every tier above it. 2.76 puts that seat at x ±6.78,
 * clear of the truss with room for the body's own width.
 */
const STADIUM_SWEEP = 2.76;
const SECTION_RANGE = 2.44; // the horseshoe range personSections/eraSections use
const HEADLINERS = 8;
const TIER_Y0 = 2.6, TIER_DY = 1.35;
const TIER_RX0 = 18.2, TIER_DRX = 1.75;
const TIER_RZ0 = 27.4, TIER_DRZ = 2.0;

export function layoutStadium(
  t: ArenaTransition, pool: SlotPool, cards: readonly ArenaCard[], anchorId: string,
  sections: readonly ArenaSection[],
): ArenaLayoutResult {
  const t0 = performance.now();
  t.present.fill(0);
  const notes: string[] = [];
  const sectionCounts: { key: string; label: string; count: number }[] = [];
  let dropped = 0;
  let seated = 0;

  // Hovering just over the ring: the jumbotron above carries the name in
  // lights, the card carries the data. Both saying it at the same height read
  // as one blown-out sign.
  const anchorSlot = pool.acquire(anchorId);
  if (anchorSlot >= 0) {
    writeCard(t, anchorSlot, 0, 3.4, 0, 0, 0, 2.0, BAND.CENTER);
    seated++;
  }

  let maxStrength = 0;
  for (const c of cards) if (c.strength > maxStrength) maxStrength = c.strength;

  // Field boards: the top of the card, billed on the floor. Strongest stands
  // centre-most, and the arc faces OUT toward the broadcast camera — these are
  // billboards for the reader, not seats facing the ring.
  const billed = new Set<string>();
  const people = cards
    .filter((c) => c.id !== anchorId && c.represents === undefined)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, HEADLINERS);
  for (let i = 0; i < people.length; i++) {
    const card = people[i]!;
    const slot = pool.acquire(card.id);
    if (slot < 0) { dropped++; continue; }
    // 0, -1, +1, -2, +2… of a 0.34 rad pitch: strongest centre-most.
    const step = Math.ceil(i / 2) * (i % 2 === 1 ? -1 : 1);
    const angle = step * 0.34;
    writeCard(
      t, slot,
      Math.sin(angle) * 9.6, 1.15, Math.cos(angle) * 10.4,
      angle, -0.04, 1.7, BAND.SPINE,
    );
    billed.add(card.id);
    seated++;
  }

  // The bowl. Sections keep their semantic spans, widened from the horseshoe's
  // range onto the stadium's near-full sweep.
  const remap = STADIUM_SWEEP / SECTION_RANGE;
  for (const section of sections) {
    let count = 0;
    for (const card of cards) {
      if (card.id === anchorId || billed.has(card.id) || !section.match(card)) continue;
      count++;
    }
    if (count === 0) continue;
    const from = Math.max(-STADIUM_SWEEP, Math.min(STADIUM_SWEEP, section.from * remap));
    const to = Math.max(-STADIUM_SWEEP, Math.min(STADIUM_SWEEP, section.to * remap));
    const perTier = Math.max(8, Math.ceil(Math.sqrt(count) * 2.1));
    let i = 0;
    for (const card of cards) {
      if (card.id === anchorId || billed.has(card.id) || !section.match(card)) continue;
      const slot = pool.acquire(card.id);
      if (slot < 0) { dropped++; i++; continue; }
      const tier = Math.floor(i / perTier);
      const seat = i % perTier;
      const inTier = Math.min(perTier, count - tier * perTier);
      const f = inTier === 1 ? 0.5 : seat / (inTier - 1);
      const angle = from + (to - from) * f;
      const rx = TIER_RX0 + tier * TIER_DRX;
      const rz = TIER_RZ0 + tier * TIER_DRZ;
      // Seat pitch on the mean radius decides the card's width, exactly as the
      // horseshoe does — a crowded bank must not merge into a slab.
      const pitch = (Math.abs(to - from) * (rx + rz) * 0.5) / Math.max(1, inTier);
      const fit = Math.min(1, (pitch * 0.82) / CARD_W);
      writeCard(
        t, slot,
        Math.sin(angle) * rx, TIER_Y0 + tier * TIER_DY, Math.cos(angle) * rz,
        angle + Math.PI, -0.12,
        prominence(card.strength, maxStrength) * fit * 0.92,
        card.bank === AB.AGGREGATE ? BAND.AGGREGATE : BAND.DIRECT,
        1,
      );
      seated++;
      i++;
    }
    sectionCounts.push({ key: section.key, label: section.label, count });
  }
  if (dropped > 0) notes.push(`${dropped} cards exceeded the instance budget and were not seated`);
  return {
    seated, dropped, layoutMs: performance.now() - t0,
    sections: sectionCounts, extent: TIER_RZ0 + 5 * TIER_DRZ, notes,
  };
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
