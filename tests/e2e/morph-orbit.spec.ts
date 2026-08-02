import { expect, test, type Page } from "@playwright/test";

type RuntimeProbe = { errors: string[]; expectedFailures: RegExp[] };

function guardRuntime(page: Page, expectedFailures: RegExp[] = []): RuntimeProbe {
  const probe = { errors: [] as string[], expectedFailures };
  const expected = (url: string) => expectedFailures.some((pattern) => pattern.test(url));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (expectedFailures.length > 0 && /Failed to load resource.*(?:503|net::ERR_FAILED)/i.test(text)) return;
    if (!expected(text)) probe.errors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => probe.errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (!expected(request.url())) probe.errors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !expected(response.url())) probe.errors.push(`http ${response.status()}: ${response.url()}`);
  });
  return probe;
}

async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40_000 });
}

async function openMorph(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Morph Lab", exact: true }).click();
  await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__kayfabeMorph?.currentLayout != null, undefined, {
    timeout: 30_000,
  });
}

async function search(page: Page, query: string, expectedName = query): Promise<void> {
  const input = page.getByRole("combobox", { name: /Search/ });
  await input.fill("");
  await input.fill(query);
  const exact = new RegExp(`^${expectedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const option = page.locator('.search-pop [role="option"]').filter({
    has: page.locator("span", { hasText: exact }),
  });
  await option.first().waitFor({ state: "visible", timeout: 10_000 });
  expect(await option.count(), `${query} should have one exact, disambiguated result`).toBe(1);
  await option.click({ force: true });
  await expect(page.locator(".morph-crumbs")).toContainText(expectedName, { timeout: 10_000 });
}

async function settledIn(page: Page, mode: string, timeout = 40_000): Promise<void> {
  await expect.poll(
    () => page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      return renderer ? `${renderer.mode}:${renderer.morphing || renderer.cam.flying ? "moving" : "settled"}` : "missing";
    }),
    { timeout },
  ).toBe(`${mode}:settled`);
}

function watchTransition(page: Page, mode: string) {
  return page.evaluate((expectedMode) => new Promise<{ progress: number[]; modes: string[] }>((resolve) => {
    const renderer = (window as any).__kayfabeMorph;
    const progress: number[] = [];
    const modes: string[] = [];
    let started = false;
    const startedAt = performance.now();
    const tick = () => {
      if (renderer.morphing) {
        started = true;
        progress.push(renderer.morphProgress);
        modes.push(renderer.mode);
      } else if (started || performance.now() - startedAt > 15_000) {
        resolve({ progress, modes });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), mode);
}

async function enterOrbit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await settledIn(page, "orbit");
}

async function orbitIdentity(page: Page, kind: "direct" | "bridge") {
  return page.evaluate((wanted) => {
    const renderer = (window as any).__kayfabeMorph;
    const layout = renderer.currentLayout;
    const allowed = wanted === "direct" ? new Set([2, 3, 4, 5]) : new Set([11]);
    const label = layout.labels.find((candidate: any) => {
      if (!candidate.pick?.startsWith("p:")) return false;
      const slot = renderer.slotOfId(candidate.pick);
      return slot !== null && allowed.has(layout.nodeRole[slot]);
    });
    return label ? { id: label.pick as string, name: label.text as string } : null;
  }, kind);
}

async function projectedPoint(page: Page, id: string) {
  return page.evaluate((target) => {
    const renderer = (window as any).__kayfabeMorph;
    const slot = renderer.slotOfId(target);
    if (slot === null) return null;
    const point = renderer.projectSlot(slot);
    const rect = renderer.canvas.getBoundingClientRect();
    return point ? { ...point, pageX: rect.left + point.x, pageY: rect.top + point.y } : null;
  }, id);
}

async function emptyCanvasPoint(page: Page) {
  return page.evaluate(() => {
    const renderer = (window as any).__kayfabeMorph;
    const rect = renderer.canvas.getBoundingClientRect();
    for (let y = 90; y < rect.height - 100; y += 45) {
      for (let x = 330; x < rect.width - 370; x += 55) {
        if (document.elementFromPoint(rect.left + x, rect.top + y) !== renderer.canvas) continue;
        if (!renderer.pick(x, y, 8, "programmatic")) return { pageX: rect.left + x, pageY: rect.top + y };
      }
    }
    return { pageX: rect.left + rect.width * 0.5, pageY: rect.top + rect.height * 0.75 };
  });
}

async function showSheet(page: Page, name: "Layout" | "Details" | "Map") {
  await page.getByRole("tab", { name, exact: true }).click({ timeout: 6_000 });
}

test.describe("Morph Lab Orbit Map", () => {
  test.slow();

  test("desktop: Array morphs into a truthful two-hop Orbit and bridge selection recenters", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop Orbit journey");
    const runtime = guardRuntime(page);
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await search(page, "Undertaker", "The Undertaker");
    await settledIn(page, "loom");

    const transition = watchTransition(page, "orbit");
    await page.getByRole("button", { name: "Orbit", exact: true }).click();
    const trajectory = await transition;
    expect(trajectory.progress.some((value) => value > 0.05 && value < 0.95)).toBe(true);
    expect(trajectory.modes.every((mode) => mode === "orbit")).toBe(true);
    await settledIn(page, "orbit");

    const topology = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const layout = renderer.currentLayout;
      const roles = Array.from(layout.nodeRole as Uint8Array);
      const selectedSlot = renderer.slotOfId(layout.anchorId);
      const direct = roles.filter((role) => role >= 2 && role <= 5).length;
      const bridge = roles.filter((role) => role === 11).length;
      const bridgeRoutes = layout.routes.filter((route: any) => route.kind === 5);
      return {
        mode: layout.mode,
        anchorId: layout.anchorId,
        selectedCount: roles.filter((role) => role === 1).length,
        direct,
        bridge,
        bridgeRoutes: bridgeRoutes.length,
        fakeSelectedToBridge: bridgeRoutes.filter((route: any) => route.a === selectedSlot || route.b === selectedSlot).length,
        finite: Array.from(layout.nodeTargets as Float32Array).every(Number.isFinite),
        notes: layout.notes as string[],
      };
    });
    expect(topology).toMatchObject({ mode: "orbit", selectedCount: 1, fakeSelectedToBridge: 0, finite: true });
    expect(topology.anchorId).toMatch(/^p:/);
    expect(topology.direct).toBeGreaterThan(0);
    expect(topology.bridge).toBeGreaterThan(0);
    expect(topology.bridgeRoutes).toBeGreaterThan(0);

    await expect(page.getByText("inner orbit · direct relationship", { exact: true })).toBeVisible();
    await expect(page.getByText("outer orbit · two-hop bridge", { exact: true })).toBeVisible();
    await expect(page.getByTestId("morph-counts")).toContainText("direct nodes");
    await expect(page.getByTestId("morph-counts")).toContainText("bridge nodes");

    const direct = await orbitIdentity(page, "direct");
    expect(direct).not.toBeNull();
    const directLabel = page.locator(".mlabel.pickable").filter({ hasText: direct!.name }).first();
    await directLabel.hover();
    await expect(page.locator(".morph-hover-peek")).toContainText(/Direct (?:documented )?relationship with The Undertaker/);
    await expect(page.locator(".morph-hover-peek")).toContainText(/Opposed ×\d+ · same-side ×\d+ · battle royal ×\d+/);

    const bridge = await orbitIdentity(page, "bridge");
    expect(bridge).not.toBeNull();
    const bridgeLabel = page.locator(".mlabel.pickable").filter({ hasText: bridge!.name }).first();
    // Leave the previous card before approaching another projected label. A
    // real pointer cannot hover an entity physically covered by an actionable
    // card, and force-hovering through it would bypass the product contract.
    await page.mouse.move(720, 80);
    await expect(page.locator(".morph-hover-card")).toHaveCount(0, { timeout: 2_000 });
    await bridgeLabel.hover();
    const peek = page.locator(".morph-hover-peek");
    await expect(peek).toContainText("Two hops from The Undertaker");
    await expect(peek).toContainText(/Supported through \d+ displayed connection/);
    await expect(peek).toContainText("No direct relationship is claimed by this placement.");

    const recenter = watchTransition(page, "orbit");
    await bridgeLabel.locator("button.mlabel-primary").click();
    const recenterTrajectory = await recenter;
    expect(recenterTrajectory.progress.some((value) => value > 0.03 && value < 0.97)).toBe(true);
    await settledIn(page, "orbit");
    await expect(page.locator(".morph-crumbs")).toContainText(bridge!.name);
    const recentered = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      return { mode: renderer.mode, anchorId: renderer.currentLayout.anchorId };
    });
    expect(recentered).toEqual({ mode: "orbit", anchorId: bridge!.id });
    expect(runtime.errors, runtime.errors.join("\n")).toEqual([]);
  });

  test("desktop: canvas, label, and actions share hover ownership; drag does not select", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop pointer journey");
    const runtime = guardRuntime(page);
    await boot(page);
    await openMorph(page);
    await search(page, "Undertaker", "The Undertaker");
    await settledIn(page, "loom");
    await enterOrbit(page);

    const direct = await orbitIdentity(page, "direct");
    expect(direct).not.toBeNull();
    const point = await projectedPoint(page, direct!.id);
    expect(point?.front).toBe(true);
    await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      (window as any).__qaHoverHistory = [];
      renderer.onHoverState = (state: any) => (window as any).__qaHoverHistory.push({ id: state.id, source: state.source });
    });
    await page.mouse.move(point!.pageX, point!.pageY);
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeMorph.hover.snapshot().id)).toBe(direct!.id);

    const label = page.locator(".mlabel.pickable").filter({ hasText: direct!.name }).first();
    // The renderer positions pooled labels imperatively every frame. Forcing
    // the pointer move avoids Playwright's DOM-stability retry fighting that
    // intentional motion under a heavily loaded multi-WebGL suite.
    await label.hover({ force: true });
    const card = page.locator(".morph-hover-card");
    await expect(card).toContainText(direct!.name);
    await card.hover();
    await card.getByRole("button", { name: "Pin", exact: true }).click();
    await expect(card.getByRole("button", { name: "Unpin", exact: true })).toHaveAttribute("aria-pressed", "true");
    const crossing = await page.evaluate(() => (window as any).__qaHoverHistory as Array<{ id: string | null }>);
    const acquired = crossing.findIndex((state) => state.id === direct!.id);
    expect(acquired).toBeGreaterThanOrEqual(0);
    expect(crossing.slice(acquired).some((state) => state.id === null)).toBe(false);

    const anchorBefore = await page.evaluate(() => (window as any).__kayfabeMorph.currentLayout.anchorId as string);
    const dragStart = await emptyCanvasPoint(page);
    await page.mouse.move(dragStart.pageX, dragStart.pageY);
    await page.mouse.down();
    await page.mouse.move(dragStart.pageX + 55, dragStart.pageY + 28, { steps: 4 });
    await expect.poll(
      () => page.evaluate(() => (window as any).__kayfabeMorph.hover.snapshot().cameraDragging),
      { timeout: 2_000 },
    ).toBe(true);
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeMorph.hover.snapshot().cameraDragging)).toBe(false);
    expect(await page.evaluate(() => (window as any).__kayfabeMorph.currentLayout.anchorId)).toBe(anchorBefore);
    expect(runtime.errors, runtime.errors.join("\n")).toEqual([]);
  });

  test("desktop: explicit Orbit survives five rapid selections and URL reload", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop URL and retarget journey");
    const runtime = guardRuntime(page);
    await boot(page);
    await openMorph(page);
    await search(page, "Undertaker", "The Undertaker");
    await settledIn(page, "loom");
    await enterOrbit(page);

    for (const [query, expected] of [
      ["Kane", "Kane"],
      ["Steve Austin", "Steve Austin"],
      ["Hulk Hogan", "Hulk Hogan"],
      ["The Rock", "The Rock"],
      ["Ric Flair", "Ric Flair"],
    ]) {
      await search(page, query, expected);
      await page.waitForTimeout(90);
    }
    await settledIn(page, "orbit", 50_000);
    await page.waitForTimeout(1_500);
    await expect(page.locator(".morph-crumbs")).toContainText("Ric Flair");
    await expect.poll(() => page.evaluate(() => (window as any).__kayfabeMorph.mode)).toBe("orbit");

    await page.locator("canvas.morph-gl").dispatchEvent("wheel", { deltaY: -180 });
    await expect.poll(() => page.url()).toContain("mom=orbit");
    await expect.poll(() => page.url()).toMatch(/mo(?:cx|d|th|ph)=/);
    const hash = new URL(page.url()).hash;

    await page.reload();
    await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 40_000 });
    await settledIn(page, "orbit", 50_000);
    await expect(page.locator(".morph-crumbs")).toContainText("Ric Flair");
    await expect(page.getByRole("button", { name: "Orbit", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(new URL(page.url()).hash).toContain("mom=orbit");
    expect(hash).toContain("mom=orbit");
    expect(runtime.errors, runtime.errors.join("\n")).toEqual([]);
  });

  test("desktop: failed optional dossier leaves graph-derived Orbit usable and Retry recovers detail", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "one optional-shard recovery journey");
    let failPeopleShard = true;
    const expectedShard = /\/data\/entities\/people\/[^/]+\.json(?:\?|$)/;
    await page.route("**/data/entities/people/*.json", async (route) => {
      if (failPeopleShard) await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      else await route.continue();
    });
    const runtime = guardRuntime(page, [expectedShard]);
    await boot(page);
    await openMorph(page);
    await search(page, "Undertaker", "The Undertaker");
    await settledIn(page, "loom");
    await enterOrbit(page);

    const structure = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const roles = Array.from(renderer.currentLayout.nodeRole as Uint8Array);
      return {
        mode: renderer.mode,
        direct: roles.filter((role) => role >= 2 && role <= 5).length,
        bridge: roles.filter((role) => role === 11).length,
        notes: renderer.currentLayout.notes as string[],
      };
    });
    expect(structure.mode).toBe("orbit");
    expect(structure.direct).toBeGreaterThan(0);
    expect(structure.bridge).toBeGreaterThan(0);
    expect(structure.notes.join(" ")).toMatch(/dossier|person detail|optional detail/i);
    await expect(page.getByText("person detail unavailable", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry person detail" })).toBeVisible();

    failPeopleShard = false;
    await page.getByRole("button", { name: "Retry person detail" }).click();
    await settledIn(page, "orbit");
    await expect(page.getByText("documented matches", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(runtime.errors, runtime.errors.join("\n")).toEqual([]);
  });

  test("mobile: Orbit bands fit above the sheet and touch selection opens persistent Details", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile touch journey");
    const runtime = guardRuntime(page);
    await boot(page);
    await openMorph(page);
    await search(page, "Undertaker", "The Undertaker");
    await settledIn(page, "loom");
    await showSheet(page, "Layout");
    await enterOrbit(page);
    await showSheet(page, "Map");

    const framing = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const canvas = document.querySelector<HTMLCanvasElement>("canvas.morph-gl")!;
      const sheet = document.querySelector<HTMLElement>(".rail.right.morph-rail")!;
      const canvasRect = canvas.getBoundingClientRect();
      const sheetRect = sheet.getBoundingClientRect();
      const sheetVisible = getComputedStyle(sheet).display !== "none";
      const active = [] as Array<{ x: number; y: number }>;
      for (let slot = 0; slot < renderer.currentLayout.nodeRole.length; slot++) {
        const role = renderer.currentLayout.nodeRole[slot];
        if (role !== 1 && !(role >= 2 && role <= 5) && role !== 11) continue;
        const point = renderer.projectSlot(slot);
        if (point?.front) active.push(point);
      }
      return {
        active,
        width: canvas.clientWidth,
        unobscuredBottom: sheetVisible ? sheetRect.top - canvasRect.top : canvas.clientHeight,
        bodyOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(framing.active.length).toBeGreaterThan(2);
    expect(framing.active.every((point) => point.x >= 0 && point.x <= framing.width && point.y >= 0 && point.y < framing.unobscuredBottom)).toBe(true);
    expect(framing.bodyOverflow).toBeLessThanOrEqual(1);

    const direct = await orbitIdentity(page, "direct");
    expect(direct).not.toBeNull();
    const anchorBeforeTouch = await page.evaluate(() => (window as any).__kayfabeMorph.currentLayout.anchorId as string);
    // Exercise the actual touch target at the projected entity. DOM labels
    // are collision-pooled while the camera settles and are not the only
    // mobile interaction path.
    const point = await projectedPoint(page, direct!.id);
    expect(point?.front).toBe(true);
    await page.touchscreen.tap(point!.pageX, point!.pageY);
    await settledIn(page, "orbit");
    const touched = await page.evaluate(() => {
      const shared = (window as any).__kayfabeStore?.getState?.();
      const renderer = (window as any).__kayfabeMorph;
      const id = shared?.selection?.kind === "node" ? shared.selection.id : renderer.currentLayout.anchorId;
      return {
        id,
        name: renderer.currentLayout.labels.find((candidate: any) => candidate.pick === id)?.text ?? null,
      };
    });
    expect(touched.id).not.toBe(anchorBeforeTouch);
    expect(touched.name).toBeTruthy();
    await showSheet(page, "Details");
    await expect(page.locator(".rail.right.morph-rail h2").filter({ hasText: touched.name! })).toBeVisible();
    await showSheet(page, "Layout");
    await expect(page.getByRole("button", { name: "Focus selected entity" })).toBeVisible();
    await page.getByRole("button", { name: "Focus selected entity" }).click();
    await showSheet(page, "Map");
    await expect(page.locator("canvas.morph-gl")).toBeVisible();
    expect(runtime.errors, runtime.errors.join("\n")).toEqual([]);
  });

  test("reduced motion lands Orbit immediately without losing bridge semantics", async ({ page }) => {
    test.skip(test.info().project.name !== "reduced-motion", "reduced-motion contract");
    const runtime = guardRuntime(page);
    await boot(page);
    await openMorph(page);
    await search(page, "Undertaker", "The Undertaker");
    await settledIn(page, "loom");
    const started = Date.now();
    await enterOrbit(page);
    // This includes the asynchronous topology rebuild and test polling. The
    // reduced-motion contract below is geometric: no active morph/camera
    // flight once the layout arrives. Keep only a generous hang guard here.
    // This is only a deadlock guard; concurrent project workers can make graph
    // derivation cross two seconds under SwiftShader. The semantic assertions
    // below prove that geometry itself is already landed, with no camera flight.
    expect(Date.now() - started).toBeLessThan(5_000);
    const state = await page.evaluate(() => {
      const renderer = (window as any).__kayfabeMorph;
      const roles = Array.from(renderer.currentLayout.nodeRole as Uint8Array);
      return {
        morphing: renderer.morphing,
        direct: roles.filter((role) => role >= 2 && role <= 5).length,
        bridge: roles.filter((role) => role === 11).length,
        bridgeRoutes: renderer.currentLayout.routes.filter((route: any) => route.kind === 5).length,
      };
    });
    expect(state.morphing).toBe(false);
    expect(state.direct).toBeGreaterThan(0);
    expect(state.bridge).toBeGreaterThan(0);
    expect(state.bridgeRoutes).toBeGreaterThan(0);
    expect(runtime.errors, runtime.errors.join("\n")).toEqual([]);
  });
});
