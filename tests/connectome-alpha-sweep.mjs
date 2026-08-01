/**
 * Find the fiber alpha budget at which the connectome core stops saturating.
 *
 * The previous metric averaged over the whole 1600x950 canvas, which dilutes a
 * blown-out 300x350 core into "1% of pixels" and reads as fine. This measures
 * the GRAPH REGION only, which is where the plateau actually is.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "test-results/connectome-alpha";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://127.0.0.1:9460/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas.gl", { timeout: 120000 });
await page.waitForFunction(() => !!window.__kayfabeRenderer, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const r = window.__kayfabeRenderer;
  return { shown: r.shownEdges?.length ?? null, dropped: r.droppedEdges ?? null };
});
console.log("edges shown/dropped:", JSON.stringify(info));

/** Luminance histogram over the canvas centre, where the graph sits. */
async function measure(label) {
  return page.evaluate((lbl) => {
    const c = document.querySelector("canvas.gl");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    const W = c.width, H = c.height;
    // Centre box: the graph occupies roughly the middle third.
    const bw = Math.floor(W * 0.42), bh = Math.floor(H * 0.62);
    const x0 = Math.floor((W - bw) / 2), y0 = Math.floor((H - bh) / 2);
    const px = new Uint8Array(bw * bh * 4);
    gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, white = 0, bright = 0, n = bw * bh;
    let minL = 255, maxL = 0;
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l;
      if (l > 205) white++;
      if (l > 140) bright++;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
    }
    return {
      label: lbl,
      meanLuma: +(sum / n).toFixed(1),
      whitePct: +((white / n) * 100).toFixed(2),
      brightPct: +((bright / n) * 100).toFixed(2),
      maxLuma: Math.round(maxL),
    };
  }, label);
}

console.log("\nregion: canvas centre (42% x 62%)");
console.log(JSON.stringify(await measure("baseline (uGlobalAlpha=1)")));
await page.screenshot({ path: `${OUT}/alpha-1.00.png` });

for (const a of [0.6, 0.4, 0.25, 0.15, 0.1, 0.06]) {
  await page.evaluate((v) => {
    const r = window.__kayfabeRenderer;
    // The renderer drives its own rAF loop; setting the uniform is enough,
    // the next frame picks it up.
    r.edges.setGlobalAlpha(v);
  }, a);
  await page.waitForTimeout(900);
  console.log(JSON.stringify(await measure(`uGlobalAlpha=${a}`)));
  await page.screenshot({ path: `${OUT}/alpha-${a.toFixed(2)}.png` });
}

await browser.close();
