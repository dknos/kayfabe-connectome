/**
 * Ratings performance contract. It records frame cadence and real renderer
 * picking; QA_REPORT_ONLY=1 retains measurements without enforcing budgets.
 * ENV: KAYFABE_BASE_URL, QA_PERF_OUT, QA_PERF_FRAMES (default 180),
 * QA_HEADFUL, QA_CHROMIUM_EXECUTABLE, QA_REQUIRE_HARDWARE=1,
 * QA_REPORT_ONLY=1.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const OUT = process.env.QA_PERF_OUT ?? "/tmp/kayfabe-ratings-performance";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1", REPORT_ONLY = process.env.QA_REPORT_ONLY === "1";
const FRAME_COUNT = Math.max(30, Math.min(600, Number(process.env.QA_PERF_FRAMES ?? 180) || 180));
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: process.env.QA_HEADFUL !== "1", ...(process.env.QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE } : {}), args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];
async function open() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator("canvas.gl").waitFor({ state: "visible", timeout: 40_000 });
  await page.getByRole("button", { name: "Meltzer Ratings", exact: true }).click();
  await page.getByTestId("ratings-canvas").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => window.__kayfabeRatings?.currentLayout && !window.__kayfabeRatings.morphing, undefined, { timeout: 35_000 });
}
const measure = (name) => page.evaluate(async ({ sampleName, frameCount }) => {
  const r = window.__kayfabeRatings;
  const frame = [];
  await new Promise((resolve) => {
    let previous = performance.now(), count = 0;
    const tick = (now) => { frame.push(now - previous); previous = now; if (++count >= frameCount) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const layout = r.currentLayout;
  let index = -1, targetOpacity = 0;
  for (let i = 0; i < layout.matchIds.length; i++) {
    if (layout.opacity[i] > targetOpacity) { index = i; targetOpacity = layout.opacity[i]; }
  }
  if (index < 0 || targetOpacity <= .01) throw new Error("no visible exact match for picking");
  const id = layout.matchIds[index];
  r.focusMatch(id);
  await new Promise((resolve, reject) => {
    const deadline = performance.now() + 3000;
    const poll = () => {
      if (!r.cam.flying) resolve();
      else if (performance.now() >= deadline) reject(new Error("rating camera did not settle before pick sampling"));
      else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  const p = r.currentPositionOfMatch(id), screen = r.cam.worldToScreen(p[0], p[1], p[2]);
  const picks = [];
  for (let i = 0; i < 40; i++) { const start = performance.now(); const hit = r.pick(screen.x, screen.y, "mouse"); picks.push({ ms: performance.now() - start, id: hit?.id ?? null }); }
  const canvas = document.querySelector("canvas.ratings-gl"), gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
  return { name: sampleName, mode: r.mode, frame, picks, target: id, targetOpacity, exact: r.visibleExactMatches, tier: r.qualityTier, cpuMs: r.rendererCpuMs, gpu: gl ? String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : "unavailable" };
}, { sampleName: name, frameCount: FRAME_COUNT });

async function settle(mode) {
  await page.waitForFunction((wanted) => window.__kayfabeRatings?.currentLayout && !window.__kayfabeRatings.morphing && (!wanted || window.__kayfabeRatings.mode === wanted), mode, { timeout: 35_000 });
}

async function setTier(tier) {
  const details = page.locator("details.ratings-diagnostics");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await details.getByLabel("Quality override").selectOption(tier);
  await page.waitForFunction((wanted) => window.__kayfabeRatings?.qualityTier === wanted, tier, { timeout: 15_000 });
}

async function promotionScope() {
  const select = page.locator("select").filter({ hasText: "All promotions" });
  const chosen = (await select.locator("option").evaluateAll((nodes) => nodes.slice(1, 2).map((node) => ({ value: node.value, label: node.textContent ?? "" }))))[0];
  if (!chosen) throw new Error("no corpus-backed promotion option");
  await select.selectOption(chosen.value);
  const name = chosen.label.replace(/ · \d+$/, "");
  await page.getByRole("combobox", { name: /Search people/ }).fill(name);
  await page.locator('.search-pop [role="option"]').filter({ hasText: name }).first().click({ force: true });
  await settle("promotion");
}

async function compareScope() {
  const ids = await page.evaluate(() => {
    const layout = window.__kayfabeRatings.currentLayout;
    return Array.from(layout.opacity)
      .map((opacity, index) => opacity > .7 ? layout.matchIds[index] : null)
      .filter(Boolean)
      .slice(0, 24);
  });
  if (ids.length < 2) return false;
  await page.evaluate((id) => window.__kayfabeRatings.hover.enterSurface("keyboard", id), ids[0]);
  await page.getByRole("button", { name: "Set A" }).click();
  const compare = page.getByRole("button", { name: "C · Compare A/B", exact: true });
  for (const id of ids.slice(1)) {
    await page.evaluate((candidate) => window.__kayfabeRatings.hover.enterSurface("keyboard", candidate), id);
    await page.getByRole("button", { name: "Set B" }).click();
    if (!await compare.isDisabled()) break;
  }
  if (await compare.isDisabled()) return false;
  await compare.click();
  await settle("compare");
  return true;
}

const compact = (raw) => {
  const frame = raw.frame.slice(5), pick = raw.picks.map((p) => p.ms);
  return { ...raw, frame: { p50: percentile(frame, .5), p95: percentile(frame, .95), over33ms: frame.filter((x) => x > 33.34).length / frame.length }, pick: { p50: percentile(pick, .5), p95: percentile(pick, .95), p99: percentile(pick, .99), exactHits: raw.picks.filter((p) => p.id === raw.target).length } };
};

const samples = [];
const skipped = [];
let completed = false;
let failure = null;
const persistReport = () => writeFileSync(`${OUT}/report.json`, `${JSON.stringify({
  base: BASE,
  frameCount: FRAME_COUNT,
  reportOnly: REPORT_ONLY,
  softwareBudgetsReportOnly: true,
  completed,
  failure,
  samples,
  skipped,
}, null, 2)}\n`);
const appendSample = (sample) => {
  samples.push(sample);
  persistReport();
};

try {
  await open();
  const globalContract = await page.evaluate(() => {
    const layout = window.__kayfabeRatings.currentLayout;
    return layout.lanes.length === 1 && layout.lanes[0].id === "global:chronology" &&
      Array.from(layout.opacity).every((opacity, index) => opacity <= .01 || layout.positions[index * 3 + 2] === 0);
  });
  if (!globalContract) throw new Error("global performance scope is not the neutral time/rating chronology");
  for (const tier of ["high", "medium", "low"]) {
    await setTier(tier);
    await settle("promotions");
    appendSample(compact(await measure(`global-${tier}`)));
  }
  await promotionScope();
  appendSample(compact(await measure("promotion")));
  // Promotion focus intentionally leaves its evidence filter in place. Clear
  // that prior scope before constructing a person benchmark; otherwise a
  // truthful empty NJPW/Undertaker intersection has nothing to pick.
  await page.locator("select").filter({ hasText: "All promotions" }).selectOption({ index: 0 });
  await page.getByRole("combobox", { name: /Search people/ }).fill("The Undertaker");
  await page.locator('.search-pop [role="option"]').filter({ hasText: "The Undertaker" }).first().click({ force: true });
  await settle("career");
  appendSample(compact(await measure("career")));
  await page.getByRole("button", { name: "1 · Time + rating", exact: true }).click();
  await settle("promotions");
  const compared = await compareScope();
  if (compared) appendSample(compact(await measure("compare")));
  else skipped.push("compare: two distinct comparison identities were not available from current exact peaks");
  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  if (REQUIRE_HARDWARE && samples.some((sample) => /swiftshader|software|llvmpipe/i.test(sample.gpu))) throw new Error(`software WebGL: ${samples.map((sample) => sample.gpu).join("; ")}`);
  const failures = [];
  for (const sample of samples) {
    if (sample.pick.exactHits !== sample.picks.length) failures.push(`${sample.name}: exact pick ${sample.pick.exactHits}/${sample.picks.length}`);
    const software = /swiftshader|software|llvmpipe/i.test(sample.gpu);
    if (!software && sample.frame.over33ms > .02) failures.push(`${sample.name}: slow frames ${(sample.frame.over33ms * 100).toFixed(1)}%`);
    if (!software && sample.pick.p95 > 4) failures.push(`${sample.name}: pick p95 ${sample.pick.p95.toFixed(2)}ms`);
    if (!software && sample.cpuMs > 16.7) failures.push(`${sample.name}: renderer CPU ${sample.cpuMs.toFixed(2)}ms`);
  }
  if (failures.length && !REPORT_ONLY) throw new Error(failures.join("; "));
  completed = true;
  persistReport();
  console.log(`ratings performance ${failures.length ? "reported" : "passed"}: ${samples.map((sample) => `${sample.name} ${sample.frame.p95.toFixed(1)}ms`).join(", ")}`);
} catch (error) {
  failure = String(error);
  throw error;
} finally {
  persistReport();
  await browser.close();
}
