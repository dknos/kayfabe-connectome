/**
 * Short reproducible ratings journeys for human review. ARGS: output dir;
 * ENV: KAYFABE_BASE_URL, QA_HEADFUL, QA_CHROMIUM_EXECUTABLE, QA_ONLY=name.
 */
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-ratings-recordings";
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const ONLY = process.env.QA_ONLY?.split(",").filter(Boolean) ?? null;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: process.env.QA_HEADFUL !== "1", ...(process.env.QA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE } : {}), args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"] });
const results = [];
const persistReport = () => writeFileSync(`${OUT}/report.json`, `${JSON.stringify({ base: BASE, results }, null, 2)}\n`);

async function record(name, journey) {
  if (ONLY && !ONLY.includes(name)) return;
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, recordVideo: { dir: OUT, size: { width: 1600, height: 900 } } });
  const page = await context.newPage(), errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (request) => request.url().includes("/data/") && errors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`));
  page.on("response", (response) => response.status() >= 400 && response.url().includes("/data/") && errors.push(`http ${response.status()}: ${response.url()}`));
  const video = page.video();
  try {
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("canvas.gl").waitFor({ state: "visible", timeout: 40_000 });
    await page.getByRole("button", { name: "Meltzer Ratings", exact: true }).click();
    await page.getByTestId("ratings-canvas").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => window.__kayfabeRatings?.currentLayout && !window.__kayfabeRatings.morphing, undefined, { timeout: 35_000 });
    await journey(page);
    if (errors.length) throw new Error(errors.join("\n"));
    results.push({ name, ok: true });
  } catch (error) { results.push({ name, ok: false, error: String(error) }); throw error; }
  finally {
    await context.close();
    if (video) { const path = await video.path(); const target = `${OUT}/${name}.webm`; if (path && existsSync(path)) renameSync(path, target); }
    persistReport();
  }
}

try {
  await record("promotion-to-five-star", async (page) => {
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "5★+", exact: true }).click();
    await page.waitForFunction(() => window.__kayfabeRatings?.visibleExactMatches > 0 && !window.__kayfabeRatings.morphing);
    await page.waitForTimeout(900);
  });
  await record("lock-exact-ledger-match", async (page) => {
    const list = page.getByRole("listbox", { name: /Rated matches in/ });
    await list.getByRole("option").first().click();
    await page.getByLabel("Ratings inspector").getByText("Locked match", { exact: false }).waitFor();
    await page.waitForTimeout(1000);
  });
  await record("undertaker-career-ridge", async (page) => {
    const box = page.getByRole("combobox", { name: /Search people/ });
    await box.fill("The Undertaker");
    await page.locator('.search-pop [role="option"]').filter({ hasText: "The Undertaker" }).first().click({ force: true });
    await page.waitForFunction(() => window.__kayfabeRatings?.mode === "career" && !window.__kayfabeRatings.morphing, undefined, { timeout: 35_000 });
    await page.waitForTimeout(1000);
  });
  if (!results.length) throw new Error(`QA_ONLY selected no known recording: ${process.env.QA_ONLY}`);
  persistReport();
  console.log(`ratings recordings complete: ${results.filter((r) => r.ok).length}/${results.length}`);
} finally {
  persistReport();
  await browser.close();
}
