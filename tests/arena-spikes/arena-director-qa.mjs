/**
 * Camera director QA.
 *
 * The three guarantees the brief sets, each measured rather than asserted:
 * every preset travels instead of cutting, manual input cancels direction
 * immediately, and no control silently does nothing.
 *
 * Run (dev server must be up):
 *   KAYFABE_BASE_URL=http://127.0.0.1:9464 node tests/arena-spikes/arena-director-qa.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const OUT = process.env.QA_ARENA_OUT ?? "/tmp/kayfabe-arena-director-qa.json";
const FLOOR_Y = -2.05;

const browser = await chromium.launch({
  headless: process.env.QA_HEADFUL !== "1",
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const results = [];
const notes = [];
const record = (row) => { results.push(row); console.log(JSON.stringify(row)); };

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));

  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 40000 });
  await page.waitForTimeout(3000);
  await page.getByRole("combobox", { name: /Search/ }).fill("Matt Sydal");
  await page.locator(".search-pop [role=option]").first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".search-pop [role=option]").first().click({ force: true });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Arena Array" }).click();
  await page.waitForSelector("canvas.arena-gl", { timeout: 20000 });
  await page.waitForFunction(() => window.__kayfabeArena && !window.__kayfabeArena.animating, null, { timeout: 20000 });
  await page.waitForTimeout(900);

  // Pin the tier. A governor step-down re-slices the card budget mid-run, and a
  // card selected before the step can legitimately stop being seated after it —
  // which looks like a director failure and is not one.
  await page.evaluate(() => { window.__kayfabeArena.autoQuality = false; });
  const fresh = await page.evaluate(() => typeof window.__kayfabeArena?.director?.apply === "function");
  record({ check: "bundle is current", hasDirector: fresh });
  if (!fresh) { notes.push("FAIL: stale bundle — director missing"); throw new Error("stale"); }

  // Select a real relationship so the pair presets have something to frame.
  //
  // The anchor is whatever setScope left selected, so it is captured before
  // choosing anything else. An earlier version guarded against a field that
  // does not exist (`layout.anchorId`), selected nothing usable, and both pair
  // presets then correctly refused with "that pair is not both seated" — the
  // director was right and the probe was wrong.
  const picked = await page.evaluate(() => {
    const r = window.__kayfabeArena;
    const anchor = r.selectedId;
    for (let slot = 0; slot < r.transition.capacity; slot++) {
      if (r.transition.state[slot] === 0) continue;
      const id = r.pool.idOf(slot);
      if (id && id !== anchor) { r.setSelected(id); return { anchor, selected: id }; }
    }
    return { anchor, selected: null };
  });
  record({ check: "a relationship is selected for the pair presets", ...picked });
  if (!picked.selected) notes.push("FAIL: could not select a non-anchor card; the pair presets are untested");

  // --- every preset travels, and none dives through the floor ------------
  for (const preset of ["establishing", "ring", "section", "relationship", "headToHead", "rail"]) {
    const row = await page.evaluate(async (key) => {
      const r = window.__kayfabeArena;
      r.controls.reset();
      r.setFormation("arena", true);
      await new Promise((res) => setTimeout(res, 900));
      const result = r.director.apply(key);
      // Sample the camera every frame and record the LARGEST single-frame
      // step in NDC-ish world terms. A cut shows up here as one huge step.
      const samples = [];
      let last = r.camera.position.clone();
      let minY = r.camera.position.y;
      for (let i = 0; i < 70; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const p = r.camera.position;
        samples.push(p.distanceTo(last));
        last = p.clone();
        minY = Math.min(minY, p.y);
      }
      const total = samples.reduce((a, b) => a + b, 0);
      return {
        preset: key, ok: result.ok, reason: result.reason ?? null,
        travelled: +total.toFixed(2),
        largestStep: +Math.max(...samples).toFixed(3),
        minCameraY: +minY.toFixed(2),
        active: r.director.active,
      };
    }, preset);
    record({ check: "preset travels without cutting", ...row });
    if (row.ok) {
      // A cut would put most of the journey into one frame. Damping spreads it.
      if (row.travelled > 0.5 && row.largestStep > row.travelled * 0.5) {
        notes.push(`FAIL: ${preset} moved ${row.largestStep} of ${row.travelled} in a single frame — that is a cut`);
      }
      if (row.minCameraY < FLOOR_Y) notes.push(`FAIL: ${preset} put the camera at y=${row.minCameraY}, below the floor`);
    } else if (!row.reason) {
      notes.push(`FAIL: ${preset} refused without giving a reason — that is a control silently doing nothing`);
    }
  }

  // --- manual input cancels direction ------------------------------------
  const cancel = await page.evaluate(async () => {
    const r = window.__kayfabeArena;
    r.controls.reset();
    await new Promise((res) => setTimeout(res, 600));
    r.director.apply("ring");
    const activeBefore = r.director.active;
    const directingBefore = r.director.directing;
    // A wheel event is genuine reader input and must win immediately.
    r.canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return {
      activeBefore, directingBefore,
      directingAfter: r.director.directing,
      activeAfter: r.director.active,
    };
  });
  record({ check: "manual input cancels automated direction", ...cancel });
  if (!cancel.directingBefore) notes.push("FAIL: director did not report directing after a preset");
  if (cancel.directingAfter) notes.push("FAIL: a wheel event did not cancel the directed move");

  // --- refusals are honest, not silent -----------------------------------
  const refusal = await page.evaluate(() => {
    const r = window.__kayfabeArena;
    // A person scope carries no title-year projection, so the rail preset has
    // nothing to frame. It must SAY so rather than quietly not moving.
    const result = r.director.apply("rail");
    return { hasRail: Boolean(r.director), ok: result.ok, reason: result.reason ?? null };
  });
  record({ check: "an unavailable preset explains itself", ...refusal });
  if (!refusal.ok && !refusal.reason) notes.push("FAIL: rail preset refused with no reason");

  // --- R and Home restore a valid view ------------------------------------
  const restore = await page.evaluate(async () => {
    const r = window.__kayfabeArena;
    r.director.apply("headToHead");
    await new Promise((res) => setTimeout(res, 900));
    r.director.reset();
    await new Promise((res) => setTimeout(res, 1200));
    const t = r.transition, cam = r.camera;
    const w = r.canvas.clientWidth, h = r.canvas.clientHeight;
    const V = Object.getPrototypeOf(cam.position).constructor;
    const v = new V();
    let inside = 0, total = 0;
    for (let i = 0; i < t.capacity; i++) {
      if (t.state[i] === 0) continue;
      total++;
      v.set(t.posCur[i * 3], t.posCur[i * 3 + 1], t.posCur[i * 3 + 2]).project(cam);
      const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
      if (x >= 0 && x <= w && y >= 0 && y <= h) inside++;
    }
    return { total, inside, pct: Math.round((inside / Math.max(1, total)) * 100), engaged: r.controls.engaged };
  });
  record({ check: "reset restores the formation's own framing", ...restore });
  if (restore.pct < 100) notes.push(`FAIL: after reset only ${restore.pct}% of cards are in frame`);
  if (restore.engaged) notes.push("FAIL: reset left the camera engaged, so the formation cannot re-frame it");

  record({ check: "console errors", errors: errors.length, sample: errors.slice(0, 3) });
  if (errors.length) notes.push(`FAIL: ${errors.length} console errors`);
  await context.close();
} finally {
  await browser.close();
}

writeFileSync(OUT, JSON.stringify({ results, notes }, null, 2));
console.log(notes.length ? `\n${notes.length} PROBLEM(S):\n${notes.join("\n")}` : "\nall director checks passed");
process.exitCode = notes.length ? 1 : 0;
