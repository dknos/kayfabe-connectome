import { expect, test, type Page } from "@playwright/test";

const root = () => process.env.KAYFABE_BASE_URL ?? "/";

async function boot(page: Page): Promise<void> {
  await page.goto(root());
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40_000 });
  await page.waitForFunction(() => (window as any).__kayfabeRenderer?.isActive === true);
}

async function openRatings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Meltzer Ratings", exact: true }).click();
  await expect(page.getByTestId("ratings-canvas")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__kayfabeRatings?.currentLayout != null, undefined, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => {
    const renderer = (window as any).__kayfabeRatings;
    return Boolean(renderer && !renderer.morphing);
  }), { timeout: 30_000 }).toBe(true);
}

test.describe("Meltzer Ratings resilience", () => {
  test.slow();
  test.beforeEach(() => test.skip(test.info().project.name !== "desktop", "one desktop WebGL lifecycle pass is sufficient"));

  test("secondary renderer creation failure is visible and Retry recovers", async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const proto = HTMLCanvasElement.prototype as any;
      (window as any).__qaRatingsGetContext = proto.getContext;
      proto.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (this.classList.contains("ratings-gl") && kind.startsWith("webgl")) return null;
        return (window as any).__qaRatingsGetContext.call(this, kind, ...args);
      };
    });
    await page.getByRole("button", { name: "Meltzer Ratings", exact: true }).click();
    const fallback = page.getByRole("alert").filter({ hasText: "MELTZER RIDGE" });
    await expect(fallback).toBeVisible({ timeout: 30_000 });
    await expect(fallback.getByRole("button", { name: "Retry renderer" })).toBeVisible();
    expect(await page.evaluate(() => Boolean((window as any).__kayfabeRatings))).toBe(false);

    await page.evaluate(() => {
      HTMLCanvasElement.prototype.getContext = (window as any).__qaRatingsGetContext;
    });
    await fallback.getByRole("button", { name: "Retry renderer" }).click();
    await page.waitForFunction(() => (window as any).__kayfabeRatings?.currentLayout != null, undefined, { timeout: 30_000 });
    await expect(fallback).toHaveCount(0);
  });

  test("a real WEBGL_lose_context cycle restores the same rating layout", async ({ page }) => {
    await boot(page);
    await openRatings(page);
    // Pin the adaptive tier so a legitimate SwiftShader downgrade cannot be
    // mistaken for context-restore nondeterminism while this assertion runs.
    await page.evaluate(() => (window as any).__kayfabeRatings.setQualityOverride("low"));
    await expect.poll(() => page.evaluate(() => {
      const renderer = (window as any).__kayfabeRatings;
      return renderer?.qualityTier === "low" && !renderer.morphing;
    }), { timeout: 20_000 }).toBe(true);
    const before = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeRatings;
      const extension = renderer.gl.getContext().getExtension("WEBGL_lose_context");
      (window as any).__qaRatingsLoseContext = extension;
      return { supported: Boolean(extension), mode: renderer.mode, ids: Array.from(renderer.currentLayout.matchIds), lanes: renderer.currentLayout.lanes.length };
    });
    test.skip(!before.supported, "WEBGL_lose_context is unavailable in this browser/GPU");
    await page.evaluate(() => (window as any).__qaRatingsLoseContext.loseContext());
    await expect(page.getByRole("status").filter({ hasText: "Graphics context paused" })).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => (window as any).__qaRatingsLoseContext.restoreContext());
    await expect(page.getByRole("status").filter({ hasText: "Graphics context paused" })).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => {
      const renderer = (window as any).__kayfabeRatings;
      return renderer && !renderer.morphing ? { mode: renderer.mode, ids: Array.from(renderer.currentLayout.matchIds), lanes: renderer.currentLayout.lanes.length } : null;
    }), { timeout: 30_000 }).toEqual({ mode: before.mode, ids: before.ids, lanes: before.lanes });
  });

  test("lens ownership parks Connectome and releases the ratings renderer on return", async ({ page }) => {
    await boot(page);
    await openRatings(page);
    expect(await page.evaluate(() => (window as any).__kayfabeRenderer.isActive)).toBe(false);
    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await page.waitForFunction(() => (window as any).__kayfabeRenderer?.isActive === true);
    expect(await page.evaluate(() => Boolean((window as any).__kayfabeRatings))).toBe(false);
    await openRatings(page);
  });
});
