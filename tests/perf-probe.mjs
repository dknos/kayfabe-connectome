import { chromium } from "@playwright/test";
const browser = await chromium.launch();
for (const [name, vp] of [["desktop-1920", { width: 1920, height: 1080 }], ["mobile-390", { width: 390, height: 844 }]]) {
  const page = await (await browser.newContext({ viewport: vp })).newPage();
  await page.goto("http://127.0.0.1:9460");
  await page.waitForSelector("canvas.gl", { timeout: 30000 });
  await page.waitForTimeout(9000);
  const stats = await page.evaluate(() => {
    const r = window.__kayfabeRenderer;
    return { frameMs: r.governor.frameTimeMs().toFixed(1), tier: r.governor.tier, dropped: r.droppedEdges };
  });
  console.log(name, JSON.stringify(stats));
  if (name.startsWith("mobile")) await page.screenshot({ path: "/tmp/claude-1000/-home-nemoclaw/6ff4b8a3-aa5d-4280-bb8e-67e808d21b09/scratchpad/qa/7-mobile.png" });
  await page.context().close();
}
await browser.close();
