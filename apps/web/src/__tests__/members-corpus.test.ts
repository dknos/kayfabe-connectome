import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  ChampionshipsFile,
  Manifest,
  NodesColumnar,
  SearchEntity,
} from "@kayfabe/graph-contract";
import {
  ME,
  writeMorphEmphasis,
  type MorphEmphasis,
} from "@kayfabe/morph-renderer";
import { resolveMembers, type MemberResult } from "../graph/members";
import { GraphModel } from "../graph/model";

/** These are current-corpus regression tests, not synthetic fixtures. They
 * deliberately resolve the production materialization before asserting the
 * measured populations, so renderer coverage cannot drift to a drawn-edge or
 * layout-role subset. */
const materialized = (path: string) =>
  new URL(`../../../../data/materialized/${path}`, import.meta.url);
const json = <T>(path: string): T =>
  JSON.parse(readFileSync(materialized(path), "utf8")) as T;

const manifest = json<Manifest>("manifest.json");
const nodes = json<NodesColumnar>("graph/nodes.json");
const search = json<SearchEntity[]>("search/entities.json");
const championships = json<ChampionshipsFile>("entities/championships.json");
const rawEdges = readFileSync(materialized("graph/edges.bin"));
const edges = new Uint32Array(
  rawEdges.buffer,
  rawEdges.byteOffset,
  rawEdges.byteLength / Uint32Array.BYTES_PER_ELEMENT,
);
const model = new GraphModel(nodes, edges, manifest);

function exactNodeId(name: string, type: NodesColumnar["type"][number]): string {
  const hits = nodes.id.filter((_id, i) => nodes.name[i] === name && nodes.type[i] === type);
  expect(hits, `${name} must resolve to one canonical graph node`).toHaveLength(1);
  return hits[0]!;
}

function rendererMemberCount(result: MemberResult, selectedId: string): number {
  const slots = result.ids.map((id) => model.indexOfId.get(id)).filter((v): v is number => v !== undefined);
  const target = {
    emph: new Float32Array(nodes.count),
    semantic: new Float32Array(nodes.count),
  };
  const emphasis: MorphEmphasis = {
    selected: model.indexOfId.get(selectedId) ?? -1,
    hovered: -1,
    selectedId: null,
    hoveredId: null,
    pinned: [],
    pathNodes: [],
    members: slots,
    anchors: [],
    virtualMembers: [],
    virtualAnchors: [],
    memberGroup: "all",
    basis: result.basis,
    caveat: result.caveat ?? null,
    coverageWarnings: result.coverageWarnings ?? [],
    dimBackground: true,
  };
  writeMorphEmphasis(target, emphasis, new Uint8Array(nodes.count), nodes.count, () => null);
  let count = 0;
  for (const level of target.semantic) if (level === ME.MEMBER) count++;
  return count;
}

describe("current corpus semantic membership", () => {
  it("lights Ric Flair's full adjacency, not a rendered trace subset", () => {
    const id = exactNodeId("Ric Flair", 0);
    const result = resolveMembers(model, manifest, search, id, null);
    expect(new Set(result.ids).size).toBe(result.ids.length);
    expect(result.ids).toHaveLength(398);
    expect(rendererMemberCount(result, id)).toBe(result.ids.length);
  });

  it("lights every graph-resident wrestler documented in AJPW", () => {
    const id = exactNodeId("AJPW", 1);
    const result = resolveMembers(model, manifest, search, id, null);
    expect(new Set(result.ids).size).toBe(result.ids.length);
    expect(result.ids).toHaveLength(1_563);
    expect(rendererMemberCount(result, id)).toBe(result.ids.length);
  });

  it("lights WWF Hardcore Title holders only, from explicit reign records", () => {
    const id = exactNodeId("WWF Hardcore Title", 2);
    const result = resolveMembers(model, manifest, search, id, championships);
    expect(new Set(result.ids).size).toBe(result.ids.length);
    expect(result.ids).toHaveLength(37);
    expect(result.basis).toContain("documented holding");
    expect(result.caveat).toContain("not lit");
    expect(rendererMemberCount(result, id)).toBe(result.ids.length);
  });
});
