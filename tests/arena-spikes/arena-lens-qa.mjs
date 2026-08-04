/**
 * Arena Array lens QA — the acceptance criteria that need the real app.
 *
 * Covers: the lens opens, the default view is readable at both target
 * resolutions, a retained card is trackable Arena -> Index, and repeated lens
 * switching releases renderer resources.
 *
 * Run (dev server must be up): node tests/arena-spikes/arena-lens-qa.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const OUT = process.env.QA_ARENA_OUT ?? "/tmp/kayfabe-arena-lens-qa.json";
const browser = await chromium.launch({
  headless: process.env.QA_HEADFUL !== "1",
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const results = [];
const notes = [];

const openArena = async (page, subject) => {
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 40000 });
  await page.waitForTimeout(3000);
  const box = page.getByRole("combobox", { name: /Search/ });
  await box.fill(subject);
  await page.locator(".search-pop [role=option]").first().waitFor({ state: "visible", timeout: 15000 });
  await page.locator(".search-pop [role=option]").first().click({ force: true });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Arena Array" }).click();
  await page.waitForSelector("canvas.arena-gl", { timeout: 20000 });
  await page.waitForFunction(() => window.__kayfabeArena && !window.__kayfabeArena.animating, null, { timeout: 20000 });
};

try {
  for (const vp of [{ w: 1920, h: 1080 }, { w: 1366, h: 768 }]) {
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
    await openArena(page, "Psycho Clown");

    const readable = await page.evaluate(() => {
      const r = window.__kayfabeArena;
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
      return { total, inside, labels: r.labels.report, drawCalls: r.drawCalls, sections: r.layout.sections };
    });
    const row = {
      check: "default arena view is readable", viewport: `${vp.w}x${vp.h}`,
      cards: readable.total, insidePct: Math.round((readable.inside / readable.total) * 100),
      labelsShown: readable.labels.shown, labelsWanted: readable.labels.wanted,
      drawCalls: readable.drawCalls, sections: readable.sections, errors: errors.length,
    };
    results.push(row);
    console.log(JSON.stringify(row));
    if (row.insidePct < 100) notes.push(`FAIL: ${row.viewport} leaves ${100 - row.insidePct}% of cards off-screen`);
    if (errors.length) notes.push(`FAIL: ${row.viewport} runtime errors: ${errors.slice(0, 3).join(" | ")}`);

    // A retained card must travel, not teleport, from Arena into Index.
    const travel = await page.evaluate(async () => {
      const r = window.__kayfabeArena;
      const cam = r.camera, t = r.transition;
      const V = Object.getPrototypeOf(cam.position).constructor;
      const v = new V();
      let slot = -1;
      for (let i = 0; i < t.capacity; i++) if (t.state[i] !== 0 && r.pool.idOf(i) !== r.selectedId) { slot = i; break; }
      const project = () => {
        v.set(t.posCur[slot * 3], t.posCur[slot * 3 + 1], t.posCur[slot * 3 + 2]).project(cam);
        return { x: v.x, y: v.y };
      };
      const id = r.pool.idOf(slot);
      const path = [project()];
      r.setFormation("index");
      for (let i = 0; i < 200; i++) {
        await new Promise(requestAnimationFrame);
        path.push(project());
        if (!r.animating) break;
      }
      let maxStep = 0;
      for (let i = 1; i < path.length; i++) maxStep = Math.max(maxStep, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
      const net = Math.hypot(path[path.length - 1].x - path[0].x, path[path.length - 1].y - path[0].y);
      return { id, sameSlotAfter: r.pool.slotOf(id) === slot, samples: path.length, maxStep, net };
    });
    const trow = {
      check: "retained card travels Arena -> Index", viewport: `${vp.w}x${vp.h}`,
      ...travel, moved: travel.net > 0.05, noTeleport: travel.maxStep < travel.net * 0.4,
    };
    results.push(trow);
    console.log(JSON.stringify(trow));
    if (!trow.moved) notes.push(`FAIL: ${trow.viewport} card did not move between formations`);
    if (!trow.noTeleport) notes.push(`FAIL: ${trow.viewport} card teleported (max step ${travel.maxStep.toFixed(3)} of ${travel.net.toFixed(3)})`);
    if (!trow.sameSlotAfter) notes.push(`FAIL: ${trow.viewport} card changed instance across the formation change`);

    await context.close();
  }

  // Repeated lens switching must release renderer resources.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openArena(page, "Psycho Clown");
  const cycle = await page.evaluate(async () => {
    const readInfo = () => window.__kayfabeArena?.resourceInfo() ?? null;
    const baseline = readInfo();
    const click = async (name) => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
      btn?.click();
      await new Promise((r) => setTimeout(r, 900));
    };
    for (let i = 0; i < 4; i++) {
      await click("Connectome");
      await click("Arena Array");
    }
    await new Promise((r) => setTimeout(r, 1200));
    return { baseline, after: readInfo() };
  });
  const crow = {
    check: "repeated lens switching releases resources", cycles: 4,
    baseline: cycle.baseline, after: cycle.after,
    stable: !!cycle.after && !!cycle.baseline
      && cycle.after.geometries <= cycle.baseline.geometries
      && cycle.after.programs <= cycle.baseline.programs + 1,
    errors: errors.length,
  };
  results.push(crow);
  console.log(JSON.stringify(crow));
  if (!crow.stable) notes.push(`FAIL: renderer resources grew across lens switches: ${JSON.stringify(cycle)}`);
  if (errors.length) notes.push(`FAIL: lens-switch runtime errors: ${errors.slice(0, 3).join(" | ")}`);
  await context.close();

  console.log(JSON.stringify({ status: notes.length ? "issues" : "ok", notes }));
} finally {
  writeFileSync(OUT, `${JSON.stringify({ base: BASE, generatedAt: new Date().toISOString(), results, notes }, null, 2)}\n`);
  await browser.close();
}
