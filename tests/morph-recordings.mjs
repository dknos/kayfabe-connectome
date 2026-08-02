/**
 * Morph Lab journey recordings — the visual-QA reel.
 *
 * Records the transformations that prove the lens: organic → Relationship
 * Array, dense wrestler, large promotion, exact title lineage, Career Spine
 * playback, Head-to-Head, Return to Tissue, and a five-target rapid retarget.
 * One fail-closed video per journey (webm).
 *
 * ARGS: argv[2] = output dir (default /tmp/kayfabe-morph-recordings)
 * ENV: KAYFABE_BASE_URL (default http://127.0.0.1:9460),
 *      QA_CHROMIUM_EXECUTABLE (optional full Chrome path for hardware GL),
 *      QA_REQUIRE_HARDWARE=1 (reject software WebGL such as SwiftShader)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2] ?? "/tmp/kayfabe-morph-recordings";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1";
const WIDTH = Number(process.env.QA_W ?? 1600);
const HEIGHT = Number(process.env.QA_H ?? 900);
const NARROW = WIDTH <= 860;
const TAG = process.env.QA_TAG ? `${process.env.QA_TAG}-` : "";
const browser = await chromium.launch({
  ...(process.env.QA_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.QA_CHROMIUM_EXECUTABLE }
    : {}),
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});

const ONLY = process.argv[3] ?? null;
let selectedJourneyCount = 0;

const exactText = (value) =>
  new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

async function record(name, drive) {
  if (ONLY && !name.includes(ONLY)) return;
  selectedJourneyCount++;
  const outputName = `${TAG}${name}`;
  const dir = join(OUT, ".tmp-" + outputName);
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir, size: { width: WIDTH, height: HEIGHT } },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} — ${r.failure()?.errorText}`));
  page.on("response", (r) => r.status() >= 400 && errors.push(`http ${r.status()}: ${r.url()}`));

  let file;
  let succeeded = false;
  try {
    await page.goto(BASE);
    await page.waitForSelector("canvas.gl", { timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: /^Morph Lab(?: β)?$/ }).click();
    await page.waitForSelector(".morph-gl", { timeout: 20000 });
    await waitMode(page, "organic");
    await showSheet(page, "Map");
    const gpu = await gpuRenderer(page);
    if (REQUIRE_HARDWARE && (gpu === "unavailable" || /swiftshader|llvmpipe|software/i.test(gpu))) {
      throw new Error(`${name}: software WebGL renderer rejected: ${gpu}`);
    }
    console.log(name, `GPU: ${gpu}`);
    await drive(page);
    if (errors.length) throw new Error(`${name} runtime failures:\n${errors.join("\n")}`);
    succeeded = true;
  } finally {
    await ctx.close();
    file = readdirSync(dir).find((f) => f.endsWith(".webm"));
    if (file) {
      const suffix = succeeded ? ".webm" : ".failed.webm";
      renameSync(join(dir, file), join(OUT, `${outputName}${suffix}`));
    }
  }
  if (!file) throw new Error(`${name}: browser produced no WebM recording`);
  console.log(name, "ok");
}

const gpuRenderer = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas.morph-gl");
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    if (!gl) return "unavailable";
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });

const waitMode = (page, mode, settled = true) =>
  page.waitForFunction(
    ([expected, mustSettle]) => {
      const r = window.__kayfabeMorph;
      return r?.mode === expected && (!mustSettle || !r.morphing);
    },
    [mode, settled],
    { timeout: 30000 },
  );

const showSheet = async (page, name) => {
  if (!NARROW) return;
  await page.getByRole("tab", { name, exact: true }).click({ timeout: 6000 });
};

const search = async (page, q, expectedName = q, waitForLayout = true) => {
  const box = page.getByRole("combobox", { name: /Search/ });
  await box.fill("");
  await box.fill(q);
  const option = page.locator('.search-pop [role="option"]').filter({
    has: page.locator("span", { hasText: exactText(expectedName) }),
  });
  await option.first().waitFor({ state: "visible", timeout: 10000 });
  if (await option.count() !== 1) {
    throw new Error(`${q}: expected one exact result named ${expectedName}, got ${await option.count()}`);
  }
  await option.click();
  await page.locator(".morph-crumbs").getByText(expectedName, { exact: true }).waitFor({ timeout: 10000 });
  if (waitForLayout) {
    await page.waitForFunction(
      (name) => {
        const r = window.__kayfabeMorph;
        const layout = r?.currentLayout;
        return !!layout?.anchorId && layout.labels.some(
          (label) => label.pick === layout.anchorId && label.text === name,
        );
      },
      expectedName,
      { timeout: 30000 },
    );
  }
};

const rapidSearch = async (page, q, expectedName = q) => {
  await search(page, q, expectedName, false);
  await page.waitForTimeout(90);
};

const clickLabelAction = async (page, entityName, actionName) => {
  const label = page.locator(".mlabel.force").filter({
    has: page.locator(".mlabel-name", { hasText: exactText(entityName) }),
  });
  await label.first().waitFor({ state: "visible", timeout: 10000 });
  if (await label.count() !== 1) {
    throw new Error(`${entityName}: expected one projected focus label, got ${await label.count()}`);
  }
  // Contact actions are intentionally revealed on hover/focus; exercising
  // that disclosure is part of the journey, not something to bypass with a
  // forced click against a display:none button.
  await label.hover();
  const action = label.getByRole("button", { name: actionName, exact: true });
  await action.first().waitFor({ state: "visible", timeout: 10000 });
  if (await action.count() !== 1) {
    throw new Error(`${entityName}: expected one visible ${actionName} action, got ${await action.count()}`);
  }
  await action.click();
};

const stableAnchor = async (page, expectedName, mode = "loom") => {
  await page.waitForFunction(
    ([name, expectedMode]) => {
      const r = window.__kayfabeMorph;
      const layout = r?.currentLayout;
      if (!layout || r.morphing || layout.mode !== expectedMode || !layout.anchorId) return false;
      return layout.labels.some((label) => label.pick === layout.anchorId && label.text === name);
    },
    [expectedName, mode],
    { timeout: 30000 },
  );
};

const hoverRelationshipBank = async (page, tone) => {
  const candidate = page.locator(`.mlabel.${tone}.pickable:not(.force)`).first();
  await candidate.waitFor({ state: "visible", timeout: 10000 });
  const entityName = (await candidate.locator(".mlabel-name").textContent())?.trim();
  if (!entityName) throw new Error(`${tone}: projected relationship label had no identity`);
  await candidate.hover();
  // Hover emphasis intentionally raises this label to force priority, so
  // re-find it by stable identity instead of retaining the role-class query.
  const hovered = page.locator(".mlabel.pickable").filter({
    has: page.locator(".mlabel-name", { hasText: exactText(entityName) }),
  });
  await hovered.getByRole("button", { name: "Pin entity", exact: true }).waitFor({
    state: "visible",
    timeout: 4000,
  });
  await page.waitForTimeout(850);
};

try {
await record("1-organic-to-loom", async (page) => {
  // Give the opening tissue an intentional readable beat before it organizes.
  await page.waitForTimeout(1600);
  await search(page, "Undertaker", "The Undertaker");
  await page.waitForTimeout(2600);
  await waitMode(page, "loom");
});

await record("2-wrestler-to-wrestler", async (page) => {
  await search(page, "Undertaker", "The Undertaker");
  await page.waitForTimeout(2400);
  await search(page, "Kane");
  await page.waitForTimeout(2400);
  await waitMode(page, "loom");
});

await record("3-dense-wrestler", async (page) => {
  await search(page, "Ric Flair");
  await page.waitForTimeout(2800);
  await waitMode(page, "loom");
  await hoverRelationshipBank(page, "tone-ember");
  await hoverRelationshipBank(page, "tone-cyan");
});

await record("4-large-promotion", async (page) => {
  await search(page, "AJPW");
  await page.waitForTimeout(2800);
  await waitMode(page, "motherboard");
});

await record("5-title-lineage", async (page) => {
  await search(page, "WWF Hardcore Title");
  await page.waitForTimeout(2800);
  await waitMode(page, "lineage");
});

await record("6-career-playback", async (page) => {
  await search(page, "Undertaker", "The Undertaker");
  await page.waitForTimeout(1800);
  await showSheet(page, "Layout");
  await page.getByRole("button", { name: "Career", exact: true }).click({ timeout: 8000 });
  await page.waitForTimeout(2200);
  await waitMode(page, "career");
  await showSheet(page, "Map");
  await page.locator('.pulsebar [aria-label="Play"]').click({ timeout: 8000 });
  await page.waitForTimeout(6000);
  await page.locator('.pulsebar [aria-label="Pause"]').click({ timeout: 4000 });
});

await record("7-head-to-head", async (page) => {
  await search(page, "Undertaker", "The Undertaker");
  await waitMode(page, "loom");
  await clickLabelAction(page, "The Undertaker", "Set comparison A");
  await search(page, "Kane");
  await waitMode(page, "loom");
  await clickLabelAction(page, "Kane", "Set comparison B");
  await showSheet(page, "Layout");
  await page.getByRole("button", { name: "Compare", exact: true }).click({ timeout: 8000 });
  await page.waitForTimeout(2800);
  await waitMode(page, "h2h");
  await showSheet(page, "Map");
  if (NARROW) await page.waitForTimeout(1600);
});

await record("8-return-to-tissue", async (page) => {
  await search(page, "Undertaker", "The Undertaker");
  await page.waitForTimeout(2400);
  await showSheet(page, "Layout");
  await page.getByRole("button", { name: /Return to tissue/i }).click();
  await page.waitForTimeout(2600);
  await waitMode(page, "organic");
  await showSheet(page, "Map");
  if (NARROW) await page.waitForTimeout(1600);
});

await record("9-five-target-rapid-retarget", async (page) => {
  for (const [query, expectedName] of [
    ["Undertaker", "The Undertaker"],
    ["Kane", "Kane"],
    ["Steve Austin", "Steve Austin"],
    ["The Rock", "The Rock"],
    ["Ric Flair", "Ric Flair"],
  ]) {
    await rapidSearch(page, query, expectedName);
  }
  await stableAnchor(page, "Ric Flair");
  // A stale async shard can appear correct briefly and then overwrite the
  // fifth target. Hold the terminal state long enough to catch that race.
  await page.waitForTimeout(1200);
  const final = await page.evaluate(() => {
    const r = window.__kayfabeMorph;
    const layout = r?.currentLayout;
    const anchorId = layout?.anchorId ?? null;
    const anchorName = layout?.labels.find((label) => label.pick === anchorId)?.text ?? null;
    return { anchorId, anchorName, mode: r?.mode ?? null, morphing: r?.morphing ?? null };
  });
  if (final.anchorName !== "Ric Flair" || final.mode !== "loom" || final.morphing !== false) {
    throw new Error(`rapid retarget did not remain on the fifth target: ${JSON.stringify(final)}`);
  }
});

if (ONLY && selectedJourneyCount === 0) {
  throw new Error(`No recording journey matched filter: ${ONLY}`);
}
console.log("recordings in", OUT);
} finally {
  await browser.close();
}
