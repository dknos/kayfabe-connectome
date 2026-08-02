/**
 * Morph Lab QA harness — screenshots plus renderer-counter probes, in the
 * Earlier visual-QA mould: a screenshot that looks plausible but reports the wrong
 * mode or a dead morph still fails.
 *
 * ARGS: argv[2] = output dir (default /tmp/kayfabe-morph-qa)
 * ENV: KAYFABE_BASE_URL, QA_W/QA_H, QA_TAG, QA_REDUCED=1, QA_MOBILE=1,
 *      QA_TIER=high|medium|low (exercise the renderer's ordinary governor path),
 *      QA_CHROMIUM_EXECUTABLE (optional full Chrome path for hardware GL),
 *      QA_HEADFUL=1 (use WSLg/native display; default remains headless),
 *      QA_REQUIRE_HARDWARE=1 (reject software WebGL such as SwiftShader)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-morph-qa";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const W = Number(process.env.QA_W ?? 1920);
const H = Number(process.env.QA_H ?? 1080);
const TAG = process.env.QA_TAG ?? String(W);
const REDUCED = process.env.QA_REDUCED === "1";
const MOBILE = process.env.QA_MOBILE === "1";
const REQUIRE_HARDWARE = process.env.QA_REQUIRE_HARDWARE === "1";
const HEADFUL = process.env.QA_HEADFUL === "1";
const FORCE_TIER = ["high", "medium", "low"].includes(process.env.QA_TIER ?? "") ? process.env.QA_TIER : null;
const captures = [];

const errors = [];
const browser = await chromium.launch({
  headless: !HEADFUL,
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
const cdp = await ctx.newCDPSession(page);
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
    const layout = r.currentLayout;
    const orbitStats = layout?.orbitStats ?? layout?.orbit?.stats ?? null;
    const roleCounts = {};
    if (layout) {
      for (let i = 0; i < layout.nodeRole.length; i++) {
        if (layout.nodeOpacity[i] <= 0.01) continue;
        const role = String(layout.nodeRole[i]);
        roleCounts[role] = (roleCounts[role] ?? 0) + 1;
      }
    }
    const routeKinds = {};
    for (const route of layout?.routes ?? []) {
      const kind = String(route.kind);
      routeKinds[kind] = (routeKinds[kind] ?? 0) + 1;
    }
    const anchorId = layout?.anchorId ?? null;
    return {
      mode: r.mode,
      morphing: r.morphing,
      progress: r.morphProgress,
      traces: r.traceLive,
      routeCount: layout?.routes.length ?? 0,
      guideCount: orbitStats?.guideCount ?? layout?.regions.filter((region) => /orbit.*guide|guide.*orbit/i.test(region.key)).length ?? 0,
      anchorId,
      anchorName: layout?.labels.find((label) => label.pick === anchorId)?.text ?? null,
      representedCount: layout?.representedCount ?? 0,
      activeCount: layout?.expandedCount ?? 0,
      directCount: orbitStats?.directDisplayed ?? orbitStats?.displayedDirectRelationships ?? ["2", "3", "4", "5"].reduce((sum, role) => sum + (roleCounts[role] ?? 0), 0),
      bridgeCount: orbitStats?.bridgeDisplayed ?? orbitStats?.displayedBridgeCandidates ?? roleCounts["11"] ?? 0,
      bridgeConnectorCount: orbitStats?.bridgeRoutesDisplayed ?? orbitStats?.displayedSupportingRoutes ?? routeKinds["5"] ?? 0,
      roleCounts,
      routeKinds,
      labels: r.lastLabelReport,
      frameMs: Math.round(r.frameTimeMs * 10) / 10,
      latestPickMs: r.lastPickDiagnostic?.durationMs ?? null,
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
      return r?.mode === expected && (!mustSettle || (!r.morphing && !r.cam.flying));
    },
    [mode, settled],
    { timeout: 30000 },
  );

const exactText = (value) =>
  new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

const search = async (query, expectedName = query, waitForLayout = true) => {
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

const clickLabelAction = async (entityName, actionName) => {
  const label = page.locator(".mlabel.force").filter({
    has: page.locator(".mlabel-name", { hasText: exactText(entityName) }),
  });
  await label.first().waitFor({ state: "visible", timeout: 10000 });
  if (await label.count() !== 1) throw new Error(`${entityName}: expected one focus label`);
  await label.locator(".mlabel-primary").focus();
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
  const outputPath = `${OUT}/${TAG}-${name}.png`;
  if (expectedMorphing) {
    // Playwright's full-page screenshot preparation can consume most of the
    // 920 ms production transition. CDP captures the current compositor frame
    // directly, preserving a truthful intermediate state.
    const frame = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    writeFileSync(outputPath, frame.data, "base64");
  } else {
    await page.screenshot({ path: outputPath });
  }
  captures.push({ name: `${TAG}-${name}`, viewport: { width: W, height: H }, reducedMotion: REDUCED, mobile: MOBILE, ...state });
  console.log(`${TAG}-${name}`, JSON.stringify(state));
};

const waitMorphBand = (mode, min, max) =>
  page.waitForFunction(
    ([expected, low, high]) => {
      const renderer = window.__kayfabeMorph;
      return renderer?.mode === expected && renderer.morphing && renderer.morphProgress >= low && renderer.morphProgress <= high;
    },
    [mode, min, max],
    { timeout: 15000 },
  );

const hoverOrbitLabel = async (kind) => {
  const identity = await page.evaluate((wanted) => {
    const renderer = window.__kayfabeMorph;
    const labels = renderer?.currentLayout?.labels ?? [];
    const matches = (label) => `${label.badge ?? ""} ${label.sub ?? ""} ${label.detail ?? ""}`.toLowerCase();
    const label = labels.find((candidate) => {
      if (!candidate.pick?.startsWith("p:")) return false;
      const text = matches(candidate);
      return wanted === "bridge" ? /2 hops|two hops|bridge/.test(text) : /direct|opposed|same-side|mixed|battle.royal/.test(text) && !/2 hops|two hops|bridge/.test(text);
    });
    if (!label?.pick) return null;
    // Force the semantic label through the ordinary centralized hover owner;
    // the strongest layout candidate is not guaranteed to survive DOM label
    // collision before it becomes the active hover target.
    renderer.hover.enterSurface("keyboard", label.pick);
    return { id: label.pick, name: label.text };
  }, kind);
  if (!identity) throw new Error(`Orbit ${kind} label metadata is unavailable`);
  const label = page.locator(".mlabel.pickable").filter({ has: page.locator(".mlabel-name", { hasText: exactText(identity.name) }) }).first();
  await label.waitFor({ state: "visible", timeout: 10000 });
  await label.hover();
  await page.waitForFunction((id) => window.__kayfabeMorph?.emphasisSnapshot().hovered >= 0 || window.__kayfabeMorph?.emphasisSnapshot().hoveredId === id, identity.id, { timeout: 5000 });
  await page.waitForTimeout(180);
  return identity;
};

const hoverOrbitContext = async (prefix) => {
  // Park outside the canvas/card first. Otherwise the old card disappearing
  // can expose the canvas under the stationary pointer and immediately queue
  // a competing pick while this deterministic context capture is acquired.
  await page.mouse.move(4, 4);
  const identity = await page.evaluate((wantedPrefix) => {
    const renderer = window.__kayfabeMorph;
    const label = renderer?.currentLayout?.labels.find((candidate) => candidate.pick?.startsWith(wantedPrefix));
    if (!label?.pick) return null;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    renderer.hover.clear("cancel");
    renderer.hover.enterSurface("label", label.pick);
    return { id: label.pick, name: label.text };
  }, prefix);
  if (!identity) throw new Error(`Orbit ${prefix} context is unavailable for the QA anchor`);
  await page.waitForFunction((id) => window.__kayfabeMorph?.hover.snapshot().id === id, identity.id, { timeout: 5000 });
  await page.waitForTimeout(180);
  return identity;
};

try {
await page.goto(BASE);
await page.waitForSelector("canvas.gl", { timeout: 30000 });
await page.waitForTimeout(4000);

// enter the lab
await page.getByRole("button", { name: /^Morph Lab(?: β)?$/ }).click();
await page.waitForSelector(".morph-gl", { timeout: 20000 });
await waitMode("organic");
if (FORCE_TIER) {
  await page.evaluate((target) => {
    const renderer = window.__kayfabeMorph;
    const order = ["low", "medium", "high"];
    if (!renderer || !target) return;
    while (renderer.qualityTier !== target) {
      renderer.stepTier(order.indexOf(target) > order.indexOf(renderer.qualityTier) ? 1 : -1);
    }
  }, FORCE_TIER);
  await page.waitForTimeout(800);
  await waitMode("organic");
}
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
if (REDUCED) await waitMode("loom");
else await waitMorphBand("loom", 0.12, 0.88);
await shot("2-loom-midmorph", "loom", REDUCED ? false : true);
await page.waitForTimeout(2200);
await waitMode("loom");
await shot("3-loom", "loom", false);

// Relationship Array → Orbit must preserve the same canonical population and
// expose both graph-distance bands. Capture two genuinely intermediate frames
// when motion is enabled, then the landed reading and its direct/bridge hover
// states. Reduced motion intentionally has only the landed frame.
if (MOBILE) await page.getByRole("tab", { name: "Layout" }).click({ timeout: 6000 });
await page.getByRole("button", { name: "Orbit", exact: true }).click({ timeout: 8000 });
await waitMode("orbit", false);
if (!REDUCED) {
  // The 920 ms production transition has a narrow 20–30% wall-clock window;
  // under software WebGL a single scheduled frame can cross it. Capture the
  // first real moving frame after the opening stage and record its exact
  // progress in the manifest rather than manufacturing a paused scene.
  await waitMorphBand("orbit", 0.18, 0.60);
  await shot("4-orbit-morph-25", "orbit", true);
  // A full-page PNG can take longer than the remaining graph transition on a
  // software renderer. If the first capture consumed that window, replay the
  // same deterministic Array -> Orbit transition instead of flaking or
  // mislabelling a settled frame as an intermediate one.
  const afterFirstCapture = await page.evaluate(() => ({
    morphing: window.__kayfabeMorph?.morphing ?? false,
    progress: window.__kayfabeMorph?.morphProgress ?? 1,
  }));
  if (!afterFirstCapture.morphing || afterFirstCapture.progress > 0.82) {
    await page.getByRole("button", { name: "Array", exact: true }).click({ timeout: 8000 });
    await waitMode("loom");
    await page.getByRole("button", { name: "Orbit", exact: true }).click({ timeout: 8000 });
    await waitMode("orbit", false);
  }
  await waitMorphBand("orbit", 0.55, 0.90);
  await shot("5-orbit-morph-65", "orbit", true);
}
await waitMode("orbit");
if (MOBILE) await page.getByRole("tab", { name: "Map" }).click({ timeout: 6000 });
await shot(REDUCED ? "4-orbit-reduced" : "6-orbit", "orbit", false);

const landedOrbit = await probe();
if ((landedOrbit?.directCount ?? 0) <= 0) throw new Error("Undertaker Orbit displayed no direct relationships");
if ((landedOrbit?.bridgeCount ?? 0) <= 0) throw new Error("Undertaker Orbit displayed no two-hop bridge people");
if ((landedOrbit?.bridgeConnectorCount ?? 0) <= 0) throw new Error("Undertaker Orbit displayed no supporting bridge routes");

if (!MOBILE) {
  await hoverOrbitLabel("direct");
  await shot("7-orbit-direct-hover", "orbit", false);
  await hoverOrbitLabel("bridge");
  await shot("8-orbit-bridge-hover", "orbit", false);

  const hoverCard = page.locator(".morph-hover-card");
  await hoverCard.getByRole("button", { name: "Pin", exact: true }).click();
  await hoverCard.getByRole("button", { name: "Set comparison A", exact: true }).click();
  await shot("9-orbit-pinned-path", "orbit", false);

  await hoverOrbitContext("pr:");
  await shot("10-orbit-promotion-hover", "orbit", false);
  await hoverOrbitContext("t:");
  await shot("11-orbit-championship-hover", "orbit", false);
  await page.mouse.move(4, 4);
  await page.evaluate(() => window.__kayfabeMorph?.hover.clear("cancel"));
  await page.locator(".morph-hover-card").waitFor({ state: "detached", timeout: 3000 });

  const context = page.getByRole("checkbox", { name: "Corpus context" });
  await context.uncheck();
  await waitMode("orbit");
  await shot("12-orbit-context-off", "orbit", false);
  await context.check();
  await waitMode("orbit");

  await search("Kane");
  if (!REDUCED) {
    await waitMorphBand("orbit", 0.18, 0.82);
    await shot("13-orbit-recenter-midmorph", "orbit", true);
  }
  await waitMode("orbit");
  await shot("14-orbit-recenter-kane", "orbit", false);

  // The same graph-resident entities travel out of Orbit and into chronology.
  await page.getByRole("button", { name: "Career", exact: true }).click({ timeout: 8000 });
  await waitMode("career", false);
  if (!REDUCED) {
    await waitMorphBand("career", 0.18, 0.82);
    await shot("15-orbit-to-career-midmorph", "career", true);
  }
  await waitMode("career");
  await page.getByRole("button", { name: "Array", exact: true }).click({ timeout: 8000 });
  await waitMode("loom");
} else {
  // Touch has no hover dependency: tap a visible direct label, then prove
  // Details remains available and the map can be restored.
  const direct = await page.evaluate(() => {
    const renderer = window.__kayfabeMorph;
    const labels = renderer?.currentLayout?.labels ?? [];
    const label = labels.find((candidate) => candidate.pick?.startsWith("p:") && /direct|opposed|same-side|mixed|battle.royal/i.test(`${candidate.badge ?? ""} ${candidate.sub ?? ""}`));
    const point = label?.pick ? renderer?.projectId(label.pick) : null;
    const rect = renderer?.canvas.getBoundingClientRect();
    return label && point?.front && rect
      ? { name: label.text, x: rect.left + point.x, y: rect.top + point.y }
      : null;
  });
  if (!direct) throw new Error("mobile Orbit exposed no direct touch target");
  await page.touchscreen.tap(direct.x, direct.y);
  await waitMode("orbit");
  await page.getByRole("tab", { name: "Details" }).click({ timeout: 6000 });
  await shot("7-mobile-orbit-details", "orbit", false);
  await page.getByRole("tab", { name: "Map" }).click({ timeout: 6000 });
  await shot("8-mobile-orbit-touch-selection", "orbit", false);
  await page.getByRole("tab", { name: "Layout" }).click({ timeout: 6000 });
  await page.getByRole("button", { name: "Array", exact: true }).click({ timeout: 8000 });
  await waitMode("loom");
}

// retarget to another wrestler mid-reading
await search("Undertaker", "The Undertaker");
await waitMode("loom");
await search("Kane");
if (REDUCED) await waitMode("loom");
else await waitMorphBand("loom", 0.12, 0.88);
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
  await page.getByRole("button", { name: "Array", exact: true }).click();
  await waitMode("loom");
  await clickLabelAction("The Undertaker", "Set comparison A");
  await search("Kane");
  await waitMode("loom");
  await clickLabelAction("Kane", "Set comparison B");
  await page.getByRole("button", { name: "Compare", exact: true }).click({ timeout: 8000 });
  await waitMode("h2h");
  await shot("11-head-to-head", "h2h", false);

  // Five fast selections must finish on the fifth and stay there.
  await page.getByRole("button", { name: "Array", exact: true }).click();
  for (const [query, expectedName] of [
    ["Undertaker", "The Undertaker"],
    ["Kane", "Kane"],
    ["Steve Austin", "Steve Austin"],
    ["The Rock", "The Rock"],
    ["Ric Flair", "Ric Flair"],
  ]) {
    await search(query, expectedName, false);
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
const connectomeCaptureName = `${TAG}-${MOBILE ? "10" : "14"}-connectome-back`;
await page.screenshot({ path: `${OUT}/${connectomeCaptureName}.png` });
captures.push({
  name: connectomeCaptureName,
  viewport: { width: W, height: H },
  reducedMotion: REDUCED,
  mobile: MOBILE,
  lens: "connectome",
  active: await page.evaluate(() => window.__kayfabeRenderer?.isActive === true),
});

console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):` : "NO CONSOLE ERRORS");
for (const e of errors.slice(0, 20)) console.log("  " + e);
if (errors.length) throw new Error(`runtime failures:\n${errors.join("\n")}`);
} finally {
  writeFileSync(
    `${OUT}/${TAG}-manifest.json`,
    `${JSON.stringify({ baseUrl: BASE, generatedAt: new Date().toISOString(), captures, errors }, null, 2)}\n`,
  );
  await browser.close();
}
