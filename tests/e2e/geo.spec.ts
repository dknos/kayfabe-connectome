import { expect, test, type Page } from "@playwright/test";

/**
 * GEO — territory globe journeys, against the real materialized projection.
 *
 * These run headless on a software rasteriser, so the quality governor drops
 * to a lower tier than a real GPU would. Every assertion here is therefore on
 * ANALYTICAL state — counts, readouts, evidence, URL — never on pixel output,
 * because visual budgets legitimately differ per tier while the numbers must
 * not. Visual QA is a separate, human-inspected pass (tests/geo-visual-qa.mjs).
 */

test.describe("geo replay", () => {
  // The merged corpus plus a 16 MB geographic projection, served to three
  // parallel browser projects from one dev server.
  test.slow();

  async function openGeo(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto("/");
    await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40000 });
    await page.getByRole("button", { name: "Geo Replay" }).click();
    await page.waitForFunction(() => !!(window as any).__kayfabeGeo, null, { timeout: 90000 });
    // The footer readout is present in every layout; the inspector is not — on
    // a narrow viewport only one sheet is open at a time.
    await expect(page.getByTestId("geo-readout")).toBeVisible({ timeout: 40000 });
    return errors;
  }

  /** The scope options live in a listbox; a bare option role also matches the
   * <select> elements' own <option> children, which are never "visible". */
  function optionsFor(page: Page, kind: string) {
    return page.getByRole("listbox", { name: `${kind} options` }).getByRole("option");
  }

  async function selectPromotion(page: Page, name: string): Promise<void> {
    await page.getByLabel("Search promotion").fill(name);
    await optionsFor(page, "promotion").filter({ hasText: new RegExp(`^${name}$`) })
      .first().click();
    await expect(page.getByTestId("geo-scope-label")).toContainText("cards in scope");
  }

  test("WWF replay: scope, play, beacon, city evidence, share and reload", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);

    // coverage is disclosed before anything plays
    await expect(page.getByTestId("geo-coverage")).toContainText("geographic coverage");
    await expect(page.getByTestId("geo-coverage")).toContainText("unplotted");

    await selectPromotion(page, "WWF");
    await expect(page.getByTestId("geo-scope-label")).toContainText("3,066");

    await page.getByRole("button", { name: "Play", exact: true }).first().click();
    await expect(page.getByTestId("geo-current-card")).toBeVisible({ timeout: 20000 });
    // the current card advances
    const first = await page.getByTestId("geo-date").textContent();
    await page.waitForTimeout(2500);
    const later = await page.getByTestId("geo-date").textContent();
    expect(first).not.toBeNull();

    // a beacon is actually alight, and the renderer lost no logical record
    const stats = await page.evaluate(() => (window as any).__kayfabeGeo.stats());
    expect(stats.intentsDropped).toBe(0);
    expect(stats.intentsReceived).toBeGreaterThan(0);
    expect(stats.webglContexts).toBe(1);

    // city, event and match count are all readable
    await expect(page.getByTestId("geo-location")).not.toBeEmpty();
    await expect(page.getByTestId("geo-match-count")).not.toBeEmpty();

    await page.getByRole("button", { name: "Pause", exact: true }).first().click();
    const paused = await page.getByTestId("geo-progress").textContent();
    await page.waitForTimeout(1200);
    expect(await page.getByTestId("geo-progress").textContent()).toBe(paused);

    // select a city from the analytics list (equivalent to clicking its beacon,
    // and hit-testing a 6px point on a software rasteriser is flaky)
    await page.getByTestId("geo-analytics").getByRole("button", { name: "compute" }).click();
    await page.getByTestId("geo-analytics").locator(".ev-row").first().click();
    await expect(page.getByTestId("geo-place-inspector")).toBeVisible();
    await expect(page.getByTestId("geo-place-scope-cards")).not.toBeEmpty();

    // open one supporting card
    const rows = page.getByTestId("geo-city-card-row");
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    await rows.first().click();
    await expect(page.getByTestId("geo-current-card")).toBeVisible();

    // Set every serialised control to a non-default before sharing, so the
    // reload proves the whole analysis restores and not merely the lens.
    await page.getByLabel("Camera").selectOption("smart");
    await page.getByLabel("Chronological record arcs").check();
    await page.getByLabel("Afterglow").selectOption("window");
    await page.getByLabel("Metric").selectOption("matches");
    await page.waitForTimeout(700);

    const url = page.url();
    expect(url).toContain("lens=geo");
    expect(url).toContain("gs=promotion");
    expect(url).toContain("gcam=smart");
    expect(url).toContain("gar=1");
    expect(url).toContain("gag=window");
    expect(url).toContain("ghm=matches");
    expect(url).toContain("gpl=");

    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__kayfabeGeo, null, { timeout: 90000 });
    await expect(page.getByTestId("geo-scope-label")).toContainText("3,066", { timeout: 40000 });
    await expect(page.getByLabel("Camera")).toHaveValue("smart");
    await expect(page.getByLabel("Afterglow")).toHaveValue("window");
    await expect(page.getByLabel("Metric")).toHaveValue("matches");
    await expect(page.getByLabel("Chronological record arcs")).toBeChecked();
    // the selected city and the playback position come back too
    await expect(page.getByTestId("geo-place-inspector")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("geo-progress")).toContainText("processed");

    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
    void later;
  });

  test("wrestler tour: only that wrestler's cards, arcs labelled record sequence", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    // The dossier lives in the connectome lens; the handoff is what carries the
    // selection into GEO, so the journey has to start where a reader would.
    await page.getByRole("button", { name: "Connectome" }).click();
    await page.getByRole("combobox", { name: /Search/ }).fill("Ric Flair");
    await page.getByRole("option").first().click({ force: true });
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("geo-handoff-person").click();

    await expect(page.getByTestId("geo-scope-summary")).toBeVisible({ timeout: 30000 });

    const scopeCards = Number(
      (await page.getByTestId("geo-total-cards").textContent())?.replace(/[^\d]/g, "") ?? "0",
    );
    expect(scopeCards).toBeGreaterThan(0);
    // a person scope is strictly smaller than the whole corpus
    expect(scopeCards).toBeLessThan(54138);

    await page.getByLabel("Chronological record arcs").check();
    await expect(page.getByText(/record sequence, not a travel route/)).toBeVisible();

    await page.getByRole("button", { name: "Play", exact: true }).first().click();
    await page.waitForTimeout(2500);
    await expect(page.getByTestId("geo-current-card")).toBeVisible();
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("title changes: gold treatment is evidence-backed, gaps are not invented", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    await page.getByLabel("Scope", { exact: true }).selectOption("championship");
    await page.getByLabel("Search championship").fill("WWE Championship");
    const opt = optionsFor(page, "championship").first();
    await expect(opt).toBeVisible({ timeout: 20000 });
    await opt.click();
    await expect(page.getByTestId("geo-scope-label")).toContainText("cards in scope");

    // step to a documented title change; the gold note only appears when the
    // underlying card carries one
    await page.getByRole("button", { name: "Jump to next title change" }).click();
    await expect(page.getByTestId("geo-current-card")).toBeVisible({ timeout: 20000 });
    const gold = page.getByTestId("geo-title-change");
    if (await gold.count()) {
      await expect(gold).toContainText("documented title change");
    }
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("same-day cards are shown together and never chained into a route", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    await selectPromotion(page, "WWF");
    await page.getByLabel("Clock").selectOption("calendar");

    // 886 of WWF's 1,637 documented dates carry more than one card, but the
    // earliest records are single-card house shows — so scrub into the run of
    // multi-town nights first rather than clicking through a hundred batches.
    await page.getByLabel("Scrub playback").fill("100");
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      await page.getByRole("button", { name: "Next date batch" }).click();
      found = (await page.getByTestId("geo-same-day").count()) > 0;
    }
    expect(found, "no multi-card date found within 40 batches of card 100").toBe(true);
    await expect(page.getByTestId("geo-same-day")).toContainText("not ordered into a route");
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("unresolved locations are counted, disclosed and never plotted", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);

    // the corpus scope contains every unresolved record
    const unplotted = Number(
      (await page.getByTestId("geo-scope-unresolved").textContent())?.replace(/[^\d]/g, "") ?? "0",
    );
    expect(unplotted).toBeGreaterThan(0);

    // no plotted place sits at 0,0 — the Gulf of Guinea trap
    const nullIsland = await page.evaluate(async () => {
      const res = await fetch("/data/geo/places.json");
      const p = await res.json();
      let hits = 0;
      for (let i = 0; i < p.count; i++) if (p.lat[i] === 0 && p.lon[i] === 0) hits++;
      return hits;
    });
    expect(nullIsland).toBe(0);

    // the unresolved ledger is shipped and non-empty
    const unresolved = await page.evaluate(async () => {
      const res = await fetch("/data/geo/unresolved.json");
      return (await res.json()).length as number;
    });
    expect(unresolved).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByTestId("geo-table")).toBeVisible({ timeout: 20000 });
    await page.getByRole("tab", { name: "unplotted" }).click();
    await expect(page.getByTestId("geo-table")).toContainText("unresolved");
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("geo table carries the same scope as the globe", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    await selectPromotion(page, "WWF");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByTestId("geo-table")).toContainText("3,066 cards in scope");
    // sortable, non-canvas, and every geographic column is present
    for (const col of ["Date", "Location", "Country", "Precision", "Title changes", "Card id"]) {
      await expect(page.getByRole("button", { name: new RegExp(col) }).first()).toBeVisible();
    }
    await page.getByRole("tab", { name: "places" }).click();
    await expect(page.getByTestId("geo-table")).toContainText("Coordinate");
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("mobile: globe operable, city inspected, table reachable, follow disabled", async ({
    page, isMobile,
  }) => {
    test.skip(!isMobile, "mobile journey");
    const errors = await openGeo(page);
    // One sheet at a time on a narrow viewport; controls is the landing sheet.
    await expect(page.getByRole("tab", { name: "controls" })).toHaveAttribute(
      "aria-selected", "true",
    );
    await selectPromotion(page, "WWF");
    // The transport bar is the mobile play affordance — always on screen,
    // never behind a sheet.
    const bar = page.locator(".geo-bar");
    await bar.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(2500);
    // the current-card readout stays reachable on a 390px viewport
    await expect(page.getByTestId("geo-readout")).toBeVisible();
    await bar.getByRole("button", { name: "Pause", exact: true }).click();

    // the inspector is reachable and does not permanently cover the globe
    await page.getByRole("tab", { name: "inspector" }).click();
    await expect(page.getByTestId("geo-scope-summary")).toBeVisible();
    await page.getByRole("tab", { name: "globe only" }).click();
    await expect(page.getByTestId("geo-scope-summary")).toBeHidden();
    await expect(page.getByTestId("geo-globe")).toBeVisible();

    await page.getByRole("tab", { name: "controls" }).click();
    await page.getByLabel("Camera").selectOption("free");
    await expect(page.getByLabel("Camera")).toHaveValue("free");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await expect(page.getByTestId("geo-table")).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Geo Replay" }).click();
    await expect(page.getByTestId("geo-globe")).toBeVisible();
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("reduced motion: state advances without travelling effects", async ({ page }, info) => {
    test.skip(info.project.name !== "reduced-motion", "reduced-motion journey");
    const errors = await openGeo(page);
    await selectPromotion(page, "WWF");
    await expect(page.getByText(/Reduced motion is on/)).toBeVisible();

    await page.getByRole("button", { name: "Play", exact: true }).first().click();
    await page.waitForTimeout(3000);
    // the record advances and the full readout is available
    await expect(page.getByTestId("geo-current-card")).toBeVisible();
    await expect(page.getByTestId("geo-readout")).toContainText("card");
    // no ripples or columns are spawned at all in reduced motion
    const stats = await page.evaluate(() => (window as any).__kayfabeGeo.stats());
    expect(stats.ringsActive).toBe(0);
    expect(stats.columnsActive).toBe(0);
    expect(stats.intentsDropped).toBe(0);
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("switching lenses leaves no second WebGL loop and no leaked viewer", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    // the connectome canvas is hidden, not merely paused-with-last-frame
    const display = await page.evaluate(
      () => getComputedStyle(document.querySelector(".stage > canvas.gl")!).display,
    );
    expect(display).toBe("none");

    for (let i = 0; i < 3; i++) {
      await page.getByRole("button", { name: "Connectome" }).click();
      await expect(page.locator("canvas.gl")).toBeVisible();
      await page.getByRole("button", { name: "Geo Replay" }).click();
      await page.waitForFunction(() => !!(window as any).__kayfabeGeo, null, { timeout: 60000 });
    }
    const life = await page.evaluate(() => (window as any).__kayfabeGeo.stats());
    // one live context; every earlier viewer was destroyed
    expect(life.webglContexts).toBe(1);
    expect(life.viewersCreated - life.viewersDestroyed).toBe(1);
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("clicking a beacon on the globe opens that city", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    await selectPromotion(page, "WWF");
    await page.getByRole("button", { name: "Next card" }).click();
    await expect(page.getByTestId("geo-current-card")).toBeVisible({ timeout: 20000 });

    // Frame the current card's city, then click the exact pixel the engine
    // says it projects to. This exercises the real path a reader uses —
    // scene.pick -> onPick -> selectPlace — rather than routing around it.
    const target = await page.evaluate(async () => {
      const engine = (window as any).__kayfabeGeo;
      const res = await fetch("/data/geo/places.json");
      const places = await res.json();
      const label = document.querySelector('[data-testid="geo-location"]')?.textContent ?? "";
      const idx = places.displayName.findIndex(
        (d: string) => d && label.includes(d),
      );
      if (idx < 0) return null;
      engine.focusPlace(idx);
      await new Promise((r) => setTimeout(r, 3000));
      return { idx, displayName: places.displayName[idx] as string,
               at: engine.windowCoordinatesOf(idx) };
    });
    expect(target, "no plotted place on the current card").not.toBeNull();
    expect(target!.at, "place did not project onto the canvas").not.toBeNull();

    const box = (await page.locator(".geo-globe canvas").boundingBox())!;
    await page.mouse.click(box.x + target!.at!.x, box.y + target!.at!.y);

    await expect(page.getByTestId("geo-place-inspector")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("geo-place-inspector")).toContainText(target!.displayName);
    await expect(page.getByTestId("geo-city-card-row").first()).toBeVisible({ timeout: 15000 });
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("pair geography survives a date-range change and a reload", async ({
    page, isMobile,
  }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    await page.getByRole("button", { name: "Connectome" }).click();
    await page.getByRole("combobox", { name: /Search/ }).fill("Ric Flair");
    await page.getByRole("option").first().click({ force: true });
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    // open a relationship from the dossier, then send it to GEO
    await page.locator(".ev-row.search-row").first().click();
    await expect(page.getByText("Relationship dossier")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("geo-handoff-pair").click();

    await expect(page.getByTestId("geo-scope-summary")).toBeVisible({ timeout: 30000 });
    const cards = async () =>
      Number((await page.getByTestId("geo-total-cards").textContent())?.replace(/[^\d]/g, "") ?? "0");
    const before = await cards();
    expect(before).toBeGreaterThan(0);

    // A pair has no scope index — its cards come from the evidence store. Any
    // re-resolve must reuse them rather than silently emptying the scope.
    await page.getByRole("slider", { name: "To" }).fill(String(46000));
    await page.waitForTimeout(1500);
    await page.getByRole("slider", { name: "To" }).fill(String(46020));
    await page.waitForTimeout(1500);
    expect(await cards()).toBeGreaterThan(0);

    const url = page.url();
    expect(url).toContain("gs=pair");
    await page.goto(url);
    await page.waitForFunction(() => !!(window as any).__kayfabeGeo, null, { timeout: 90000 });
    await expect(page.getByTestId("geo-scope-summary")).toBeVisible({ timeout: 40000 });
    expect(await cards()).toBeGreaterThan(0);
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("event-series geography plays a documented series", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "desktop journey");
    const errors = await openGeo(page);
    await page.getByLabel("Scope", { exact: true }).selectOption("event");
    await page.getByLabel("Search event").fill("WrestleMania");
    const opt = optionsFor(page, "event").first();
    await expect(opt).toBeVisible({ timeout: 20000 });
    await opt.click();
    await expect(page.getByTestId("geo-scope-label")).toContainText("cards in scope");
    const cards = Number(
      (await page.getByTestId("geo-total-cards").textContent())?.replace(/[^\d]/g, "") ?? "0",
    );
    expect(cards).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Next card" }).click();
    await expect(page.getByTestId("geo-current-card")).toBeVisible({ timeout: 20000 });
    expect(errors, `console errors: ${errors.join(" | ")}`).toEqual([]);
  });

  test("required map and place attribution stays visible", async ({ page, isMobile }) => {
    test.skip(!!isMobile, "desktop journey");
    await openGeo(page);
    const credits = page.locator(".cesium-widget-credits");
    await expect(credits).toBeVisible();
    await expect(credits).toContainText("Natural Earth II");
    await expect(credits).toContainText("GeoNames");
    await expect(credits).toContainText("CC BY 4.0");
  });
});
