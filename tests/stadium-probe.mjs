/** Stadium tab QA probe: stale-bundle check, formation switch, screenshots. */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.PROBE_URL ?? "http://127.0.0.1:9462";
const OUT = "/tmp/claude-1000/-home-nemoclaw/5b5d1498-b592-4671-83e5-34ab1e18a208/scratchpad/stadium-assets/qa";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.type(), m.text()); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(`${BASE}/#2/lens=arena`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__kayfabeArena !== undefined, null, { timeout: 60000 });

// Stale-bundle detector: the stadium seam only exists in the new package code.
const fresh = await page.evaluate(() => window.__kayfabeArena.stadium !== undefined);
console.log("bundle fresh:", fresh);
if (!fresh) {
  console.log("STALE VITE — restart the dev server and re-run");
  await browser.close();
  process.exit(2);
}

await page.evaluate(() => { window.__kayfabeArena.autoQuality = false; });
// Let the default arena settle, capture a control shot for regression eyes.
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/arena_before.png` });

await page.click('.arena-formations button:has-text("Stadium")');
// GLB fetch + parse + first frames. Poll until the environment group has the
// loaded scenes (env + ring + chairs arrive as children beyond the rig).
await page.waitForFunction(() => {
  const s = window.__kayfabeArena.stadium;
  return s && s.root.visible && s.root.children.length > 25;
}, null, { timeout: 120000 }).catch(() => console.log("env child-count wait timed out (rig-only?)"));
await page.waitForTimeout(4000); // transition + a few frames
const stats = await page.evaluate(() => {
  const r = window.__kayfabeArena;
  return {
    formation: r.formation,
    seated: r.layout?.seated,
    sections: r.layout?.sections,
    drawCalls: r.drawCalls,
    frameWallMs: Math.round(r.frameWallMs * 10) / 10,
    tier: r.tier,
    rootChildren: r.stadium.root.children.length,
  };
});
console.log("stadium stats:", JSON.stringify(stats));
await page.screenshot({ path: `${OUT}/stadium_default.png` });

// The composited screenshot (labels + meta strip) through the renderer's own seam.
const shot = await page.evaluate(() => window.__kayfabeArena.screenshot());
if (shot) fs.writeFileSync(`${OUT}/stadium_composited.png`, Buffer.from(shot.split(",")[1], "base64"));

// Switch back: the original formations must be untouched.
// Scoped to the formation group: the header's "Arena Array" lens button is
// also a button containing "Arena", and page.click takes the first DOM match.
await page.click('.arena-formations button:has-text("Arena")');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/arena_after.png` });
const back = await page.evaluate(() => ({
  formation: window.__kayfabeArena.formation,
  stadiumVisible: window.__kayfabeArena.stadium.root.visible,
}));
console.log("back to arena:", JSON.stringify(back));

await browser.close();
console.log("PROBE DONE");
