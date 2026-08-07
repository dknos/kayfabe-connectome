import { expect, test, type Page } from "@playwright/test";

/**
 * Founder journey: start a promotion from nothing, hire free agents off the
 * real 1997 market, create a championship, and run night one.
 */

async function hireCheapFreeAgent(page: Page, nthFromBottom: number): Promise<void> {
  await page.getByRole("button", { name: "Talent Market" }).click();
  const rows = page.locator('[data-testid^="market-row-"]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(10);
  // Cheap end of the market: rows sort by awareness descending.
  await rows.nth(count - 1 - nthFromBottom).click();
  await expect(page.getByTestId("person-profile")).toBeVisible();
  await page.getByTestId("offer-open").click();
  await page.getByTestId("offer-downside").fill("5000");
  await page.getByTestId("offer-length").fill("24");
  await page.getByTestId("offer-submit").click();
  await expect(page.getByTestId("offer-outcome")).toBeVisible();
  const outcome = page.getByTestId("offer-outcome");
  if (!(await outcome.textContent())?.includes("Deal")) {
    // They countered — an overwhelming offer for the cheap end should not
    // happen often, but accepting the counter is the honest fallback.
    await page.getByRole("button", { name: "Accept their terms" }).click();
    await expect(page.getByTestId("offer-outcome")).toContainText("Deal");
  }
}

test("found an indy, hire the market, crown a champion, run night one", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("new-universe").click();
  await page.getByTestId("wizard-build").click();
  await expect(page.getByTestId("company-table")).toBeVisible({ timeout: 180_000 });

  // Found our own instead of taking over.
  await page.getByTestId("mode-found").click();
  await page.getByTestId("found-name").fill("Keystone Championship Wrestling");
  await page.getByTestId("found-short").fill("KCW");
  await page.getByRole("radio", { name: "Bankrolled" }).check();
  await page.getByTestId("world-seed").fill("founder-e2e-seed");
  await page.getByTestId("create-universe").click();
  await expect(page.getByTestId("control-center")).toBeVisible();
  await expect(page.getByTestId("company-cash")).toHaveText("$1,000,000.00");

  // An empty roster and a live market.
  await page.getByRole("button", { name: "Roster" }).click();
  await expect(page.getByText("0 under contract")).toBeVisible();
  await hireCheapFreeAgent(page, 0);
  await hireCheapFreeAgent(page, 1);
  await page.getByRole("button", { name: "Contracts" }).click();
  expect(await page.getByTestId("contracts-table").locator("tbody tr").count()).toBe(2);

  // A belt of our own.
  await page.getByRole("button", { name: "Championships" }).click();
  await page.getByTestId("title-name").fill("KCW World Championship");
  await page.getByTestId("title-create").click();
  await expect(page.getByText("KCW World Championship").first()).toBeVisible();

  // Night one at the home athletic club.
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByTestId("schedule-name").fill("KCW Night One");
  await page.getByTestId("schedule-submit").click();
  await page.getByRole("button", { name: "Control Center" }).click();
  await page.getByTestId(/book-show-/).first().click();
  await expect(page.getByTestId("booker-board")).toBeVisible();
  await page.getByTestId("add-match").click();
  await page.getByTestId("auto-fill-segment").first().click();
  await expect(page.getByTestId("card-valid")).toBeVisible();
  await page.getByTestId("run-show").click();
  await expect(page.getByTestId("live-show")).toBeVisible();
  await page.getByTestId("live-finish").click();
  await expect(page.getByTestId("postshow")).toBeVisible();
  await expect(page.getByTestId("show-grade")).toBeVisible();

  // The night entered the books.
  await page.getByRole("button", { name: "Finance" }).click();
  await expect(page.getByTestId("finance-ledger").locator("tbody tr").first()).toBeVisible();
});
