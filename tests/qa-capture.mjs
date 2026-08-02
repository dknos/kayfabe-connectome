import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "/tmp/claude-1000/-home-nemoclaw/6ff4b8a3-aa5d-4280-bb8e-67e808d21b09/scratchpad/qa";
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:9460";
const errors = [];

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-webgl"] });

async function desktopFlow() {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[desktop] ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`[desktop pageerror] ${e.message}`));
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(5000); // settle: layout, first frames, labels
  await page.screenshot({ path: `${OUT}/1-global.png` });

  // search → focus
  await page.getByRole("combobox", { name: /Search/ }).fill("Undertaker");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/2-search.png` });
  await page.getByRole("option").first().click({ force: true });
  await page.waitForTimeout(2500); // camera flight + dossier load
  await page.screenshot({ path: `${OUT}/3-focused.png` });

  // relationship dossier
  const ev = page.getByText("open evidence").first();
  if (await ev.isVisible().catch(() => false)) {
    await ev.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/4-relationship.png` });
  }

  // timeline playback — scrub into the Attitude Era first so activity is visible
  await page.getByLabel("Timeline mode").selectOption("playback");
  const strip = page.locator(".pulse-canvas-wrap canvas");
  const box = await strip.boundingBox();
  await page.mouse.click(box.x + box.width * 0.57, box.y + box.height * 0.5);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/5-playback.png` });
  await page.getByRole("button", { name: "Pause" }).click();

  // date filter narrowed
  await page.getByLabel("Years").fill("1997");
  await page.getByLabel("End year", { exact: true }).fill("2001");
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/6-filtered-97-01.png` });

  console.log("desktop URL state:", page.url());
  await ctx.close();
}

async function mobileFlow() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[mobile] ${m.text()}`));
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${OUT}/7-mobile.png` });
  await ctx.close();
}

async function reducedFlow() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/8-reduced-motion.png` });
  await ctx.close();
}

async function semanticInspectorFlow() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  const search = page.getByRole("combobox", { name: /Search/ });
  await search.fill("Ric Flair");
  await page.getByRole("option").first().click({ force: true });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/9-semantic-inspector.png` });
  await ctx.close();
}

async function globalCorpusFlow() {
  // v2: the csv merge made the corpus global — verify the NJPW region and
  // Meltzer-starred evidence rows on a rated rivalry
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`[global] ${m.text()}`));
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.getByRole("combobox", { name: /Search/ }).fill("Kazuchika Okada");
  await page.waitForTimeout(600);
  await page.getByRole("option").first().click({ force: true });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/10-okada-focus.png` });
  const ev = page.getByText("open evidence").first();
  if (await ev.isVisible().catch(() => false)) {
    await ev.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/11-okada-evidence.png` });
  }
  await ctx.close();
}

await desktopFlow();
await mobileFlow();
await reducedFlow();
await semanticInspectorFlow();
await globalCorpusFlow();
await browser.close();
console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):\n` + errors.slice(0, 20).join("\n") : "NO CONSOLE ERRORS");
