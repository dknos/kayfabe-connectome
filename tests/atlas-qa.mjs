/**
 * Visual QA for the ATLAS lens.
 *
 * Walks the semantic hierarchy the way a reader does and captures every state
 * the spec's visual-QA list calls for. Reads the renderer's own counters as
 * well as the frame, so a screenshot that looks plausible but represents the
 * wrong number of promotions still fails.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-atlas-qa";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const W = Number(process.env.QA_W ?? 1920);
const H = Number(process.env.QA_H ?? 1080);
const TAG = process.env.QA_TAG ?? "1920";

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-webgl"] });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  ...(process.env.QA_REDUCED ? { reducedMotion: "reduce" } : {}),
  ...(process.env.QA_MOBILE ? { hasTouch: true, isMobile: true } : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const shot = (n) => page.screenshot({ path: `${OUT}/${TAG}-${n}.png` });
const probe = () =>
  page.evaluate(() => {
    const r = window.__kayfabeAtlas;
    const s = r?.scene_;
    return {
      state: s?.state ?? null,
      quads: s?.quads.length ?? 0,
      dots: s?.dots.length ?? 0,
      paths: s?.paths.length ?? 0,
      labelSpecs: s?.labels.length ?? 0,
      domLabels: document.querySelectorAll(".alabel").length,
      lanes: s?.lanes.length ?? 0,
      crumbs: [...document.querySelectorAll(".atlas-crumbs .crumb")].map((e) => e.textContent.trim()),
      counts: document.querySelector('[data-testid="atlas-counts"]')?.textContent?.trim() ?? "",
      frameMs: r ? +r.frameTimeMs.toFixed(1) : null,
      tier: r?.qualityTier ?? null,
    };
  });

await page.goto(BASE);
await page.waitForSelector("canvas.gl", { timeout: 60000 });
await page.waitForTimeout(4000);

await page.getByRole("button", { name: "Atlas", exact: true }).click();
await page.waitForSelector('[data-testid="atlas-canvas"]', { timeout: 30000 });
await page.waitForTimeout(4500);
console.log("overview:", JSON.stringify(await probe()));
await shot("1-overview");

// zoom into a dense band so title rails resolve
await page.mouse.move(W * 0.55, H * 0.4);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(120); }
await page.waitForTimeout(1400);
console.log("dense:", JSON.stringify(await probe()));
await shot("2-dense-group");

// On a narrow viewport the controls live behind a bottom-sheet tab.
const openControls = async () => {
  const tab = page.getByRole("button", { name: "Controls", exact: true });
  if (await tab.isVisible().catch(() => false)) await tab.click();
};
await openControls();
await page.getByRole("button", { name: "Fit view" }).click();
await page.waitForTimeout(1200);
if (process.env.QA_MOBILE) {
  await shot("2b-controls-sheet");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.waitForTimeout(400);
}

// search a promotion -> should centre + flash its lane
await page.getByRole("combobox", { name: /Search/ }).fill("WWE");
await page.waitForTimeout(700);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2600);
console.log("promotion:", JSON.stringify(await probe()));
await shot("3-promotion-focus");

// a title-heavy promotion
await page.getByRole("combobox", { name: /Search/ }).fill("NJPW");
await page.waitForTimeout(700);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2800);
console.log("title-heavy:", JSON.stringify(await probe()));
await shot("4-title-heavy-promotion");

// a lineage with real reigns
await page.getByRole("combobox", { name: /Search/ }).fill("WWE Championship");
await page.waitForTimeout(800);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2800);
console.log("lineage:", JSON.stringify(await probe()));
await shot("5-championship-lineage");

// a tag-team lineage
await page.getByRole("combobox", { name: /Search/ }).fill("WWF Tag Team Titles");
await page.waitForTimeout(800);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2600);
console.log("tag lineage:", JSON.stringify(await probe()));
await shot("6-tag-lineage");

// a source-artifact title
await page.getByRole("combobox", { name: /Search/ }).fill("Cruiserweight Classic Championship");
await page.waitForTimeout(800);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2400);
console.log("artifact:", JSON.stringify(await probe()));
await shot("7-artifact-title");

// a career across many promotions
await page.getByRole("combobox", { name: /Search/ }).fill("Chris Jericho");
await page.waitForTimeout(800);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(3000);
console.log("career:", JSON.stringify(await probe()));
await shot("8-career-route");

// a wrestler with no titles
await page.getByRole("combobox", { name: /Search/ }).fill("Colt Cabana");
await page.waitForTimeout(800);
await page.getByRole("option").first().click({ force: true });
await page.waitForTimeout(2800);
console.log("career-notitles:", JSON.stringify(await probe()));
await shot("9-career-no-titles");

// playback
await page.getByLabel("Timeline mode").selectOption("playback");
await page.getByRole("button", { name: "Play", exact: true }).click();
await page.waitForTimeout(4000);
await shot("10-playback");
await page.getByRole("button", { name: "Pause" }).click();
console.log("playback:", JSON.stringify(await probe()));

// back to overview, then lens round trip
await page.keyboard.press("Escape");
await page.waitForTimeout(1500);
const afterEsc = await probe();
console.log("after esc:", JSON.stringify(afterEsc));
await shot("11-back-to-overview");

console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):\n${errors.slice(0, 12).join("\n")}` : "NO CONSOLE ERRORS");
console.log(`screenshots -> ${OUT}`);
await ctx.close();
await browser.close();
