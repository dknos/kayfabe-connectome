/**
 * Visual QA for the connectome's flight controls and proximity labels.
 *
 * Answers two questions a unit test cannot: does W actually travel INTO the
 * tissue (rather than dollying against it), and do names resolve out of it as
 * you approach? Both are read off the renderer's own state as well as the
 * frame, so a regression that leaves the picture looking plausible still fails.
 *
 * Usage: node tests/fly-qa.mjs [outdir]
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/kayfabe-fly-qa";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";

const browser = await chromium.launch({ args: ["--use-gl=angle", "--enable-webgl"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(BASE);
await page.waitForSelector("canvas.gl", { timeout: 60000 });
await page.waitForTimeout(6000);

const probe = () =>
  page.evaluate(() => {
    const r = window.__kayfabeRenderer;
    const c = r.cameraCtl.camera.position;
    const labels = [...document.querySelectorAll(".nlabel")];
    return {
      dist: +r.cameraDistance.toFixed(3),
      cam: [+c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3)],
      target: [
        +r.cameraCtl.target.x.toFixed(3),
        +r.cameraCtl.target.y.toFixed(3),
        +r.cameraCtl.target.z.toFixed(3),
      ],
      labelCount: labels.length,
      nearCount: labels.filter((el) => el.classList.contains("near")).length,
      names: labels.slice(0, 8).map((el) => el.textContent.trim()),
    };
  });

const before = await probe();
await page.screenshot({ path: `${OUT}/fly-0-before.png` });

// Fly forward. Key events reach the window listener without focusing anything
// — and deliberately WITHOUT clicking the canvas, because a click that lands
// on a node selects it, and a selection isolates, which is a different label
// question entirely.
for (let step = 1; step <= 3; step++) {
  await page.keyboard.down("w");
  await page.waitForTimeout(1100);
  await page.keyboard.up("w");
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/fly-${step}-forward.png` });
  const p = await probe();
  console.log(`after W x${step}:`, JSON.stringify(p));
}
const afterW = await probe();

// Strafe + rise, so the other axes are exercised too.
await page.keyboard.down("d");
await page.keyboard.down("e");
await page.waitForTimeout(600);
await page.keyboard.up("d");
await page.keyboard.up("e");
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/fly-4-strafe.png` });
const afterD = await probe();

// Shift boost.
await page.keyboard.down("Shift");
await page.keyboard.down("w");
await page.waitForTimeout(500);
await page.keyboard.up("w");
await page.keyboard.up("Shift");
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/fly-5-boost.png` });
const afterBoost = await probe();

// Typing must never fly the camera.
await page.getByRole("combobox", { name: /Search/ }).fill("wwwwdddd");
await page.waitForTimeout(800);
const afterTyping = await probe();

const moved = (a, b) =>
  Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]);

const results = [
  ["W travels (target moved)", moved(before, afterW) > 0.2],
  ["D/E travels", moved(afterW, afterD) > 0.05],
  ["shift boosts", moved(afterD, afterBoost) > 0.05],
  ["typing does not fly", moved(afterBoost, afterTyping) < 1e-6],
  ["labels present before", before.labelCount > 0],
  ["proximity labels grew flying in", afterBoost.labelCount >= before.labelCount],
  ["proximity class applied", afterBoost.nearCount > 0],
  ["no console errors", errors.length === 0],
];

console.log("\nbefore:", JSON.stringify(before));
console.log("afterW:", JSON.stringify(afterW));
console.log("afterBoost:", JSON.stringify(afterBoost));
console.log("");
let ok = true;
for (const [name, pass] of results) {
  if (!pass) ok = false;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${name}`);
}
if (errors.length) console.log("console errors:\n" + errors.slice(0, 10).join("\n"));
console.log(`\nscreenshots -> ${OUT}`);

await ctx.close();
await browser.close();
process.exit(ok ? 0 : 1);
