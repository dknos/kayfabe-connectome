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
    await expect(page.getByText("KAYFABE CONNECTOME").first()).toBeVisible();
    // boot must finish against real materialized data
    await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 30000 });
  });

  test("mobile: search resolves, dossier bottom-sheet opens, table reachable", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-specific journey");
    const search = page.getByRole("combobox", { name: /Search/ });
    await search.fill("Undertaker");
    await page.getByRole("option").first().click({ force: true });
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Close dossier" }).click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByRole("region", { name: /People table/ })).toBeVisible();
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
    expect(url).toContain("#1/");
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
    await page.getByRole("button", { name: "Play" }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.waitForTimeout(2500);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    const errors = (page as any)._consoleErrors as string[];
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("accessible table lens is keyboard operable", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard journey runs on desktop projects");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByRole("region", { name: /People table/ })).toBeVisible();
    const firstRow = page.locator("tbody tr").first();
    await firstRow.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Connectome" })).toBeVisible();
  });
});
