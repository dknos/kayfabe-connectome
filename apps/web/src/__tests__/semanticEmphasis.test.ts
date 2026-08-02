// SYNTHETIC state fixtures — never production evidence.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChampionshipsFile,
  Manifest,
  NodesColumnar,
  PeopleBucket,
  SearchEntity,
} from "@kayfabe/graph-contract";
import {
  ME,
  writeMorphEmphasis,
  type MorphEmphasis,
} from "@kayfabe/morph-renderer";
import type { CoreData } from "../data/loader";
import { loadChampionships, loadPersonDossier } from "../data/loader";
import {
  selectSemanticEmphasis,
  semanticEmphasisChanged,
} from "../graph/semanticEmphasis";
import { EF, GraphModel, STRIDE } from "../graph/model";
import { restoreFromUrl, useStore } from "../state/store";

vi.mock("../data/loader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/loader")>();
  return {
    ...actual,
    loadChampionships: vi.fn(),
    loadPersonDossier: vi.fn(),
  };
});

const manifest = {
  schema_version: "2.0.0",
  built_at: "",
  source_fingerprint: "semantic-test",
  layout_version: "test",
  projection_version: "test",
  algorithms: {},
  counts: {},
  date_range: ["2000-01-01", "2002-12-31"],
  edges_bin: { count: 2, stride_u32: STRIDE, fields: [] },
  promo_bits: { old: 0, new: 1, promo: 2 },
  form_bits: {},
  checksums: {},
  validation: { passed: true, checks: {} },
} as unknown as Manifest;

const nodes: NodesColumnar = {
  count: 7,
  id: ["p:a", "p:b", "p:c", "t:title", "pr:old", "pr:new", "pr:promo"],
  type: [0, 0, 0, 2, 1, 1, 1],
  name: ["A", "B", "C", "Test Title", "Old", "New", "Promo"],
  community: [0, 0, 0, 0, 0, 0, 0],
  pos: new Array(21).fill(0),
  firstDay: new Array(7).fill(0),
  lastDay: new Array(7).fill(1_000),
  matches: [2, 2, 1, 0, 0, 0, 0],
  degree: [1, 2, 1, 0, 0, 0, 0],
  reigns: [0, 0, 0, 1, 0, 0, 0],
  promoMask: [1, 1, 2, 0, 1, 2, 4],
  resolution: [0, 0, 0, 0, 0, 0, 0],
};

function edge(a: number, b: number): number[] {
  const row = new Array(STRIDE).fill(0);
  row[EF.a] = a;
  row[EF.b] = b;
  row[EF.opposed] = 1;
  row[EF.firstDay] = 1;
  row[EF.lastDay] = 2;
  row[EF.promoMask] = 1;
  row[EF.formMask] = 1;
  return row;
}

const edges = Uint32Array.from([...edge(0, 1), ...edge(1, 2)]);
const model = new GraphModel(nodes, edges, manifest);
const search: SearchEntity[] = nodes.id.map((id, i) => ({
  id,
  n: nodes.name[i]!,
  t: nodes.type[i] === 0 ? "person" : nodes.type[i] === 1 ? "promotion" : "title",
  m: nodes.matches[i]!,
}));
search.push(
  { id: "t:virtual", n: "Virtual Test Title", t: "title", m: 1 },
  { id: "p:missing", n: "Listed Missing Holder", t: "person", m: 1 },
);
const core: CoreData = {
  manifest,
  nodes,
  edges,
  search,
  communities: { count: 0, label: [], size: [], center: [], topMembers: [] },
  density: { years: {} },
  promotions: {},
};

function dossier(name: string, promos: string[]): PeopleBucket[string] {
  return {
    n: name,
    first: "2000-01-01",
    last: "2002-12-31",
    m: 2,
    promos: Object.fromEntries(promos.map((id) => [id, 1])),
    years: { "2000": 1 },
    top: { partners: [], opponents: [] },
    teams: [],
    titles: [],
    src: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const mockedChampionships = vi.mocked(loadChampionships);
const mockedDossier = vi.mocked(loadPersonDossier);

beforeAll(() => {
  vi.stubGlobal("location", { hash: "" });
  vi.stubGlobal("history", { replaceState: vi.fn() });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useFakeTimers();
  mockedChampionships.mockReset();
  mockedDossier.mockReset();
  mockedChampionships.mockResolvedValue({});
  mockedDossier.mockResolvedValue({});
  useStore.setState({
    ...useStore.getInitialState(),
    core,
    model,
    selection: null,
    members: { ids: [], basis: "" },
    memberGroup: "all",
    pinned: [],
    pathResult: null,
    hoverId: null,
  });
  location.hash = "";
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("canonical semantic emphasis", () => {
  it("selects every ID-level channel without deriving semantics from layout roles", () => {
    const state = useStore.getState();
    const source = {
      ...state,
      selection: { kind: "node" as const, id: "p:a" },
      hoverId: "p:b",
      members: {
        ids: ["p:b", "p:c"],
        anchors: ["pr:promo"],
        basis: "documented matches",
        caveat: "evidence caveat",
        coverageWarnings: ["one person is not graph-resident"],
      },
      pinned: ["p:c"],
      pathResult: { nodes: ["p:a", "p:b"], edges: [0] },
      memberGroup: "opposed" as const,
      isolate: true,
    };
    const semantic = selectSemanticEmphasis(source);
    expect(semantic).toMatchObject({
      selected: "p:a",
      hovered: "p:b",
      members: ["p:b", "p:c"],
      anchors: ["pr:promo"],
      pinned: ["p:c"],
      pathNodes: ["p:a", "p:b"],
      memberGroup: "opposed",
      basis: "documented matches",
      caveat: "evidence caveat",
      coverageWarnings: ["one person is not graph-resident"],
      isolate: true,
    });
    expect(semanticEmphasisChanged(source, state)).toBe(true);
    expect(semanticEmphasisChanged(source, source)).toBe(false);
  });

  it("writes strict semantic priority after role dimming, including virtual slots", () => {
    const target = {
      emph: new Float32Array(8),
      semantic: new Float32Array(8),
    };
    const emphasis: MorphEmphasis = {
      selected: 4,
      hovered: 3,
      selectedId: null,
      hoveredId: null,
      anchors: [0],
      members: [0, 1],
      pinned: [1, 2],
      pathNodes: [2, 3],
      virtualMembers: ["p:virtual"],
      virtualAnchors: ["pr:virtual"],
      memberGroup: "all",
      basis: "test",
      caveat: null,
      coverageWarnings: [],
      dimBackground: true,
    };
    const virtuals = new Map([["p:virtual", 6], ["pr:virtual", 7]]);
    writeMorphEmphasis(
      target,
      emphasis,
      new Uint8Array(5),
      5,
      (id) => virtuals.get(id) ?? null,
    );

    expect([...target.semantic]).toEqual([
      ME.MEMBER,
      ME.MEMBER,
      ME.PATH,
      ME.HOVERED,
      ME.SELECTED,
      ME.AMBIENT,
      ME.MEMBER,
      ME.ANCHOR,
    ]);
    expect(target.emph[4]).toBeGreaterThan(target.emph[3]!);
    expect(target.emph[3]).toBeGreaterThan(target.emph[2]!);
    expect(target.emph[2]).toBeGreaterThan(target.emph[1]!);
    expect(target.emph[1]).toBeGreaterThan(target.emph[7]!);
    expect(target.emph[7]).toBeGreaterThan(target.emph[5]!);
  });
});

describe("guarded asynchronous member publication", () => {
  it("publishes title loading immediately and rejects a late result after selection changes", async () => {
    const titleLoad = deferred<ChampionshipsFile>();
    mockedChampionships.mockReturnValueOnce(titleLoad.promise);

    useStore.getState().select({ kind: "node", id: "t:title" });
    expect(useStore.getState().members).toMatchObject({ ids: [], basis: "loading reigns…" });

    useStore.getState().select({ kind: "node", id: "p:a" });
    expect(useStore.getState().members.ids).toEqual(["p:b"]);
    titleLoad.resolve({
      "t:title": {
        n: "Test Title",
        pr: "pr:promo",
        artifact: false,
        reigns: [{ holders: ["p:c"], s: "2000-01-01", e: null, m: "m:1" }],
        titleMatches: 1,
        changes: 1,
      },
    });
    await flush();

    expect(useStore.getState().selection).toEqual({ kind: "node", id: "p:a" });
    expect(useStore.getState().members.ids).toEqual(["p:b"]);
  });

  it("uses a generation token when the same person is selected again", async () => {
    const oldA = deferred<PeopleBucket>();
    const currentA = deferred<PeopleBucket>();
    mockedDossier
      .mockReturnValueOnce(oldA.promise)
      .mockResolvedValueOnce({ "p:c": dossier("C", []) })
      .mockReturnValueOnce(currentA.promise);

    useStore.getState().select({ kind: "node", id: "p:a" });
    useStore.getState().select({ kind: "node", id: "p:c" });
    useStore.getState().select({ kind: "node", id: "p:a" });

    oldA.resolve({ "p:a": dossier("A stale", ["pr:old"]) });
    await flush();
    expect(useStore.getState().members.anchors).toBeUndefined();

    currentA.resolve({ "p:a": dossier("A current", ["pr:new"]) });
    await flush();
    expect(useStore.getState().members.anchors).toEqual(["pr:new"]);
    expect(useStore.getState().pulseScope?.label).toBe("A current");
  });

  it("publishes late dossier anchors as a semantic update", async () => {
    const personLoad = deferred<PeopleBucket>();
    mockedDossier.mockReturnValueOnce(personLoad.promise);
    const observed: string[][] = [];
    const unsub = useStore.subscribe((next, previous) => {
      if (semanticEmphasisChanged(next, previous)) {
        observed.push([...selectSemanticEmphasis(next).anchors]);
      }
    });

    useStore.getState().select({ kind: "node", id: "p:a" });
    expect(useStore.getState().members.ids).toEqual(["p:b"]);
    personLoad.resolve({ "p:a": dossier("A", ["pr:promo"]) });
    await flush();
    unsub();

    expect(selectSemanticEmphasis(useStore.getState()).anchors).toEqual(["pr:promo"]);
    expect(observed).toContainEqual(["pr:promo"]);
  });

  it("resolves a virtual belt's resident and non-resident holders", async () => {
    mockedChampionships.mockResolvedValueOnce({
      "t:virtual": {
        n: "Virtual Test Title",
        pr: "pr:promo",
        artifact: false,
        reigns: [{ holders: ["p:b", "p:missing"], s: "2000-01-01", e: null, m: "m:virtual" }],
        titleMatches: 1,
        changes: 1,
      },
    });

    useStore.getState().select({ kind: "node", id: "t:virtual" });
    expect(useStore.getState().members.basis).toBe("loading reigns…");
    await flush();

    expect(useStore.getState().members.ids).toEqual(["p:b"]);
    expect(useStore.getState().members.nonResident).toEqual([
      { id: "p:missing", name: "Listed Missing Holder", reason: "not graph-resident" },
    ]);
    expect(useStore.getState().members.coverageWarnings?.[0]).toContain("cannot light");
  });

  it("resolves members through focus and URL-restore selection entry points", () => {
    useStore.getState().focus("p:a");
    expect(useStore.getState().selection).toEqual({ kind: "node", id: "p:a" });
    expect(useStore.getState().members.ids).toEqual(["p:b"]);

    useStore.setState({ selection: null, members: { ids: [], basis: "" } });
    location.hash = "#2/sel=p:c";
    restoreFromUrl();
    expect(useStore.getState().selection).toEqual({ kind: "node", id: "p:c" });
    expect(useStore.getState().members.ids).toEqual(["p:b"]);
  });

  it.each([
    ["atlas", "morph"],
    ["table", "connectome"],
    ["geoTable", "geo"],
    ["unknown", "connectome"],
  ] as const)("migrates removed lens=%s URLs to %s", (legacy, expected) => {
    location.hash = `#2/lens=${legacy}`;
    restoreFromUrl();
    expect(useStore.getState().lens).toBe(expected);
    expect(["connectome", "morph", "geo"]).toContain(useStore.getState().lens);
  });
});
