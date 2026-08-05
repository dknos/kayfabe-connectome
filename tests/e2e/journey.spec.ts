import { expect, test } from "@playwright/test";

test.describe("vertical slice journey", () => {
  // merged corpus (365k matches, ~28MB core data) served to three parallel
  // browser projects from one dev server — the v1 60s budget starves boots
  test.slow();

  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    (page as any)._consoleErrors = errors;
    await page.goto("/");
    // The wordmark intentionally yields its scarce width to search/navigation
    // on phones; the search instrument is the stable visible boot landmark.
    await expect(page.getByRole("combobox", { name: /Search/ })).toBeVisible();
    // boot must finish against real materialized data
    await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 30000 });
  });

  test("mobile: search resolves and semantic inspector bottom-sheet opens", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-specific journey");
    const search = page.getByRole("combobox", { name: /Search/ });
    await search.fill("Undertaker");
    await page.getByRole("option").first().click({ force: true });
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("complementary", { name: "Semantic inspector" })).toBeVisible();
    await page.getByRole("button", { name: "Close dossier" }).click();
    // FIVE lenses since Arena Array shipped. This assertion said 4 and had been
    // failing on mobile ever since — corrected rather than relaxed, and the
    // fifth lens is named so the count cannot drift again without saying which.
    const lenses = page.getByRole("group", { name: "Lens" }).getByRole("button");
    await expect(lenses).toHaveCount(5);
    await expect(page.getByRole("button", { name: "Arena Array", exact: true })).toBeVisible();
    // All five have to be genuinely reachable, not merely present: no
    // horizontal document overflow, and touch targets at the 44px minimum.
    const nav = await page.evaluate(() => {
      const group = document.querySelector('[role="group"][aria-label="Lens"]');
      const buttons = [...group!.querySelectorAll("button")];
      return {
        overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        minHeight: Math.min(...buttons.map((b) => b.getBoundingClientRect().height)),
        hidden: buttons.filter((b) => b.getBoundingClientRect().width === 0).length,
      };
    });
    expect(nav.overflows).toBe(false);
    expect(nav.hidden).toBe(0);
    expect(nav.minHeight).toBeGreaterThanOrEqual(44);
    await expect(page.getByRole("button", { name: "Meltzer Ratings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Atlas", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Table", exact: true })).toHaveCount(0);
  });

  test("search → focus → dossier → evidence → path → share → restore", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordances (left panel, hover)");
    // 1. alias-aware search resolves a canonical person
    const search = page.getByRole("combobox", { name: /Search/ });
    await search.fill("Undertaker");
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible();
    const chosenName = await option.textContent();
    await option.click({ force: true });

    // 2. person dossier opens with stats and evidence-backed links
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("first known record")).toBeVisible();

    // 3. open a relationship dossier from strongest links
    await page.getByText("open evidence").first().click();
    await expect(page.getByText("Relationship dossier")).toBeVisible();
    await expect(page.getByText("Supporting records")).toBeVisible();
    // evidence rows are real match records with dates
    await expect(page.locator(".evidence .ev-row").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("data-quality defect")).toHaveCount(0);

    // 4. derivation rule is explained, not implied
    await expect(page.getByText(/never within multi-way loser groups/)).toBeVisible();

    // 5. path endpoints via dossiers
    await page.getByRole("button", { name: chosenName?.replace(/person|·.*$/g, "").trim().slice(0, 12) ?? "A" }).first().click();
    await expect(page.getByText("Person dossier")).toBeVisible();
    await page.getByRole("button", { name: "Path A", exact: true }).click();
    await search.fill("Hulk Hogan");
    await page.getByRole("option").first().click({ force: true });
    await expect(page.getByText("Person dossier")).toBeVisible();
    await page.getByRole("button", { name: "Path B", exact: true }).click();
    await page.getByRole("button", { name: "Find path" }).click();
    await expect(page.locator(".derivation-note").getByText("→")).toBeVisible();

    // 6. share URL restores state
    const url = page.url();
    expect(url).toContain("#2/");
    await page.goto(url);
    await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 15000 });

    const errors = (page as any)._consoleErrors as string[];
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("date filter recomputes from records; empty state is honest", async ({ page, isMobile }) => {
    test.skip(isMobile, "filter rail is a desktop affordance in v1");
    const y0 = page.getByLabel("Years");
    await y0.fill("1985");
    const y1 = page.getByLabel("End year", { exact: true });
    await y1.fill("1992");
    await expect(page.getByText("record-accurate range")).toBeVisible({ timeout: 30000 });
    // counts carry locale separators at merged-corpus scale ("2,600 relationships")
    await expect(page.getByText(/[\d,]+ entities · [\d,]+ relationships/)).toBeVisible();
  });

  test("timeline playback fires and pauses", async ({ page }) => {
    await page.getByLabel("Timeline mode").selectOption("playback");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    const errors = (page as any)._consoleErrors as string[];
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("semantic inspector and in-context results are keyboard operable", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard journey runs on desktop projects");
    const search = page.getByRole("combobox", { name: /Search/ });
    await search.focus();
    await search.fill("Ric Flair");
    await expect(page.getByRole("listbox", { name: "Corpus search results" })).toBeVisible();
    await expect(page.getByRole("option").first()).toBeVisible();
    await search.press("Enter");
    const inspector = page.getByRole("complementary", { name: "Semantic inspector" });
    await expect(inspector).toBeVisible({ timeout: 15000 });
    await expect(inspector.getByText("Person dossier")).toBeVisible();
    await expect(inspector.getByTestId("lit-basis")).toBeVisible();
  });

  test("removed lens URLs migrate without restoring dead views", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one migration pass is sufficient");
    const migrations = [
      ["atlas", "morph"],
      ["table", "connectome"],
      ["geoTable", "geo"],
    ] as const;
    for (const [legacy, expected] of migrations) {
      await page.goto(`/#2/lens=${legacy}`);
      await expect(page.locator(".app")).toHaveAttribute("data-lens", expected, { timeout: 90000 });
      await expect(page.getByRole("group", { name: "Lens" }).getByRole("button")).toHaveCount(5);
      await expect(page.getByRole("button", { name: "Meltzer Ratings", exact: true })).toBeVisible();
    }
  });
});
