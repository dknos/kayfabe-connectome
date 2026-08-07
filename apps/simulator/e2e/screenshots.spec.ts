import { test } from "@playwright/test";

/**
 * Visual inspection captures (not assertions): walks the slice and writes
 * screenshots to test-results/simulator-shots/. Run explicitly:
 *   npx playwright test -c apps/simulator/playwright.config.ts --grep screenshots
 */

const OUT = "test-results/simulator-shots";

test("screenshots", async ({ page }) => {
  await page.goto("/");
  await page.screenshot({ path: `${OUT}/01-menu.png` });

  await page.getByTestId("new-universe").click();
  await page.screenshot({ path: `${OUT}/02-wizard-date.png` });
  await page.getByTestId("wizard-build").click();
  await page.getByTestId("company-table").waitFor({ timeout: 180_000 });
  await page.screenshot({ path: `${OUT}/03-wizard-company.png` });

  await page.getByTestId("company-table").locator("tbody tr").nth(2).click();
  await page.getByTestId("world-seed").fill("shots-seed");
  await page.getByTestId("create-universe").click();
  await page.getByTestId("control-center").waitFor();
  await page.screenshot({ path: `${OUT}/04-control-center.png` });

  await page.getByRole("button", { name: "Roster" }).click();
  await page.screenshot({ path: `${OUT}/05-roster.png` });
  await page.getByTestId("roster-table").locator("tbody tr").first().click();
  await page.screenshot({ path: `${OUT}/06-person.png` });

  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByTestId("schedule-submit").click();
  await page.getByRole("button", { name: "Control Center" }).click();
  await page.getByTestId(/book-show-/).first().click();
  await page.getByTestId("add-angle").click();
  await page.getByTestId("add-match").click();
  await page.getByTestId("add-match").click();
  for (let i = 0; i < 3; i++) await page.getByTestId("auto-fill-segment").nth(i).click();
  await page.screenshot({ path: `${OUT}/07-booker.png` });

  await page.getByTestId("run-show").click();
  await page.getByTestId("live-show").waitFor();
  await page.getByTestId("live-next").click();
  await page.getByTestId("live-next").click();
  await page.screenshot({ path: `${OUT}/08-live.png` });
  await page.getByTestId("live-finish").click();
  await page.getByTestId("postshow").waitFor();
  await page.screenshot({ path: `${OUT}/09-postshow.png`, fullPage: true });

  await page.getByRole("button", { name: "Finance" }).click();
  await page.screenshot({ path: `${OUT}/10-finance.png` });

  await page.getByRole("button", { name: "Historical Almanac" }).click();
  await page.getByTestId("almanac-search").fill("Mankind");
  await page.getByTestId("almanac-result").first().waitFor({ timeout: 30_000 });
  await page.getByTestId("almanac-result").first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/11-almanac.png`, fullPage: true });

  await page.getByRole("button", { name: "Championships" }).click();
  await page.screenshot({ path: `${OUT}/12-titles.png` });
});
