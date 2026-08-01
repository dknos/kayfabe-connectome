import { chromium } from "@playwright/test";
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message + "\n" + (e.stack || "").slice(0, 800)));
await page.goto("http://127.0.0.1:9460/");
await page.locator("canvas.gl").waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
console.log("boot ok, errors so far:", errors.length);
await page.getByLabel("Years").fill("1985");
await page.getByLabel("End year", { exact: true }).fill("1992");
const t0 = Date.now();
try {
  await page.getByText("record-accurate range").waitFor({ timeout: 60000 });
  console.log("record-accurate visible after", Date.now() - t0, "ms");
} catch { console.log("record-accurate NEVER appeared"); }
await page.waitForTimeout(2000);
const mainText = await page.locator(".rail.left").textContent().catch(() => "(left rail missing)");
console.log("left rail text:", (mainText || "").slice(0, 300));
console.log("CONSOLE ERRORS:", JSON.stringify(errors.slice(0, 6), null, 1));
await b.close();
