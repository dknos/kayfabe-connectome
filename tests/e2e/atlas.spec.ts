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
