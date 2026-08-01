/**
 * Verify the fiber exposure control across the three things that move it:
 * drawn count, camera distance, and filtered views. A fixed per-edge budget
 * can only be right at one of these; the control has to hold overlap roughly
 * constant across all of them without going dead.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "test-results/connectome-exposure";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto("http://127.0.0.1:9460/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas.gl", { timeout: 120000 });
await page.waitForTimeout(9000);

async function measure(label) {
  const m = await page.evaluate((lbl) => {
    const c = document.querySelector("canvas.gl");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    const W = c.width, H = c.height;
    const bw = Math.floor(W * 0.42), bh = Math.floor(H * 0.62);
    const x0 = Math.floor((W - bw) / 2), y0 = Math.floor((H - bh) / 2);
    const px = new Uint8Array(bw * bh * 4);
    gl.readPixels(x0, y0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, white = 0, lit = 0;
    const n = bw * bh;
    for (let i = 0; i < n; i++) {
      const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
      sum += l;
      if (l > 205) white++;
      if (l > 30) lit++;
    }
    const r = window.__kayfabeRenderer;
    return {
      label: lbl,
      shown: r.shownEdges.length,
      exposure: +(r.exposure ?? -1).toFixed(4),
      dist: +(r.cameraCtl.distance()).toFixed(2),
      meanLuma: +(sum / n).toFixed(1),
      whitePct: +((white / n) * 100).toFixed(2),
      structurePct: +((lit / n) * 100).toFixed(2),
    };
  }, label);
  console.log(JSON.stringify(m));
  return m;
}

const results = [];
results.push(await measure("default fit-all, full corpus"));
await page.screenshot({ path: `${OUT}/01-default.png` });

// Zoom in: overlap per pixel drops, exposure must rise to compensate.
for (const step of [1, 2, 3]) {
  await page.mouse.move(900, 450);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(1400);
  results.push(await measure(`zoomed in x${step}`));
  await page.screenshot({ path: `${OUT}/02-zoom-${step}.png` });
}

// Back out, then filter to a sparse view: fewer fibers must not go dim.
await page.mouse.wheel(0, 2400);
await page.waitForTimeout(1600);
await page.locator('input[type="range"]').first().evaluate((el) => {
  el.value = String(Math.round(Number(el.max) * 0.86));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(6000);
results.push(await measure("filtered to a recent window"));
await page.screenshot({ path: `${OUT}/03-filtered.png` });

console.log("\n=== verdict ===");
const bad = results.filter((r) => r.whitePct > 1.0);
const dead = results.filter((r) => r.structurePct < 1.0);
console.log(bad.length ? `  SATURATED: ${bad.map((b) => b.label).join(", ")}` : "  no view saturates (white < 1% everywhere)");
console.log(dead.length ? `  TOO DIM: ${dead.map((b) => b.label).join(", ")}` : "  no view goes dead (structure > 1% everywhere)");
await browser.close();
