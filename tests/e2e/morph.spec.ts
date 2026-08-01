import { expect, test, type Page } from "@playwright/test";

/**
 * MORPH LAB journeys.
 *
 * The lab's promise is continuity: ONE persistent set of corpus entities
 * travelling between readable topologies. So the suite checks the claims that
 * make the lens what it is — that it opens on the untouched organic tissue,
 * that a selection genuinely MORPHS (intermediate positions observed, not a
 * cut), that a retarget travels rather than teleports, that "return to
 * tissue" restores the organic positions bit-for-bit, and that the connectome
 * underneath survives the round trip untouched.
 */

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto("/");
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40000 });
  return errors;
}

/**
 * Open the lens and wait for a laid-out board — ANY board. Deliberately not
 * "wait for organic": opening the lab with something already selected must
 * land straight in that entity's topology, and asserting organic here would
 * assert the opposite of the required behaviour.
 */
async function openMorph(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Morph Lab β", exact: true }).click();
  await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(
    () => (window as any).__kayfabeMorph?.currentLayout != null,
    undefined,
    { timeout: 30000 },
  );
}

/** Choose a search result; selection flows through the ONE shared store. */
async function search(page: Page, q: string): Promise<void> {
  await page.getByRole("combobox", { name: /Search/ }).fill(q);
  await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
  await page.getByRole("option").first().click({ force: true });
}

const morphState = (page: Page) =>
  page.evaluate(() => {
    const r = (window as any).__kayfabeMorph;
    return r
      ? {
          mode: r.mode,
          morphing: r.morphing,
          progress: r.morphProgress,
          traceLive: r.traceLive,
          labelShown: r.lastLabelReport.shown,
        }
      : null;
  });

/** Wait until the lab has SETTLED in a mode (layout built + transition done). */
async function settledIn(page: Page, mode: string, timeout = 30000): Promise<void> {
  await expect
    .poll(async () => {
      const s = await morphState(page);
      return s && s.mode === mode && !s.morphing ? mode : `${s?.mode}/${s?.morphing}`;
    }, { timeout })
    .toBe(mode);
}

test.describe("morph lab lens", () => {
  // merged corpus (365k matches) plus a second WebGL context and per-mode
  // detail shards, three browser projects against one dev server
  test.slow();

  test("morph lab opens on organic positions", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop journey; mobile has its own below");
    const errors = await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // The board is the tissue itself: real positions, live ambient fibers,
    // and labels actually shown — not a black canvas that claims to be a lens.
    const probe = await page.evaluate(() => {
      const r = (window as any).__kayfabeMorph;
      const pos = [0, 1, 2].map((s) => r.currentPositionOf(s));
      return {
        mode: r.mode,
        pos,
        traceLive: r.traceLive,
        labelShown: r.lastLabelReport.shown,
        count: r.currentLayout.nodeTargets.length / 3,
      };
    });
    expect(probe.mode).toBe("organic");
    expect(probe.count).toBeGreaterThan(1000);
    for (const p of probe.pos) {
      expect(p).not.toBeNull();
      // organic positions come from the force layout — none of the first
      // slots sits exactly at the origin
      expect(Math.hypot(p![0], p![1], p![2])).toBeGreaterThan(0);
    }
    expect(probe.traceLive).toBeGreaterThan(0);
    await expect
      .poll(async () => (await morphState(page))!.labelShown, { timeout: 15000 })
      .toBeGreaterThan(0);

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("selecting a wrestler morphs into the loom, and the morph actually runs", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    // Under prefers-reduced-motion there is deliberately NO long transition —
    // the reduced-motion project asserts the opposite, below.
    test.skip(test.info().project.name === "reduced-motion", "no long morph by design");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // Sample from a page-side interval STARTED BEFORE THE CLICK: the dossier
    // shard has to load before the morph can start, so any wall-clock delay
    // after the click races the fetch and reads either the old board or the
    // settled new one. Resolved only after the morph ends. This is the
    // "the morph was never running" regression test — a cut never raises the
    // morphing flag, so a cut yields an empty sample set.
    const trajectory = page.evaluate(
      () =>
        new Promise<{ progress: number[]; mode: string }>((res) => {
          const r = (window as any).__kayfabeMorph;
          const progress: number[] = [];
          let started = false;
          let ticks = 0;
          const id = setInterval(() => {
            if (r.morphing) {
              started = true;
              progress.push(r.morphProgress);
            } else if (started) {
              clearInterval(id);
              return res({ progress, mode: r.mode });
            }
            if (++ticks > 3000) {
              clearInterval(id);
              return res({ progress, mode: r.mode });
            }
          }, 8);
        }),
    );

    await search(page, "Undertaker");
    const traj = await trajectory;

    expect(traj.mode).toBe("loom");
    const detail = `progress samples: ${traj.progress.map((p) => p.toFixed(2)).join(",")}`;
    // the transition was observed RUNNING…
    expect(traj.progress.length, detail).toBeGreaterThanOrEqual(1);
    // …and passed through genuinely intermediate progress, not just 0 or 1
    expect(traj.progress.some((p) => p > 0.05 && p < 0.95), detail).toBe(true);
    await settledIn(page, "loom");
  });

  test("clicking another wrestler retargets without snapping", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    test.skip(test.info().project.name === "reduced-motion", "no spatial morph by design");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await search(page, "Undertaker");
    await settledIn(page, "loom");

    // Track the loom's anchor (the slot the layout marked SELECTED = role 1):
    // in Kane's loom the Undertaker becomes an opponent, so this exact slot
    // must TRAVEL from the anchor position to the opponent column.
    const slot = await page.evaluate(
      () => (window as any).__kayfabeMorph.currentLayout.nodeRole.indexOf(1),
    );
    expect(slot).toBeGreaterThanOrEqual(0);
    const before = await page.evaluate(
      (s) => (window as any).__kayfabeMorph.currentPositionOf(s),
      slot,
    );

    const trajectory = page.evaluate(
      (s) =>
        new Promise<{ samples: [number, number][]; modes: string[] }>((res) => {
          const r = (window as any).__kayfabeMorph;
          const samples: [number, number][] = [];
          const modes: string[] = [];
          let started = false;
          let ticks = 0;
          const id = setInterval(() => {
            if (r.morphing) {
              started = true;
              const p = r.currentPositionOf(s);
              if (p) samples.push([p[0], p[1]]);
              modes.push(r.mode);
            } else if (started) {
              clearInterval(id);
              return res({ samples, modes });
            }
            if (++ticks > 3000) {
              clearInterval(id);
              return res({ samples, modes });
            }
          }, 8);
        }),
      slot,
    );

    await search(page, "Kane");
    const traj = await trajectory;
    await settledIn(page, "loom");
    const after = await page.evaluate(
      (s) => (window as any).__kayfabeMorph.currentPositionOf(s),
      slot,
    );

    // the person↔person mode never changed mid-flight
    expect(traj.modes.every((m) => m === "loom")).toBe(true);

    const travel = Math.hypot(after![0] - before![0], after![1] - before![1]);
    expect(travel, "the ex-anchor must occupy a different place in the new loom").toBeGreaterThan(1);

    // fractions of the way, deduped because the sampler outruns the renderer
    const fractions = traj.samples.map(
      ([x, y]) => Math.hypot(x - before![0], y - before![1]) / travel,
    );
    const distinct = [...new Set(fractions.map((p) => p.toFixed(3)))].map(Number);
    const detail = `distinct fractions: ${distinct.map((p) => p.toFixed(2)).join(",")}`;
    // Observed at least one position strictly BETWEEN origin and destination —
    // the whole difference between travelling and teleporting.
    expect(traj.samples.length, detail).toBeGreaterThanOrEqual(1);
    expect(distinct.some((p) => p > 0.02 && p < 0.98), detail).toBe(true);
    // No teleport: no consecutive observed step covers essentially the whole
    // displacement. Deliberately NOT "< half": quintic in-out peaks at ~5x
    // average velocity, so a legitimate morph covers ~0.7 of the travel in a
    // mid-flight 120 ms window, and headless GL under full-suite contention
    // renders few enough frames that step quantization stacks on top of that.
    // A cut still fails this: it is one step of 1.0 with zero intermediates.
    let maxStep = 0;
    const path = [0, ...distinct.filter((p) => p > 0 && p < 1).sort((a, b) => a - b), 1];
    for (let i = 1; i < path.length; i++) maxStep = Math.max(maxStep, path[i]! - path[i - 1]!);
    expect(maxStep, detail).toBeLessThan(0.92);
    // and the slot advanced monotonically toward its destination
    const rising = fractions.every((p, i) => i === 0 || p >= fractions[i - 1]! - 0.02);
    expect(rising, detail).toBe(true);
  });

  test("back restores the previous arrangement", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await search(page, "Undertaker");
    await settledIn(page, "loom");
    await expect(page.locator(".morph-crumbs")).toContainText("The Undertaker");
    await search(page, "Kane");
    await settledIn(page, "loom");
    await expect(page.locator(".morph-crumbs")).toContainText("Kane");

    // the search box holds focus after a pick; Backspace must reach the
    // global history handler, not edit the query
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press("Backspace");

    await expect(page.locator(".morph-crumbs")).toContainText("The Undertaker", { timeout: 20000 });
    await settledIn(page, "loom");
  });

  test("promotion motherboard and championship lineage", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // a promotion re-forms the tissue as its motherboard
    await search(page, "WWF");
    await settledIn(page, "motherboard");
    await expect(page.locator(".morph-crumbs")).toContainText("Promotion Motherboard");

    // a championship row in the right rail opens that belt's lineage
    const row = page.locator(".rail.right.morph-rail .ev-row").first();
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.click();
    await settledIn(page, "lineage");
    await expect(page.locator(".morph-crumbs")).toContainText("Championship Lineage");
  });

  test("return to tissue restores exact organic positions", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // capture settled organic positions of a spread of corpus slots
    const slots = await page.evaluate(() => {
      const r = (window as any).__kayfabeMorph;
      const count = r.currentLayout.nodeTargets.length / 3;
      return [0, Math.min(100, count - 1), Math.min(5000, count - 1)];
    });
    const capture = (s: number[]) =>
      page.evaluate(
        (ss) => ss.map((s: number) => (window as any).__kayfabeMorph.currentPositionOf(s)),
        s,
      );
    const before = await capture(slots);

    await search(page, "Undertaker");
    await settledIn(page, "loom");

    await page.getByRole("button", { name: /Return to tissue/ }).click();
    await settledIn(page, "organic");

    // EXACT float equality — the organic layout never computes a position, it
    // restores the one clone taken at boot, so the round trip is byte-for-byte
    const after = await capture(slots);
    expect(after).toEqual(before);
  });

  test("the connectome survives the round trip", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    const errors = await boot(page);
    // frame the connectome somewhere specific first
    await search(page, "Undertaker");
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    const before = await page.evaluate(() => {
      const r = (window as any).__kayfabeRenderer;
      return { dist: r.cameraDistance, active: r.isActive };
    });
    expect(before.active).toBe(true);

    // full morph journey: the carried selection lands straight in the loom…
    await openMorph(page);
    await settledIn(page, "loom");
    // …the connectome's loop is suspended rather than disposed…
    expect(await page.evaluate(() => (window as any).__kayfabeRenderer.isActive)).toBe(false);
    // …and back out through the tissue
    await page.getByRole("button", { name: /Return to tissue/ }).click();
    await settledIn(page, "organic");

    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await expect(page.locator("canvas.gl")).toBeVisible();
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    const after = await page.evaluate(() => {
      const r = (window as any).__kayfabeRenderer;
      return { dist: r.cameraDistance, active: r.isActive };
    });
    expect(after.active).toBe(true);
    // no unexpected fit-all: the framing came back as it was
    expect(Math.abs(after.dist - before.dist)).toBeLessThan(0.5);

    // the other lenses still function after a lab visit
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByRole("region", { name: /People table/ })).toBeVisible();
    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await expect(page.locator("canvas.gl")).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("reduced motion applies the layout at once", async ({ page }) => {
    test.skip(test.info().project.name !== "reduced-motion", "reduced-motion project only");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // Started before the click: measure from the moment the loom layout
    // arrives to the moment the transition reports done, and pin the anchor's
    // geometry — under reduced motion it must ALREADY be at its destination.
    const observed = page.evaluate(
      () =>
        new Promise<{ settleMs: number; mode: string; moved: number }>((res) => {
          const r = (window as any).__kayfabeMorph;
          let t0 = 0;
          let p0: [number, number, number] | null = null;
          let slot = -1;
          const start = performance.now();
          const id = setInterval(() => {
            if (r.mode === "loom" && t0 === 0) {
              t0 = performance.now();
              slot = r.currentLayout.nodeRole.indexOf(1);
              p0 = slot >= 0 ? r.currentPositionOf(slot) : null;
            }
            if (t0 > 0 && r.morphProgress >= 1) {
              clearInterval(id);
              const p1 = slot >= 0 ? r.currentPositionOf(slot) : null;
              const moved =
                p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) : -1;
              return res({ settleMs: performance.now() - t0, mode: r.mode, moved });
            }
            if (performance.now() - start > 30000) {
              clearInterval(id);
              return res({ settleMs: -1, mode: r.mode, moved: -1 });
            }
          }, 16);
        }),
    );

    await search(page, "Undertaker");
    const got = await observed;
    expect(got.mode).toBe("loom");
    // spec duration is 190 ms; ~400 ms plus headless frame slack, and far
    // below the 920 ms travelling morph this project must never run
    expect(got.settleMs).toBeGreaterThanOrEqual(0);
    expect(got.settleMs).toBeLessThan(600);
    // the anchor never travelled — geometry landed at once
    expect(got.moved).toBeGreaterThanOrEqual(0);
    expect(got.moved).toBeLessThan(0.001);
  });

  test("mobile: lab operable, sheet tabs work", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile journey");
    const errors = await boot(page);
    await page.getByRole("button", { name: "Morph Lab β", exact: true }).click();
    await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 30000 });

    const app = page.locator(".app");
    await expect(app).toHaveAttribute("data-morph-sheet", "inspector");
    await page.getByRole("tab", { name: "Layout" }).click();
    await expect(app).toHaveAttribute("data-morph-sheet", "controls");
    await expect(page.locator(".rail.left.morph-rail")).toBeVisible();
    await page.getByRole("tab", { name: "Details" }).click();
    await expect(app).toHaveAttribute("data-morph-sheet", "inspector");
    await page.getByRole("tab", { name: "Map" }).click();
    await expect(app).toHaveAttribute("data-morph-sheet", "hidden");
    await expect(page.locator("canvas.morph-gl")).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });
});
