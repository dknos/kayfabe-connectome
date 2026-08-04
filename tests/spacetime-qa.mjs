/**
 * Spacetime lens QA probe: boot, open the lens, read the seam, screenshot.
 *
 * Headless WebGL here is SwiftShader, so nothing below judges appearance or
 * frame time — assertions read state through __kayfabeSpacetime, and a
 * screenshot that contradicts its own probe state fails rather than ships.
 *
 *   node tests/spacetime-qa.mjs [outdir]
 *   PROBE_MODE=bridge PROBE_PLAY=1 PROBE_SPEED=365 PROBE_UNWARP=1
 *   KAYFABE_BASE_URL=http://127.0.0.1:9461 (second-vite sessions)
 */
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const OUT = process.argv[2] ?? "/tmp/kayfabe-spacetime-qa";
const MODE = process.env.PROBE_MODE ?? "exterior";
mkdirSync(OUT, { recursive: true });

const failures = [];
const assert = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${what}`);
};

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
    frameWallMs: r.frameWallMs,
    labels: r.labels.report,
    beadCount: r.events.count,
    contextLost: r.contextLost,
    notes: l.notes,
  };
});
console.log(JSON.stringify(state, null, 2));

assert(state.subject === "p:116704", "canonical subject is Matt Sydal");
assert(state.personas === 2, "Sydal + Bourne merged as one worldline");
assert(state.events === 922, "922 documented events (695 + 227)");
assert(state.drawn + state.hidden === state.relationships,
  "hidden worldlines reported, never lost");
assert(state.beadCount === state.events, "every event has a bead");
assert(!state.contextLost, "GL context live");
assert(state.mode === MODE, `probe reached ${MODE} mode`);
if (MODE === "bridge" && process.env.PROBE_UNWARP !== "1") {
  assert(state.warpMix > 0.85, "bridge warp mix engaged");
}
if (process.env.PROBE_UNWARP === "1") {
  assert(state.warpMix < 0.2, "held U unwarps the sky");
}
assert(errors.length === 0, `no console errors (${errors.length})${errors[0] ? ` — ${errors[0]}` : ""}`);

const shot = `${OUT}/${MODE}${process.env.PROBE_PLAY === "1" ? "-play" : ""}${process.env.PROBE_UNWARP === "1" ? "-unwarp" : ""}.png`;
await page.screenshot({ path: shot });
console.log(`screenshot: ${shot}`);
await browser.close();
if (failures.length > 0) {
  console.error(`spacetime-qa FAILED: ${failures.join("; ")}`);
  process.exit(2);
}
console.log("spacetime-qa OK");
