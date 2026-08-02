import { describe, expect, it } from "vitest";
import { MorphHoverController } from "@kayfabe/morph-renderer";

function controllerFixture() {
  let now = 10;
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const controller = new MorphHoverController({
    graceMs: 100,
    confirmationFrames: 2,
    now: () => now,
    setTimer: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => timers.delete(id as unknown as number),
  });
  return {
    controller,
    advance(ms = 1) { now += ms; },
    flushTimers() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    pendingTimers: () => timers.size,
  };
}

describe("Morph hover ownership", () => {
  it("acquires the first canvas target immediately and tracks pointer coordinates", () => {
    const { controller } = controllerFixture();
    controller.proposeCanvas("p:a", 30, 42);
    expect(controller.snapshot()).toMatchObject({
      id: "p:a",
      source: "canvas",
      candidateId: null,
      pointerX: 30,
      pointerY: 42,
      acquisitionTime: 10,
    });
  });

  it("requires two confirming frames before an overlapping candidate replaces sticky hover", () => {
    const { controller, advance } = controllerFixture();
    controller.proposeCanvas("p:a", 10, 10);
    advance();
    controller.proposeCanvas("p:b", 11, 10);
    expect(controller.snapshot()).toMatchObject({ id: "p:a", candidateId: "p:b" });
    advance();
    controller.proposeCanvas("p:b", 12, 10);
    expect(controller.snapshot()).toMatchObject({ id: "p:b", candidateId: null, source: "canvas" });
  });

  it("keeps one identity while crossing canvas, label, and hover-card surfaces", () => {
    const { controller, flushTimers, pendingTimers } = controllerFixture();
    controller.proposeCanvas("p:a", 10, 10);
    controller.leaveSurface("canvas", "p:a");
    expect(pendingTimers()).toBe(1);
    controller.enterSurface("label", "p:a");
    expect(pendingTimers()).toBe(0);
    controller.leaveSurface("label", "p:a");
    controller.enterSurface("card", "p:a");
    flushTimers();
    expect(controller.snapshot()).toMatchObject({ id: "p:a", source: "card" });
  });

  it("clears only after the final related-surface leave grace expires", () => {
    const { controller, flushTimers } = controllerFixture();
    controller.enterSurface("label", "p:a");
    controller.leaveSurface("label", "p:a");
    expect(controller.snapshot().id).toBe("p:a");
    flushTimers();
    expect(controller.snapshot()).toMatchObject({ id: null, source: null, candidateId: null });
  });

  it("does not postpone leave grace on repeated empty canvas samples", () => {
    const { controller, flushTimers, pendingTimers } = controllerFixture();
    controller.proposeCanvas("p:a", 10, 10);
    controller.proposeCanvas(null, 20, 20);
    controller.proposeCanvas(null, 30, 20);
    expect(pendingTimers()).toBe(1);
    flushTimers();
    expect(controller.snapshot().id).toBeNull();
  });

  it("increments layout generation and clears an identity absent from the new layout", () => {
    const { controller } = controllerFixture();
    controller.enterSurface("keyboard", "p:a");
    controller.layoutChanged((id) => id === "p:other");
    expect(controller.snapshot()).toMatchObject({ id: null, layoutGeneration: 1 });
  });

  it("preserves a hovered identity that remains in the next layout", () => {
    const { controller } = controllerFixture();
    controller.enterSurface("keyboard", "p:a");
    controller.layoutChanged((id) => id === "p:a");
    expect(controller.snapshot()).toMatchObject({ id: "p:a", source: "keyboard", layoutGeneration: 1 });
  });

  it("clears stale spatial hover when a surviving node moves in a new layout", () => {
    const { controller } = controllerFixture();
    controller.enterSurface("label", "p:a");
    controller.layoutChanged((id) => id === "p:a");
    expect(controller.snapshot()).toMatchObject({ id: null, source: null, layoutGeneration: 1 });
  });

  it("suppresses canvas proposals while dragging and accepts recomputation after pointerup", () => {
    const { controller } = controllerFixture();
    controller.proposeCanvas("p:a", 10, 10);
    controller.setDragging(true);
    controller.proposeCanvas("p:b", 20, 20);
    expect(controller.snapshot()).toMatchObject({ id: "p:a", cameraDragging: true });
    controller.setDragging(false);
    controller.proposeCanvas("p:b", 20, 20);
    controller.proposeCanvas("p:b", 20, 20);
    expect(controller.snapshot()).toMatchObject({ id: "p:b", cameraDragging: false });
  });

  it("touch transition clears pointer hover while keyboard can still own accessible focus", () => {
    const { controller } = controllerFixture();
    controller.proposeCanvas("p:a", 10, 10);
    controller.setTouchActive(true);
    expect(controller.snapshot()).toMatchObject({ id: null, touchActive: true });
    controller.enterSurface("label", "p:b");
    expect(controller.snapshot().id).toBeNull();
    controller.enterSurface("keyboard", "p:b");
    expect(controller.snapshot()).toMatchObject({ id: "p:b", source: "keyboard" });
  });

  it("keeps keyboard focus authoritative over canvas noise until focus leaves", () => {
    const { controller, flushTimers } = controllerFixture();
    controller.enterSurface("keyboard", "p:a");
    controller.proposeCanvas("p:b", 20, 20);
    controller.proposeCanvas("p:b", 20, 20);
    expect(controller.snapshot()).toMatchObject({ id: "p:a", source: "keyboard" });
    controller.leaveSurface("keyboard", "p:a");
    flushTimers();
    controller.proposeCanvas("p:b", 20, 20);
    expect(controller.snapshot()).toMatchObject({ id: "p:b", source: "canvas" });
  });

  it("does not let pointer entry steal ownership from a focused card action", () => {
    const { controller, pendingTimers } = controllerFixture();
    controller.enterSurface("keyboard", "p:a");
    controller.enterSurface("card", "p:a");
    controller.leaveSurface("card", "p:a");
    expect(controller.snapshot()).toMatchObject({ id: "p:a", source: "keyboard" });
    expect(pendingTimers()).toBe(0);
  });

  it("disposal cancels pending leave and prevents stale emissions", () => {
    const { controller, flushTimers } = controllerFixture();
    const seen: Array<string | null> = [];
    controller.onChange = (state) => seen.push(state.id);
    controller.enterSurface("label", "p:a");
    controller.leaveSurface("label", "p:a");
    controller.dispose();
    flushTimers();
    expect(seen).toEqual(["p:a"]);
  });
});
