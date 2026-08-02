/**
 * Hardware Morph Lab frame/picking probe.
 *
 * This measures browser requestAnimationFrame intervals (not the renderer's
 * CPU-only bookkeeping number) while each semantic structure is visible. It
 * also times current-position picking against the selected anchor. The script
 * is deliberately fail-closed for runtime/network errors, software WebGL,
 * sustained sub-30 FPS, and a >= 50 ms picking p95.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1";
const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const failures = [];
page.on("console", (message) => message.type() === "error" && failures.push(`console: ${message.text()}`));
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("requestfailed", (request) => failures.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`));
page.on("response", (response) => response.status() >= 400 && failures.push(`http ${response.status()}: ${response.url()}`));

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
};

const search = async (query) => {
  const box = page.getByRole("combobox", { name: /Search/ });
  await box.fill("");
  await box.fill(query);
  const option = page.locator(".search-pop [role=option]").first();
  await option.waitFor({ state: "visible", timeout: 10000 });
  await option.click({ force: true });
};

const waitMode = (mode) =>
  page.waitForFunction(
    (expected) => window.__kayfabeMorph?.mode === expected && !window.__kayfabeMorph?.morphing,
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
    const anchorId = renderer.currentLayout?.anchorId ?? null;
    const slot = anchorId ? renderer.slotOfId(anchorId) : null;
    const projected = slot === null ? null : renderer.projectSlot(slot);
    if (anchorId && projected?.front) {
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        const hit = renderer.pick(projected.x, projected.y);
        pickMs.push(performance.now() - t0);
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
      rendererCpuEmaMs: renderer.frameTimeMs,
      tier: renderer.qualityTier,
      visibleRoutes: renderer.currentLayout?.routes.length ?? 0,
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
  const result = {
    scenario: name,
    mode,
    frameP50Ms: Number(p50.toFixed(2)),
    frameP95Ms: Number(p95.toFixed(2)),
    worstFrameMs: Number(worst.toFixed(2)),
    below30FpsFrames: below30,
    sampledFrames: browserSample.deltas.length,
    pickP95Ms: Number(pickP95.toFixed(2)),
    pickCorrect: `${browserSample.correct}/${browserSample.pickMs.length}`,
    rendererCpuEmaMs: Number(browserSample.rendererCpuEmaMs.toFixed(2)),
    tier: browserSample.tier,
    visibleRoutes: browserSample.visibleRoutes,
    gpu: browserSample.gpu,
  };
  // One isolated scheduler hitch is reportable; two percent or more at <30
  // FPS means the mode is remaining slow and fails this run.
  if (below30 > Math.max(1, Math.floor(browserSample.deltas.length * 0.02))) {
    throw new Error(`${name}: ${below30}/${browserSample.deltas.length} frames were below 30 FPS`);
  }
  if (browserSample.pickMs.length && pickP95 >= 50) {
    throw new Error(`${name}: pick p95 ${pickP95.toFixed(2)} ms exceeds 50 ms`);
  }
  if (browserSample.pickMs.length && browserSample.correct !== browserSample.pickMs.length) {
    throw new Error(`${name}: selected anchor picked correctly ${browserSample.correct}/${browserSample.pickMs.length}`);
  }
  console.log(JSON.stringify(result));
  return result;
};

try {
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: /^Morph Lab(?: β)?$/ }).click();
  await page.waitForSelector("canvas.morph-gl", { timeout: 20000 });
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

  const results = [];
  results.push(await sample("organic", "organic"));

  await search("Ric Flair");
  results.push(await sample("wrestler-ric-flair", "loom"));

  await search("AJPW");
  results.push(await sample("promotion-ajpw", "motherboard"));

  await search("WWF Hardcore Title");
  results.push(await sample("title-hardcore", "lineage"));

  await search("Undertaker");
  await waitMode("loom");
  await page.getByRole("button", { name: "Career", exact: true }).click();
  results.push(await sample("career-undertaker", "career"));

  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await startFrameWindow();
  for (const query of ["Kane", "Steve Austin", "The Rock", "Shawn Michaels", "Ric Flair"]) {
    await search(query);
    await page.waitForTimeout(85);
  }
  await waitMode("loom");
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
    throw new Error(
      `rapid-retarget-active: ${rapidResult.below30FpsFrames}/${rapidDeltas.length} frames were below 30 FPS`,
    );
  }
  results.push(await sample("rapid-retarget-final", "loom"));
  const finalCrumb = await page.locator(".morph-crumbs").textContent();
  if (!finalCrumb?.includes("Ric Flair")) {
    throw new Error(`rapid retarget did not end on Ric Flair: ${JSON.stringify(finalCrumb)}`);
  }

  const longTasks = await page.evaluate(() => {
    window.__qaMorphLongTaskObserver?.disconnect();
    return window.__qaMorphLongTasks ?? [];
  });
  const maxLongTaskMs = longTasks.length ? Math.max(...longTasks) : 0;
  console.log(JSON.stringify({ longTasks: longTasks.length, maxLongTaskMs: Number(maxLongTaskMs.toFixed(2)) }));
  if (maxLongTaskMs > 100) throw new Error(`main-thread long task ${maxLongTaskMs.toFixed(2)} ms exceeds 100 ms`);
  if (failures.length) throw new Error(`runtime failures:\n${failures.join("\n")}`);
  console.log(JSON.stringify({ status: "ok", scenarios: results.length + 1 }));
} finally {
  await context.close();
  await browser.close();
}
