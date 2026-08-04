// Quick spacetime lens probe: boot, open lens, read the seam, screenshot.
// Headless here is SwiftShader — layout/state assertions only, never fps.
import { chromium } from "@playwright/test";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9462";
const OUT = process.argv[2] ?? "/tmp/claude-1000/-home-nemoclaw/d65e16f0-c2ed-43c1-9fbc-89c52139c3d1/scratchpad/shots";
const MODE = process.env.PROBE_MODE ?? "exterior";

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(`${BASE}/#2/lens=spacetime`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas.spacetime-gl", { timeout: 60000 });
await page.waitForFunction(() => {
  const r = window.__kayfabeSpacetime;
  return r && r.scope && r.currentLayout;
}, { timeout: 60000 });
await page.waitForTimeout(1500);

if (MODE === "bridge") {
  await page.keyboard.press("b");
  await page.waitForTimeout(2500);
}
if (process.env.PROBE_SPEED) {
  await page.selectOption('select[aria-label="Playback speed"]', process.env.PROBE_SPEED);
}
if (process.env.PROBE_PLAY === "1") {
  await page.keyboard.press(" ");
  await page.waitForTimeout(3500);
}
if (process.env.PROBE_UNWARP === "1") {
  await page.keyboard.down("u");
  await page.waitForTimeout(1600);
}

const state = await page.evaluate(() => {
  const r = window.__kayfabeSpacetime;
  const l = r.currentLayout;
  return {
    subject: r.scope.subjectId,
    label: r.scope.subjectLabel,
    events: r.scope.events.length,
    personas: r.scope.personas.length,
    relationships: r.scope.relationships.length,
    drawn: l.drawnWorldlines,
    hidden: l.hiddenWorldlines,
    sectors: l.sectors.length,
    decades: l.decades.length,
    mode: r.mode,
    playhead: r.playhead,
    warpV: r.warpSpeed,
    warpMix: r.warpMixNow,
    tier: r.tier,
    drawCalls: r.drawCalls,
    frameWallMs: r.frameWallMs,
    labels: r.labels.report,
    beadCount: r.events.count,
    contextLost: r.contextLost,
    notes: l.notes,
  };
});
console.log(JSON.stringify(state, null, 2));
console.log("console errors:", errors.length, errors.slice(0, 5));

await page.screenshot({ path: `${OUT}/${MODE}${process.env.PROBE_PLAY === "1" ? "-play" : ""}${process.env.PROBE_UNWARP === "1" ? "-unwarp" : ""}.png` });
await browser.close();
