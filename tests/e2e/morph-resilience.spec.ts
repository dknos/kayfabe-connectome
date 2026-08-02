import { expect, test, type Page } from "@playwright/test";

/**
 * Failure-mode and ownership tests for Morph Lab.
 *
 * These stay separate from the long visual journeys so a renderer lifecycle
 * regression fails with a small, actionable trace. The tests intentionally
 * use the same read-only window seams as morph.spec.ts; no test-only product
 * behavior is installed.
 */

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40_000 });
  await page.waitForFunction(() => (window as any).__kayfabeRenderer?.isActive === true);
}

async function openMorph(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Morph Lab", exact: true }).click();
  await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => (window as any).__kayfabeMorph?.currentLayout != null,
    undefined,
    { timeout: 30_000 },
  );
}

async function settledIn(page: Page, mode: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const renderer = (window as any).__kayfabeMorph;
          if (!renderer) return "missing";
          return `${renderer.mode}:${renderer.morphing ? "moving" : "settled"}`;
        }),
      { timeout },
    )
    .toBe(`${mode}:settled`);
}

async function chooseSearchResult(page: Page, name: string): Promise<void> {
  const input = page.getByRole("combobox", { name: /Search people/ });
  await input.fill("");
  await input.fill(name);
  const result = page
    .locator(".search-pop [role=option]")
    .filter({ hasText: name })
    .first();
  await expect(result).toBeVisible({ timeout: 10_000 });
  await result.click({ force: true });
}

const connectomeCamera = (page: Page) =>
  page.evaluate(() => {
    const renderer = (window as any).__kayfabeRenderer;
    const controller = renderer.cameraCtl;
    return {
      position: controller.camera.position.toArray() as number[],
      quaternion: controller.camera.quaternion.toArray() as number[],
      target: controller.target.toArray() as number[],
      distance: renderer.cameraDistance as number,
      active: renderer.isActive as boolean,
    };
  });

test.describe("Morph Lab resilience", () => {
  test.slow();

  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop", "one desktop WebGL lifecycle pass is sufficient");
  });

  test("initial Connectome WebGL failure is visible and Retry renderer recovers", async ({ page }) => {
    await page.addInitScript(() => {
      const proto = HTMLCanvasElement.prototype as any;
      (window as any).__qaOriginalCanvasGetContext = proto.getContext;
      proto.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (this.classList.contains("gl") && kind.startsWith("webgl")) return null;
        return (window as any).__qaOriginalCanvasGetContext.call(this, kind, ...args);
      };
    });
    await page.goto("/");

    const fallback = page.getByRole("alert").filter({ hasText: "3D renderer unavailable" });
    await expect(fallback).toBeVisible({ timeout: 40_000 });
    await expect(fallback).toContainText("Connectome could not create a WebGL renderer");
    await expect(fallback.getByRole("button", { name: "Retry renderer" })).toBeVisible();
    await expect(page.locator("canvas.gl")).toBeVisible();
    expect(await page.evaluate(() => Boolean((window as any).__kayfabeRenderer))).toBe(false);

    await page.evaluate(() => {
      const original = (window as any).__qaOriginalCanvasGetContext;
      if (original) HTMLCanvasElement.prototype.getContext = original;
    });
    await fallback.getByRole("button", { name: "Retry renderer" }).click();

    await page.waitForFunction(() => (window as any).__kayfabeRenderer?.isActive === true, undefined, {
      timeout: 30_000,
    });
    await expect(fallback).toHaveCount(0);
    await expect(page.locator("canvas.gl")).toBeVisible();
  });

  test("WebGL creation failure is visible and Retry renderer recovers", async ({ page }) => {
    await boot(page);

    // Connectome already owns a healthy context. Fail only the subsequently
    // mounted Morph canvas, so this proves the secondary renderer's fallback
    // instead of replacing WebGL for the entire application.
    await page.evaluate(() => {
      const proto = HTMLCanvasElement.prototype as any;
      (window as any).__qaOriginalCanvasGetContext = proto.getContext;
      proto.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
        if (this.classList.contains("morph-gl") && kind.startsWith("webgl")) return null;
        return (window as any).__qaOriginalCanvasGetContext.call(this, kind, ...args);
      };
    });

    await page.getByRole("button", { name: "Morph Lab", exact: true }).click();
    const fallback = page.getByRole("alert").filter({ hasText: "3D renderer unavailable" });
    await expect(fallback).toBeVisible({ timeout: 30_000 });
    await expect(fallback).toContainText("Morph Lab could not create a WebGL renderer");
    await expect(fallback.getByRole("button", { name: "Retry renderer" })).toBeVisible();
    await expect(page.locator("canvas.morph-gl")).toBeVisible();
    expect(await page.evaluate(() => Boolean((window as any).__kayfabeMorph))).toBe(false);

    await page.evaluate(() => {
      const original = (window as any).__qaOriginalCanvasGetContext;
      if (original) HTMLCanvasElement.prototype.getContext = original;
    });
    await fallback.getByRole("button", { name: "Retry renderer" }).click();

    await page.waitForFunction(
      () => (window as any).__kayfabeMorph?.currentLayout != null,
      undefined,
      { timeout: 30_000 },
    );
    await expect(fallback).toHaveCount(0);
    await settledIn(page, "organic");
  });

  test("a real WEBGL_lose_context cycle reports loss and restores the layout", async ({ page }) => {
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    const supported = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const extension = renderer.gl.getContext().getExtension("WEBGL_lose_context");
      (window as any).__qaLoseContext = extension;
      return Boolean(extension);
    });
    test.skip(!supported, "WEBGL_lose_context is unavailable in this browser/GPU");

    const before = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      return {
        mode: renderer.mode as string,
        anchorId: renderer.currentLayout.anchorId as string | null,
        nodeCount: renderer.currentLayout.nodeTargets.length / 3,
      };
    });

    await page.evaluate(() => (window as any).__qaLoseContext.loseContext());
    const lost = page.getByRole("status").filter({ hasText: "Graphics context lost" });
    await expect(lost).toBeVisible({ timeout: 10_000 });
    await expect(lost).toContainText("Waiting for the GPU context to restore");

    await page.evaluate(() => (window as any).__qaLoseContext.restoreContext());
    await expect(lost).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const renderer = (window as any).__kayfabeMorph;
          return renderer?.currentLayout
            ? {
                mode: renderer.mode,
                anchorId: renderer.currentLayout.anchorId,
                nodeCount: renderer.currentLayout.nodeTargets.length / 3,
              }
            : null;
        }),
      )
      .toEqual(before);
  });

  test("five rapid selections settle on the fifth target and stay there", async ({ page }) => {
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    for (const name of ["The Undertaker", "Kane", "Steve Austin", "Hulk Hogan", "Ric Flair"]) {
      await chooseSearchResult(page, name);
    }

    await settledIn(page, "loom", 45_000);
    await expect(page.locator(".morph-crumbs")).toContainText("Ric Flair");
    const final = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      return {
        anchorId: renderer.currentLayout.anchorId as string,
        mode: renderer.mode as string,
      };
    });
    expect(final.anchorId).toMatch(/^p:/);
    expect(final.mode).toBe("loom");

    // Give every superseded request enough time to resolve. An old shard must
    // never win after the fifth layout has already settled.
    await page.waitForTimeout(1_500);
    await expect(page.locator(".morph-crumbs")).toContainText("Ric Flair");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const renderer = (window as any).__kayfabeMorph;
          return `${renderer.mode}:${renderer.currentLayout.anchorId}:${renderer.morphing}`;
        }),
      )
      .toBe(`loom:${final.anchorId}:false`);
  });

  test("Morph keyboard input moves only Morph and preserves Connectome camera exactly", async ({ page }) => {
    await boot(page);

    // Make the Connectome state non-default so an accidental Morph-side reset
    // cannot pass by coincidentally restoring the default view.
    await page.locator("canvas.gl").dispatchEvent("wheel", { deltaY: -180 });
    await page.waitForTimeout(100);
    const before = await connectomeCamera(page);
    expect(before.active).toBe(true);

    await openMorph(page);
    await settledIn(page, "organic");
    const parked = await connectomeCamera(page);
    expect(parked.active).toBe(false);
    expect({ ...parked, active: true }).toEqual(before);

    const morphBefore = await page.evaluate(() => (window as any).__kayfabeMorph.cam.snapshot());
    await page.keyboard.press("r");
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeMorph.cam.flying)).toBe(true);

    // WASD is handled by Morph's capture listener and cancels only its camera
    // tween. Connectome remains mounted but its fly controller is disabled.
    await page.keyboard.down("w");
    await page.waitForTimeout(220);
    await page.keyboard.up("w");
    const morphAfter = await page.evaluate(() => ({
      view: (window as any).__kayfabeMorph.cam.snapshot(),
      flying: (window as any).__kayfabeMorph.cam.flying,
    }));
    expect(morphAfter.flying).toBe(false);
    expect(
      Math.hypot(
        morphAfter.view.cx - morphBefore.cx,
        morphAfter.view.cy - morphBefore.cy,
        morphAfter.view.cz - morphBefore.cz,
      ),
    ).toBeGreaterThan(1);

    await page.keyboard.press("q");
    await page.keyboard.press("t");
    await settledIn(page, "organic");
    const stillParked = await connectomeCamera(page);
    expect(stillParked).toEqual(parked);

    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeRenderer.isActive)).toBe(true);
    const after = await connectomeCamera(page);
    expect(after).toEqual(before);
  });

  test("live desktop-to-mobile resize recomputes sheet insets and framing", async ({ page }) => {
    await boot(page);
    await openMorph(page);
    await chooseSearchResult(page, "Ric Flair");
    await settledIn(page, "loom", 45_000);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("tablist", { name: "Morph Lab panels" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => !(window as any).__kayfabeMorph.cam.flying), {
      timeout: 10_000,
    }).toBe(true);

    const projection = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const layout = renderer.currentLayout;
      const slot = renderer.slotOfId(layout.anchorId);
      const point = slot === null ? null : renderer.projectSlot(slot);
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.morph-gl")!;
      const sheet = document.querySelector<HTMLElement>(".rail.right.morph-rail")!;
      const canvasRect = canvas.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      return {
        point,
        width: canvas.clientWidth,
        unobscuredBottom: sheetRect.top - canvasRect.top,
      };
    });
    expect(projection.point?.front).toBe(true);
    expect(projection.point!.x).toBeGreaterThanOrEqual(0);
    expect(projection.point!.x).toBeLessThanOrEqual(projection.width);
    expect(projection.point!.y).toBeGreaterThanOrEqual(0);
    expect(projection.point!.y).toBeLessThan(projection.unobscuredBottom);
  });
});

test.describe("Morph Lab mobile framing", () => {
  test.slow();

  test("selected anchor stays inside the unobscured canvas above the visible sheet", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "mobile frustum-inset regression");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await chooseSearchResult(page, "Ric Flair");
    await settledIn(page, "loom", 45_000);
    await expect.poll(() => page.evaluate(() => !(window as any).__kayfabeMorph.cam.flying)).toBe(true);

    const projection = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const layout = renderer.currentLayout;
      const slot = renderer.slotOfId(layout.anchorId);
      const point = slot === null ? null : renderer.projectSlot(slot);
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.morph-gl")!;
      const sheet = document.querySelector<HTMLElement>(".rail.right.morph-rail")!;
      const canvasRect = canvas.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      return {
        anchorId: layout.anchorId as string | null,
        point,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        sheetVisible: getComputedStyle(sheet).display !== "none",
        unobscuredBottom: sheetRect.top - canvasRect.top,
      };
    });

    expect(projection.anchorId).toMatch(/^p:/);
    expect(projection.sheetVisible).toBe(true);
    expect(projection.point).not.toBeNull();
    expect(projection.point!.front).toBe(true);
    expect(projection.point!.x).toBeGreaterThanOrEqual(0);
    expect(projection.point!.x).toBeLessThanOrEqual(projection.width);
    expect(projection.point!.y).toBeGreaterThanOrEqual(0);
    expect(projection.unobscuredBottom).toBeGreaterThan(0);
    expect(projection.unobscuredBottom).toBeLessThan(projection.height);
    expect(projection.point!.y).toBeLessThan(projection.unobscuredBottom);
  });
});
