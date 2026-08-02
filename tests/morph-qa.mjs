/**
 * Morph Lab QA harness — screenshots plus renderer-counter probes, in the
 * Earlier visual-QA mould: a screenshot that looks plausible but reports the wrong
 * mode or a dead morph still fails.
 *
 * ARGS: argv[2] = output dir (default /tmp/kayfabe-morph-qa)
 * ENV: KAYFABE_BASE_URL, QA_W/QA_H, QA_TAG, QA_REDUCED=1, QA_MOBILE=1,
 *      QA_CHROMIUM_EXECUTABLE (optional full Chrome path for hardware GL),
 *      QA_REQUIRE_HARDWARE=1 (reject software WebGL such as SwiftShader)
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-morph-qa";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const W = Number(process.env.QA_W ?? 1920);
const H = Number(process.env.QA_H ?? 1080);
const TAG = process.env.QA_TAG ?? String(W);
const REDUCED = process.env.QA_REDUCED === "1";
const MOBILE = process.env.QA_MOBILE === "1";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1";

const errors = [];
const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  ...(REDUCED ? { reducedMotion: "reduce" } : {}),
  ...(MOBILE ? { hasTouch: true, isMobile: true } : {}),
});
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
page.on("response", (r) => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.url()}`));

const probe = () =>
  page.evaluate(() => {
    const r = window.__kayfabeMorph;
    if (!r) return null;
    const canvas = document.querySelector("canvas.morph-gl");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return {
      mode: r.mode,
      morphing: r.morphing,
      progress: r.morphProgress,
      traces: r.traceLive,
      labels: r.lastLabelReport,
      frameMs: Math.round(r.frameTimeMs * 10) / 10,
      tier: r.qualityTier,
      gpu: gl
        ? String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
        : "unavailable",
    };
  });

const waitMode = (mode, settled = true) =>
  page.waitForFunction(
    ([expected, mustSettle]) => {
      const r = window.__kayfabeMorph;
      return r?.mode === expected && (!mustSettle || !r.morphing);
    },
    [mode, settled],
    { timeout: 30000 },
  );

const exactText = (value) =>
  new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

const search = async (query, expectedName = query) => {
  const box = page.getByRole("combobox", { name: /Search/ });
  await box.fill("");
  await box.fill(query);
  const option = page.locator('.search-pop [role="option"]').filter({
    has: page.locator("span", { hasText: exactText(expectedName) }),
  });
  await option.first().waitFor({ state: "visible", timeout: 10000 });
  if (await option.count() !== 1) {
    throw new Error(`${query}: expected one exact result named ${expectedName}, got ${await option.count()}`);
  }
  await option.click();
  await page.locator(".morph-crumbs").getByText(expectedName, { exact: true }).waitFor({ timeout: 10000 });
};

const clickLabelAction = async (entityName, actionName) => {
  const label = page.locator(".mlabel.force").filter({
    has: page.locator(".mlabel-name", { hasText: exactText(entityName) }),
  });
  await label.first().waitFor({ state: "visible", timeout: 10000 });
  if (await label.count() !== 1) throw new Error(`${entityName}: expected one focus label`);
  await label.hover();
  const action = label.getByRole("button", { name: actionName, exact: true });
  await action.waitFor({ state: "visible", timeout: 6000 });
  await action.click();
};

const expectMembers = async (expected, label) => {
  await page.waitForFunction(
    (count) => window.__kayfabeMorph?.emphasisSnapshot().members === count,
    expected,
    { timeout: 20000 },
  );
  const actual = await page.evaluate(() => window.__kayfabeMorph?.emphasisSnapshot().members ?? -1);
  if (actual !== expected) throw new Error(`${label}: expected ${expected} semantic members, got ${actual}`);
  console.log(`${label}-members`, actual);
};

const shot = async (name, expectedMode, expectedMorphing) => {
  const state = await probe();
  if (!state) throw new Error(`${TAG}-${name}: Morph renderer probe is unavailable`);
  if (state.mode !== expectedMode) {
    throw new Error(`${TAG}-${name}: expected ${expectedMode}, got ${state.mode}`);
  }
  if (expectedMorphing != null && state.morphing !== expectedMorphing) {
    throw new Error(`${TAG}-${name}: expected morphing=${expectedMorphing}, got ${state.morphing}`);
  }
  if (REQUIRE_HARDWARE && (state.gpu === "unavailable" || /swiftshader|llvmpipe|software/i.test(state.gpu))) {
    throw new Error(`${TAG}-${name}: software WebGL renderer rejected: ${state.gpu}`);
  }
  await page.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
  console.log(`${TAG}-${name}`, JSON.stringify(state));
};

try {
await page.goto(BASE);
await page.waitForSelector("canvas.gl", { timeout: 30000 });
await page.waitForTimeout(4000);

// enter the lab
await page.getByRole("button", { name: /^Morph Lab(?: β)?$/ }).click();
await page.waitForSelector(".morph-gl", { timeout: 20000 });
await waitMode("organic");
await shot("1-organic", "organic", false);

// organic positions must equal the connectome's (scaled) — probe one node
const organicCheck = await page.evaluate(() => {
  const r = window.__kayfabeMorph;
  const m = window.__kayfabeRenderer;
  if (!r || !m) return "missing renderers";
  const p = r.currentPositionOf(0);
  return { morph0: p };
});
console.log("organic-check", JSON.stringify(organicCheck));
if (organicCheck === "missing renderers" || !organicCheck.morph0?.every(Number.isFinite)) {
  throw new Error(`organic position probe failed: ${JSON.stringify(organicCheck)}`);
}

// select a wrestler → Relationship Array
await search("Undertaker", "The Undertaker");
await waitMode("loom", false);
if (!REDUCED) await page.waitForFunction(() => window.__kayfabeMorph?.morphing, undefined, { timeout: 10000 });
await page.waitForTimeout(250);
await shot("2-loom-midmorph", "loom", REDUCED ? false : true);
await page.waitForTimeout(2200);
await waitMode("loom");
await shot("3-loom", "loom", false);

// retarget to another wrestler mid-reading
await search("Kane");
if (!REDUCED) await page.waitForFunction(() => window.__kayfabeMorph?.morphing, undefined, { timeout: 10000 });
await page.waitForTimeout(250);
await shot("4-retarget-midmorph", "loom", REDUCED ? false : true);
await page.waitForTimeout(2000);
await waitMode("loom");
await shot("5-loom-kane", "loom", false);

// Dense wrestler — membership is the full graph adjacency, not trace budget.
await search("Ric Flair");
await waitMode("loom");
await expectMembers(398, "ric-flair");
await shot("6-dense-ric-flair", "loom", false);

// Large promotion — all current-corpus documented participants illuminate.
await search("AJPW");
await waitMode("motherboard");
await expectMembers(1563, "ajpw");
await shot("7-promotion-ajpw", "motherboard", false);

// Title → lineage; holders come only from explicit reign records.
await search("WWF Hardcore Title");
await waitMode("lineage");
await expectMembers(37, "wwf-hardcore-title");
await shot("8-title-hardcore", "lineage", false);

if (!MOBILE) {
  // Career playback: the visible playhead and pulses use live routed geometry.
  await search("Undertaker", "The Undertaker");
  await waitMode("loom");
  await page.getByRole("button", { name: "Career", exact: true }).click({ timeout: 8000 });
  await waitMode("career");
  await shot("9-career", "career", false);
  await page.locator('.pulsebar [aria-label="Play"]').click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  await shot("10-career-playing", "career", false);
  await page.locator('.pulsebar [aria-label="Pause"]').click({ timeout: 8000 });

  // Head-to-Head through the same projected-label actions a reader uses.
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await waitMode("loom");
  await clickLabelAction("The Undertaker", "Set comparison A");
  await search("Kane");
  await waitMode("loom");
  await clickLabelAction("Kane", "Set comparison B");
  await page.getByRole("button", { name: "Compare", exact: true }).click({ timeout: 8000 });
  await waitMode("h2h");
  await shot("11-head-to-head", "h2h", false);

  // Five fast selections must finish on the fifth and stay there.
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  for (const [query, expectedName] of [
    ["Undertaker", "The Undertaker"],
    ["Kane", "Kane"],
    ["Steve Austin", "Steve Austin"],
    ["The Rock", "The Rock"],
    ["Ric Flair", "Ric Flair"],
  ]) {
    await search(query, expectedName);
    await page.waitForTimeout(90);
  }
  await waitMode("loom");
  const finalAnchor = await page.evaluate(() => {
    const renderer = window.__kayfabeMorph;
    const anchor = renderer?.currentLayout?.anchorId;
    return renderer?.currentLayout?.labels.find((label) => label.pick === anchor)?.text ?? null;
  });
  if (finalAnchor !== "Ric Flair") throw new Error(`rapid retarget ended on ${finalAnchor}`);
  await shot("12-rapid-retarget", "loom", false);
}

// return to tissue
if (MOBILE) await page.getByRole("tab", { name: "Layout" }).click({ timeout: 6000 });
await page.getByRole("button", { name: /Return to tissue/i }).click({ timeout: 6000 });
await waitMode("organic");
await shot(MOBILE ? "9-tissue" : "13-tissue", "organic", false);

// back to connectome — must be intact
await page.getByRole("button", { name: "Connectome", exact: true }).click();
await page.waitForFunction(() => window.__kayfabeRenderer?.isActive === true, undefined, { timeout: 10000 });
await page.screenshot({ path: `${OUT}/${TAG}-${MOBILE ? "10" : "14"}-connectome-back.png` });

console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):` : "NO CONSOLE ERRORS");
for (const e of errors.slice(0, 20)) console.log("  " + e);
if (errors.length) throw new Error(`runtime failures:\n${errors.join("\n")}`);
} finally {
  await browser.close();
}
