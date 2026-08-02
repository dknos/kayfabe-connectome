/**
 * GEO visual QA capture.
 *
 * Automated assertions live in tests/e2e/geo.spec.ts and check ANALYTICAL
 * state. This script produces the images a human has to look at: framing,
 * bloom, label collisions, misleading arcs, inspector overlap, gold
 * readability, mobile controls, and stray markers.
 *
 *   node tests/geo-visual-qa.mjs [outDir]
 *
 * ENV: KAYFABE_BASE_URL, QA_VIEWPORT (optional exact viewport name),
 * QA_CHROMIUM_EXECUTABLE, QA_REQUIRE_HARDWARE=1.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "test-results/geo-visual-qa";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460/";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1";
const ONLY_VIEWPORT = process.env.QA_VIEWPORT ?? null;

const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "390x844", width: 390, height: 844, mobile: true },
].filter((viewport) => !ONLY_VIEWPORT || viewport.name === ONLY_VIEWPORT);
if (VIEWPORTS.length === 0) throw new Error(`Unknown QA_VIEWPORT: ${ONLY_VIEWPORT}`);

const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});

const problems = [];

async function openGeo(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector(".topbar"), { timeout: 120000 });
  await page.waitForSelector("canvas.gl", { timeout: 90000 });
  await page.getByRole("button", { name: "Geo Replay" }).click();
  await page.waitForFunction(() => !!window.__kayfabeGeo, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const gpu = await page.evaluate(() => {
    const canvas = document.querySelector(".geo-globe canvas");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl
      ? String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      : "unavailable";
  });
  if (REQUIRE_HARDWARE && /unavailable|swiftshader|llvmpipe|software/i.test(gpu)) {
    throw new Error(`software WebGL renderer rejected: ${gpu}`);
  }
  console.log(`  GPU: ${gpu}`);
}

async function pickPromotion(page, name) {
  await page.getByLabel("Search promotion").fill(name);
  await page.waitForTimeout(400);
  await page
    .getByRole("listbox", { name: "promotion options" })
    .getByRole("option")
    .filter({ hasText: new RegExp(`^${name}$`) })
    .first()
    .click();
  await page.waitForTimeout(1500);
}

async function shot(page, label, vp) {
  const file = `${OUT}/${vp.name}-${label}.png`;
  await page.screenshot({ path: file });
  // A globe that rendered nothing but background is the failure mode that
  // automated assertions miss, so flag suspiciously uniform frames.
  const uniform = await page.evaluate(() => {
    const c = document.querySelector(".geo-globe canvas");
    return c ? c.width < 400 || c.height < 300 : true;
  });
  if (uniform) problems.push(`${vp.name}/${label}: globe canvas missing or undersized`);
  console.log(`  ${file}`);
}

for (const vp of VIEWPORTS) {
  console.log(`\n=== ${vp.name} ===`);
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: !!vp.mobile,
    isMobile: !!vp.mobile,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (request) => errors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`http ${response.status()}: ${response.url()}`);
  });

  await openGeo(page);
  await shot(page, "01-corpus-world", vp);

  await pickPromotion(page, "WWF");
  await shot(page, "02-wwf-scope", vp);

  // WWF playback, world overview, accumulating footprint
  await page.locator(".geo-bar").getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(6000);
  await shot(page, "03-wwf-playing", vp);
  await page.waitForTimeout(8000);
  await shot(page, "04-wwf-accumulated-heat", vp);
  await page.locator(".geo-bar").getByRole("button", { name: "Pause", exact: true }).click();

  if (!vp.mobile) {
    // Fit the footprint, then focus one city
    await page.getByRole("button", { name: "Fit active" }).click();
    await page.waitForTimeout(2500);
    await shot(page, "05-wwf-footprint-fit", vp);

    // Chronological arcs on — check they read as annotation, not infrastructure
    await page.getByLabel("Chronological record arcs").check();
    await page.locator(".geo-bar").getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(6000);
    await shot(page, "06-wwf-record-arcs", vp);

    // High-speed aggregation
    await page.getByLabel("Speed").selectOption("100");
    await page.waitForTimeout(5000);
    await shot(page, "07-high-speed-aggregation", vp);
    const stats = await page.evaluate(() => window.__kayfabeGeo.stats());
    console.log("  stats:", JSON.stringify(stats));
    if (stats.intentsDropped !== 0) problems.push(`${vp.name}: intentsDropped=${stats.intentsDropped}`);
    await page.locator(".geo-bar").getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByLabel("Speed").selectOption("3");
    await page.getByLabel("Chronological record arcs").uncheck();

    // Sliding window heat
    await page.getByLabel("Afterglow").selectOption("window");
    await page.waitForTimeout(2500);
    await shot(page, "08-sliding-window", vp);
    await page.getByLabel("Afterglow").selectOption("accumulate");

    // Analytics + city focus
    await page.getByTestId("geo-analytics").getByRole("button", { name: "compute" }).click();
    await page.waitForTimeout(600);
    await page.getByTestId("geo-analytics").locator(".ev-row").first().click();
    await page.waitForTimeout(2500);
    await shot(page, "09-city-focus-inspector", vp);

    // Promotion comparison
    await page.getByLabel("Compare with promotion").fill("NJPW");
    await page.waitForTimeout(500);
    await page.getByTestId("geo-comparison").locator(".chip").first().click();
    await page.waitForTimeout(1500);
    await shot(page, "10-promotion-comparison", vp);

    // Championship geography, gold treatment
    await page.getByRole("button", { name: "Return to world" }).click();
    await page.getByLabel("Scope", { exact: true }).selectOption("championship");
    await page.getByLabel("Search championship").fill("WWE Championship");
    await page.waitForTimeout(600);
    const champ = page.getByRole("listbox", { name: "championship options" }).getByRole("option").first();
    if (await champ.count()) {
      await champ.click();
      await page.waitForTimeout(1200);
      for (let i = 0; i < 6; i++) {
        await page.getByRole("button", { name: "Jump to next title change" }).click();
        await page.waitForTimeout(350);
      }
      await shot(page, "11-title-change-gold", vp);
    }

    // Low quality tier
    await page.evaluate(() => window.__kayfabeGeo.setTier("low"));
    await page.waitForTimeout(1500);
    await shot(page, "12-low-quality-tier", vp);
    await page.evaluate(() => window.__kayfabeGeo.setTier("high"));

    // Unresolved disclosure stays in the contextual inspector.
    await page.getByLabel("Scope", { exact: true }).selectOption("corpus");
    await page.waitForTimeout(900);
    await shot(page, "13-unplotted-inspector", vp);
  } else {
    // Mobile: each sheet, and globe-only
    await page.getByRole("tab", { name: "inspector" }).click();
    await page.waitForTimeout(800);
    await shot(page, "05-mobile-inspector", vp);
    await page.getByRole("tab", { name: "globe only" }).click();
    await page.waitForTimeout(800);
    await shot(page, "06-mobile-globe-only", vp);
  }

  if (errors.length) problems.push(`${vp.name}: ${errors.length} console errors — ${errors[0]}`);
  console.log(`  console errors: ${errors.length}`);
  await ctx.close();
}

// Reduced motion, at the desktop reference viewport
console.log("\n=== reduced-motion 1440x900 ===");
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openGeo(page);
  await pickPromotion(page, "WWF");
  await page.locator(".geo-bar").getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(6000);
  await shot(page, "14-reduced-motion", { name: "reduced-motion" });
  const s = await page.evaluate(() => window.__kayfabeGeo.stats());
  console.log("  stats:", JSON.stringify(s));
  if (s.ringsActive !== 0 || s.columnsActive !== 0) {
    problems.push(`reduced motion still spawning rings/columns: ${JSON.stringify(s)}`);
  }
  if (errors.length) problems.push(`reduced-motion: ${errors[0]}`);
  await ctx.close();
}

await browser.close();
console.log("\n=== automated flags ===");
if (!problems.length) console.log("  none — every frame captured; inspect them by eye");
for (const p of problems) console.log("  ! " + p);
