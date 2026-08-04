/**
 * Arena Array navigation QA — the acceptance criteria for iteration 2.
 *
 * Covers what unit tests cannot: that the lens opens on the intended subject,
 * that a shared link still beats that default, that WASDQE actually moves the
 * camera without breaching the floor clamp, and that following someone to
 * their own array leaves a history entry the browser's Back button can use.
 *
 * Headless WebGL here is SwiftShader, so nothing below judges appearance or
 * frame time — every assertion reads state through __kayfabeArena.
 *
 * Run (dev server must be up): node tests/arena-spikes/arena-navigation-qa.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const SYDAL = "p:116704";
const CABANA = "p:108882";

const browser = await chromium.launch({
  headless: process.env.QA_HEADFUL !== "1",
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const openArena = async (page, hash) => {
  await page.goto(`${BASE}/#${hash}`);
  await page.waitForSelector("canvas.arena-gl", { timeout: 60000 });
  await page.waitForFunction(
    () => window.__kayfabeArena?.scope?.anchorId,
    null,
    { timeout: 60000 },
  );
  await page.waitForTimeout(1200);
};

const anchorOf = (page) => page.evaluate(() => window.__kayfabeArena?.scope?.anchorId ?? null);
const cameraOf = (page) =>
  page.evaluate(() => {
    const c = window.__kayfabeArena.camera;
    return { x: c.position.x, y: c.position.y, z: c.position.z };
  });

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // 1. the lens opens on Matt Sydal when the link names no subject
  await openArena(page, "2/lens=arena");
  const first = await anchorOf(page);
  record("default subject is Matt Sydal", first === SYDAL, first);

  // 2. a link that names a subject still wins over that default
  await openArena(page, `2/lens=arena/sel=${CABANA}`);
  const linked = await anchorOf(page);
  record("sel= beats the default", linked === CABANA, linked);

  // 3. WASDQE moves the camera, and never below the floor
  await openArena(page, "2/lens=arena");
  const before = await cameraOf(page);
  await page.locator("canvas.arena-gl").hover();
  for (const key of ["w", "a", "e"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(450);
    await page.keyboard.up(key);
  }
  await page.waitForTimeout(600);
  const after = await cameraOf(page);
  const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  record("WASDQE moves the camera", moved > 0.5, `travelled ${moved.toFixed(2)}`);
  record("camera stays above the floor", after.y > 0, `y=${after.y.toFixed(2)}`);

  // 4. typing must not walk the arena
  // The camera is damped, so it keeps easing for a moment after the last key
  // came up. Measuring before it settles reads that ease as drift.
  await page.waitForTimeout(1500);
  const parked = await cameraOf(page);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "qa-typing-probe";
    document.body.appendChild(input);
    input.focus();
  });
  await page.keyboard.down("w");
  await page.waitForTimeout(450);
  await page.keyboard.up("w");
  await page.waitForTimeout(400);
  const afterTyping = await cameraOf(page);
  const drift = Math.hypot(
    afterTyping.x - parked.x, afterTyping.y - parked.y, afterTyping.z - parked.z,
  );
  record("typing does not walk the arena", drift < 0.5, `drifted ${drift.toFixed(3)}`);
  await page.evaluate(() => document.getElementById("qa-typing-probe")?.remove());

  // 5. following a card to its own array through the real UI, then Back
  await openArena(page, "2/lens=arena");
  const subject = await anchorOf(page);
  // Project a seated card to screen coordinates and click it, which is the
  // only way to exercise picking, the inspector and the follow action as a
  // reader meets them.
  const target = await page.evaluate((anchor) => {
    const r = window.__kayfabeArena;
    const t = r.transition, cam = r.camera;
    const w = r.canvas.clientWidth, h = r.canvas.clientHeight;
    const V = Object.getPrototypeOf(cam.position).constructor;
    const v = new V();
    for (const card of r.scope.cards) {
      if (card.id === anchor || card.represents || !card.id.startsWith("p:")) continue;
      const slot = r.pool.slotOf(card.id);
      if (slot === undefined) continue;
      v.set(t.posCur[slot * 3], t.posCur[slot * 3 + 1], t.posCur[slot * 3 + 2]).project(cam);
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      if (x > 40 && x < w - 40 && y > 40 && y < h - 40) return { id: card.id, name: card.name, x, y };
    }
    return null;
  }, subject);

  if (!target) {
    record("follow a card to its own array", false, "no on-screen card to click");
  } else {
    const canvas = await page.locator("canvas.arena-gl").boundingBox();
    await page.mouse.click(canvas.x + target.x, canvas.y + target.y);
    const inspector = page.locator(".arena-inspector");
    const opened = await inspector.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false);
    record("clicking a card opens its detail", opened, target.name);

    if (opened) {
      const follow = inspector.getByRole("button", { name: /Open .*array/ });
      const hasFollow = await follow.count() > 0;
      record("detail offers to open their array", hasFollow, target.name);
      if (hasFollow) {
        await follow.click();
        await page.waitForFunction(
          (id) => window.__kayfabeArena?.scope?.anchorId === id, target.id, { timeout: 25000 },
        ).catch(() => {});
        const now = await anchorOf(page);
        record("following changes the subject", now === target.id, `${subject} -> ${now}`);

        const trail = await page.locator(".arena-trail .arena-trail-step").count();
        record("the trail records where we came from", trail >= 2, `${trail} steps`);

        await page.goBack();
        await page.waitForTimeout(2000);
        const back = await anchorOf(page);
        record("Back returns to the previous subject", back === subject, `${now} -> ${back}`);
      }
    }
  }

  // 6. the wire and its pulses answer for EVERY card, not just the near rows
  await openArena(page, "2/lens=arena");
  await page.waitForTimeout(2500);
  const canvasBox = await page.locator("canvas.arena-gl").boundingBox();
  const ranks = [];
  for (const frac of [0.02, 0.35, 0.7, 0.99]) {
    // Resolved fresh each time: the governor can demote the tier and re-seat
    // the pool between choosing a card and pointing at it, which makes
    // coordinates captured up front silently wrong.
    const card = await page.evaluate((f) => {
      const r = window.__kayfabeArena, tr = r.transition, cam = r.camera;
      const w = r.canvas.clientWidth, h = r.canvas.clientHeight;
      const V = Object.getPrototypeOf(cam.position).constructor;
      const v = new V();
      const on = [];
      r.scope.cards.forEach((c, i) => {
        if (c.id === r.scope.anchorId || c.represents) return;
        const s = r.pool.slotOf(c.id);
        if (s === undefined || tr.state[s] === 0) return;
        v.set(tr.posCur[s * 3], tr.posCur[s * 3 + 1], tr.posCur[s * 3 + 2]).project(cam);
        const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
        if (x > 30 && x < w - 30 && y > 30 && y < h - 30 && r.pick(x, y)?.id === c.id) {
          on.push({ rank: i, id: c.id, name: c.name, strength: c.strength, x, y });
        }
      });
      return on.length ? on[Math.min(on.length - 1, Math.floor(on.length * f))] : null;
    }, frac);
    if (!card) continue;
    await page.mouse.move(canvasBox.x + card.x, canvasBox.y + card.y);
    await page.waitForTimeout(700);
    const state = await page.evaluate(() => ({
      wire: window.__kayfabeArena.routes.pickTargets().filter((l) => l.visible).length,
      pulses: window.__kayfabeArena.pulses.count,
      hover: window.__kayfabeArena.hoverId ?? null,
    }));
    ranks.push({ ...card, ...state });
  }
  record("every rank is reachable", ranks.length === 4, `${ranks.length}/4 sampled`);
  record(
    "hovering any card draws exactly one wire",
    ranks.length > 0 && ranks.every((r) => r.wire === 1 && r.hover === r.id),
    ranks.map((r) => `#${r.rank}:${r.wire}`).join(" "),
  );
  record(
    "pulses ride it, scaled by encounters",
    ranks.length > 0 && ranks.every((r) => r.pulses >= 2)
      && ranks[0].pulses > ranks[ranks.length - 1].pulses,
    ranks.map((r) => `${r.strength}enc→${r.pulses}`).join(" "),
  );
  await page.mouse.move(canvasBox.x + 5, canvasBox.y + 5);
  await page.waitForTimeout(500);
  const idle = await page.evaluate(() => ({
    wire: window.__kayfabeArena.routes.pickTargets().filter((l) => l.visible).length,
    pulses: window.__kayfabeArena.pulses.count,
    hover: window.__kayfabeArena.hoverId ?? null,
    selected: window.__kayfabeArena.selectedId ?? null,
  }));
  record("nothing pulses while nothing is pointed at", idle.wire === 0 && idle.pulses === 0,
    `wire=${idle.wire} pulses=${idle.pulses} hover=${idle.hover} selected=${idle.selected}`);

  record("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
