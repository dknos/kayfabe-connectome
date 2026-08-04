/**
 * SPIKE 2 probe — picking.
 *
 * Answers one question: does instanced raycast or GPU-ID picking beat the
 * mechanism this repository already ships? MorphPicking.ts's projected-distance
 * scan is the incumbent, so the burden of proof is on the newcomers.
 *
 * GPU-ID is ground truth for AGREEMENT because it samples the exact pixel under
 * the pointer through the same vertex path the card draws with. Cost and
 * agreement are reported separately: a method can be fast and wrong.
 *
 * Run: node tests/arena-spikes/spike2-picking.mjs
 *      QA_HEADFUL=1 node tests/arena-spikes/spike2-picking.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const HEADFUL = process.env.QA_HEADFUL === "1";
const OUT = process.env.QA_SPIKE_OUT ?? "/tmp/kayfabe-arena-spike2.json";
const URL = `${BASE}/spikes/picking.html`;

const browser = await chromium.launch({
  headless: !HEADFUL,
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
const failures = [];
const notes = [];
const results = [];
page.on("console", (m) => m.type() === "error" && failures.push(`console: ${m.text()}`));
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

/**
 * Waiting for "not animating" is not enough. This page loses its WebGL context
 * once during boot and restores about 1.5 s later, and
 * WebGLRenderer.render() early-returns while it is lost — so an impatient probe
 * measures a dead context and reports confident zeros. The context must be
 * alive before any number is taken.
 */
const settle = async () => {
  await page.waitForFunction(
    () => window.__arenaPick && !window.__arenaPick.animating() && !window.__arenaPick.contextLost(),
    null,
    { timeout: 30000 },
  );
  // One extra frame so the post-restore re-commit has been composed.
  await page.evaluate(() => new Promise(requestAnimationFrame));
};

const assertLive = async (where) => {
  if (await page.evaluate(() => window.__arenaPick.contextLost())) {
    throw new Error(`${where}: WebGL context is lost — measurements would be silently empty`);
  }
};

/**
 * Sample every live card's projected centre, then ask each method what is
 * there. Agreement is measured against GPU-ID, and timing is measured over the
 * same points so the comparison is like for like.
 */
const sweep = async (label, opts) => {
  await assertLive(label);
  const r = await rawSweep(label, opts);
  // Ground-truth sanity: these points are aimed AT card centres, so GPU-ID must
  // hit a card on the overwhelming majority of them. A low number means the
  // reference is broken, and every agreement percentage derived from it is
  // meaningless rather than merely disappointing.
  if (r.samples > 0 && r.gpuSelfHitPct < 80) {
    throw new Error(
      `${label}: GPU ground truth hit only ${r.gpuSelfHitPct.toFixed(1)}% of card centres — reference is broken, agreement figures discarded`,
    );
  }
  return r;
};

const rawSweep = async (label, opts) =>
  page.evaluate(async ([tag, options]) => {
    const spike = window.__arenaPick;
    const methods = ["projected", "raycast", "gpu"];
    const slots = spike.liveSlotList();
    const points = [];
    for (const slot of slots) {
      const p = spike.slotScreen(slot);
      if (p && p.front && p.x > 4 && p.y > 4 && p.x < 1916 && p.y < 1076) points.push({ slot, x: p.x, y: p.y });
      if (points.length >= 220) break;
    }
    const timings = {};
    const answers = {};
    for (const method of methods) {
      const ms = [];
      const got = [];
      for (const pt of points) {
        const t0 = performance.now();
        const id = spike.pick(method, pt.x, pt.y);
        ms.push(performance.now() - t0);
        got.push(id);
      }
      ms.sort((a, b) => a - b);
      timings[method] = {
        p50: ms[Math.floor(ms.length * 0.5)] ?? 0,
        p95: ms[Math.floor(ms.length * 0.95)] ?? 0,
        max: ms[ms.length - 1] ?? 0,
      };
      answers[method] = got;
    }
    // Idle cost: pointing at empty space still scans/renders.
    const idle = {};
    for (const method of methods) {
      const ms = [];
      for (let i = 0; i < 40; i++) {
        const t0 = performance.now();
        spike.pick(method, 6, 6);
        ms.push(performance.now() - t0);
      }
      ms.sort((a, b) => a - b);
      idle[method] = ms[Math.floor(ms.length * 0.5)] ?? 0;
    }
    const truth = answers.gpu;
    const agree = (m) => {
      let same = 0;
      let missed = 0;
      for (let i = 0; i < truth.length; i++) {
        if (answers[m][i] === truth[i]) same++;
        else if (answers[m][i] === -1 && truth[i] !== -1) missed++;
      }
      return { agreePct: truth.length ? (same / truth.length) * 100 : 0, missedHits: missed };
    };
    return {
      tag, options, samples: points.length,
      cards: spike.cardCount(),
      timings, idle,
      projectedVsGpu: agree("projected"),
      raycastVsGpu: agree("raycast"),
      gpuSelfHitPct: truth.length ? (truth.filter((v) => v !== -1).length / truth.length) * 100 : 0,
    };
  }, [label, opts]);

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__arenaPick?.ready === true, null, { timeout: 30000 });
  const gpu = await page.evaluate(() => window.__arenaPick.gpu());
  const software = /swiftshader|llvmpipe|software/i.test(gpu);
  console.log(JSON.stringify({ gpu, software }));

  // ---- scale sweep, settled arena ----
  for (const [scopeKey, budget] of [
    ["person:p:d7fbacefc", 160], ["person:p:108882", 360], ["person:p:108882", 600],
  ]) {
    await page.evaluate(([k, n]) => window.__arenaPick.select(k, n), [scopeKey, budget]);
    await settle();
    const r = await sweep(`settled-${budget}`, { budget });
    results.push(r);
    console.log(JSON.stringify(r));
  }

  // ---- camera moving ----
  await page.evaluate(() => window.__arenaPick.select("person:p:108882", 600));
  await settle();
  await page.evaluate(() => window.__arenaPick.setOrbit(true));
  await page.waitForTimeout(400);
  const orbit = await sweep("camera-orbiting", { budget: 600 });
  results.push(orbit);
  console.log(JSON.stringify(orbit));
  await page.evaluate(() => window.__arenaPick.setOrbit(false));

  // ---- mid-transition: the case the audit says only GPU survives ----
  await page.evaluate(() => window.__arenaPick.setFormation("index"));
  await page.waitForTimeout(280); // deliberately mid-flight
  const during = await sweep("mid-transition", { budget: 600 });
  results.push(during);
  console.log(JSON.stringify(during));
  await settle();

  // ---- the stale-boundingSphere trap, reproduced on purpose ----
  await page.evaluate(() => window.__arenaPick.setBoundsPolicy("never"));
  await page.evaluate(() => window.__arenaPick.setFormation("arena"));
  await page.waitForTimeout(280);
  const stale = await sweep("mid-transition-stale-bounds", { budget: 600, bounds: "never" });
  results.push(stale);
  console.log(JSON.stringify(stale));
  await settle();
  await page.evaluate(() => window.__arenaPick.setBoundsPolicy("always"));

  // ---- high-DPI ----
  await page.evaluate(() => window.__arenaPick.setPixelRatio(2));
  await page.waitForTimeout(300);
  const dpr2 = await sweep("dpr-2", { budget: 600, dpr: 2 });
  results.push(dpr2);
  console.log(JSON.stringify(dpr2));
  await page.evaluate(() => window.__arenaPick.setPixelRatio(1));

  if (failures.length) notes.push(`runtime failures: ${failures.join(" | ")}`);
  console.log(JSON.stringify({ status: notes.length ? "issues" : "ok", notes }));
} finally {
  writeFileSync(OUT, `${JSON.stringify({
    url: URL, headful: HEADFUL, generatedAt: new Date().toISOString(),
    results, notes, runtimeFailures: failures,
  }, null, 2)}\n`);
  await context.close();
  await browser.close();
}
