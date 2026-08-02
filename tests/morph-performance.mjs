/**
 * Hardware Morph Lab frame/picking probe.
 *
 * This measures browser requestAnimationFrame intervals (not the renderer's
 * CPU-only bookkeeping number) while each semantic structure is visible. It
 * also times current-position picking against the selected anchor. The script
 * is deliberately fail-closed for runtime/network errors, software WebGL,
 * sustained sub-30 FPS, and a >= 50 ms picking p95.
 * Set QA_HEADFUL=1 to use WSLg/native display for hardware-WebGL attempts;
 * default launch remains headless. QA_W/QA_H select desktop or mobile probes.
 * QA_REPORT_ONLY=1 records every scenario and threshold violation without
 * stopping at the first scheduler/performance miss (useful on software GL).
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1";
const HEADFUL = process.env.QA_HEADFUL === "1";
const WIDTH = Number(process.env.QA_W ?? 1440);
const HEIGHT = Number(process.env.QA_H ?? 900);
const NARROW = WIDTH <= 860;
const OUTPUT = process.env.QA_PERF_OUT ?? "/tmp/kayfabe-morph-performance.json";
const browser = await chromium.launch({
  headless: !HEADFUL,
  ...(process.env.QA_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  ...(NARROW ? { hasTouch: true, isMobile: true } : {}),
});
const page = await context.newPage();
const failures = [];
const results = [];
const REPORT_ONLY = process.env.QA_REPORT_ONLY === "1";
const performanceWarnings = [];
let longTaskReport = null;
page.on("console", (message) => message.type() === "error" && failures.push(`console: ${message.text()}`));
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) => failures.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`));
page.on("response", (response) => response.status() >= 400 && failures.push(`http ${response.status()}: ${response.url()}`));

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
};

const performanceViolation = (message) => {
  performanceWarnings.push(message);
  if (!REPORT_ONLY) throw new Error(message);
};

const search = async (query) => {
  const box = page.getByRole("combobox", { name: /Search/ });
  await box.fill("");
  await box.fill(query);
  const option = page.locator(".search-pop [role=option]").first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click({ force: true });
};

const showSheet = async (name) => {
  if (!NARROW) return;
  await page.getByRole("tab", { name, exact: true }).click({ timeout: 6000 });
};

const waitMode = (mode) =>
  page.waitForFunction(
    (expected) => window.__kayfabeMorph?.mode === expected && !window.__kayfabeMorph?.morphing && !window.__kayfabeMorph?.cam.flying,
    mode,
    { timeout: 30000 },
  );

const startFrameWindow = () =>
  page.evaluate(() => {
    const state = { active: true, last: 0, deltas: [] };
    window.__qaMorphFrameWindow = state;
    const tick = (time) => {
      if (!state.active) return;
      if (state.last > 0) state.deltas.push(time - state.last);
      state.last = time;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const stopFrameWindow = () =>
  page.evaluate(() => {
    const state = window.__qaMorphFrameWindow;
    if (!state) return [];
    state.active = false;
    return state.deltas;
  });

const sample = async (name, mode, frames = 120) => {
  await waitMode(mode);
  await page.waitForTimeout(200);
  const browserSample = await page.evaluate(async (count) => {
    const renderer = window.__kayfabeMorph;
    if (!renderer) throw new Error("Morph renderer probe is unavailable");
    const canvas = document.querySelector("canvas.morph-gl");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const gpu = gl
      ? String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      : "unavailable";
    const deltas = [];
    let previous = await new Promise(requestAnimationFrame);
    for (let i = 0; i < count; i++) {
      const next = await new Promise(requestAnimationFrame);
      deltas.push(next - previous);
      previous = next;
    }
    const pickMs = [];
    let correct = 0;
    const pickHits = {};
    const anchorId = renderer.currentLayout?.anchorId ?? null;
    const slot = anchorId ? renderer.slotOfId(anchorId) : null;
    const projected = slot === null ? null : renderer.projectSlot(slot);
    if (anchorId && projected?.front) {
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        const hit = renderer.pick(projected.x, projected.y);
        pickMs.push(performance.now() - t0);
        const hitId = hit?.id ?? "<none>";
        pickHits[hitId] = (pickHits[hitId] ?? 0) + 1;
        if (hit?.id === anchorId) correct++;
      }
    }
    return {
      gpu,
      mode: renderer.mode,
      anchorId,
      deltas,
      pickMs,
      correct,
      pickHits,
      pickDebug: renderer.lastPickDiagnostic ?? null,
      rendererCpuEmaMs: renderer.frameTimeMs,
      tier: renderer.qualityTier,
      visibleRoutes: renderer.currentLayout?.routes.length ?? 0,
      labels: renderer.lastLabelReport,
      orbitStats: renderer.currentLayout?.orbitStats ?? renderer.currentLayout?.orbit?.stats ?? null,
      activeEntities: renderer.currentLayout?.expandedCount ?? 0,
      guideCount: renderer.currentLayout?.orbitStats?.guideCount ?? renderer.currentLayout?.regions.filter(
        (region) => /orbit.*guide|guide.*orbit/i.test(region.key),
      ).length ?? 0,
    };
  }, frames);
  if (browserSample.mode !== mode) throw new Error(`${name}: expected ${mode}, got ${browserSample.mode}`);
  if (REQUIRE_HARDWARE && /unavailable|swiftshader|llvmpipe|software/i.test(browserSample.gpu)) {
    throw new Error(`${name}: software WebGL renderer rejected: ${browserSample.gpu}`);
  }
  const p50 = percentile(browserSample.deltas, 0.5);
  const p95 = percentile(browserSample.deltas, 0.95);
  const worst = Math.max(...browserSample.deltas);
  const below30 = browserSample.deltas.filter((ms) => ms > 1000 / 30).length;
  const pickP95 = percentile(browserSample.pickMs, 0.95);
  const pickP99 = percentile(browserSample.pickMs, 0.99);
  const result = {
    scenario: name,
    mode,
    frameP50Ms: Number(p50.toFixed(2)),
    frameP95Ms: Number(p95.toFixed(2)),
    worstFrameMs: Number(worst.toFixed(2)),
    below30FpsFrames: below30,
    sampledFrames: browserSample.deltas.length,
    pickP95Ms: Number(pickP95.toFixed(2)),
    pickP99Ms: Number(pickP99.toFixed(2)),
    pickCorrect: `${browserSample.correct}/${browserSample.pickMs.length}`,
    pickHits: browserSample.pickHits,
    pickCandidates: browserSample.pickDebug?.candidateCount ?? null,
    rendererCpuEmaMs: Number(browserSample.rendererCpuEmaMs.toFixed(2)),
    tier: browserSample.tier,
    visibleRoutes: browserSample.visibleRoutes,
    labelsShown: browserSample.labels.shown,
    labelsWanted: browserSample.labels.wanted,
    activeEntities: browserSample.activeEntities,
    directNodes: browserSample.orbitStats?.directDisplayed ?? browserSample.orbitStats?.displayedDirectRelationships ?? null,
    bridgeNodes: browserSample.orbitStats?.bridgeDisplayed ?? browserSample.orbitStats?.displayedBridgeCandidates ?? null,
    bridgeRoutes: browserSample.orbitStats?.bridgeRoutesDisplayed ?? browserSample.orbitStats?.displayedSupportingRoutes ?? null,
    guideCount: browserSample.guideCount,
    gpu: browserSample.gpu,
  };
  // One isolated scheduler hitch is reportable; two percent or more at <30
  // FPS means the mode is remaining slow and fails this run.
  if (below30 > Math.max(1, Math.floor(browserSample.deltas.length * 0.02))) {
    performanceViolation(`${name}: ${below30}/${browserSample.deltas.length} frames were below 30 FPS`);
  }
  if (browserSample.pickMs.length && pickP95 >= 50) {
    performanceViolation(`${name}: pick p95 ${pickP95.toFixed(2)} ms exceeds 50 ms`);
  }
  if (REQUIRE_HARDWARE && browserSample.pickMs.length && pickP95 >= 4) {
    performanceViolation(`${name}: hardware pick p95 ${pickP95.toFixed(2)} ms exceeds 4 ms`);
  }
  if (REQUIRE_HARDWARE && browserSample.pickMs.length && pickP99 >= 8) {
    performanceViolation(`${name}: hardware pick p99 ${pickP99.toFixed(2)} ms exceeds 8 ms`);
  }
  if (REQUIRE_HARDWARE && browserSample.rendererCpuEmaMs >= 16) {
    performanceViolation(`${name}: renderer CPU EMA ${browserSample.rendererCpuEmaMs.toFixed(2)} ms exceeds 16 ms`);
  }
  if (browserSample.pickMs.length && browserSample.correct !== browserSample.pickMs.length) {
    throw new Error(`${name}: selected anchor picked correctly ${browserSample.correct}/${browserSample.pickMs.length}; hits=${JSON.stringify(browserSample.pickHits)}`);
  }
  console.log(JSON.stringify(result));
  return result;
};

const forceTier = async (target) => {
  await page.evaluate((wanted) => {
    const renderer = window.__kayfabeMorph;
    if (!renderer) throw new Error("Morph renderer probe is unavailable");
    const order = ["low", "medium", "high"];
    while (renderer.qualityTier !== wanted) {
      const direction = order.indexOf(wanted) > order.indexOf(renderer.qualityTier) ? 1 : -1;
      renderer.stepTier(direction);
    }
  }, target);
  await page.waitForFunction((wanted) => window.__kayfabeMorph?.qualityTier === wanted, target);
  await page.waitForTimeout(800);
  await waitMode("orbit");
};

const hoverSweep = async (name) => {
  const points = await page.evaluate(() => {
    const renderer = window.__kayfabeMorph;
    const layout = renderer?.currentLayout;
    if (!renderer || !layout) return [];
    const rect = renderer.canvas.getBoundingClientRect();
    const projected = [];
    for (let slot = 0; slot < layout.nodeOpacity.length && projected.length < 72; slot++) {
      if (layout.nodeOpacity[slot] < 0.12 || layout.nodeRole[slot] === 0) continue;
      const point = renderer.projectSlot(slot);
      if (point?.front) projected.push({ x: rect.left + point.x, y: rect.top + point.y });
    }
    return projected;
  });
  if (points.length < 3) throw new Error(`${name}: insufficient projected active entities for hover sweep`);
  await startFrameWindow();
  for (const point of points) {
    await page.mouse.move(point.x, point.y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  const deltas = await stopFrameWindow();
  const debug = await page.evaluate(() => window.__kayfabeMorph?.lastPickDiagnostic ?? null);
  const result = {
    scenario: name,
    sampledTargets: points.length,
    frameP95Ms: Number(percentile(deltas, 0.95).toFixed(2)),
    worstFrameMs: Number(Math.max(...deltas).toFixed(2)),
    latestPickMs: debug?.durationMs ?? null,
    latestPickCandidates: debug?.candidateCount ?? null,
  };
  console.log(JSON.stringify(result));
  if (REQUIRE_HARDWARE && result.latestPickMs !== null && result.latestPickMs >= 8) {
    performanceViolation(`${name}: latest hardware pick ${result.latestPickMs.toFixed(2)} ms exceeds 8 ms`);
  }
  return result;
};

try {
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /^Morph Lab(?: β)?$/ }).click();
  await page.waitForSelector("canvas.morph-gl", { timeout: 20000 });
  await showSheet("Map");
  await page.evaluate(() => {
    window.__qaMorphLongTasks = [];
    if (!("PerformanceObserver" in window)) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__qaMorphLongTasks.push(entry.duration);
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
      window.__qaMorphLongTaskObserver = observer;
    } catch {
      // An older browser without Long Tasks support still has the rAF proof.
    }
  });

  results.push(await sample("organic", "organic"));

  await search("Undertaker");
  await waitMode("loom");
  await showSheet("Layout");
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await waitMode("orbit");
  await showSheet("Map");
  results.push(await sample("orbit-undertaker", "orbit"));
  results.push(await hoverSweep("orbit-undertaker-hover-sweep"));

  await search("Ric Flair");
  results.push(await sample("orbit-dense-ric-flair", "orbit"));

  await showSheet("Layout");
  await page.getByRole("checkbox", { name: "Corpus context" }).uncheck();
  await waitMode("orbit");
  await showSheet("Map");
  results.push(await sample("orbit-dense-context-off", "orbit"));
  await showSheet("Layout");
  await page.getByRole("checkbox", { name: "Corpus context" }).check();
  await waitMode("orbit");

  // Force the same semantic Orbit through display-only tier budgets. This
  // calls the renderer's own governor step, so the ordinary tier-change and
  // store rebuild path is measured rather than installing a test-only mode.
  await forceTier("medium");
  results.push(await sample("orbit-dense-medium", "orbit"));
  await forceTier("low");
  results.push(await sample("orbit-dense-low", "orbit"));

  await search("AJPW");
  results.push(await sample("promotion-ajpw", "motherboard"));

  await search("WWF Hardcore Title");
  results.push(await sample("title-hardcore", "lineage"));

  await search("Undertaker");
  await waitMode("orbit");
  await showSheet("Layout");
  await page.getByRole("button", { name: "Career", exact: true }).click();
  results.push(await sample("career-undertaker", "career"));

  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await waitMode("orbit");
  await startFrameWindow();
  for (const query of ["Kane", "Steve Austin", "The Rock", "Shawn Michaels", "Ric Flair"]) {
    await search(query);
    await page.waitForTimeout(85);
  }
  await waitMode("orbit");
  const rapidDeltas = await stopFrameWindow();
  const rapidResult = {
    scenario: "rapid-retarget-active",
    frameP50Ms: Number(percentile(rapidDeltas, 0.5).toFixed(2)),
    frameP95Ms: Number(percentile(rapidDeltas, 0.95).toFixed(2)),
    worstFrameMs: Number(Math.max(...rapidDeltas).toFixed(2)),
    below30FpsFrames: rapidDeltas.filter((ms) => ms > 1000 / 30).length,
    sampledFrames: rapidDeltas.length,
  };
  console.log(JSON.stringify(rapidResult));
  if (rapidResult.below30FpsFrames > Math.max(1, Math.floor(rapidDeltas.length * 0.02))) {
    performanceViolation(
      `rapid-retarget-active: ${rapidResult.below30FpsFrames}/${rapidDeltas.length} frames were below 30 FPS`,
    );
  }
  results.push(await sample("orbit-rapid-retarget-final", "orbit"));
  const finalCrumb = await page.locator(".morph-crumbs").textContent();
  if (!finalCrumb?.includes("Ric Flair")) {
    throw new Error(`rapid retarget did not end on Ric Flair: ${JSON.stringify(finalCrumb)}`);
  }

  const longTasks = await page.evaluate(() => {
    window.__qaMorphLongTaskObserver?.disconnect();
    return window.__qaMorphLongTasks ?? [];
  });
  const maxLongTaskMs = longTasks.length ? Math.max(...longTasks) : 0;
  longTaskReport = { longTasks: longTasks.length, maxLongTaskMs: Number(maxLongTaskMs.toFixed(2)) };
  console.log(JSON.stringify(longTaskReport));
  if (maxLongTaskMs > 100) performanceViolation(`main-thread long task ${maxLongTaskMs.toFixed(2)} ms exceeds 100 ms`);
  if (failures.length) throw new Error(`runtime failures:\n${failures.join("\n")}`);
  console.log(JSON.stringify({ status: "ok", scenarios: results.length + 1, viewport: `${WIDTH}x${HEIGHT}` }));
} finally {
  writeFileSync(
    OUTPUT,
    `${JSON.stringify({
      baseUrl: BASE,
      generatedAt: new Date().toISOString(),
      viewport: { width: WIDTH, height: HEIGHT },
      hardwareRequired: REQUIRE_HARDWARE,
      scenarios: results,
      longTasks: longTaskReport,
      runtimeFailures: failures,
      performanceWarnings,
    }, null, 2)}\n`,
  );
  await context.close();
  await browser.close();
}
