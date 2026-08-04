/**
 * SPIKE 5 probe — the label field.
 *
 * Run: node tests/arena-spikes/spike5-labels.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const HEADFUL = process.env.QA_HEADFUL === "1";
const OUT = process.env.QA_SPIKE_OUT ?? "/tmp/kayfabe-arena-spike5.json";
const URL = `${BASE}/spikes/labels.html`;
const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

const browser = await chromium.launch({
  headless: !HEADFUL,
  args: ["--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist"],
});
const results = [];
const notes = [];
const failures = [];

try {
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && failures.push(`${vp.name} console: ${m.text()}`));
    page.on("pageerror", (e) => failures.push(`${vp.name} pageerror: ${e.message}`));
    await page.goto(URL);
    await page.waitForFunction(() => window.__arenaLabels?.ready === true, null, { timeout: 30000 });
    await page.waitForFunction(() => !window.__arenaLabels.contextLost(), null, { timeout: 30000 });

    for (const [scopeKey, budget, label] of [
      ["person:p:d7fbacefc", 203, "psycho-clown"],
      ["promotion:pr:c8", 600, "aaa-pr-c8"],
    ]) {
      await page.evaluate(([k, n]) => window.__arenaLabels.select(k, n), [scopeKey, budget]);
      await page.waitForFunction(() => !window.__arenaLabels.animating(), null, { timeout: 20000 });
      for (const formation of ["arena", "index"]) {
        await page.evaluate((f) => window.__arenaLabels.setFormation(f), formation);
        await page.waitForFunction(() => !window.__arenaLabels.animating(), null, { timeout: 20000 });
        await page.evaluate(() => window.__arenaLabels.forceUpdate());

        const r = await page.evaluate(() => {
          const s = window.__arenaLabels;
          const boxes = s.labelBoxes();
          // Count genuine overlaps among what was actually shown. The whole
          // point of the pass is that this is zero.
          let overlaps = 0;
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i], b = boxes[j];
              if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) overlaps++;
            }
          }
          return { report: s.report(), shown: boxes.length, overlaps, domNodes: s.domNodes(), domCreations: s.domCreations() };
        });

        // Overlaps are only tolerable where the brief demands them: a selected
        // or hovered label displaces rather than disappears. Everything else
        // must be clean.
        const priorityOverlapsOnly = await page.evaluate(() => {
          const s = window.__arenaLabels;
          const boxes = s.labelBoxes();
          const sel = s.selectedId?.() ?? null;
          let nonPriority = 0;
          for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i], b = boxes[j];
              const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
              if (hit && a.id !== sel && b.id !== sel) nonPriority++;
            }
          }
          return nonPriority;
        });

        const row = {
          viewport: vp.name, scope: label, formation,
          wanted: r.report.wanted, shown: r.report.shown, suppressed: r.report.suppressed,
          labelUpdateMs: Number(r.report.updateMs.toFixed(3)),
          overlaps: r.overlaps, nonPriorityOverlaps: priorityOverlapsOnly,
          domNodes: r.domNodes, domCreations: r.domCreations,
        };
        results.push(row);
        console.log(JSON.stringify(row));
        if (priorityOverlapsOnly > 0) notes.push(`FAIL: ${vp.name}/${label}/${formation} shows ${priorityOverlapsOnly} overlapping label pairs that are not priority displacements`);
        if (r.domNodes !== r.domCreations) notes.push(`FAIL: ${vp.name} DOM pool grew: ${r.domNodes} nodes vs ${r.domCreations} created`);
      }
    }

    // Selected label must never be collision-dropped, even at an absurd density.
    const priority = await page.evaluate(async () => {
      const s = window.__arenaLabels;
      await new Promise(requestAnimationFrame);
      const ids = s.shownIds();
      const victim = ids.find((v) => v) ?? null;
      s.setSelected(victim);
      s.setBudget(4); // brutal budget: only four labels may show
      s.forceUpdate();
      const after = s.shownIds();
      s.setBudget(48);
      return { victim, keptSelected: after.includes(victim), shownAfter: after.length };
    });
    const prow = { viewport: vp.name, check: "selected label survives a 4-label budget", ...priority };
    results.push(prow);
    console.log(JSON.stringify(prow));
    if (!priority.keptSelected) notes.push(`FAIL: ${vp.name} dropped the SELECTED label under budget pressure`);

    await context.close();
  }
  if (failures.length) notes.push(`runtime failures: ${failures.join(" | ")}`);
  console.log(JSON.stringify({ status: notes.length ? "issues" : "ok", notes }));
} finally {
  writeFileSync(OUT, `${JSON.stringify({
    url: URL, headful: HEADFUL, generatedAt: new Date().toISOString(),
    results, notes, runtimeFailures: failures,
  }, null, 2)}\n`);
  await browser.close();
}
