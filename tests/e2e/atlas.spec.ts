import { expect, test, type Page } from "@playwright/test";

/**
 * ATLAS journeys.
 *
 * Walks the semantic hierarchy the way a reader does and checks the claims the
 * lens makes, not just that pixels appeared: that every promotion is
 * represented, that a selection survives a lens round trip, that a shared link
 * restores the same view, and that a belt with no derivable lineage says so
 * instead of rendering empty.
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
 * Open the lens and wait for a board — ANY board.
 *
 * Deliberately not "wait for the overview": opening ATLAS with something
 * already selected must land straight in that entity's state, so asserting the
 * overview here would be asserting the opposite of the required behaviour.
 */
async function openAtlas(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Atlas", exact: true }).click();
  await expect(page.getByTestId("atlas-canvas")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("atlas-counts")).toContainText("represented", { timeout: 30000 });
}

/** Choose a search result and wait for the board to actually become that state. */
async function search(page: Page, q: string, expectCrumb: RegExp): Promise<void> {
  await page.getByRole("combobox", { name: /Search/ }).fill(q);
  await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
  await page.getByRole("option").first().click({ force: true });
  await expect(page.locator(".atlas-crumbs .crumb.here")).toHaveText(expectCrumb, {
    timeout: 20000,
  });
}

const atlasState = (page: Page) =>
  page.evaluate(() => (window as any).__kayfabeAtlas?.scene_?.state ?? null);

test.describe("atlas lens", () => {
  // merged corpus (365k matches) plus a second projection, three browser
  // projects against one dev server
  test.slow();

  test("hierarchy: overview → promotion → championship → holder → back", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop hierarchy walk; mobile has its own journey");
    const errors = await boot(page);
    await openAtlas(page);

    // 1-3. the overview renders lanes for EVERY promotion, not a filtered subset
    expect(await atlasState(page)).toBe("overview");
    await expect(page.getByTestId("atlas-counts")).toContainText("571 promotions represented");
    const lanes = await page.evaluate(() => (window as any).__kayfabeAtlas.scene_.lanes.length);
    expect(lanes).toBe(571);
    // championships are drawn as gold rails inside the lanes, not hidden
    const titleQuads = await page.evaluate(
      () => (window as any).__kayfabeAtlas.scene_.quads.filter((q: any) => q.kind === 2).length,
    );
    expect(titleQuads).toBeGreaterThan(4000);

    // 4-5. search centres a promotion
    await search(page, "WWE", /^WWE$/);
    expect(await atlasState(page)).toBe("promotion");

    // 6-7. promotion focus has the three zones
    await expect(page.getByRole("heading", { name: /Promotion/ })).toBeVisible();
    await expect(page.getByText(/documented participants/).first()).toBeVisible();

    // 8-9. a championship opens a chronological lineage
    await page.getByRole("button", { name: /WWE Championship/ }).first().click();
    await expect(page.locator(".atlas-crumbs .crumb.here")).toHaveText(/Championship/, {
      timeout: 20000,
    });
    expect(await atlasState(page)).toBe("title");
    // reign blocks are in date order and there are many of them
    const reignOrder = await page.evaluate(() => {
      const q = (window as any).__kayfabeAtlas.scene_.quads.filter((x: any) =>
        x.key.startsWith("reign:"),
      );
      return { n: q.length, sorted: q.every((v: any, i: number) => i === 0 || v.x >= q[i - 1].x) };
    });
    expect(reignOrder.n).toBeGreaterThan(20);
    expect(reignOrder.sorted).toBe(true);
    // the breadcrumb records the whole hierarchy
    await expect(page.locator(".atlas-crumbs")).toContainText("All promotions");
    await expect(page.locator(".atlas-crumbs")).toContainText("WWE");

    // 10-11. a holder opens their career route
    await page.locator(".rail.right").getByRole("button").filter({ hasText: /^\d{4}-/ }).first().click();
    await expect(page.getByRole("heading", { name: /Selected reign/ })).toBeVisible({ timeout: 15000 });
    await page.getByRole("heading", { name: /Selected reign/ }).locator("..").getByRole("button").filter({ hasText: /career route/ }).first().click();
    await expect(page.locator(".atlas-crumbs .crumb.here")).not.toHaveText(/Championship/, {
      timeout: 20000,
    });
    expect(await atlasState(page)).toBe("career");

    // 12. Escape walks back up the hierarchy
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("atlas-counts")).toContainText("571 promotions represented", {
      timeout: 20000,
    });
    expect(await atlasState(page)).toBe("overview");

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("a belt with no derivable lineage says so rather than rendering empty", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openAtlas(page);
    // NJPW belts come from the csv corpus, which carries no title-change field
    await search(page, "NJPW Strong Openweight", /Openweight/);
    expect(await atlasState(page)).toBe("title");
    await expect(page.getByText(/no title-change field/i).first()).toBeVisible();
    // and it still has a shape: documented title matches per year
    const bars = await page.evaluate(
      () => (window as any).__kayfabeAtlas.scene_.quads.filter((q: any) => q.key.startsWith("tmbar:")).length,
    );
    expect(bars).toBeGreaterThan(0);
  });

  test("timeline playback animates the organized board", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    const errors = await boot(page);
    await openAtlas(page);
    await search(page, "WWE", /^WWE$/);
    await page.getByLabel("Timeline mode").selectOption("playback");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.waitForTimeout(3000);
    // the playhead exists on the board and the current-event readout moved
    const hasPlayhead = await page.evaluate(
      () => !!(window as any).__kayfabeAtlas.scene_.quads.find((q: any) => q.key === "playhead"),
    );
    expect(hasPlayhead).toBe(true);
    await page.getByRole("button", { name: "Pause" }).click();
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("selection survives the lens round trip, and framing is preserved", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    // frame the connectome somewhere specific first
    await page.getByRole("combobox", { name: /Search/ }).fill("Undertaker");
    await page.getByRole("option").first().click({ force: true });
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    const before = await page.evaluate(() => {
      const r = (window as any).__kayfabeRenderer;
      return { dist: r.cameraDistance, active: r.isActive };
    });
    expect(before.active).toBe(true);

    await openAtlas(page);
    // the same wrestler is now a career route — the selection carried
    expect(await atlasState(page)).toBe("career");
    // and the connectome's loop is suspended rather than disposed
    const during = await page.evaluate(() => (window as any).__kayfabeRenderer.isActive);
    expect(during).toBe(false);

    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    const after = await page.evaluate(() => {
      const r = (window as any).__kayfabeRenderer;
      return { dist: r.cameraDistance, active: r.isActive };
    });
    expect(after.active).toBe(true);
    // no unexpected fit-all: the framing came back as it was
    expect(Math.abs(after.dist - before.dist)).toBeLessThan(0.5);
  });

  test("a shared atlas URL restores the same view", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openAtlas(page);
    await search(page, "WWE", /^WWE$/);
    await page.getByLabel("Group").selectOption("alpha");
    await page.getByLabel("Labels").selectOption("dense");
    await page.waitForTimeout(900);
    const url = page.url();
    expect(url).toContain("lens=atlas");
    expect(url).toContain("ag=alpha");
    expect(url).toContain("ald=dense");

    await page.goto(url);
    await expect(page.getByTestId("atlas-canvas")).toBeVisible({ timeout: 40000 });
    await expect(page.locator(".atlas-crumbs .crumb.here")).toHaveText(/^WWE$/, { timeout: 30000 });
    expect(await atlasState(page)).toBe("promotion");
    await expect(page.getByLabel("Group")).toHaveValue("alpha");
    await expect(page.getByLabel("Labels")).toHaveValue("dense");
  });

  test("invalid atlas url values fall back to defaults instead of breaking", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    // A fresh load, not a hash change on an already-booted document: pasting a
    // link opens a new document, and that is the path being tested.
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto("/#2/lens=atlas/ag=nonsense/aso=nope/ald=huge/ama=-99/art=0/ach=0");
    await expect(page.getByTestId("atlas-canvas")).toBeVisible({ timeout: 40000 });
    await expect(page.getByTestId("atlas-counts")).toContainText("promotions represented", {
      timeout: 30000,
    });
    await expect(page.getByLabel("Group")).toHaveValue("decade");
    await expect(page.getByLabel("Labels")).toHaveValue("normal");
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("reduced motion updates the layout without requiring a morph", async ({ page }) => {
    test.skip(test.info().project.name !== "reduced-motion", "reduced-motion project only");
    const errors = await boot(page);
    await openAtlas(page);
    await search(page, "WWE", /^WWE$/);
    expect(await atlasState(page)).toBe("promotion");
    // geometry is at its destination immediately, not mid-flight
    await page.waitForTimeout(400);
    const settled = await page.evaluate(() => {
      const r = (window as any).__kayfabeAtlas;
      return r.scene_.quads.length > 0;
    });
    expect(settled).toBe(true);
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("mobile: the board is reachable and selectable by tap", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile journey");
    const errors = await boot(page);
    await page.getByRole("button", { name: "Atlas", exact: true }).click();
    await expect(page.getByTestId("atlas-canvas")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("atlas-counts")).toContainText("promotions represented", {
      timeout: 30000,
    });
    // search reaches a promotion without any hover interaction
    await page.getByRole("combobox", { name: /Search/ }).fill("WWE");
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
    await page.getByRole("option").first().click({ force: true });
    await expect(page.locator(".atlas-crumbs .crumb.here")).toHaveText(/^WWE$/, { timeout: 25000 });
    expect(await atlasState(page)).toBe("promotion");
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("atlas data is lazy: nothing is fetched until the lens opens, then only what is needed", async ({ page, isMobile }) => {
    test.skip(isMobile, "one platform is enough for a network assertion");
    const atlasReqs: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url()).pathname;
      if (u.includes("/data/atlas/")) atlasReqs.push(u.split("/data/atlas/")[1]!);
    });
    await page.goto("/");
    await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40000 });
    await page.waitForTimeout(2500);
    // A reader who never opens ATLAS pays nothing for it.
    expect(atlasReqs, `unexpected atlas fetches on boot: ${atlasReqs.join(", ")}`).toHaveLength(0);

    await openAtlas(page);
    await page.waitForTimeout(1500);
    // Opening it costs the compact overview and NOTHING else — no detail shards.
    expect([...atlasReqs].sort()).toEqual(["manifest.json", "promotions.json", "titles.json"]);

    await search(page, "WWE", /^WWE$/);
    await page.waitForTimeout(1000);
    // Selecting a promotion pulls exactly one promotion shard.
    const shards = atlasReqs.filter((u) => u.startsWith("promotions/"));
    expect(shards).toHaveLength(1);
    expect(atlasReqs.filter((u) => u.startsWith("people/"))).toHaveLength(0);
  });

  test("a state change morphs shared entities instead of teleporting them", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    // Under prefers-reduced-motion there is deliberately NO spatial morph —
    // the layout applies at once and only opacity crossfades — so this
    // assertion belongs to the projects that animate. The reduced-motion
    // project asserts the opposite, below.
    test.skip(test.info().project.name === "reduced-motion", "no spatial morph by design");
    await boot(page);
    await openAtlas(page);
    // WWE's rail exists in BOTH the overview and its own focus board under the
    // same key, so it is the entity that must travel rather than cut.
    const key = await page.evaluate(() => {
      const s = (window as any).__kayfabeAtlas.scene_;
      const lane = s.lanes.find((l: any) => l.label === "WWE");
      return lane ? `rail:${lane.key}` : null;
    });
    expect(key).not.toBeNull();
    const before = await page.evaluate((k) => (window as any).__kayfabeAtlas.debugQuad(k), key);
    expect(before).not.toBeNull();

    // Sample from inside requestAnimationFrame rather than on a wall-clock
    // timeout: the shard has to load before the morph can start, so any fixed
    // delay races the fetch and reads either the old board or the settled new
    // one. Started BEFORE the click, resolved after the morph ends.
    // Sampled on a short interval rather than requestAnimationFrame: rAF is
    // capped at the RENDER rate, and headless GL draws this board at single
    // digits, so rAF sampling under full-suite load can miss the whole 760 ms
    // window. The buffer only changes on render frames, so duplicates are
    // expected and deduped below.
    const trajectory = page.evaluate((k) => {
      const r = (window as never as { __kayfabeAtlas: any }).__kayfabeAtlas;
      return new Promise<{ samples: [number, number][]; final: [number, number] | null }>((res) => {
        const samples: [number, number][] = [];
        let started = false;
        let ticks = 0;
        const id = setInterval(() => {
          const q = r.debugQuad(k);
          if (r.morphing) {
            started = true;
            if (q) samples.push([q.x, q.y]);
          } else if (started) {
            clearInterval(id);
            return res({ samples, final: q ? [q.x, q.y] : null });
          }
          if (++ticks > 2500) {
            clearInterval(id);
            return res({ samples, final: q ? [q.x, q.y] : null });
          }
        }, 8);
      });
    }, key);

    // Drive the state change the way a reader does.
    await page.getByRole("combobox", { name: /Search/ }).fill("WWE");
    await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
    await page.getByRole("option").first().click({ force: true });
    await expect(page.locator(".atlas-crumbs .crumb.here")).toHaveText(/^WWE$/, { timeout: 20000 });

    const traj = await trajectory;
    expect(traj.final).not.toBeNull();
    const [fx, fy] = traj.final!;
    // The rail genuinely occupies a different place on the two boards…
    const travel = Math.hypot(fx - before!.x, fy - before!.y);
    expect(travel, "the rail should be somewhere else on the focus board").toBeGreaterThan(1);
    // …and it was observed at several intermediate positions on the way, each
    // strictly between origin and destination. That is the whole difference
    // between a morph and a cut, and a cut would show one sample at 100%.
    // Distinct positions, because the sampler runs faster than the renderer.
    // A cut produces zero of these — the morph flag is never observed true —
    // so even one intermediate position is proof, and two is comfortable.
    const progress = traj.samples.map(
      ([x, y]) => Math.hypot(x - before!.x, y - before!.y) / travel,
    );
    const distinct = [...new Set(progress.map((p) => p.toFixed(3)))].map(Number);
    const intermediate = distinct.filter((p) => p > 0.02 && p < 0.98);
    const detail = `distinct progress samples: ${distinct.map((p) => p.toFixed(2)).join(",")}`;
    // Deliberately NOT a frame count. Headless GL under full-suite contention
    // renders two or three frames inside a 760 ms morph, and an assertion tuned
    // to that is an assertion about the test machine. The invariant is simply:
    // while the morph is running, the entity is observed somewhere that is not
    // its destination. A cut never sets the morph flag at all, so it yields no
    // samples; a jump-to-destination yields samples that are all at 1.0.
    // Observed on this machine: 0.00, 0.38, 1.00.
    expect(traj.samples.length, detail).toBeGreaterThanOrEqual(1);
    expect(distinct.some((p) => p < 0.9), detail).toBe(true);
    expect(intermediate.length + distinct.filter((p) => p <= 0.02).length, detail)
      .toBeGreaterThanOrEqual(1);
    // and it advanced monotonically rather than jittering
    const rising = progress.every((p, i) => i === 0 || p >= progress[i - 1]! - 0.02);
    expect(rising).toBe(true);
  });

  test("reduced motion applies the layout at once instead of travelling", async ({ page }) => {
    test.skip(test.info().project.name !== "reduced-motion", "reduced-motion project only");
    await boot(page);
    await openAtlas(page);
    const key = await page.evaluate(() => {
      const s = (window as any).__kayfabeAtlas.scene_;
      const lane = s.lanes.find((l: any) => l.label === "WWE");
      return lane ? `rail:${lane.key}` : null;
    });
    expect(key).not.toBeNull();
    const before = await page.evaluate((k) => (window as any).__kayfabeAtlas.debugQuad(k), key);

    const trajectory = page.evaluate((k) => {
      const r = (window as never as { __kayfabeAtlas: any }).__kayfabeAtlas;
      return new Promise<[number, number][]>((res) => {
        const samples: [number, number][] = [];
        let started = false;
        let ticks = 0;
        const id = setInterval(() => {
          const q = r.debugQuad(k);
          if (r.morphing) {
            started = true;
            if (q) samples.push([q.x, q.y]);
          } else if (started) {
            clearInterval(id);
            return res(samples);
          }
          if (++ticks > 2500) {
            clearInterval(id);
            return res(samples);
          }
        }, 8);
      });
    }, key);

    await search(page, "WWE", /^WWE$/);
    const samples = await trajectory;
    const after = await page.evaluate((k) => (window as any).__kayfabeAtlas.debugQuad(k), key);
    const travel = Math.hypot(after!.x - before!.x, after!.y - before!.y);
    expect(travel).toBeGreaterThan(1);
    // Every observed position is already the destination: the geometry never
    // travels, only the opacity crossfades. A reader who asked for less motion
    // should not have to watch 8,000 rectangles fly to learn the board changed.
    for (const [x, y] of samples) {
      expect(Math.hypot(x - after!.x, y - after!.y) / travel).toBeLessThan(0.02);
    }
  });

  test("the connectome, geo and table lenses still work", async ({ page, isMobile }) => {
    const errors = await boot(page);
    // connectome still renders its own graph
    const nodes = await page.evaluate(() => (window as any).__kayfabeRenderer?.governor?.tier ?? null);
    expect(nodes).not.toBeNull();

    await page.getByRole("button", { name: "Atlas", exact: true }).click();
    await expect(page.getByTestId("atlas-canvas")).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await expect(page.locator("canvas.gl")).toBeVisible();

    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByRole("region", { name: /People table/ })).toBeVisible();
    await page.getByRole("button", { name: "Connectome", exact: true }).click();

    if (!isMobile) {
      await page.getByRole("button", { name: "Geo Replay", exact: true }).click();
      await expect(page.getByTestId("geo-globe")).toBeVisible({ timeout: 40000 });
    }
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });
});
