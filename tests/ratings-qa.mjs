/**
 * Meltzer Ratings visual QA: each capture includes renderer evidence, so a
 * plausible image cannot hide an empty projection or a software-only run.
 *
 * ARGS: argv[2] output dir. ENV: KAYFABE_BASE_URL, QA_W, QA_H, QA_TAG,
 * QA_REDUCED=1, QA_MOBILE=1, QA_TIER=high|medium|low, QA_HEADFUL=1,
 * QA_CHROMIUM_EXECUTABLE, QA_REQUIRE_HARDWARE=1.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-ratings-qa";
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const W = Number(process.env.QA_W ?? 1920), H = Number(process.env.QA_H ?? 1080);
const TAG = process.env.QA_TAG ?? String(W);
const MOBILE = process.env.QA_MOBILE === "1", REDUCED = process.env.QA_REDUCED === "1";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1", HEADFUL = process.env.QA_HEADFUL === "1";
const FORCE_TIER = ["high", "medium", "low"].includes(process.env.QA_TIER ?? "") ? process.env.QA_TIER : null;
mkdirSync(OUT, { recursive: true });

const errors = [], captures = [];
const browser = await chromium.launch({ headless: !HEADFUL, ...(process.env.QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE } : {}), args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"] });
const context = await browser.newContext({ viewport: { width: W, height: H }, ...(MOBILE ? { isMobile: true, hasTouch: true } : {}), ...(REDUCED ? { reducedMotion: "reduce" } : {}) });
const page = await context.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
page.on("response", (r) => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.url()}`));

const probe = () => page.evaluate(() => {
  const r = window.__kayfabeRatings;
  const canvas = document.querySelector("canvas.ratings-gl");
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  return r ? {
    mode: r.mode, tier: r.qualityTier, morphing: r.morphing, exact: r.visibleExactMatches,
    aggregates: r.visibleAggregateBins, labels: r.shownLabels, wantedLabels: r.wantedLabels,
    selected: r.selectedMatchId, threshold: r.activeThreshold, coverage: r.coverageStats,
    range: r.ratingRange, frameMs: r.frameTimeMs, cpuMs: r.rendererCpuMs,
    rendererInfo: r.rendererInfo, canvas: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
    gpu: gl ? String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : "unavailable",
  } : null;
});

async function waitRating(mode) {
  await page.waitForFunction((wanted) => {
    const r = window.__kayfabeRatings;
    return r?.currentLayout && !r.morphing && (!wanted || r.mode === wanted);
  }, mode, { timeout: 35_000 });
}

async function open() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator("canvas.gl").waitFor({ state: "visible", timeout: 40_000 });
  await page.getByRole("button", { name: "Meltzer Ratings", exact: true }).click();
  await page.getByTestId("ratings-canvas").waitFor({ state: "visible", timeout: 30_000 });
  await waitRating("promotions");
  if (FORCE_TIER) {
    await page.evaluate((tier) => window.__kayfabeRatings.setQualityOverride(tier), FORCE_TIER);
    await page.waitForFunction((tier) => window.__kayfabeRatings?.qualityTier === tier, FORCE_TIER);
  }
}

async function capture(name, expectedMode) {
  await waitRating(expectedMode);
  // Semantic selection can finish its GPU morph before the bounded camera
  // flight settles. Capture the readable end state, not an arbitrary
  // compositor frame part-way through a focus flight.
  await page.waitForFunction(() => !window.__kayfabeRatings?.camera?.flying, null, { timeout: 12_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const state = await probe();
  if (!state || state.mode !== expectedMode || state.exact <= 0 || !state.canvas || state.canvas[0] < 200 || state.canvas[1] < 100) {
    throw new Error(`${name}: invalid ratings projection ${JSON.stringify(state)}`);
  }
  if (REQUIRE_HARDWARE && /swiftshader|software|llvmpipe/i.test(state.gpu)) throw new Error(`${name}: software WebGL (${state.gpu})`);
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  const file = `${OUT}/${name}-${TAG}.png`;
  // The application is deliberately viewport-locked. A full-page capture on
  // mobile Chromium can recompose fixed WebGL/DOM layers at a temporary scroll
  // offset after a virtualized row receives focus, so capture the actual
  // interactive viewport instead.
  await page.screenshot({ path: file });
  captures.push({ name, file, ...state });
}

async function hover(kind) {
  const id = await page.evaluate((which) => {
    const r = window.__kayfabeRatings, layout = r.currentLayout;
    if (which === "exact") {
      const index = Array.from(layout.opacity).findIndex((value) => value > .7);
      return index >= 0 ? layout.matchIds[index] : null;
    }
    const bins = [...layout.aggregates].filter((bin) => bin.opacity > .1).sort((a, b) => which === "dense" ? b.ratedCount - a.ratedCount : a.ratedCount - b.ratedCount);
    return bins[0]?.key ?? null;
  }, kind);
  if (!id) throw new Error(`no ${kind} hover identity`);
  await page.evaluate((value) => window.__kayfabeRatings.hover.enterSurface("keyboard", value), id);
  await page.locator(`[data-rating-hover="${id}"]`).waitFor({ state: "visible", timeout: 10000 });
  return id;
}

async function aggregateRatedCount(id) {
  return page.evaluate((key) => window.__kayfabeRatings.currentLayout.aggregates.find((bin) => bin.key === key)?.ratedCount ?? null, id);
}

async function waitForVisibleRatingContract(kind) {
  await page.waitForFunction((wanted) => {
    const layout = window.__kayfabeRatings?.currentLayout;
    if (!layout) return false;
    const values = Array.from(layout.opacity)
      .map((opacity, index) => opacity > .01 ? layout.rating[index] : null)
      .filter((value) => value !== null);
    if (!values.length) return false;
    return wanted === "negative"
      ? values.every((value) => value <= 0) && values.some((value) => value < 0)
      : values.every((value) => value > 5) && values.some((value) => value > 5);
  }, kind, { timeout: 20_000 });
}

async function reset() {
  const details = page.locator("details.ratings-diagnostics");
  if (await details.getAttribute("open") === null) await details.locator("summary").click();
  await details.getByRole("button", { name: "Reset ratings controls" }).click();
  await page.getByRole("button", { name: "1 · Time + rating", exact: true }).click();
  await waitRating("promotions");
}

async function promotionScope() {
  const select = page.locator("select").filter({ hasText: "All promotions" });
  const options = await select.locator("option").evaluateAll((nodes) => nodes.slice(1).map((node) => ({ value: node.value, label: node.textContent ?? "" })));
  if (!options.length) throw new Error("ratings controls did not expose a rated promotion");
  const selected = options[0];
  await select.selectOption(selected.value);
  const name = selected.label.replace(/ · \d+$/, "");
  const search = page.getByRole("combobox", { name: /Search people/ });
  await search.fill(name);
  await page.locator('.search-pop [role="option"]').filter({ hasText: name }).first().click({ force: true });
  await waitRating("promotion");
}

async function titleScope() {
  await reset();
  const before = await page.evaluate(() => window.__kayfabeRatings.currentLayout.generation);
  await page.getByRole("checkbox", { name: "Title matches", exact: true }).check();
  await page.waitForFunction((generation) => {
    const renderer = window.__kayfabeRatings;
    return renderer?.currentLayout.generation > generation && !renderer.morphing;
  }, before, { timeout: 20000 });
  await page.getByRole("listbox", { name: /Rated matches in/ }).getByRole("option").first().click();
  const title = (await page.getByLabel("Ratings inspector").locator("dt", { hasText: "Title state" }).locator("xpath=following-sibling::dd[1]").textContent() ?? "").split(" · ")[0].trim();
  if (!title || title === "No title match reported") throw new Error("title-only ledger did not expose a title name");
  const search = page.getByRole("combobox", { name: /Search people/ });
  await search.fill(title);
  await page.locator('.search-pop [role="option"]').filter({ hasText: title }).first().click({ force: true });
  await waitRating("title");
}

try {
  await open();
  const globalContract = await page.evaluate(() => {
    const layout = window.__kayfabeRatings.currentLayout;
    const visibleDepths = Array.from(layout.opacity)
      .map((opacity, index) => opacity > .01 ? layout.positions[index * 3 + 2] : null)
      .filter((value) => value !== null);
    return {
      lanes: layout.lanes.map((lane) => ({ id: lane.id, z: lane.z, basis: lane.coverageBasis })),
      allVisibleDepthsNeutral: visibleDepths.length > 0 && visibleDepths.every((value) => value === 0),
      aggregatesGlobal: layout.aggregates.length > 0 && layout.aggregates.every((bin) => bin.promotionId === null && bin.coverageBasis === "global-denominator"),
    };
  });
  if (JSON.stringify(globalContract.lanes) !== JSON.stringify([{ id: "global:chronology", z: 0, basis: "global-denominator" }]) ||
      !globalContract.allVisibleDepthsNeutral || !globalContract.aggregatesGlobal) {
    throw new Error(`global splash is not a promotion-neutral time/rating chronology: ${JSON.stringify(globalContract)}`);
  }
  await capture("01-global", "promotions");
  if (MOBILE) {
    await page.getByRole("tab", { name: "Layout", exact: true }).click();
    await capture("14-mobile-layout", "promotions");
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    const list = page.getByRole("listbox", { name: /Rated matches in/ });
    await list.getByRole("option").first().click();
    await page.getByLabel("Ratings inspector").getByText("Locked match", { exact: false }).waitFor({ timeout: 10_000 });
    await capture("15-mobile-details", "promotions");
    await page.getByRole("tab", { name: "Map", exact: true }).click();
    await capture("16-mobile-map", "promotions");
  } else {
    await page.getByRole("spinbutton", { name: "Custom threshold plane" }).fill("5");
    await capture("02-five-datum", "promotions");
    await page.getByRole("button", { name: "5★+", exact: true }).click();
    await page.waitForFunction(() => {
      const r = window.__kayfabeRatings;
      return r?.activeThreshold === 5 && r.ratingRange[1] > 5
        && Array.from(r.currentLayout.opacity).some((opacity, index) => opacity > .01 && r.currentLayout.rating[index] > 5);
    });
    await capture("03-five-star-threshold", "promotions");

    await reset();
    const denseId = await hover("dense");
    const denseCount = await aggregateRatedCount(denseId);
    if (!(denseCount > 0)) throw new Error(`dense aggregate has invalid rated sample ${denseCount}`);
    await capture("04-dense-era-aggregate", "promotions");
    const sparseId = await hover("sparse");
    const sparseCount = await aggregateRatedCount(sparseId);
    if (!(sparseCount > 0 && sparseCount < denseCount)) throw new Error(`aggregate density ordering failed: dense=${denseCount}, sparse=${sparseCount}`);
    await capture("05-sparse-era-aggregate", "promotions");

    await promotionScope();
    await capture("06-promotion", "promotion");
    await titleScope();
    await capture("07-title", "title");

    await reset();
    const priorLock = page.getByRole("button", { name: "Clear lock", exact: true });
    if (await priorLock.isVisible()) await priorLock.click();
    await hover("exact");
    await capture("08-exact-hover", "promotions");
    await page.getByRole("button", { name: "Lock selection" }).click();
    await capture("09-exact-lock", "promotions");
    await hover("dense");
    await capture("10-aggregate-hover", "promotions");

    await reset();
    const clearLock = page.getByRole("button", { name: "Clear lock", exact: true });
    if (await clearLock.isVisible()) await clearLock.click();
    await page.getByRole("spinbutton", { name: "Maximum reported rating" }).fill("0");
    await waitForVisibleRatingContract("negative");
    await capture("11-negative", "promotions");
    await page.getByRole("button", { name: "Above 5★", exact: true }).click();
    await waitForVisibleRatingContract("above-five");
    await capture("12-above-five", "promotions");

    await reset();
    const firstComparisonMatch = await hover("exact");
    await page.getByRole("button", { name: "Set A" }).click();
    const comparisonCandidates = await page.evaluate((first) => {
      const layout = window.__kayfabeRatings.currentLayout;
      return Array.from(layout.opacity)
        .map((opacity, index) => opacity > .7 && layout.matchIds[index] !== first ? layout.matchIds[index] : null)
        .filter(Boolean)
        .slice(0, 20);
    }, firstComparisonMatch);
    const compare = page.getByRole("button", { name: "C · Compare A/B", exact: true });
    for (const candidate of comparisonCandidates) {
      await page.evaluate((id) => window.__kayfabeRatings.hover.enterSurface("keyboard", id), candidate);
      await page.getByRole("button", { name: "Set B" }).click();
      if (!await compare.isDisabled()) break;
    }
    if (await compare.isDisabled()) throw new Error("distinct exact matches did not expose two comparison identities");
    await compare.click();
    await capture("13-compare", "compare");
  }

  const search = page.getByRole("combobox", { name: /Search people/ });
  await search.fill("The Undertaker");
  await page.locator('.search-pop [role="option"]').filter({ hasText: "The Undertaker" }).first().click({ force: true });
  await capture("17-career", "career");
  if (REDUCED) {
    if ((await probe()).morphing) throw new Error("reduced-motion ratings lens reported an in-flight morph");
    await capture("18-reduced-motion", "career");
  }

  if (errors.length) throw new Error(`browser errors:\n${errors.join("\n")}`);
  writeFileSync(`${OUT}/report.json`, `${JSON.stringify({ base: BASE, viewport: [W, H], mobile: MOBILE, reduced: REDUCED, captures }, null, 2)}\n`);
  console.log(`ratings QA passed: ${captures.length} captures in ${OUT}`);
} finally {
  await browser.close();
}
