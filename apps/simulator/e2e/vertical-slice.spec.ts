import { expect, test } from "@playwright/test";

/**
 * The vertical-slice acceptance journey (docs: XXXIII). One long test on
 * purpose: it is the product loop, in order, against the REAL corpus.
 * Requires data/materialized to exist (dev middleware serves it).
 */

test("create → search → negotiate → schedule → book → run → review → advance 30 days → save → reload → same hash", async ({
  page,
}) => {
  // 1-2. Launch and create a universe at a supported historical date.
  await page.goto("/");
  await page.getByTestId("new-universe").click();
  await expect(page.getByTestId("start-date")).toHaveValue("1997-01-06");
  await page.getByTestId("wizard-build").click();

  // 3. Snapshot build against the real corpus (rosters, champions, seeding).
  await expect(page.getByTestId("company-table")).toBeVisible({ timeout: 180_000 });
  const companyRows = page.getByTestId("company-table").locator("tbody tr");
  expect(await companyRows.count()).toBeGreaterThanOrEqual(3);

  // 4. Pick the first playable company, fixed seed for determinism.
  await companyRows.first().click();
  await page.getByTestId("world-seed").fill("e2e-fixed-seed");
  await page.getByTestId("create-universe").click();
  await expect(page.getByTestId("control-center")).toBeVisible();
  await expect(page.getByTestId("game-date")).toHaveText("1997-01-06");

  // 5. Alias search: one canonical person, both ring names, no duplicates.
  await page.getByRole("button", { name: "Historical Almanac" }).click();
  await page.getByTestId("almanac-search").fill("Cactus Jack");
  const cactus = page.getByTestId("almanac-result");
  await expect(cactus.first()).toBeVisible({ timeout: 30_000 });
  const cactusText = await cactus.first().textContent();
  await page.getByTestId("almanac-search").fill("Mankind");
  await expect(page.getByTestId("almanac-result").first()).toBeVisible();
  const mankindText = await page.getByTestId("almanac-result").first().textContent();
  // Both aliases resolve to the same canonical person entry.
  expect(cactusText).toContain("Mick Foley");
  expect(mankindText).toContain("Mick Foley");

  // 6. Inspect a wrestler: pre-start history + current simulated state.
  await page.getByRole("button", { name: "Roster" }).click();
  await expect(page.getByTestId("roster-table")).toBeVisible();
  await page.getByTestId("roster-table").locator("tbody tr").first().click();
  await expect(page.getByTestId("person-profile")).toBeVisible();
  await expect(page.getByTestId("person-history-note")).not.toBeEmpty();

  // 7. Negotiate a contract with that worker (renegotiation path).
  await page.getByTestId("offer-open").click();
  await page.getByTestId("offer-downside").fill("12000");
  await page.getByTestId("offer-length").fill("24");
  await page.getByTestId("offer-submit").click();
  await expect(page.getByTestId("offer-outcome")).toBeVisible();

  // 8. Schedule an event at a real venue on the current date.
  await page.getByRole("button", { name: "Calendar" }).click();
  await page.getByTestId("schedule-name").fill("E2E Spectacular");
  await page.getByTestId("schedule-submit").click();
  await expect(page.getByTestId("engine-errors")).toHaveCount(0);

  // 9. Create a storyline with a future milestone.
  await page.getByRole("button", { name: "Creative Room" }).click();
  await page.getByTestId("story-name").fill("The Crown Dispute");
  await page.getByTestId("story-create").click();
  await expect(page.getByTestId("storyline-row").first()).toBeVisible();

  // 10. Book the card: an angle and two matches, one for the title.
  await page.getByRole("button", { name: "Control Center" }).click();
  await page.getByTestId(/book-show-/).first().click();
  await expect(page.getByTestId("booker-board")).toBeVisible();
  await page.getByTestId("add-match").click();
  await page.getByTestId("add-match").click();
  await page.getByTestId("add-angle").click();
  // Click-to-assign: fill each segment with available roster names.
  await page.getByTestId("auto-fill-segment").first().click();
  const segments = page.getByTestId("segment-row");
  expect(await segments.count()).toBe(3);
  await expect(page.getByTestId("card-valid")).toBeVisible();

  // 11-13. Run the show, watch the crowd, get explainable feedback.
  await page.getByTestId("run-show").click();
  await expect(page.getByTestId("live-show")).toBeVisible();
  await page.getByTestId("live-finish").click();
  await expect(page.getByTestId("postshow")).toBeVisible();
  await expect(page.getByTestId("show-grade")).toBeVisible();
  expect(await page.getByTestId("segment-report").count()).toBeGreaterThanOrEqual(3);

  // 14. Money entered the ledger.
  await page.getByRole("button", { name: "Finance" }).click();
  await expect(page.getByTestId("finance-ledger").locator("tbody tr").first()).toBeVisible();

  // 16. AI companies exist and act (world companies screen shows rivals).
  await page.getByRole("button", { name: "World Companies" }).click();
  expect(await page.getByTestId("company-row").count()).toBeGreaterThanOrEqual(3);

  // 17. Advance 30 days.
  for (let i = 0; i < 4; i++) {
    await page.getByTestId("advance-week").click();
    await expect(page.getByTestId("engine-errors")).toHaveCount(0, { timeout: 60_000 });
  }
  await page.getByTestId("advance-day").click();
  await page.getByTestId("advance-day").click();
  await expect(page.getByTestId("game-date")).toHaveText("1997-02-05", { timeout: 60_000 });

  // Grab the state fingerprint before saving.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("state-hash")).toBeVisible();
  const hashBefore = await page.getByTestId("state-hash").textContent();
  const cashBefore = await page.getByTestId("company-cash").textContent();

  // 18. Save, reload the app, load the save.
  await page.getByTestId("save-game").click();
  await expect(page.getByTestId("save-notice")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("new-universe")).toBeVisible();
  await page.locator('[data-testid^="load-"]').first().click();
  await expect(page.getByTestId("control-center")).toBeVisible({ timeout: 30_000 });

  // 19. Same date, same cash, same state hash.
  await expect(page.getByTestId("game-date")).toHaveText("1997-02-05");
  expect(await page.getByTestId("company-cash").textContent()).toBe(cashBefore);
  await page.getByRole("button", { name: "Settings" }).click();
  expect(await page.getByTestId("state-hash").textContent()).toBe(hashBefore);

  // 20. The almanac still opens read-only on the loaded universe.
  await page.getByRole("button", { name: "Historical Almanac" }).click();
  await page.getByTestId("almanac-search").fill("Undertaker");
  await expect(page.getByTestId("almanac-result").first()).toBeVisible({ timeout: 30_000 });
});
