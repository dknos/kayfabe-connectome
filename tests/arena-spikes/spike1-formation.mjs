/**
 * SPIKE 1 probe — formation morph.
 *
 * Produces the numbers the audit matrix is allowed to cite. Every figure here
 * comes from this script; nothing in the documentation may claim a
 * measurement that this (or a sibling probe) did not print.
 *
 * Two environments are sampled deliberately:
 *   headful  WSLg gives ANGLE/D3D12 on real hardware — the meaningful number
 *   headless SwiftShader software rasterizer — the pessimistic LOW-tier floor
 * CPU-side figures (layout generation, retarget cost) are renderer-independent
 * and are the ones that actually decide the architecture.
 *
 * Run: node tests/arena-spikes/spike1-formation.mjs
 *      QA_HEADFUL=1 node tests/arena-spikes/spike1-formation.mjs
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = process.env.KAYFABE_BASE_URL ?? "http://127.0.0.1:9460";
const HEADFUL = process.env.QA_HEADFUL === "1";
const OUT = process.env.QA_SPIKE_OUT ?? "/tmp/kayfabe-arena-spike1.json";
const URL = `${BASE}/spikes/formation.html`;

const browser = await chromium.launch({
  headless: !HEADFUL,
  args: [
    "--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist",
    // usedJSHeapSize is bucketed to 100 KB and clamped without this flag, which
    // makes a naive heap delta read as a flat 10,000,000 and prove nothing.
    "--enable-precise-memory-info", "--js-flags=--expose-gc",
  ],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
const failures = [];
page.on("console", (m) => m.type() === "error" && failures.push(`console: ${m.text()}`));
page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));

const settle = () =>
  page.waitForFunction(() => window.__arenaSpike && !window.__arenaSpike.animating(), null, { timeout: 20000 });

const sampleFrames = (frames) =>
  page.evaluate(async (count) => {
    window.__arenaSpike.resetFrames();
    let prev = await new Promise(requestAnimationFrame);
    for (let i = 0; i < count; i++) prev = await new Promise(requestAnimationFrame);
    void prev;
    return window.__arenaSpike.frameStats();
  }, frames);

/**
 * The load-bearing correctness test: a retained card must TRAVEL. Sampling one
 * named card's projected position every frame through a formation change
 * proves both halves of the claim — that it moves at all (not a cut) and that
 * it never jumps (not a respawn).
 */
const trackCard = (id, to) =>
  page.evaluate(async ([cardId, target]) => {
    const spike = window.__arenaSpike;
    const path = [];
    spike.setFormation(target);
    for (let i = 0; i < 220; i++) {
      await new Promise(requestAnimationFrame);
      const p = spike.cardScreenPos(cardId);
      if (p) path.push([p.x, p.y]);
      if (!spike.animating()) break;
    }
    let maxStep = 0;
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      const step = Math.hypot(dx, dy);
      maxStep = Math.max(maxStep, step);
      total += step;
    }
    const straight = path.length > 1
      ? Math.hypot(path[path.length - 1][0] - path[0][0], path[path.length - 1][1] - path[0][1])
      : 0;
    return { samples: path.length, maxStepNdc: maxStep, totalNdc: total, netNdc: straight };
  }, [id, to]);

const results = [];
const notes = [];

try {
  await page.goto(URL);
  await page.waitForFunction(() => window.__arenaSpike?.ready === true, null, { timeout: 30000 });
  // Ask the live WebGL context directly. The renderer wrapper can report
  // "unknown", and treating that as "not software" silently promotes a
  // SwiftShader run into a hardware claim.
  // A throwaway canvas answers reliably; querying the context three.js already
  // created returns null for the unmasked parameter in current Chrome.
  const gpu = await page.evaluate(() => {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) return "no-context";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const unmasked = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
    return String(unmasked ?? gl.getParameter(gl.RENDERER) ?? "unknown");
  });
  const scopes = await page.evaluate(() => window.__arenaSpike.scopes());
  // Unknown is treated as unverified rather than hardware: a renderer we
  // cannot name must never be reported as a hardware measurement.
  const software = /swiftshader|llvmpipe|software/i.test(gpu);
  const rendererKnown = gpu !== "unknown" && gpu !== "no-context";
  console.log(JSON.stringify({ gpu, software, rendererKnown, scopes }));
  if (!rendererKnown) notes.push("renderer could not be identified — frame timings are unattributed");

  const SCENARIOS = [
    { scope: "person:p:d7fbacefc", label: "psycho-clown", budgets: [160, 203] },
    { scope: "person:p:cd52d3f2c", label: "widest", budgets: [360, 600] },
    { scope: "promotion:pr:c8", label: "aaa-pr-c8", budgets: [160, 360, 600] },
  ];
  // The widest scope id is discovered at build time; resolve it from the page.
  const widest = scopes.find((s) => s.startsWith("person:") && s !== "person:p:d7fbacefc" && s !== "person:p:ccf01da71");
  if (widest) SCENARIOS[1].scope = widest;

  for (const scenario of SCENARIOS) {
    for (const budget of scenario.budgets) {
      await page.evaluate(([key, n]) => window.__arenaSpike.select(key, n), [scenario.scope, budget]);
      await settle();
      const cardCount = await page.evaluate(() => window.__arenaSpike.cardCount());

      for (const formation of ["arena", "index", "echo"]) {
        await page.evaluate((f) => window.__arenaSpike.setFormation(f), formation);
        const during = await sampleFrames(60);
        await settle();
        const still = await sampleFrames(60);
        const info = await page.evaluate(() => ({
          layoutMs: window.__arenaSpike.layoutMs(),
          retargetMs: window.__arenaSpike.retargetMs(),
          cpuEmaMs: window.__arenaSpike.cpuEmaMs(),
          drawCalls: window.__arenaSpike.drawCalls(),
          dropped: window.__arenaSpike.dropped(),
          liveSlots: window.__arenaSpike.liveSlots(),
        }));
        results.push({
          scenario: scenario.label, scope: scenario.scope, budget, cardCount, formation,
          layoutMs: Number(info.layoutMs.toFixed(3)),
          retargetMs: Number(info.retargetMs.toFixed(3)),
          transitionCpuEmaMs: Number(info.cpuEmaMs.toFixed(3)),
          drawCalls: info.drawCalls,
          droppedCards: info.dropped,
          liveSlots: info.liveSlots,
          duringP50Ms: Number(during.p50.toFixed(2)),
          duringP95Ms: Number(during.p95.toFixed(2)),
          settledP50Ms: Number(still.p50.toFixed(2)),
          settledP95Ms: Number(still.p95.toFixed(2)),
        });
        console.log(JSON.stringify(results[results.length - 1]));
      }
    }
  }

  // ---- retained-card continuity, the acceptance criterion that matters ----
  await page.evaluate(() => window.__arenaSpike.select("person:p:d7fbacefc", 203));
  await settle();
  await page.evaluate(() => window.__arenaSpike.setFormation("arena"));
  await settle();
  const travel = await trackCard("p:c865d980b", "index"); // Murder Clown
  const verdict = {
    check: "retained card travels Arena -> Index",
    ...travel,
    moved: travel.netNdc > 0.05,
    // A teleport would put most of the journey into one frame. A choreographed
    // morph spreads it: the largest single step stays a small fraction.
    noTeleport: travel.maxStepNdc < travel.netNdc * 0.35,
  };
  console.log(JSON.stringify(verdict));
  results.push(verdict);
  if (!verdict.moved) notes.push("FAIL: card did not move between formations");
  if (!verdict.noTeleport) notes.push(`FAIL: card teleported (max step ${travel.maxStepNdc.toFixed(3)} of net ${travel.netNdc.toFixed(3)})`);

  // ---- interruption safety: retarget mid-flight ----
  const interrupted = await page.evaluate(async () => {
    const spike = window.__arenaSpike;
    spike.setFormation("arena");
    await new Promise(requestAnimationFrame);
    const before = [];
    for (let i = 0; i < 18; i++) { await new Promise(requestAnimationFrame); before.push(spike.cardScreenPos("p:c865d980b")); }
    spike.setFormation("index"); // interrupt mid-flight
    const after = [];
    for (let i = 0; i < 24; i++) { await new Promise(requestAnimationFrame); after.push(spike.cardScreenPos("p:c865d980b")); }
    const seam = Math.hypot(after[0].x - before[before.length - 1].x, after[0].y - before[before.length - 1].y);
    // The baseline must EXCLUDE the seam frame. Including it makes the
    // comparison compare the seam with itself and pass unconditionally.
    let maxOrdinaryStep = 0;
    const step = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    for (let i = 1; i < before.length; i++) maxOrdinaryStep = Math.max(maxOrdinaryStep, step(before[i - 1], before[i]));
    for (let i = 1; i < after.length; i++) maxOrdinaryStep = Math.max(maxOrdinaryStep, step(after[i - 1], after[i]));
    return { seamNdc: seam, maxOrdinaryStepNdc: maxOrdinaryStep };
  });
  const interruptVerdict = {
    check: "mid-flight retarget continues from current transform",
    ...interrupted,
    // The frame across the interruption must not be visibly larger than the
    // largest ordinary frame either side of it; if it is, the transition
    // restarted from a stale source instead of from what was on screen.
    continuous: interrupted.seamNdc <= interrupted.maxOrdinaryStepNdc * 1.5,
  };
  console.log(JSON.stringify(interruptVerdict));
  results.push(interruptVerdict);
  if (!interruptVerdict.continuous) notes.push(`FAIL: interruption seam ${interrupted.seamNdc.toFixed(4)} vs max ordinary step ${interrupted.maxOrdinaryStepNdc.toFixed(4)}`);

  // ---- population churn: enter, leave, slot release and re-acquisition ----
  // Every scenario above holds the population fixed, so leaving is always 0 and
  // the shader's exit branch never runs. Drill-down is the real case: seat 600,
  // collapse to the top 360, expand back. If leaving slots are never released
  // the pool drains and cards start being silently dropped.
  await page.evaluate(() => window.__arenaSpike.select("promotion:pr:c8", 600));
  await settle();
  await page.evaluate(() => window.__arenaSpike.setFormation("arena"));
  await settle();
  const churn = await page.evaluate(async () => {
    const spike = window.__arenaSpike;
    const trackedId = "p:d7fbacefc";
    const slotBefore = spike.slotOf(trackedId);
    const freeBefore = spike.freeSlots();
    spike.setBudget(360);
    const collapse = spike.churnStats();
    while (spike.animating()) await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const freeAfterCollapse = spike.freeSlots();
    spike.setBudget(600);
    const expand = spike.churnStats();
    while (spike.animating()) await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return {
      slotBefore, freeBefore, collapse, expand, freeAfterCollapse,
      freeAfterExpand: spike.freeSlots(),
      slotAfter: spike.slotOf(trackedId),
      droppedAfterExpand: spike.dropped(),
      liveAfter: spike.liveSlots(),
    };
  });
  const churnVerdict = {
    check: "drill-down churn releases and re-acquires slots",
    ...churn,
    leavingHappened: churn.collapse.leaving > 0,
    enteringHappened: churn.expand.entering > 0,
    slotsReclaimed: churn.freeAfterCollapse > churn.freeBefore,
    noDropsAfterRoundTrip: churn.droppedAfterExpand === 0,
    // A retained card must keep its identity across the round trip.
    trackedKeptSlot: churn.slotBefore === churn.slotAfter,
  };
  console.log(JSON.stringify(churnVerdict));
  results.push(churnVerdict);
  if (!churnVerdict.leavingHappened) notes.push("FAIL: collapsing the population produced no leaving cards");
  if (!churnVerdict.enteringHappened) notes.push("FAIL: expanding the population produced no entering cards");
  if (!churnVerdict.slotsReclaimed) notes.push("FAIL: leaving cards never returned their slots to the pool");
  if (!churnVerdict.noDropsAfterRoundTrip) notes.push(`FAIL: ${churn.droppedAfterExpand} cards dropped after a round trip`);
  if (!churnVerdict.trackedKeptSlot) notes.push(`FAIL: tracked card changed slot ${churn.slotBefore} -> ${churn.slotAfter}`);

  // ---- world-space path shape ----
  // Screen-space path length cannot distinguish a curved card path from a
  // straight path bent by a moving camera, so measure the bow in world space.
  // Measured on the ASSEMBLY leg (Echo -> Arena), which is the transition the
  // spec asks to sweep. Index is deliberately a flat snap into alignment, so
  // measuring the bow there would only prove that a straight target is straight.
  await page.evaluate(() => window.__arenaSpike.select("person:p:d7fbacefc", 203));
  await settle();
  await page.evaluate(() => window.__arenaSpike.setFormation("echo"));
  await settle();
  const bow = await page.evaluate(async () => {
    const spike = window.__arenaSpike;
    const path = [];
    spike.setFormation("arena");
    for (let i = 0; i < 220; i++) {
      await new Promise(requestAnimationFrame);
      const p = spike.cardWorldPos("p:c865d980b");
      if (p) path.push(p);
      if (!spike.animating()) break;
    }
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    let arc = 0;
    for (let i = 1; i < path.length; i++) arc += d(path[i - 1], path[i]);
    const chord = path.length > 1 ? d(path[0], path[path.length - 1]) : 0;
    return { samples: path.length, arcWorld: arc, chordWorld: chord };
  });
  const bowVerdict = {
    check: "world-space path shape",
    ...bow,
    bowRatio: bow.chordWorld > 0 ? Number((bow.arcWorld / bow.chordWorld).toFixed(4)) : 0,
  };
  console.log(JSON.stringify(bowVerdict));
  results.push(bowVerdict);

  // ---- allocation proxy: heap across many retargets ----
  const heap = await page.evaluate(async () => {
    const spike = window.__arenaSpike;
    const read = () => performance.memory?.usedJSHeapSize ?? 0;
    const first = read();
    // A clamped/bucketed reading is worthless. Detect it up front by checking
    // whether the counter can move at all, rather than reporting a flat delta
    // as if it were evidence of zero allocation.
    const probe = new Array(200000).fill(0).map((_, i) => ({ i }));
    const bumped = read();
    void probe.length;
    const counterLive = bumped > first;
    if (globalThis.gc) globalThis.gc();
    await new Promise((r) => setTimeout(r, 300));
    const before = read();
    for (let i = 0; i < 60; i++) {
      spike.setFormation(["echo", "arena", "index"][i % 3]);
      for (let f = 0; f < 4; f++) await new Promise(requestAnimationFrame);
    }
    if (globalThis.gc) globalThis.gc();
    await new Promise((r) => setTimeout(r, 300));
    return { beforeBytes: before, afterBytes: read(), retargets: 60, counterLive };
  });
  const heapVerdict = {
    check: "heap growth across 60 retargets",
    ...heap,
    deltaKb: Number(((heap.afterBytes - heap.beforeBytes) / 1024).toFixed(1)),
    perRetargetKb: Number(((heap.afterBytes - heap.beforeBytes) / 1024 / heap.retargets).toFixed(2)),
    trustworthy: heap.counterLive,
  };
  if (!heap.counterLive) notes.push("heap counter is clamped — allocation delta is not evidence");
  console.log(JSON.stringify(heapVerdict));
  results.push(heapVerdict);

  if (failures.length) notes.push(`runtime failures: ${failures.join(" | ")}`);
  console.log(JSON.stringify({ status: notes.length ? "issues" : "ok", notes }));
} finally {
  writeFileSync(OUT, `${JSON.stringify({
    url: URL, headful: HEADFUL, generatedAt: new Date().toISOString(),
    results, notes, runtimeFailures: failures,
  }, null, 2)}\n`);
  await context.close();
  await browser.close();
}
