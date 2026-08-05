/**
 * Visual capture for the Arena, through the renderer's OWN screenshot path.
 *
 * `page.screenshot()` is the wrong tool here and produces a confidently wrong
 * picture: the context is not created with `preserveDrawingBuffer`, so the
 * WebGL surface is undefined once the frame has been presented and the capture
 * comes back with perfect DOM labels sitting on a black void. That looks
 * exactly like a renderer that draws nothing.
 *
 * `ArenaRenderer.screenshot()` renders immediately before reading, inside the
 * same task, and composites the DOM label layer on top — so what it returns is
 * what the reader actually sees.
 *
 * Usage:
 *   KAYFABE_BASE_URL=http://127.0.0.1:9463 node tests/arena-spikes/arena-visual-capture.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const SHOTS = process.env.QA_SHOT_DIR ?? "/tmp/kayfabe-arena-shots";
const SUBJECT = process.env.QA_SUBJECT ?? "Matt Sydal";
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = (process.env.QA_VIEWPORTS ?? "1920x1080,1366x768,390x844")
  .split(",").map((s) => { const [w, h] = s.split("x").map(Number); return { w, h }; });

const browser = await chromium.launch({
  headless: process.env.QA_HEADFUL !== "1",
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});

const saveShot = async (page, name) => {
  const dataUrl = await page.evaluate(() => window.__kayfabeArena?.screenshot() ?? null);
  if (!dataUrl) { console.log(`${name}: renderer returned no screenshot`); return false; }
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(dataUrl.split(",")[1], "base64"));
  console.log(`${name}.png`);
  return true;
};

try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.waitForSelector("canvas.gl", { timeout: 40000 });
    await page.waitForTimeout(3000);
    const box = page.getByRole("combobox", { name: /Search/ });
    await box.fill(SUBJECT);
    await page.locator(".search-pop [role=option]").first().waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".search-pop [role=option]").first().click({ force: true });
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Arena Array" }).click();
    await page.waitForSelector("canvas.arena-gl", { timeout: 20000 });
    await page.waitForFunction(() => window.__kayfabeArena && !window.__kayfabeArena.animating, null, { timeout: 20000 });
    // Pin the tier so a capture describes a KNOWN configuration rather than
    // whatever rung the governor happened to reach on a software rasteriser.
    const tier = process.env.QA_TIER;
    if (tier) {
      // Through the real control, not through the renderer. ArenaLens holds the
      // tier in React state and re-applies it on every render, so a direct
      // applyTier() call is silently reverted and every capture comes back
      // labelled with a tier that is not the one being tested.
      await page.selectOption(".arena-tier select", tier);
      await page.evaluate(() => { window.__kayfabeArena.autoQuality = false; });
    }
    await page.waitForTimeout(1500);
    await saveShot(page, `arena-${vp.w}x${vp.h}${tier ? `-${tier}` : ""}`);
    await context.close();
  }
} finally {
  await browser.close();
}
