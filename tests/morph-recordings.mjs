/**
 * Morph Lab journey recordings — the visual-QA reel.
 *
 * Records the transformations that prove the lens: organic → Loom,
 * wrestler → wrestler retarget, Loom → Motherboard, Motherboard → Lineage,
 * Career Circuit playback, Return to tissue, and a rapid retarget during an
 * unfinished morph. One video per journey (webm), plus a probe log.
 *
 * ARGS: argv[2] = output dir (default /tmp/kayfabe-morph-recordings)
 * ENV: KAYFABE_BASE_URL (default http://127.0.0.1:9460)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/kayfabe-morph-recordings";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-webgl"] });

const ONLY = process.argv[3] ?? null;

async function record(name, drive) {
  if (ONLY && !name.includes(ONLY)) return;
  const dir = join(OUT, ".tmp-" + name);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir, size: { width: 1600, height: 900 } },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Morph Lab β" }).click();
  await page.waitForSelector(".morph-gl", { timeout: 20000 });
  await page.waitForTimeout(2500);
  try {
    await drive(page);
  } catch (e) {
    console.log(name, "DRIVE FAILED:", String(e).split("\n")[0]);
  }
  await ctx.close();
  const file = readdirSync(dir).find((f) => f.endsWith(".webm"));
  if (file) renameSync(join(dir, file), join(OUT, `${name}.webm`));
  console.log(name, errors.length ? `PAGEERRORS: ${errors.join(" | ")}` : "ok");
}

const search = async (page, q) => {
  await page.getByRole("combobox", { name: /Search/ }).fill(q);
  await page.waitForTimeout(700);
  await page.getByRole("option").first().click({ force: true });
};

await record("1-organic-to-loom", async (page) => {
  await search(page, "Undertaker");
  await page.waitForTimeout(2600);
});

await record("2-wrestler-to-wrestler", async (page) => {
  await search(page, "Undertaker");
  await page.waitForTimeout(2400);
  await search(page, "Kane");
  await page.waitForTimeout(2400);
});

await record("3-loom-to-motherboard", async (page) => {
  await search(page, "Undertaker");
  await page.waitForTimeout(2400);
  await search(page, "WWF");
  await page.waitForTimeout(2800);
});

await record("4-motherboard-to-lineage", async (page) => {
  await search(page, "WWF");
  await page.waitForTimeout(2600);
  const row = page.locator(".rail.right.morph-rail .ev-row").first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(2800);
  }
});

await record("5-career-playback", async (page) => {
  await search(page, "Undertaker");
  await page.waitForTimeout(1800);
  await page.locator(".morph-layouts .chip", { hasText: "Career Circuit" }).click({ timeout: 8000 });
  await page.waitForTimeout(2200);
  await page.locator('.pulsebar [aria-label="Play"]').click({ timeout: 8000 });
  await page.waitForTimeout(6000);
  await page.locator('.pulsebar [aria-label="Pause"]').click({ timeout: 4000 }).catch(() => {});
});

await record("6-return-to-tissue", async (page) => {
  await search(page, "Undertaker");
  await page.waitForTimeout(2400);
  await page.getByRole("button", { name: /Return to tissue/ }).click();
  await page.waitForTimeout(2600);
});

await record("7-rapid-retarget-midmorph", async (page) => {
  await search(page, "Undertaker");
  await page.waitForTimeout(420); // mid-flight
  await search(page, "Kane");
  await page.waitForTimeout(420); // mid-flight again
  await search(page, "Steve Austin");
  await page.waitForTimeout(2600);
});

await browser.close();
console.log("recordings in", OUT);
