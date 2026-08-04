/**
 * SPIKE 3 + 4 probe — evidence routes and selective postprocessing.
 *
 * rAF is vsync-clamped and reads a flat 16.7 ms for every configuration, so it
 * is used only as a pass/fail gate. Ranking uses render-submission time (CPU
 * command submission, not GPU execution), draw calls and render-target count.
 *
 * Run: node tests/arena-spikes/spike34-routes-post.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const HEADFUL = process.env.QA_HEADFUL === "1";
const OUT = process.env.QA_SPIKE_OUT ?? "/tmp/kayfabe-arena-spike34.json";
const URL = `${BASE}/spikes/routes.html`;

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

const live = () =>
  page.waitForFunction(() => window.__arenaRoutes && !window.__arenaRoutes.contextLost(), null, { timeout: 30000 });

/** Let the EMA settle on the current configuration before reading it. */
const measure = async (label, extra = {}) => {
  await live();
  await page.evaluate(() => window.__arenaRoutes.resetRenderEma());
  await page.evaluate(async () => { for (let i = 0; i < 90; i++) await new Promise(requestAnimationFrame); });
  const r = await page.evaluate(() => ({
    renderMs: window.__arenaRoutes.renderEmaMs(),
    drawCalls: window.__arenaRoutes.drawCalls(),
    routes: window.__arenaRoutes.routeCount(),
    renderTargets: window.__arenaRoutes.renderTargetCount(),
  }));
  const row = { label, ...extra, renderSubmitMs: Number(r.renderMs.toFixed(3)), drawCalls: r.drawCalls, routes: r.routes, renderTargets: r.renderTargets };
  results.push(row);
  console.log(JSON.stringify(row));
  return row;
};

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__arenaRoutes?.ready === true, null, { timeout: 30000 });
  await live();
  const gpu = await page.evaluate(() => window.__arenaRoutes.gpu());
  console.log(JSON.stringify({ gpu, software: /swiftshader|llvmpipe|software/i.test(gpu) }));

  // ---- SPIKE 3: route count scaling ----
  await page.evaluate(() => window.__arenaRoutes.setPost("none"));
  for (const n of [0, 25, 50, 100]) {
    await page.evaluate((k) => window.__arenaRoutes.setRoutes(k), n);
    await measure(`routes-${n}`, { requested: n, post: "none", pulses: 0 });
  }

  // ---- SPIKE 3: pulses ----
  await page.evaluate(() => window.__arenaRoutes.setRoutes(100));
  for (const p of [10, 16]) {
    await page.evaluate((k) => window.__arenaRoutes.setPulses(k), p);
    await measure(`routes-100-pulses-${p}`, { requested: 100, post: "none", pulses: p });
  }

  // ---- SPIKE 3: progressive reveal actually reveals ----
  const reveal = await page.evaluate(async () => {
    const s = window.__arenaRoutes;
    const at = {};
    for (const r of [0, 0.25, 0.5, 1]) {
      s.setReveal(r);
      await new Promise(requestAnimationFrame);
      const segs = s.revealedSegments();
      at[r] = { min: Math.min(...segs), max: Math.max(...segs) };
    }
    s.setReveal(1);
    return at;
  });
  const revealRow = {
    label: "progressive-reveal",
    perSegmentCounts: reveal,
    // 23 segments for 24 samples; a working prefix reveal must be monotonic and
    // must actually reach 0 and full.
    works: reveal["0"].max === 0 && reveal["1"].max === 23 && reveal["0.5"].max > reveal["0.25"].max,
  };
  results.push(revealRow);
  console.log(JSON.stringify(revealRow));
  if (!revealRow.works) notes.push(`FAIL: fat-line prefix reveal did not behave monotonically: ${JSON.stringify(reveal)}`);

  // ---- SPIKE 3: the params.Line2 trap, measured ----
  const hover = await page.evaluate(async () => {
    const s = window.__arenaRoutes;
    // Aiming at a route's exact centreline hits even with zero tolerance, so it
    // cannot expose the params.Line2 trap. Offset perpendicular instead: that
    // is what a real pointer does.
    const OFFSET_PX = 5;
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const p = s.routeScreenNear(i, OFFSET_PX);
      if (p && p.x > 0 && p.y > 0 && p.x < 1920 && p.y < 1080) pts.push(p);
    }
    const run = () => {
      let hits = 0;
      const ms = [];
      for (const p of pts) {
        const t0 = performance.now();
        const key = s.hoverRoute(p.x, p.y);
        ms.push(performance.now() - t0);
        if (key) hits++;
      }
      ms.sort((a, b) => a - b);
      return { samples: pts.length, hitPct: pts.length ? (hits / pts.length) * 100 : 0, p50: ms[Math.floor(ms.length / 2)] ?? 0, p95: ms[Math.floor(ms.length * 0.95)] ?? 0 };
    };
    s.setLine2Threshold(6);
    const withBucket = run();
    s.setLine2Threshold(null); // reproduce the default state
    const withoutBucket = run();
    s.setLine2Threshold(6);
    return { withBucket, withoutBucket };
  });
  const hoverRow = { label: "route-hover-tolerance-5px", ...hover };
  if (hover.withBucket.hitPct <= hover.withoutBucket.hitPct) {
    notes.push(`NOTE: params.Line2 bucket made no difference at 5 px offset (with ${hover.withBucket.hitPct}% vs without ${hover.withoutBucket.hitPct}%)`);
  }
  results.push(hoverRow);
  console.log(JSON.stringify(hoverRow));

  // ---- SPIKE 3: screen-space width holds across resolutions ----
  const res = await page.evaluate(async () => {
    const s = window.__arenaRoutes;
    const out = {};
    for (const dpr of [1, 2]) {
      s.setPixelRatio(dpr);
      await new Promise(requestAnimationFrame);
      out[dpr] = s.resolutionOf();
    }
    s.setPixelRatio(1);
    return out;
  });
  const resRow = {
    label: "line-resolution-on-resize",
    resolutions: res,
    // resolution is in CSS pixels, NOT drawing-buffer pixels: linewidth is a
    // CSS-pixel width and the shader divides by this. Scaling it by dpr would
    // halve apparent line width at dpr 2. So the correct behaviour is that it
    // stays constant across pixel ratios.
    cssPixelsNotBufferPixels: res["2"][0] === res["1"][0] && res["2"][1] === res["1"][1],
  };
  results.push(resRow);
  console.log(JSON.stringify(resRow));
  if (!resRow.cssPixelsNotBufferPixels) notes.push(`FAIL: LineMaterial.resolution changed with devicePixelRatio; it must stay in CSS pixels: ${JSON.stringify(res)}`);

  // ---- SPIKE 4: postprocessing stacks ----
  await page.evaluate(() => { window.__arenaRoutes.setRoutes(100); window.__arenaRoutes.setPulses(10); });
  for (const mode of ["none", "bloom", "bloom+afterimage"]) {
    await page.evaluate((m) => window.__arenaRoutes.setPost(m), mode);
    await measure(`post-${mode}`, { post: mode, requested: 100, pulses: 10 });
  }
  await page.evaluate(() => window.__arenaRoutes.setPost("none"));

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
