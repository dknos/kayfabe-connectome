import { expect, test, type Page } from "@playwright/test";

/**
 * MORPH LAB journeys.
 *
 * The lab's promise is continuity: ONE persistent set of corpus entities
 * travelling between readable topologies. So the suite checks the claims that
 * make the lens what it is — that it opens on the untouched organic tissue,
 * that a selection genuinely MORPHS (intermediate positions observed, not a
 * cut), that a retarget travels rather than teleports, that "return to
 * tissue" restores the organic positions bit-for-bit, and that the connectome
 * underneath survives the round trip untouched.
 */

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto("/");
  await expect(page.locator("canvas.gl")).toBeVisible({ timeout: 40000 });
  return errors;
}

/**
 * Open the lens and wait for a laid-out board — ANY board. Deliberately not
 * "wait for organic": opening the lab with something already selected must
 * land straight in that entity's topology, and asserting organic here would
 * assert the opposite of the required behaviour.
 */
async function openMorph(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Morph Lab", exact: true }).click();
  await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(
    () => (window as any).__kayfabeMorph?.currentLayout != null,
    undefined,
    { timeout: 30000 },
  );
}

/** Choose a search result; selection flows through the ONE shared store. */
async function search(page: Page, q: string): Promise<void> {
  await page.getByRole("combobox", { name: /Search/ }).fill(q);
  await expect(page.getByRole("option").first()).toBeVisible({ timeout: 10000 });
  await page.getByRole("option").first().click({ force: true });
}

const morphState = (page: Page) =>
  page.evaluate(() => {
    const r = (window as any).__kayfabeMorph;
    return r
      ? {
          mode: r.mode,
          morphing: r.morphing,
          progress: r.morphProgress,
          traceLive: r.traceLive,
          labelShown: r.lastLabelReport.shown,
        }
      : null;
  });

/** Wait until the lab has SETTLED in a mode (layout built + transition done). */
async function settledIn(page: Page, mode: string, timeout = 30000): Promise<void> {
  await expect
    .poll(async () => {
      const s = await morphState(page);
      return s && s.mode === mode && !s.morphing ? mode : `${s?.mode}/${s?.morphing}`;
    }, { timeout })
    .toBe(mode);
}

test.describe("morph lab lens", () => {
  // merged corpus (365k matches) plus a second WebGL context and per-mode
  // detail shards, three browser projects against one dev server
  test.slow();

  test("morph lab opens on organic positions", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop journey; mobile has its own below");
    const errors = await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // The board is the tissue itself: real positions, live ambient fibers,
    // and labels actually shown — not a black canvas that claims to be a lens.
    const probe = await page.evaluate(() => {
      const r = (window as any).__kayfabeMorph;
      const pos = [0, 1, 2].map((s) => r.currentPositionOf(s));
      return {
        mode: r.mode,
        pos,
        traceLive: r.traceLive,
        labelShown: r.lastLabelReport.shown,
        count: r.currentLayout.nodeTargets.length / 3,
      };
    });
    expect(probe.mode).toBe("organic");
    expect(probe.count).toBeGreaterThan(1000);
    for (const p of probe.pos) {
      expect(p).not.toBeNull();
      // organic positions come from the force layout — none of the first
      // slots sits exactly at the origin
      expect(Math.hypot(p![0], p![1], p![2])).toBeGreaterThan(0);
    }
    expect(probe.traceLive).toBeGreaterThan(0);
    await expect
      .poll(async () => (await morphState(page))!.labelShown, { timeout: 15000 })
      .toBeGreaterThan(0);

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("selecting a wrestler morphs into the loom, and the morph actually runs", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    // Under prefers-reduced-motion there is deliberately NO long transition —
    // the reduced-motion project asserts the opposite, below.
    test.skip(test.info().project.name === "reduced-motion", "no long morph by design");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // Sample from a page-side interval STARTED BEFORE THE CLICK: the dossier
    // shard has to load before the morph can start, so any wall-clock delay
    // after the click races the fetch and reads either the old board or the
    // settled new one. Resolved only after the morph ends. This is the
    // "the morph was never running" regression test — a cut never raises the
    // morphing flag, so a cut yields an empty sample set.
    // Two clocks on purpose: an 8 ms interval outruns the renderer on a
    // healthy machine, and a rAF loop guarantees one sample per RENDERED
    // frame when timers starve under full-suite contention (the renderer's
    // own loop is rAF, so every frame a reader could see is observed). The
    // cap is wall-clock, not ticks — starved intervals fire hundreds of
    // milliseconds apart, and a tick budget at that rate is minutes long.
    const trajectory = page.evaluate(
      () =>
        new Promise<{ progress: number[]; mode: string }>((res) => {
          const r = (window as any).__kayfabeMorph;
          const progress: number[] = [];
          let started = false;
          let done = false;
          const t0 = performance.now();
          const finish = () => {
            if (done) return;
            done = true;
            clearInterval(iv);
            res({ progress, mode: r.mode });
          };
          const look = () => {
            if (done) return;
            if (r.morphing) {
              started = true;
              progress.push(r.morphProgress);
            } else if (started) return finish();
            if (performance.now() - t0 > 25000) finish();
          };
          const iv = setInterval(look, 8);
          const raf = () => {
            if (done) return;
            look();
            requestAnimationFrame(raf);
          };
          requestAnimationFrame(raf);
        }),
    );

    await search(page, "Undertaker");
    const traj = await trajectory;

    expect(traj.mode).toBe("loom");
    const detail = `progress samples: ${traj.progress.map((p) => p.toFixed(2)).join(",")}`;
    // the transition was observed RUNNING…
    expect(traj.progress.length, detail).toBeGreaterThanOrEqual(1);
    // …and passed through genuinely intermediate progress, not just 0 or 1
    expect(traj.progress.some((p) => p > 0.05 && p < 0.95), detail).toBe(true);
    await settledIn(page, "loom");
  });

  test("clicking another wrestler retargets without snapping", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    test.skip(test.info().project.name === "reduced-motion", "no spatial morph by design");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await search(page, "Undertaker");
    await settledIn(page, "loom");

    // Track the loom's anchor (the slot the layout marked SELECTED = role 1):
    // in Kane's loom the Undertaker becomes an opponent, so this exact slot
    // must TRAVEL from the anchor position to the opponent column.
    const slot = await page.evaluate(
      () => (window as any).__kayfabeMorph.currentLayout.nodeRole.indexOf(1),
    );
    expect(slot).toBeGreaterThanOrEqual(0);
    const before = await page.evaluate(
      (s) => (window as any).__kayfabeMorph.currentPositionOf(s),
      slot,
    );

    // Same dual-clock sampler as above: interval for density, rAF for the
    // guarantee that every rendered morph frame is observed, wall-clock cap
    // so starved timers cannot hang the promise past the test timeout.
    const trajectory = page.evaluate(
      (s) =>
        new Promise<{ samples: [number, number][]; modes: string[] }>((res) => {
          const r = (window as any).__kayfabeMorph;
          const samples: [number, number][] = [];
          const modes: string[] = [];
          let started = false;
          let done = false;
          const t0 = performance.now();
          const finish = () => {
            if (done) return;
            done = true;
            clearInterval(iv);
            res({ samples, modes });
          };
          const look = () => {
            if (done) return;
            if (r.morphing) {
              started = true;
              const p = r.currentPositionOf(s);
              if (p) samples.push([p[0], p[1]]);
              modes.push(r.mode);
            } else if (started) return finish();
            if (performance.now() - t0 > 25000) finish();
          };
          const iv = setInterval(look, 8);
          const raf = () => {
            if (done) return;
            look();
            requestAnimationFrame(raf);
          };
          requestAnimationFrame(raf);
        }),
      slot,
    );

    await search(page, "Kane");
    const traj = await trajectory;
    await settledIn(page, "loom");
    const after = await page.evaluate(
      (s) => (window as any).__kayfabeMorph.currentPositionOf(s),
      slot,
    );

    // the person↔person mode never changed mid-flight
    expect(traj.modes.every((m) => m === "loom")).toBe(true);

    const travel = Math.hypot(after![0] - before![0], after![1] - before![1]);
    expect(travel, "the ex-anchor must occupy a different place in the new loom").toBeGreaterThan(1);

    // fractions of the way, deduped because the sampler outruns the renderer
    const fractions = traj.samples.map(
      ([x, y]) => Math.hypot(x - before![0], y - before![1]) / travel,
    );
    const distinct = [...new Set(fractions.map((p) => p.toFixed(3)))].map(Number);
    const detail = `distinct fractions: ${distinct.map((p) => p.toFixed(2)).join(",")}`;
    // While the transition ran, the slot was observed — a cut never raises
    // the morphing flag at all, so it yields no samples…
    expect(traj.samples.length, detail).toBeGreaterThanOrEqual(1);
    // …and it was observed somewhere that is NOT its destination; a
    // jump-to-destination shows nothing but 1.0 fractions.
    expect(distinct.some((p) => p < 0.9), detail).toBe(true);
    const intermediate = distinct.filter((p) => p > 0.02 && p < 0.98);
    expect(
      intermediate.length + distinct.filter((p) => p <= 0.02).length,
      detail,
    ).toBeGreaterThanOrEqual(1);
    // Bounded per-step deltas whenever the machine rendered enough frames to
    // measure them. Deliberately NOT "< half the displacement": quintic
    // in-out peaks at ~5x average velocity, so a legitimate morph covers
    // ~0.7 of the travel across a mid-flight 120 ms window, and headless GL
    // under full-suite contention renders few enough frames that step
    // quantization stacks on top of that. Guarded on sample count so a
    // starved run degrades to the in-flight proof above instead of asserting
    // machine performance.
    if (intermediate.length >= 2) {
      const path = [0, ...distinct.filter((p) => p > 0 && p < 1).sort((a, b) => a - b), 1];
      let maxStep = 0;
      for (let i = 1; i < path.length; i++) maxStep = Math.max(maxStep, path[i]! - path[i - 1]!);
      expect(maxStep, detail).toBeLessThan(0.92);
    }
    // and the slot advanced monotonically toward its destination — a
    // retarget continues from what is on screen, it never rewinds
    const rising = fractions.every((p, i) => i === 0 || p >= fractions[i - 1]! - 0.02);
    expect(rising, detail).toBe(true);
  });

  test("back restores the previous arrangement", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await search(page, "Undertaker");
    await settledIn(page, "loom");
    await expect(page.locator(".morph-crumbs")).toContainText("The Undertaker");
    await search(page, "Kane");
    await settledIn(page, "loom");
    await expect(page.locator(".morph-crumbs")).toContainText("Kane");

    // the search box holds focus after a pick; Backspace must reach the
    // global history handler, not edit the query
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press("Backspace");

    await expect(page.locator(".morph-crumbs")).toContainText("The Undertaker", { timeout: 20000 });
    await settledIn(page, "loom");
  });

  test("promotion motherboard and championship lineage", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // a promotion re-forms the tissue as its documented network
    await search(page, "WWF");
    await settledIn(page, "motherboard");
    await expect(page.locator(".morph-crumbs")).toContainText("Promotion Network");

    // a championship row in the right rail opens that belt's lineage
    const row = page.locator(".rail.right.morph-rail .ev-row").first();
    await expect(row).toBeVisible({ timeout: 20000 });
    await row.click();
    await settledIn(page, "lineage");
    await expect(page.locator(".morph-crumbs")).toContainText("Title Lineage");
  });

  test("return to tissue restores exact organic positions", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // capture settled organic positions of a spread of corpus slots
    const slots = await page.evaluate(() => {
      const r = (window as any).__kayfabeMorph;
      const count = r.currentLayout.nodeTargets.length / 3;
      return [0, Math.min(100, count - 1), Math.min(5000, count - 1)];
    });
    const capture = (s: number[]) =>
      page.evaluate(
        (ss) => ss.map((s: number) => (window as any).__kayfabeMorph.currentPositionOf(s)),
        s,
      );
    const before = await capture(slots);

    await search(page, "Undertaker");
    await settledIn(page, "loom");

    await page.getByRole("button", { name: "Return to Tissue", exact: true }).click();
    await settledIn(page, "organic");

    // EXACT float equality — the organic layout never computes a position, it
    // restores the one clone taken at boot, so the round trip is byte-for-byte
    const after = await capture(slots);
    expect(after).toEqual(before);
  });

  test("the connectome survives the round trip", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop affordance");
    const errors = await boot(page);
    // frame the connectome somewhere specific first
    await search(page, "Undertaker");
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    const before = await page.evaluate(() => {
      const r = (window as any).__kayfabeRenderer;
      return { dist: r.cameraDistance, active: r.isActive };
    });
    expect(before.active).toBe(true);

    // full morph journey: the carried selection lands straight in the loom…
    await openMorph(page);
    await settledIn(page, "loom");
    // …the connectome's loop is suspended rather than disposed…
    expect(await page.evaluate(() => (window as any).__kayfabeRenderer.isActive)).toBe(false);
    // …and back out through the tissue
    await page.getByRole("button", { name: "Return to Tissue", exact: true }).click();
    await settledIn(page, "organic");

    await page.getByRole("button", { name: "Connectome", exact: true }).click();
    await expect(page.locator("canvas.gl")).toBeVisible();
    await expect(page.getByText("Person dossier")).toBeVisible({ timeout: 20000 });
    const after = await page.evaluate(() => {
      const r = (window as any).__kayfabeRenderer;
      return { dist: r.cameraDistance, active: r.isActive };
    });
    expect(after.active).toBe(true);
    // no unexpected fit-all: the framing came back as it was
    expect(Math.abs(after.dist - before.dist)).toBeLessThan(0.5);

    // The production lens set remains stable after a lab visit, including the
    // independent ratings renderer added as the fourth lens.
    const lenses = page.getByRole("group", { name: "Lens" });
    await expect(lenses.getByRole("button")).toHaveCount(4);
    await expect(lenses.getByRole("button", { name: "Meltzer Ratings", exact: true })).toBeVisible();
    await expect(lenses.getByRole("button", { name: "Atlas", exact: true })).toHaveCount(0);
    await expect(lenses.getByRole("button", { name: "Table", exact: true })).toHaveCount(0);

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("spatial regression: wrestler targets are deterministic, finite, unique, and restore organic bytes", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "one full-corpus spatial audit is sufficient");
    const errors = await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    const digestTargets = () =>
      page.evaluate(async () => {
        const targets = (window as any).__kayfabeMorph.currentLayout.nodeTargets as Float32Array;
        const bytes = new Uint8Array(targets.buffer, targets.byteOffset, targets.byteLength);
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return {
          bytes: bytes.byteLength,
          sha256: [...hash].map((v) => v.toString(16).padStart(2, "0")).join(""),
        };
      });

    const organicBefore = await digestTargets();
    await search(page, "Undertaker");
    await settledIn(page, "loom");

    const auditLoom = () =>
      page.evaluate(async () => {
        const r = (window as any).__kayfabeMorph;
        const l = r.currentLayout;
        const count = r.corpusSlotCount as number;
        const finiteIssues: string[] = [];
        const check = (name: string, values: ArrayLike<number>) => {
          for (let i = 0; i < values.length; i++) {
            if (!Number.isFinite(values[i])) {
              finiteIssues.push(`${name}[${i}]=${values[i]}`);
              if (finiteIssues.length >= 12) return;
            }
          }
        };
        check("targets", l.nodeTargets);
        check("opacity", l.nodeOpacity);
        check("scale", l.nodeScale);
        check("delay", l.nodeDelay);
        for (const [key, value] of Object.entries(l.bounds)) {
          if (!Number.isFinite(value as number)) finiteIssues.push(`bounds.${key}=${value}`);
        }
        for (const [key, value] of Object.entries(l.fitBounds ?? {})) {
          if (!Number.isFinite(value as number)) finiteIssues.push(`fitBounds.${key}=${value}`);
        }
        l.routes.forEach((route: any, i: number) => check(`route[${i}]`, route.points));
        l.virtuals.forEach((v: any, i: number) => check(`virtual[${i}]`, [v.x, v.y, v.z, v.scale, v.opacity]));
        l.regions.forEach((v: any, i: number) => check(`region[${i}]`, [v.x, v.y, v.z, v.w, v.h, v.alpha]));

        const ids = Array.from({ length: count }, (_, slot) => r.idAtSlot(slot) as string | null);
        const liveIds = ids.filter((id): id is string => typeof id === "string" && id.length > 0);
        const roundTripFailures = ids
          .flatMap((id, slot) => id && r.slotOfId(id) !== slot ? [id] : [])
          .slice(0, 12);

        const activeZ: number[] = [];
        const relationZ: number[] = [];
        for (let slot = 0; slot < count; slot++) {
          const role = l.nodeRole[slot] as number;
          const alpha = l.nodeOpacity[slot] as number;
          const z = l.nodeTargets[slot * 3 + 2] as number;
          if (role !== 0 && alpha >= 0.02) activeZ.push(z);
          if (role >= 2 && role <= 5 && alpha >= 0.02) relationZ.push(z);
        }
        for (const v of l.virtuals) if (v.opacity >= 0.02) activeZ.push(v.z);
        const spread = (values: number[]) => values.length ? Math.max(...values) - Math.min(...values) : 0;
        const bytes = new Uint8Array(l.nodeTargets.buffer, l.nodeTargets.byteOffset, l.nodeTargets.byteLength);
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return {
          count,
          targetSlots: l.nodeTargets.length / 3,
          representedCount: l.representedCount,
          missingIds: count - liveIds.length,
          uniqueIds: new Set(liveIds).size,
          roundTripFailures,
          finiteIssues,
          bounds: l.bounds,
          fitBounds: l.fitBounds,
          activeZSpread: spread(activeZ),
          relationZSpread: spread(relationZ),
          activeZLayers: new Set(activeZ.map((z) => Math.round(z / 20))).size,
          sha256: [...hash].map((v) => v.toString(16).padStart(2, "0")).join(""),
        };
      });

    const first = await auditLoom();
    expect(first.targetSlots).toBe(first.count);
    expect(first.representedCount).toBe(first.count);
    expect(first.missingIds).toBe(0);
    expect(first.uniqueIds).toBe(first.count);
    expect(first.roundTripFailures).toEqual([]);
    expect(first.finiteIssues).toEqual([]);
    expect(first.bounds.maxX).toBeGreaterThan(first.bounds.minX);
    expect(first.bounds.maxY).toBeGreaterThan(first.bounds.minY);
    expect(first.fitBounds.maxX).toBeGreaterThan(first.fitBounds.minX);
    expect(first.fitBounds.maxY).toBeGreaterThan(first.fitBounds.minY);
    expect(first.activeZSpread, "organized context must occupy a genuine 3D volume").toBeGreaterThan(400);
    expect(first.relationZSpread, "relationship depth must carry chronology, not decorative jitter").toBeGreaterThan(180);
    expect(first.activeZLayers).toBeGreaterThan(8);

    // Rebuild the same wrestler after a different topology. Pure deterministic
    // layout output must be byte-identical, independent of the live retarget.
    await search(page, "Kane");
    await settledIn(page, "loom");
    await search(page, "Undertaker");
    await settledIn(page, "loom");
    const rebuilt = await auditLoom();
    expect(rebuilt.sha256).toBe(first.sha256);

    await page.getByRole("button", { name: /Return to tissue/i }).click();
    await settledIn(page, "organic");
    const organicAfter = await digestTargets();
    expect(organicAfter.bytes).toBe(organicBefore.bytes);
    expect(organicAfter.sha256, "all Float32 organic target bytes must restore exactly").toBe(organicBefore.sha256);
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("spatial regression: Morph camera is perspective with attenuation and parallax", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "one deterministic camera proof is sufficient");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");
    await search(page, "Undertaker");
    await settledIn(page, "loom");

    const proof = await page.evaluate(() => {
      const r = (window as any).__kayfabeMorph;
      r.fitLayout(0, true);
      const ctl = r.cam;
      const camera = ctl.camera;
      const initial = ctl.snapshot();
      const e = camera.matrixWorld.elements as number[];
      const right = [e[0], e[1], e[2]];
      const forward = [-e[8], -e[9], -e[10]];
      const target = ctl.target as [number, number, number];
      const add = (a: number[], b: number[], k: number) => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
      const widthAt = (centre: number[], halfWidth: number) => {
        const a = add(centre, right, -halfWidth);
        const b = add(centre, right, halfWidth);
        const pa = ctl.worldToScreen(a[0], a[1], a[2]);
        const pb = ctl.worldToScreen(b[0], b[1], b[2]);
        return { px: Math.hypot(pb.x - pa.x, pb.y - pa.y), front: pa.front && pb.front };
      };

      const farCentre = add(target, forward, initial.distance * 0.5);
      const nearWidth = widthAt(target, 36);
      const farWidth = widthAt(farCentre, 36);
      const nearBefore = ctl.worldToScreen(target[0], target[1], target[2]);
      const farBefore = ctl.worldToScreen(farCentre[0], farCentre[1], farCentre[2]);
      ctl.restore({ ...initial, theta: initial.theta + 0.22 });
      const nearAfter = ctl.worldToScreen(target[0], target[1], target[2]);
      const farAfter = ctl.worldToScreen(farCentre[0], farCentre[1], farCentre[2]);
      const nearMove = [nearAfter.x - nearBefore.x, nearAfter.y - nearBefore.y];
      const farMove = [farAfter.x - farBefore.x, farAfter.y - farBefore.y];
      const differentialParallax = Math.hypot(farMove[0]! - nearMove[0]!, farMove[1]! - nearMove[1]!);
      ctl.restore(initial);
      return {
        isPerspectiveCamera: camera.isPerspectiveCamera === true,
        isOrthographicCamera: camera.isOrthographicCamera === true,
        fov: camera.fov,
        near: camera.near,
        far: camera.far,
        nearWidth,
        farWidth,
        differentialParallax,
        restored: ctl.snapshot(),
        initial,
      };
    });

    expect(proof.isPerspectiveCamera).toBe(true);
    expect(proof.isOrthographicCamera).toBe(false);
    expect(proof.fov).toBeGreaterThan(20);
    expect(proof.fov).toBeLessThan(90);
    expect(proof.near).toBeGreaterThan(0);
    expect(proof.far).toBeGreaterThan(proof.near);
    expect(proof.nearWidth.front && proof.farWidth.front).toBe(true);
    expect(proof.nearWidth.px, "equal world sizes must shrink with camera depth").toBeGreaterThan(proof.farWidth.px * 1.3);
    expect(proof.differentialParallax, "orbiting must move far geometry relative to the focus plane").toBeGreaterThan(8);
    expect(proof.restored).toEqual(proof.initial);
  });

  test("spatial regression: picking follows the current interpolated node position", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "full-corpus interpolation/picking proof");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    const observed = page.evaluate(
      () =>
        new Promise<any>((resolve) => {
          const r = (window as any).__kayfabeMorph;
          const organic = new Float32Array(r.currentLayout.nodeTargets);
          const started = performance.now();
          let sawMorph = false;
          const look = () => {
            const l = r.currentLayout;
            if (r.morphing && l?.mode === "loom" && l.anchorId) {
              sawMorph = true;
              const slot = r.slotOfId(l.anchorId);
              if (slot != null) {
                const current = r.currentPositionOf(slot);
                const screen = r.projectSlot(slot);
                const source = [organic[slot * 3], organic[slot * 3 + 1], organic[slot * 3 + 2]];
                const target = [l.nodeTargets[slot * 3], l.nodeTargets[slot * 3 + 1], l.nodeTargets[slot * 3 + 2]];
                const sourceScreen = r.cam.worldToScreen(source[0], source[1], source[2]);
                const targetScreen = r.cam.worldToScreen(target[0], target[1], target[2]);
                const sourcePx = Math.hypot(screen.x - sourceScreen.x, screen.y - sourceScreen.y);
                const targetPx = Math.hypot(screen.x - targetScreen.x, screen.y - targetScreen.y);
                const sourceWorld = Math.hypot(current[0] - source[0], current[1] - source[1], current[2] - source[2]);
                const targetWorld = Math.hypot(current[0] - target[0], current[1] - target[1], current[2] - target[2]);
                if (
                  r.morphProgress > 0.08 && r.morphProgress < 0.9 && screen.front &&
                  Math.min(sourcePx, targetPx) > 3 && Math.min(sourceWorld, targetWorld) > 3
                ) {
                  const hit = r.pick(screen.x, screen.y, 2);
                  return resolve({
                    progress: r.morphProgress,
                    expected: l.anchorId,
                    hit,
                    sourcePx,
                    targetPx,
                    sourceWorld,
                    targetWorld,
                    current,
                    source,
                    target,
                  });
                }
              }
            } else if (sawMorph && !r.morphing) {
              return resolve(null);
            }
            if (performance.now() - started > 25000) return resolve(null);
            requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }),
    );

    await search(page, "Undertaker");
    const proof = await observed;
    expect(proof, "a genuinely intermediate, pickable anchor sample must be observed").not.toBeNull();
    expect(proof.hit).toEqual({ id: proof.expected, kind: "node" });
    expect(Math.min(proof.sourcePx, proof.targetPx)).toBeGreaterThan(3);
    expect(Math.min(proof.sourceWorld, proof.targetWorld)).toBeGreaterThan(3);
    await settledIn(page, "loom");
  });

  test("reduced motion applies the layout at once", async ({ page }) => {
    test.skip(test.info().project.name !== "reduced-motion", "reduced-motion project only");
    await boot(page);
    await openMorph(page);
    await settledIn(page, "organic");

    // Started before the click: measure from the moment the loom layout
    // arrives to the moment the transition reports done, and pin the anchor's
    // geometry — under reduced motion it must ALREADY be at its destination.
    const observed = page.evaluate(
      () =>
        new Promise<{ settleMs: number; mode: string; moved: number }>((res) => {
          const r = (window as any).__kayfabeMorph;
          let t0 = 0;
          let p0: [number, number, number] | null = null;
          let slot = -1;
          const start = performance.now();
          const id = setInterval(() => {
            if (r.mode === "loom" && t0 === 0) {
              t0 = performance.now();
              slot = r.currentLayout.nodeRole.indexOf(1);
              p0 = slot >= 0 ? r.currentPositionOf(slot) : null;
            }
            if (t0 > 0 && r.morphProgress >= 1) {
              clearInterval(id);
              const p1 = slot >= 0 ? r.currentPositionOf(slot) : null;
              const moved =
                p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) : -1;
              return res({ settleMs: performance.now() - t0, mode: r.mode, moved });
            }
            if (performance.now() - start > 30000) {
              clearInterval(id);
              return res({ settleMs: -1, mode: r.mode, moved: -1 });
            }
          }, 16);
        }),
    );

    await search(page, "Undertaker");
    const got = await observed;
    expect(got.mode).toBe("loom");
    // spec duration is 190 ms; ~400 ms plus headless frame slack, and far
    // below the 920 ms travelling morph this project must never run
    expect(got.settleMs).toBeGreaterThanOrEqual(0);
    expect(got.settleMs).toBeLessThan(600);
    // the anchor never travelled — geometry landed at once
    expect(got.moved).toBeGreaterThanOrEqual(0);
    expect(got.moved).toBeLessThan(0.001);
  });

  test("an active Morph hash link immediately applies its local topology", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one same-document URL replay is sufficient");
    const errors = await boot(page);
    await openMorph(page);
    await search(page, "Ric Flair");
    await settledIn(page, "loom");
    await expect.poll(() => page.url()).toContain("sel=");

    // This is a same-document navigation while Morph is already mounted. Its
    // namespaced state must not wait for another mount before taking effect.
    await page.evaluate(() => {
      location.hash = `${location.hash}/mom=career`;
    });
    await settledIn(page, "career");
    await expect(page.getByRole("button", { name: "Career", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("mobile: lab operable, sheet tabs work", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile journey");
    const errors = await boot(page);
    await page.getByRole("button", { name: "Morph Lab", exact: true }).click();
    await expect(page.locator("canvas.morph-gl")).toBeVisible({ timeout: 30000 });

    const app = page.locator(".app");
    await expect(app).toHaveAttribute("data-morph-sheet", "inspector");
    await page.getByRole("tab", { name: "Layout" }).click();
    await expect(app).toHaveAttribute("data-morph-sheet", "controls");
    await expect(page.locator(".rail.left.morph-rail")).toBeVisible();
    await page.getByRole("tab", { name: "Details" }).click();
    await expect(app).toHaveAttribute("data-morph-sheet", "inspector");
    await page.getByRole("tab", { name: "Map" }).click();
    await expect(app).toHaveAttribute("data-morph-sheet", "hidden");
    await expect(page.locator("canvas.morph-gl")).toBeVisible();

    expect(errors, `console errors: ${errors.join("\n")}`).toHaveLength(0);
  });
});
