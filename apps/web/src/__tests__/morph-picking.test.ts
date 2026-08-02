import { describe, expect, it } from "vitest";
import {
  ME,
  MR,
  easeQuintic,
  elementProgress,
  morphPickHitRadius,
  pickAt,
  selectBestMorphPickCandidate,
  type MorphProjectedPickCandidate,
} from "@kayfabe/morph-renderer";

function fakeCamera() {
  const elements = new Array<number>(16).fill(0);
  elements[5] = 1;
  return {
    camera: { projectionMatrix: { elements } },
    viewportHeight: 100,
    worldPerPixel: 1,
    projectInto(x: number, y: number, _z: number, out: { x: number; y: number; front: boolean; depth: number }) {
      Object.assign(out, { x, y, front: true, depth: 100 });
    },
    screenToPlane(x: number, y: number) { return [x, y]; },
    worldToScreen(x: number, y: number) { return { x, y, front: true, depth: 100 }; },
  };
}

function fakeNodes(fromX = 0, toX = fromX) {
  return {
    total: 1,
    delay: Float32Array.of(0),
    alphaFrom: Float32Array.of(1),
    alphaTo: Float32Array.of(1),
    from: Float32Array.of(fromX, 20, 0),
    to: Float32Array.of(toX, 20, 0),
    scaleFrom: Float32Array.of(1),
    scaleTo: Float32Array.of(1),
    semantic: Uint8Array.of(ME.MEMBER),
    emph: Float32Array.of(1),
    glow: Float32Array.of(0),
  };
}

const candidate = (
  id: string,
  patch: Partial<MorphProjectedPickCandidate> = {},
): MorphProjectedPickCandidate => ({
  id,
  kind: "node",
  slot: Number(id.replace(/\D/g, "")) || 0,
  normalizedDistance: 0.5,
  depth: 100,
  semanticPriority: ME.AMBIENT,
  layoutRole: MR.BACKGROUND,
  opacity: 1,
  ...patch,
});

describe("depth- and semantic-aware Morph picking", () => {
  it("chooses the front node in a near-distance overlap", () => {
    const back = candidate("p:1", { normalizedDistance: 0.48, depth: 220 });
    const front = candidate("p:2", { normalizedDistance: 0.5, depth: 100 });
    expect(selectBestMorphPickCandidate([back, front])?.id).toBe("p:2");
  });

  it("lets an active Orbit role beat ambient corpus context in a near tie", () => {
    const ambient = candidate("p:1", { normalizedDistance: 0.45, layoutRole: MR.BACKGROUND });
    const direct = candidate("p:2", { normalizedDistance: 0.5, layoutRole: MR.OPPONENT });
    expect(selectBestMorphPickCandidate([ambient, direct])?.id).toBe("p:2");
  });

  it("keeps selected and hovered semantic entities easy to reacquire", () => {
    const ordinary = candidate("p:1", { normalizedDistance: 0.46, layoutRole: MR.OPPONENT });
    const selected = candidate("p:2", {
      normalizedDistance: 0.52,
      semanticPriority: ME.SELECTED,
      layoutRole: MR.SELECTED,
    });
    expect(selectBestMorphPickCandidate([ordinary, selected])?.id).toBe("p:2");
  });

  it("keeps an exact selected core pick ahead of a nearer lane inside the same hit footprint", () => {
    const selected = candidate("p:2", {
      normalizedDistance: 0,
      depth: 1930,
      semanticPriority: ME.SELECTED,
      layoutRole: MR.SELECTED,
    });
    const nearerLane = candidate("p:1", {
      normalizedDistance: 0.174,
      depth: 1625,
      semanticPriority: ME.MEMBER,
      layoutRole: MR.MIXED,
    });
    expect(selectBestMorphPickCandidate([selected, nearerLane])?.id).toBe("p:2");
  });

  it("never picks effectively invisible or behind-camera candidates", () => {
    const invisible = candidate("p:1", { normalizedDistance: 0, opacity: 0.01 });
    const behind = candidate("p:2", { normalizedDistance: 0, depth: 0 });
    expect(selectBestMorphPickCandidate([invisible, behind])).toBeNull();
  });

  it("compares screen distance normalized by each projected hit radius", () => {
    // The large point may be farther in absolute pixels but has the smaller
    // normalized distance after its projected radius is accounted for.
    const smallPoint = candidate("p:1", { normalizedDistance: 0.72 });
    const largePoint = candidate("p:2", { normalizedDistance: 0.31 });
    expect(selectBestMorphPickCandidate([smallPoint, largePoint])?.id).toBe("p:2");
  });

  it("uses larger touch hit slop than mouse without changing visible point geometry", () => {
    expect(morphPickHitRadius(8, 14)).toBe(14);
    expect(morphPickHitRadius(8, 8)).toBe(8);
    expect(morphPickHitRadius(30, 8)).toBeCloseTo(18.5);
  });

  it("uses sticky identity to prevent one-frame churn inside the overlap band", () => {
    const sticky = candidate("p:1", { normalizedDistance: 0.54 });
    const noisyFrameWinner = candidate("p:2", { normalizedDistance: 0.49 });
    expect(selectBestMorphPickCandidate([sticky, noisyFrameWinner], "p:1")?.id).toBe("p:1");
  });

  it("allows a materially closer candidate to replace sticky hover", () => {
    const sticky = candidate("p:1", { normalizedDistance: 0.72 });
    const materiallyCloser = candidate("p:2", { normalizedDistance: 0.2 });
    expect(selectBestMorphPickCandidate([sticky, materiallyCloser], "p:1")?.id).toBe("p:2");
  });

  it("uses opacity only after distance, depth, semantics, and role are tied", () => {
    const dim = candidate("p:1", { opacity: 0.35 });
    const clear = candidate("p:2", { opacity: 0.9 });
    expect(selectBestMorphPickCandidate([dim, clear])?.id).toBe("p:2");
  });

  it("stably resolves an exact tie by slot and id", () => {
    const later = candidate("p:z", { slot: 9 });
    const earlier = candidate("p:a", { slot: 3 });
    expect(selectBestMorphPickCandidate([later, earlier])?.id).toBe("p:a");
    expect(selectBestMorphPickCandidate([earlier, later])?.id).toBe("p:a");
  });

  it("rejects malformed distances, depths, and opacity without producing NaN behavior", () => {
    const malformed = [
      candidate("p:1", { normalizedDistance: Number.NaN }),
      candidate("p:2", { depth: Number.NaN }),
      candidate("p:3", { opacity: Number.NaN }),
    ];
    expect(selectBestMorphPickCandidate(malformed)).toBeNull();
  });

  it("applies mouse and touch slop to the actual projected picker", () => {
    const cam = fakeCamera();
    const nodes = fakeNodes(20);
    expect(pickAt(cam as never, nodes as never, 1, () => "p:1", [], 1, 32, 20, {
      slopPx: 8,
      source: "canvas",
    })).toBeNull();
    expect(pickAt(cam as never, nodes as never, 1, () => "p:1", [], 1, 32, 20, {
      slopPx: 14,
      source: "touch",
    })?.id).toBe("p:1");
  });

  it("matches the renderer's interpolated mid-morph position", () => {
    const cam = fakeCamera();
    const nodes = fakeNodes(0, 100);
    const currentX = easeQuintic(elementProgress(0.5, 0)) * 100;
    expect(pickAt(cam as never, nodes as never, 1, () => "p:1", [], 0.5, currentX, 20)?.id).toBe("p:1");
    expect(pickAt(cam as never, nodes as never, 1, () => "p:1", [], 0.5, 0, 20)).toBeNull();
  });

  it("considers region furniture only after an eligible entity node", () => {
    const region = {
      key: "region",
      x: 20,
      y: 20,
      z: 0,
      w: 30,
      h: 30,
      color: [1, 1, 1],
      alpha: 1,
      kind: 0,
      pick: "pr:region",
    };
    expect(pickAt(fakeCamera() as never, fakeNodes(20) as never, 1, () => "p:node", [region] as never, 1, 20, 20)?.id).toBe("p:node");
    const invisible = fakeNodes(20);
    invisible.alphaFrom[0] = invisible.alphaTo[0] = 0;
    expect(pickAt(fakeCamera() as never, invisible as never, 1, () => "p:node", [region] as never, 1, 20, 20)).toEqual({
      id: "pr:region",
      kind: "region",
    });
  });

  it("does not fall through from an organized active list into ambient corpus slots", () => {
    expect(pickAt(fakeCamera() as never, fakeNodes(20) as never, 1, () => "p:ambient", [], 1, 20, 20, {
      activeSlots: new Int32Array(0),
      activeSlotCount: 0,
      roles: Uint8Array.of(MR.BACKGROUND),
    })).toBeNull();
  });
});
