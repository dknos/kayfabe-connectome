/**
 * Connectome brightness diagnosis.
 *
 * Captures the connectome at rest, then isolates each additive layer by
 * hiding the others — the technique that found the last white-plateau (it was
 * 100% fibers). Also samples the framebuffer so "blown out" is a measured
 * number rather than an impression.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "test-results/connectome-brightness";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://127.0.0.1:9460/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas.gl", { timeout: 120000 });
await page.waitForFunction(() => !!window.__kayfabeRenderer, { timeout: 120000 })
  .catch(() => {});
await page.waitForTimeout(9000);

/** Fraction of canvas pixels at or above a luminance threshold. */
async function luminance(label) {
  return page.evaluate((lbl) => {
    const c = document.querySelector("canvas.gl");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let blown = 0, bright = 0, lit = 0, sum = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l;
      if (l > 12) lit++;
      if (l > 170) bright++;
      if (l > 235) blown++;
    }
    return {
      label: lbl,
      meanLuma: +(sum / n).toFixed(2),
      litPct: +((lit / n) * 100).toFixed(2),
      brightPct: +((bright / n) * 100).toFixed(2),
      blownPct: +((blown / n) * 100).toFixed(2),
    };
  }, label);
}

const layers = ["edges.lines", "nodes.points", "haze.points", "pulses.points", "ribbons.mesh"];

const present = await page.evaluate((ls) => {
  const r = window.__kayfabeRenderer;
  if (!r) return { renderer: false };
  const out = { renderer: true, found: {} };
  for (const path of ls) {
    const [a, b] = path.split(".");
    out.found[path] = !!(r[a] && r[a][b]);
  }
  out.keys = Object.keys(r);
  return out;
}, layers);
console.log("renderer:", JSON.stringify(present));

console.log("\n=== all layers on ===");
console.log(JSON.stringify(await luminance("all")));
await page.screenshot({ path: `${OUT}/00-all.png` });

// One layer at a time.
for (const solo of layers) {
  const ok = await page.evaluate(({ ls, keep }) => {
    const r = window.__kayfabeRenderer;
    let any = false;
    for (const path of ls) {
      const [a, b] = path.split(".");
      if (r[a] && r[a][b]) {
        r[a][b].visible = path === keep;
        if (path === keep) any = true;
      }
    }
    return any;
  }, { ls: layers, keep: solo });
  if (!ok) { console.log(`  (${solo} absent)`); continue; }
  await page.waitForTimeout(1200);
  console.log(JSON.stringify(await luminance(solo)));
  await page.screenshot({ path: `${OUT}/solo-${solo.replace(".", "-")}.png` });
}

// Restore
await page.evaluate((ls) => {
  const r = window.__kayfabeRenderer;
  for (const path of ls) {
    const [a, b] = path.split(".");
    if (r[a] && r[a][b]) r[a][b].visible = true;
  }
}, layers);

// Post-processing state
const post = await page.evaluate(() => {
  const r = window.__kayfabeRenderer;
  const gl = r.gl ?? r.renderer;
  const out = {};
  try {
    out.toneMapping = gl.toneMapping;
    out.toneMappingExposure = gl.toneMappingExposure;
    out.outputColorSpace = gl.outputColorSpace;
  } catch (e) { out.err = String(e); }
  try {
    const passes = r.composer?.passes?.map((p) => p.constructor.name);
    out.passes = passes;
    const bloom = r.composer?.passes?.find((p) => p.constructor.name.includes("Bloom"));
    if (bloom) out.bloom = { strength: bloom.strength, radius: bloom.radius, threshold: bloom.threshold };
  } catch (e) { out.err2 = String(e); }
  try {
    out.tier = r.governor?.tier;
    out.drawn = r.edges?.drawnCount ?? null;
  } catch { /* */ }
  return out;
});
console.log("\npost-processing:", JSON.stringify(post, null, 1));

await browser.close();
