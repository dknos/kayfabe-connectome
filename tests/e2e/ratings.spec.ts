import { expect, test, type Page } from "@playwright/test";

/** Ratings journeys exercise the public renderer seam, never fixture data. */
const root = () => process.env.KAYFABE_BASE_URL ?? "/";

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.goto(root());
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40_000 });
  return errors;
}

async function openRatings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Meltzer Ratings", exact: true }).click();
  await expect(page.getByTestId("ratings-canvas")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__kayfabeRatings?.currentLayout != null, undefined, { timeout: 30_000 });
}

async function settled(page: Page, mode?: string, timeout = 30_000): Promise<void> {
  await expect.poll(() => page.evaluate((wanted) => {
    const renderer = (window as any).__kayfabeRatings;
    return renderer && !renderer.morphing && (!wanted || renderer.mode === wanted);
  }, mode), { timeout }).toBe(true);
}

async function chooseSearch(page: Page, name: string): Promise<void> {
  const box = page.getByRole("combobox", { name: /Search people/ });
  await box.fill("");
  await box.fill(name);
  const result = page.locator('.search-pop [role="option"]').filter({ hasText: name }).first();
  await expect(result).toBeVisible({ timeout: 10_000 });
  await result.click({ force: true });
}

async function scopeFromPromotionControl(page: Page): Promise<{ name: string }> {
  const promotion = page.locator("select").filter({ hasText: "All promotions" });
  const options = await promotion.locator("option").evaluateAll((nodes) => nodes.slice(1).map((node) => ({ value: (node as HTMLOptionElement).value, label: node.textContent ?? "" })));
  expect(options.length).toBeGreaterThan(0);
  const chosen = options[0]!;
  await promotion.selectOption(chosen.value);
  await settled(page, "promotions");
  return { name: chosen.label.replace(/ · \d+$/, "") };
}

/** Acquire a real corpus title from the title-only exact ledger, not a guessed name. */
async function scopeFromTitleLedger(page: Page): Promise<{ name: string }> {
  const before = await page.evaluate(() => (window as any).__kayfabeRatings.currentLayout.generation);
  await page.getByRole("checkbox", { name: "Title matches", exact: true }).check();
  await expect.poll(() => page.evaluate((generation) => {
    const renderer = (window as any).__kayfabeRatings;
    return renderer.currentLayout.generation > generation && !renderer.morphing;
  }, before), { timeout: 20_000 }).toBe(true);
  await settled(page, "promotions");
  const list = page.getByRole("listbox", { name: /Rated matches in/ });
  await list.getByRole("option").first().click();
  const titleState = page.getByLabel("Ratings inspector").locator("dt", { hasText: "Title state" }).locator("xpath=following-sibling::dd[1]");
  await expect(titleState).not.toHaveText("No title match reported", { timeout: 15_000 });
  const name = (await titleState.textContent() ?? "").split(" · ")[0]?.trim() ?? "";
  expect(name).not.toBe("");
  return { name };
}

async function hoverIdentity(page: Page, identity: "exact" | "aggregate"): Promise<string> {
  const id = await page.evaluate((kind) => {
    const renderer = (window as any).__kayfabeRatings;
    const layout = renderer.currentLayout;
    if (kind === "exact") {
      const index = Array.from(layout.opacity as Float32Array).findIndex((value: number) => value > 0.7);
      return index >= 0 ? layout.matchIds[index] : null;
    }
    return layout.aggregates.find((bin: any) => bin.opacity > 0.1)?.key ?? null;
  }, identity);
  expect(id, `no hoverable ${identity} identity`).toBeTruthy();
  // This is the renderer's public hover ownership API. It exercises the same
  // onHover bridge used by keyboard-accessible labels and avoids falsely
  // claiming a visual aggregate pick when an exact peak occludes it.
  await page.evaluate((value) => (window as any).__kayfabeRatings.hover.enterSurface("keyboard", value), id);
  await expect(page.locator(`[data-rating-hover="${id}"]`)).toBeVisible({ timeout: 10_000 });
  return id!;
}

const camera = (page: Page) => page.evaluate(() => (window as any).__kayfabeRenderer.cameraCtl ? {
  position: (window as any).__kayfabeRenderer.cameraCtl.camera.position.toArray(),
  target: (window as any).__kayfabeRenderer.cameraCtl.target.toArray(),
  distance: (window as any).__kayfabeRenderer.cameraDistance,
} : null);

test.describe("Meltzer Ratings lens", () => {
  test.slow();

  test("lazy-loads the ratings ledger and locks an exact reported match", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop lens journey; mobile and reduced motion have focused journeys");
    const errors = await boot(page);
    const before = await page.evaluate(() => performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes("/data/ratings/")).length);

    await openRatings(page);
    await settled(page, "promotions");
    await expect(page.getByLabel("Rating source caveat")).toContainText("Missing is not zero");

    const probe = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeRatings;
      return {
        mode: renderer.mode,
        exact: renderer.visibleExactMatches,
        aggregates: renderer.visibleAggregateBins,
        range: renderer.ratingRange,
        coverage: renderer.coverageStats,
        lanes: renderer.currentLayout.lanes.map((lane: any) => ({ id: lane.id, z: lane.z, basis: lane.coverageBasis })),
        visibleDepths: Array.from(renderer.currentLayout.opacity as Float32Array)
          .map((opacity: number, index: number) => opacity > 0.01 ? renderer.currentLayout.positions[index * 3 + 2] : null)
          .filter((value: number | null) => value !== null),
        aggregateEvidence: renderer.currentLayout.aggregates.slice(0, 3).map((bin: any) => ({ promotionId: bin.promotionId, basis: bin.coverageBasis })),
        files: performance.getEntriesByType("resource").map((entry) => entry.name)
          .filter((name) => name.includes("/data/ratings/")),
      };
    });
    expect(probe.exact).toBeGreaterThan(0);
    expect(probe.range[0]).toBeLessThan(probe.range[1]);
    expect(probe.coverage).toBeTruthy();
    expect(probe.lanes).toEqual([{ id: "global:chronology", z: 0, basis: "global-denominator" }]);
    expect(probe.visibleDepths.length).toBeGreaterThan(0);
    expect(probe.visibleDepths.every((value: number) => value === 0)).toBe(true);
    expect(probe.aggregateEvidence.every((bin: { promotionId: string | null; basis: string }) => bin.promotionId === null && bin.basis === "global-denominator")).toBe(true);
    expect(probe.files.length).toBeGreaterThan(before);
    for (const file of ["manifest.json", "dictionaries.json", "matches.bin", "participants.bin", "coverage.bin", "lod.bin", "histograms.json"]) {
      expect(probe.files.some((url) => url.endsWith(`/ratings/${file}`))).toBe(true);
    }

    const list = page.getByRole("listbox", { name: /Rated matches in/ });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 15_000 });
    await list.getByRole("option").first().click();
    await expect(page.getByLabel("Ratings inspector")).toContainText("Locked match");
    await expect(page.getByLabel("Ratings inspector")).toContainText("Reported Meltzer rating");
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("thresholds reduce the visible ledger and shared search enters a career ridge", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop typing and ridge transition journey");
    await boot(page);
    await openRatings(page);
    await settled(page, "promotions");
    const allRated = await page.evaluate(() => (window as any).__kayfabeRatings.visibleExactMatches);

    await page.getByRole("button", { name: "5★+", exact: true }).click();
    await settled(page, "promotions");
    const fiveStar = await page.evaluate(() => (window as any).__kayfabeRatings.visibleExactMatches);
    expect(fiveStar).toBeGreaterThan(0);
    expect(fiveStar).toBeLessThan(allRated);

    await chooseSearch(page, "The Undertaker");
    await settled(page, "career");
    await expect(page.getByLabel("Ratings inspector")).toContainText("The Undertaker");
  });

  test("mobile panel tabs retain a selectable, inspectable ratings ledger", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile accessibility journey");
    await boot(page);
    await openRatings(page);
    await settled(page);
    const tabs = page.getByRole("tablist", { name: "Meltzer Ratings panels" });
    await expect(tabs).toBeVisible();
    await tabs.getByRole("tab", { name: "Details", exact: true }).click();
    const list = page.getByRole("listbox", { name: /Rated matches in/ });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 15_000 });
    await list.getByRole("option").first().click();
    await expect(page.getByLabel("Ratings inspector")).toContainText("Locked match");
    await expect(page.getByRole("heading", { name: "Locked match", exact: true })).toBeInViewport();
  });

  test("aggregate disclosure zooms to exact records; negative and above-five reported values remain distinct", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop control and aggregate disclosure journey");
    await boot(page);
    await openRatings(page);
    await settled(page, "promotions");
    const before = await page.evaluate(() => ({
      range: (window as any).__kayfabeRatings.ratingRange,
      exact: (window as any).__kayfabeRatings.visibleExactMatches,
      dayRange: (window as any).__kayfabeRatings.currentLayout.dayRange,
    }));
    expect(before.range[0]).toBeLessThan(0);

    const aggregateId = await hoverIdentity(page, "aggregate");
    const aggregateRange = await page.evaluate((id) => {
      const bin = (window as any).__kayfabeRatings.currentLayout.aggregates.find((item: any) => item.key === id);
      return bin ? [bin.startDay, bin.endDay] : null;
    }, aggregateId);
    expect(aggregateRange).toBeTruthy();
    const card = page.locator(".ratings-hover-card");
    await expect(card).toContainText("aggregate");
    await expect(card).toContainText("Coverage");
    await card.getByRole("button", { name: "Open exact matches" }).click();
    await settled(page, "promotions");
    const zoomed = await page.evaluate(() => ({
      exact: (window as any).__kayfabeRatings.visibleExactMatches,
      dayRange: (window as any).__kayfabeRatings.currentLayout.dayRange,
    }));
    expect(zoomed.exact).toBeGreaterThan(0);
    expect(zoomed.exact).toBeLessThanOrEqual(before.exact);
    expect(zoomed.dayRange).toEqual(aggregateRange);
    expect(zoomed.dayRange).not.toEqual(before.dayRange);

    // A bin intentionally narrows chronology; re-open a global lens before
    // asserting corpus-wide negative reported values rather than pretending a
    // sparse bin is evidence of absence.
    await page.goto(root());
    await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40_000 });
    await openRatings(page);
    await settled(page, "promotions");
    await page.getByRole("spinbutton", { name: "Maximum reported rating" }).fill("0");
    await settled(page, "promotions");
    expect(await page.evaluate(() => (window as any).__kayfabeRatings.visibleExactMatches)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Above 5★", exact: true }).click();
    await settled(page, "promotions");
    expect(await page.evaluate(() => (window as any).__kayfabeRatings.visibleExactMatches)).toBeGreaterThan(0);
  });

  test("promotion and title scope come from the actual corpus controls, and coverage does not imply unrated zeroes", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop multi-scope journey");
    await boot(page);
    await openRatings(page);
    await settled(page, "promotions");
    const corpusEvidence = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeRatings;
      const layout = renderer.currentLayout;
      return {
        exactCanonicalIdentities: layout.matchIds.length,
        reportedZeroes: Array.from(layout.rating as Float32Array).filter((value: number) => value === 0).length,
        coverage: renderer.coverageStats,
      };
    });
    expect(corpusEvidence.exactCanonicalIdentities).toBe(corpusEvidence.coverage.rated);
    expect(corpusEvidence.coverage.totalDocumented).toBeGreaterThan(corpusEvidence.coverage.rated);
    expect(corpusEvidence.reportedZeroes).toBeGreaterThan(0);
    const promotion = await scopeFromPromotionControl(page);
    await chooseSearch(page, promotion.name);
    await settled(page, "promotion");
    await expect(page.getByLabel("Ratings inspector")).toContainText(promotion.name);

    await page.getByRole("button", { name: "1 · Time + rating", exact: true }).click();
    await settled(page, "promotions");
    const title = await scopeFromTitleLedger(page);
    await chooseSearch(page, title.name);
    await settled(page, "title");
    const coverage = await page.evaluate(() => (window as any).__kayfabeRatings.coverageStats);
    expect(coverage.totalDocumented).toBeGreaterThanOrEqual(coverage.rated);
    await expect(page.getByLabel("Rating source caveat")).toContainText("Missing is not zero");
    await expect(page.getByLabel("Ratings inspector")).toContainText("Title focus uses every title identity");
  });

  test("exact and aggregate hover disclose their different evidence contracts, and hover can lock an exact record", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop hover and comparison journey");
    await boot(page);
    await openRatings(page);
    await settled(page, "promotions");
    const exact = await hoverIdentity(page, "exact");
    const card = page.locator(".ratings-hover-card");
    await expect(card).toContainText("reported");
    await card.getByRole("button", { name: "Set A" }).click();
    await card.getByRole("button", { name: "Lock selection" }).click();
    await expect(page.getByLabel("Ratings inspector")).toContainText("Locked match");
    expect(await page.evaluate(() => (window as any).__kayfabeRatings.selectedMatchId)).toBe(exact);

    await hoverIdentity(page, "aggregate");
    await expect(card).toContainText("This is not one match");
    await expect(card).toContainText("Chronological width is the bin span");
    // A distinct exact identity supplies B through the same disclosure action.
    // Try several visible records because adjacent team matches can share the
    // same first participant and therefore intentionally resolve to one scope.
    const candidates = await page.evaluate((locked) => {
      const r = (window as any).__kayfabeRatings, layout = r.currentLayout;
      return Array.from(layout.opacity)
        .map((v: number, i: number) => v > .7 && layout.matchIds[i] !== locked ? layout.matchIds[i] : null)
        .filter(Boolean)
        .slice(0, 16);
    }, exact);
    const compare = page.getByRole("button", { name: "C · Compare A/B", exact: true });
    for (const candidate of candidates) {
      await page.evaluate((id) => (window as any).__kayfabeRatings.hover.enterSurface("keyboard", id), candidate);
      await expect(card.getByRole("button", { name: "Set B" })).toBeVisible();
      await card.getByRole("button", { name: "Set B" }).click();
      if (!await compare.isDisabled()) break;
    }
    await expect(compare).toBeEnabled();
    await compare.click();
    await settled(page, "compare");
    await expect(page.getByLabel("Comparison summary")).toContainText("Absolute-scale comparison");
  });

  test("cold and warm versioned rating URLs restore a real promotion scope, lock, and threshold", async ({ page, browser, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop URL journey");
    await boot(page);
    await openRatings(page);
    const promotion = await scopeFromPromotionControl(page);
    await chooseSearch(page, promotion.name);
    await settled(page, "promotion");
    const list = page.getByRole("listbox", { name: /Rated matches in/ });
    await list.getByRole("option").first().click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.getByRole("button", { name: "4.5★+", exact: true }).click();
    await page.waitForTimeout(220); // URL writer is deliberately debounced.
    const warm = page.url();
    expect(warm).toContain("rtv=1");
    expect(warm).toContain("rtm=promotion");
    expect(warm).toContain("rtid=");
    const coldContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const coldPage = await coldContext.newPage();
      await coldPage.goto(warm);
      await expect(coldPage.getByTestId("ratings-canvas")).toBeVisible({ timeout: 40_000 });
      await settled(coldPage, "promotion");
      await expect(coldPage.getByLabel("Ratings inspector")).toContainText("Locked match");
      await expect(coldPage.getByRole("spinbutton", { name: "Minimum reported rating" })).toHaveValue("4.5");
    } finally {
      await coldContext.close();
    }

    const second = new URL(warm);
    second.hash = second.hash.replace(/rtmin=[^/]+/, "rtmin=5").replace(/\/rtid=[^/]+/, "");
    // Same-document hash replacement is the warm-paste contract. It must not
    // be overwritten by the URL writer from the first ratings state.
    await page.evaluate((hash) => { location.hash = hash; }, second.hash);
    await settled(page, "promotion");
    await expect(page.getByRole("spinbutton", { name: "Minimum reported rating" })).toHaveValue("5");
    await expect(page.getByLabel("Ratings inspector")).toContainText("Select a peak or a row");
  });

  test("five rapid real-promotion retargets settle on the fifth scope", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop retarget cancellation journey");
    await boot(page);
    await openRatings(page);
    const names = await page.locator("select").filter({ hasText: "All promotions" }).locator("option").evaluateAll((nodes) => nodes.slice(1, 6).map((node) => (node.textContent ?? "").replace(/ · \d+$/, "")));
    test.skip(names.length < 5, "current corpus did not expose five rated promotions");
    for (const name of names) await chooseSearch(page, name);
    await settled(page, "promotion", 45_000);
    await expect(page.getByLabel("Ratings inspector")).toContainText(names.at(-1)!);
    await page.waitForTimeout(500);
    await expect(page.getByLabel("Ratings inspector")).toContainText(names.at(-1)!);
  });

  test("playback advances the ratings curtain and exposes a current rated event without reading private renderer state", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop playback surface journey");
    await boot(page);
    await openRatings(page);
    await page.getByLabel("Timeline mode").selectOption("playback");
    const before = await page.evaluate(() => (window as any).__kayfabeRatings.screenshot());
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeRatings.screenshot()), { timeout: 10_000 }).not.toBe(before);
    await expect(page.locator(".pulse-readout .evt")).not.toHaveText("—", { timeout: 15_000 });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
  });

  test("ratings keyboard owns R/F/O/Space while brackets keep timeline ownership, and active screenshot is the ridge", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "animated desktop keyboard ownership journey");
    await boot(page);
    await openRatings(page);
    const list = page.getByRole("listbox", { name: /Rated matches in/ });
    await list.getByRole("option").first().click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeRatings.cam.flying)).toBe(true);
    await page.keyboard.press("r");
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeRatings.cam.flying)).toBe(true);
    await page.keyboard.press("o");
    await settled(page, "promotions");
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible({ timeout: 10_000 });
    const before = await page.locator(".pulse-readout .date").textContent();
    await page.keyboard.press("]");
    await expect.poll(() => page.locator(".pulse-readout .date").textContent()).not.toBe(before);
    await page.keyboard.press("Space");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Screenshot", exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("meltzer-ridge.png");
  });

  test("ratings lens round-trip does not mutate the parked Connectome camera", async ({ page, isMobile }) => {
    test.skip(isMobile || test.info().project.name !== "desktop", "desktop renderer ownership journey");
    await boot(page);
    await page.locator("canvas.gl").dispatchEvent("wheel", { deltaY: -180 });
    await page.waitForTimeout(100);
    const before = await camera(page);
    await openRatings(page);
    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await page.waitForFunction(() => (window as any).__kayfabeRenderer?.isActive === true);
    expect(await camera(page)).toEqual(before);
  });

  test("mobile tap opens Details for an exact peak and background tap releases the lock", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile direct-manipulation journey");
    await boot(page);
    await openRatings(page);
    await settled(page);
    const target = await page.evaluate(() => {
      const r = (window as any).__kayfabeRatings, layout = r.currentLayout;
      const usable = r.cam.usableScreenRect();
      for (let i = 0; i < layout.matchIds.length; i++) {
        if (layout.opacity[i] <= .7) continue;
        const p = r.currentPositionOfMatch(layout.matchIds[i]);
        const s = p && r.cam.worldToScreen(p[0], p[1], p[2]);
        if (!s?.front || s.x < usable.left || s.x > usable.right || s.y < usable.top || s.y > usable.bottom) continue;
        const hit = r.pick(s.x, s.y, "touch");
        if (hit?.kind === "match") return { x: s.x, y: s.y, id: hit.id };
      }
      return null;
    });
    expect(target, "no visible touch-pickable exact peak").toBeTruthy();
    if (!target) return;
    const canvas = page.getByTestId("ratings-canvas");
    await canvas.tap({ position: { x: target.x, y: target.y } });
    await expect(page.getByRole("tab", { name: "Details", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Ratings inspector")).toContainText("Locked match");
    await canvas.tap({ position: { x: 4, y: 4 } });
    await expect(page.getByLabel("Ratings inspector")).toContainText("Select a peak or a row");
  });

  test("reduced motion lands scope changes without a transient ridge morph", async ({ page }) => {
    test.skip(test.info().project.name !== "reduced-motion", "reduced-motion contract");
    await boot(page);
    await openRatings(page);
    await chooseSearch(page, "The Undertaker");
    await settled(page, "career");
    expect(await page.evaluate(() => (window as any).__kayfabeRatings.morphing)).toBe(false);
  });
});
