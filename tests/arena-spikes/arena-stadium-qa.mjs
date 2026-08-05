/**
 * Arena stadium QA — the shell, its budgets, and the things it must not break.
 *
 * Checks that the environment reads as a stadium without becoming the subject:
 * draw-call budgets per tier, rebuild counts (no per-frame geometry), the
 * architecture staying out of the card picking path, resource release, and
 * the reader still being able to see every card.
 *
 * Run (dev server must be up):
 *   KAYFABE_BASE_URL=http://127.0.0.1:9463 node tests/arena-spikes/arena-stadium-qa.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const OUT = process.env.QA_ARENA_OUT ?? "/tmp/kayfabe-arena-stadium-qa.json";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/kayfabe-arena-shots";
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({
  headless: process.env.QA_HEADFUL !== "1",
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const results = [];
const notes = [];
const record = (row) => { results.push(row); console.log(JSON.stringify(row)); };

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
  await page.waitForTimeout(900);
};

try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  await openArena(page, "Matt Sydal");

  // A STALE dev server serves cached packages/* modules while apps/web HMRs
  // fine, and every number below would then describe the OLD renderer. Reading
  // a newly-added field is the cheapest way to prove the bundle is current.
  const fresh = await page.evaluate(() => ({
    hasEnvironment: Boolean(window.__kayfabeArena?.environment),
    hasMoveTo: typeof window.__kayfabeArena?.controls?.moveTo === "function",
    hasInputSeq: typeof window.__kayfabeArena?.controls?.userInputSeq === "number",
  }));
  record({ check: "bundle is current (not a stale dev server)", ...fresh });
  if (!fresh.hasEnvironment || !fresh.hasMoveTo) {
    notes.push("FAIL: stale bundle — restart vite on a fresh port before trusting any number here");
    throw new Error("stale bundle");
  }

  // --- draw-call attribution -------------------------------------------
  // Measured by DIFFERENCE, with the shell suspended and restored, because a
  // budget claimed from intent rather than from the frame is not a measurement.
  const budgets = { high: 24, medium: 12, low: 6 };
  for (const tier of ["high", "medium", "low"]) {
    const row = await page.evaluate(async (t) => {
      const r = window.__kayfabeArena;
      r.autoQuality = false;
      r.applyTier(t);
      await new Promise((res) => setTimeout(res, 700));
      const frameWith = r.drawCalls;
      const was = r.environment.suspend();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const frameWithout = r.drawCalls;
      r.environment.restore(was);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return {
        tier: t,
        frameDrawCalls: frameWith,
        withoutShell: frameWithout,
        environmentDrawCalls: r.environment.drawCalls,
        measuredDelta: frameWith - frameWithout,
        rebuilds: r.environment.rebuilds,
        buildMs: Number(r.environment.lastBuildMs.toFixed(2)),
        wallMs: Number(r.frameWallMs.toFixed(1)),
        cpuMs: Number(r.frameTimeMs.toFixed(2)),
      };
    }, tier);
    record({ check: "environment draw-call budget", ...row, budget: budgets[tier] });
    if (row.environmentDrawCalls > budgets[tier]) {
      notes.push(`FAIL: ${tier} environment uses ${row.environmentDrawCalls} draw calls against a budget of ${budgets[tier]}`);
    }
  }

  // --- what the shell costs the frame ------------------------------------
  // Reported as a DIFFERENCE against the same scene with the shell suspended,
  // per tier. The absolute figures here are a software rasteriser (headless is
  // SwiftShader) and are not comparable to hardware; the delta is the honest
  // measure of what the architecture added.
  for (const tier of ["low", "high"]) {
    const cost = await page.evaluate(async (t) => {
      const r = window.__kayfabeArena;
      const settle = (ms) => new Promise((res) => setTimeout(res, ms));
      r.autoQuality = false;
      r.applyTier(t);
      await settle(2200);
      const withShell = r.frameWallMs;
      const was = r.environment.suspend();
      r.frameWallEmaMs = 0; r.lastFrameMs = 0;
      await settle(2200);
      const without = r.frameWallMs;
      r.environment.restore(was);
      r.frameWallEmaMs = 0; r.lastFrameMs = 0;
      return { tier: t, withShellMs: +withShell.toFixed(1), withoutShellMs: +without.toFixed(1),
               shellCostMs: +(withShell - without).toFixed(1) };
    }, tier);
    record({ check: "shell frame cost (SwiftShader, delta is the measure)", ...cost });
    // The low tier exists to stay usable on the worst path it will meet. A
    // shell that doubles its frame time has taken away the only thing the low
    // tier promises.
    if (tier === "low" && cost.shellCostMs > cost.withoutShellMs) {
      notes.push(`FAIL: the shell costs ${cost.shellCostMs}ms against a ${cost.withoutShellMs}ms baseline at low tier — it more than doubles the frame`);
    }
  }

  // --- the shell is not rebuilt per frame --------------------------------
  const churn = await page.evaluate(async () => {
    const r = window.__kayfabeArena;
    r.applyTier("high");
    await new Promise((res) => setTimeout(res, 800));
    const before = r.environment.rebuilds;
    await new Promise((res) => setTimeout(res, 2000));
    const idle = r.environment.rebuilds - before;
    // Formation round trip must be a visibility flip, not two rebuilds.
    r.setFormation("index");
    await new Promise((res) => setTimeout(res, 1600));
    r.setFormation("arena");
    await new Promise((res) => setTimeout(res, 1600));
    return { idleRebuilds: idle, roundTripRebuilds: r.environment.rebuilds - before - idle };
  });
  record({ check: "shell rebuilds only when its inputs change", ...churn });
  if (churn.idleRebuilds !== 0) notes.push(`FAIL: shell rebuilt ${churn.idleRebuilds}x while idle`);
  if (churn.roundTripRebuilds !== 0) notes.push(`FAIL: arena->index->arena rebuilt the shell ${churn.roundTripRebuilds}x; it should be a visibility flip`);

  // --- architecture never intercepts a card pick -------------------------
  //
  // Measured WITH and WITHOUT the shell, and compared. An absolute miss count
  // proves nothing here: cards genuinely occlude one another in a horseshoe
  // viewed from above, so a pick at one card's projected centre can correctly
  // return the nearer card in front of it. The question the acceptance
  // criterion actually asks is whether the ARCHITECTURE changes any answer —
  // and identical results with the stadium built and suspended is the only
  // evidence that settles it.
  const picking = await page.evaluate(async () => {
    const r = window.__kayfabeArena;
    const sample = () => {
      const t = r.transition, cam = r.camera;
      const w = r.canvas.clientWidth, h = r.canvas.clientHeight;
      const V = Object.getPrototypeOf(cam.position).constructor;
      const v = new V();
      let tested = 0, hit = 0, exact = 0;
      const ids = [];
      for (let slot = 0; slot < t.capacity; slot++) {
        if (t.state[slot] === 0) continue;
        const id = r.pool.idOf(slot);
        if (!id) continue;
        v.set(t.posCur[slot * 3], t.posCur[slot * 3 + 1], t.posCur[slot * 3 + 2]).project(cam);
        const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
        if (x < 2 || y < 2 || x > w - 2 || y > h - 2) continue;
        tested++;
        const got = r.pick(x, y);
        if (got) { hit++; if (got.id === id) exact++; }
        ids.push(got ? got.id : null);
      }
      return { tested, hit, exact, ids };
    };
    const withShell = sample();
    const was = r.environment.suspend();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const withoutShell = sample();
    r.environment.restore(was);
    let differing = 0;
    for (let i = 0; i < withShell.ids.length; i++) {
      if (withShell.ids[i] !== withoutShell.ids[i]) differing++;
    }
    return {
      tested: withShell.tested,
      hitPct: Math.round((withShell.hit / Math.max(1, withShell.tested)) * 100),
      exactPct: Math.round((withShell.exact / Math.max(1, withShell.tested)) * 100),
      answersChangedByShell: differing,
    };
  });
  record({ check: "the shell changes no picking answer", ...picking });
  if (picking.hitPct < 90) notes.push(`FAIL: picking found only ${picking.hitPct}% of card centres with the stadium built`);
  if (picking.answersChangedByShell !== 0) {
    notes.push(`FAIL: the stadium changed ${picking.answersChangedByShell} picking answers — architecture is intercepting card picks`);
  }

  // --- every card still inside the viewport ------------------------------
  for (const vp of [{ w: 1920, h: 1080 }, { w: 1366, h: 768 }, { w: 390, h: 844 }]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(1200);
    const framing = await page.evaluate(() => {
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
      return { total, inside, cameraY: Number(cam.position.y.toFixed(2)) };
    });
    const pct = Math.round((framing.inside / Math.max(1, framing.total)) * 100);
    record({ check: "cards inside viewport with shell present", viewport: `${vp.w}x${vp.h}`, ...framing, insidePct: pct });
    if (pct < 100) notes.push(`FAIL: ${vp.w}x${vp.h} leaves ${100 - pct}% of cards off-screen`);
    // The camera must never drop below the floor plane.
    if (framing.cameraY < -2.05) notes.push(`FAIL: ${vp.w}x${vp.h} camera at y=${framing.cameraY} is below the floor`);
    await page.screenshot({ path: `${SHOTS}/stadium-${vp.w}x${vp.h}.png` });
  }

  record({ check: "console errors", errors: errors.length, sample: errors.slice(0, 3) });
  if (errors.length) notes.push(`FAIL: ${errors.length} console errors: ${errors.slice(0, 2).join(" | ")}`);

  await context.close();
} finally {
  await browser.close();
}

writeFileSync(OUT, JSON.stringify({ results, notes }, null, 2));
console.log(notes.length ? `\n${notes.length} PROBLEM(S):\n${notes.join("\n")}` : "\nall stadium checks passed");
process.exitCode = notes.length ? 1 : 0;
