/**
 * Kayfabe Spacetime journeys.
 *
 * Same doctrine as every lens spec here: assertions read renderer state
 * through the read-only __kayfabeSpacetime seam; headless WebGL is
 * SwiftShader, so nothing below judges appearance or frame rate.
 * KAYFABE_BASE_URL overrides the target for a second-vite session.
 */
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.KAYFABE_BASE_URL ?? "";

declare global {
  interface Window {
    __kayfabeSpacetime?: {
      scope: {
        subjectId: string;
        subjectLabel: string;
        personas: { id: string }[];
        events: { matchRef: string }[];
        relationships: { p: string; n: string }[];
      } | null;
      currentLayout: { drawnWorldlines: number; hiddenWorldlines: number } | null;
      mode: string;
      warpMixNow: number;
      warpSpeed: number;
      playhead: number;
      playing: boolean;
      tier: string;
      contextLost: boolean;
      packets: { count: number };
      projectEvent(i: number): { x: number; y: number } | null;
      projectRelationship(i: number): { x: number; y: number } | null;
      resourceInfo(): { geometries: number };
    };
  }
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/`);
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40000 });
  return errors;
}

async function openSpacetime(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Spacetime", exact: true }).click();
  await expect(page.locator("canvas.spacetime-gl")).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(
    () => {
      const r = window.__kayfabeSpacetime;
      return Boolean(r && r.scope && r.currentLayout);
    },
    undefined,
    { timeout: 60000 },
  );
}

test("opens on the canonical merged subject and reports its budget honestly", async ({ page }) => {
  const errors = await boot(page);
  await openSpacetime(page);
  const state = await page.evaluate(() => {
    const r = window.__kayfabeSpacetime!;
    return {
      subject: r.scope!.subjectId,
      personas: r.scope!.personas.length,
      events: r.scope!.events.length,
      drawn: r.currentLayout!.drawnWorldlines,
      hidden: r.currentLayout!.hiddenWorldlines,
      contextLost: r.contextLost,
    };
  });
  // Matt Sydal + Evan Bourne are ONE canonical worldline: 695 + 227 events.
  expect(state.subject).toBe("p:116704");
  expect(state.personas).toBe(2);
  expect(state.events).toBe(922);
  expect(state.drawn).toBeGreaterThan(0);
  // 594 documented relationships never fit a drawn budget; the difference is
  // REPORTED, not lost.
  expect(state.drawn + state.hidden).toBe(594);
  expect(state.contextLost).toBe(false);
  await expect(page.locator(".spacetime-readout")).toContainText("922 documented matches");
  await expect(page.locator(".spacetime-readout")).toContainText("Evan Bourne");
  expect(errors).toEqual([]);
});

test("B toggles the observer; the warp mix follows the bridge", async ({ page }) => {
  await boot(page);
  await openSpacetime(page);
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__kayfabeSpacetime!.mode)).toBe("bridge");
  await expect.poll(
    () => page.evaluate(() => window.__kayfabeSpacetime!.warpMixNow),
    { timeout: 10000 },
  ).toBeGreaterThan(0.85);
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__kayfabeSpacetime!.mode)).toBe("exterior");
});

test("holding U unwarps the sky and releasing restores it", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "keyboard journey");
  await boot(page);
  await openSpacetime(page);
  await page.keyboard.press("b");
  await expect.poll(
    () => page.evaluate(() => window.__kayfabeSpacetime!.warpMixNow),
    { timeout: 10000 },
  ).toBeGreaterThan(0.85);
  await page.keyboard.down("u");
  await expect.poll(
    () => page.evaluate(() => window.__kayfabeSpacetime!.warpMixNow),
    { timeout: 10000 },
  ).toBeLessThan(0.2);
  await page.keyboard.up("u");
  await expect.poll(
    () => page.evaluate(() => window.__kayfabeSpacetime!.warpMixNow),
    { timeout: 10000 },
  ).toBeGreaterThan(0.85);
});

test("clicking a worldline inspects without choosing; choosing earns Back", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "pointer journey");
  await boot(page);
  await openSpacetime(page);
  // Click the strongest drawn relationship at its projected lane position.
  const target = await page.evaluate(() => window.__kayfabeSpacetime!.projectRelationship(0));
  expect(target).not.toBeNull();
  const canvas = page.locator("canvas.spacetime-gl");
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + target!.x, box!.y + target!.y);
  // Inspection is local: the inspector opens, the shared subject stays put.
  await expect(page.locator(".spacetime-inspector")).toBeVisible();
  const subjectBefore = await page.evaluate(() => window.__kayfabeSpacetime!.scope!.subjectId);
  expect(subjectBefore).toBe("p:116704");
  // Choosing routes through the shared store and the browser history.
  await page.locator(".spacetime-inspector button", { hasText: "Make them the subject" }).click();
  // The chosen person has no projection yet: the lens says so instead of
  // improvising, and the projected subject is offered back.
  await expect(page.locator(".spacetime-empty")).toContainText("no spacetime projection yet");
  await page.goBack();
  await expect.poll(
    () => page.evaluate(() => window.__kayfabeSpacetime?.scope?.subjectId ?? null),
    { timeout: 20000 },
  ).toBe("p:116704");
});

test("a cold bridge link restores the bridge", async ({ page }) => {
  await boot(page);
  await page.goto(`${BASE}/#2/lens=spacetime/spm=b`);
  await expect(page.locator("canvas.spacetime-gl")).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__kayfabeSpacetime?.scope), undefined, { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => window.__kayfabeSpacetime!.mode)).toBe("bridge");
});

test("reduced motion snaps the warp and parks the packets", async ({ page }) => {
  test.skip(test.info().project.name !== "reduced-motion", "reduced-motion journey");
  await boot(page);
  await openSpacetime(page);
  await page.keyboard.press("b");
  await expect.poll(() => page.evaluate(() => window.__kayfabeSpacetime!.mode)).toBe("bridge");
  // No tween under reduced motion: the mix lands immediately.
  await expect.poll(
    () => page.evaluate(() => window.__kayfabeSpacetime!.warpMixNow),
    { timeout: 3000 },
  ).toBe(1);
  expect(await page.evaluate(() => window.__kayfabeSpacetime!.packets.count)).toBe(0);
});

test("leaving the lens releases its renderer", async ({ page }) => {
  await boot(page);
  await openSpacetime(page);
  await page.getByRole("button", { name: "Connectome", exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__kayfabeSpacetime))).toBe(false);
});
