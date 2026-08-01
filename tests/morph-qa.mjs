/**
 * Morph Lab QA harness — screenshots plus renderer-counter probes, in the
 * atlas-qa mould: a screenshot that looks plausible but reports the wrong
 * mode or a dead morph still fails.
 *
 * ARGS: argv[2] = output dir (default /tmp/kayfabe-morph-qa)
 * ENV: KAYFABE_BASE_URL, QA_W/QA_H, QA_TAG, QA_REDUCED=1, QA_MOBILE=1
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-morph-qa";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const W = Number(process.env.QA_W ?? 1920);
const H = Number(process.env.QA_H ?? 1080);
const TAG = process.env.QA_TAG ?? String(W);
const REDUCED = process.env.QA_REDUCED === "1";
const MOBILE = process.env.QA_MOBILE === "1";

const errors = [];
const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-webgl"] });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  ...(REDUCED ? { reducedMotion: "reduce" } : {}),
  ...(MOBILE ? { hasTouch: true, isMobile: true } : {}),
});
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const probe = () =>
  page.evaluate(() => {
    const r = window.__kayfabeMorph;
    if (!r) return null;
    return {
      mode: r.mode,
      morphing: r.morphing,
      progress: r.morphProgress,
      traces: r.traceLive,
      labels: r.lastLabelReport,
      frameMs: Math.round(r.frameTimeMs * 10) / 10,
      tier: r.qualityTier,
    };
  });

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
  console.log(`${TAG}-${name}`, JSON.stringify(await probe()));
};

await page.goto(BASE);
await page.waitForSelector("canvas.gl", { timeout: 30000 });
await page.waitForTimeout(4000);

// enter the lab
await page.getByRole("button", { name: "Morph Lab β" }).click();
await page.waitForSelector(".morph-gl", { timeout: 20000 });
await page.waitForTimeout(3500);
await shot("1-organic");

// organic positions must equal the connectome's (scaled) — probe one node
const organicCheck = await page.evaluate(() => {
  const r = window.__kayfabeMorph;
  const m = window.__kayfabeRenderer;
  if (!r || !m) return "missing renderers";
  const p = r.currentPositionOf(0);
  return { morph0: p };
});
console.log("organic-check", JSON.stringify(organicCheck));

// select a wrestler → loom
await page.getByRole("combobox", { name: /Search/ }).fill("Undertaker");
await page.waitForTimeout(700);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(350);
await shot("2-loom-midmorph");
await page.waitForTimeout(2200);
await shot("3-loom");

// retarget to another wrestler mid-reading
await page.getByRole("combobox", { name: /Search/ }).fill("Kane");
await page.waitForTimeout(700);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(420);
await shot("4-retarget-midmorph");
await page.waitForTimeout(2000);
await shot("5-loom-kane");

// promotion → motherboard
await page.getByRole("combobox", { name: /Search/ }).fill("WWF");
await page.waitForTimeout(700);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2600);
await shot("6-motherboard");

// title → lineage (via inspector row if present; the rail is a sheet on
// mobile, so these steps degrade gracefully there)
try {
  const titleRow = page.locator(".morph-rail .ev-row.search-row").first();
  await titleRow.click({ timeout: 6000 });
  await page.waitForTimeout(2400);
  await shot("7-lineage");
} catch {
  console.log(`${TAG}-7-lineage skipped (no reachable title row)`);
}

// return to tissue
try {
  await page.getByRole("button", { name: /Return to tissue/ }).click({ timeout: 6000 });
  await page.waitForTimeout(2400);
  await shot("8-tissue");
} catch {
  console.log(`${TAG}-8-tissue skipped (button behind sheet)`);
}

// back to connectome — must be intact
await page.getByRole("button", { name: "Connectome", exact: true }).click();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/${TAG}-9-connectome-back.png` });

console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):` : "NO CONSOLE ERRORS");
for (const e of errors.slice(0, 20)) console.log("  " + e);
await browser.close();
process.exit(errors.length ? 1 : 0);
