/**
 * Deterministic Arena Array spike corpus.
 *
 * The Three.js technique spikes are required to run against real corpus data,
 * not invented placeholders: real wrestling names carry real lengths (AAA's
 * p90 is 17 characters and its longest is 27), real strength distributions are
 * violently long-tailed, and real promotion spans decide how many era sections
 * a chronological fan actually has. Synthetic data would let a label field or
 * an aggregation threshold pass a spike it would fail in production.
 *
 * This reads only the already-materialized tree and writes one generated file
 * back into it, so the spikes fetch it through the dev server's existing
 * read-only /data/ route. The output is a build artifact under
 * data/materialized/ and is never committed, exactly like every other
 * projection.
 *
 * Two scopes are emitted because they stress different things:
 *
 *   person      one selected wrestler's documented neighbourhood, classified
 *               into the Arena's semantic banks — opposed-only, same-side-only
 *               and mixed-role — which is what the horseshoe seats.
 *   promotion   pr:c8 (AAA): 1,087 people against a 600-card budget, which is
 *               the case the spec names as the stress test and the case that
 *               forces semantic aggregation rather than merely suggesting it.
 *
 * Run: node tests/arena-spikes/build-spike-corpus.mjs
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAT = join(ROOT, "data", "materialized");
const OUT_DIR = join(MAT, "arena-spike");
const OUT = join(OUT_DIR, "corpus.json");

/** edges.bin field offsets — mirrors apps/web/src/graph/model.ts EF/STRIDE. */
const EF = { a: 0, b: 1, same: 2, opposed: 3, br: 4, title: 5, firstDay: 6, lastDay: 7, promoMask: 8, formMask: 9 };
const STRIDE = 10;

/** The corpus epoch is 1900-01-01 (docs/DECISIONS.md D-008), not 1950. */
const EPOCH_MS = Date.UTC(1900, 0, 1);
const dayToYear = (day) => new Date(EPOCH_MS + day * 86400000).getUTCFullYear();
const decadeOf = (year) => `${Math.floor(year / 10) * 10}s`;

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const readShards = (dir) => {
  const out = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    Object.assign(out, readJson(join(dir, file)));
  }
  return out;
};

console.log("reading materialized tree…");
const manifest = readJson(join(MAT, "manifest.json"));
const nodes = readJson(join(MAT, "graph", "nodes.json"));
const promotions = readJson(join(MAT, "graph", "promotions.json"));
const atlasPromos = readJson(join(MAT, "atlas", "promotions.json"));
const people = readShards(join(MAT, "entities", "people"));
const atlasPeople = readShards(join(MAT, "atlas", "people"));

const edgeBuf = readFileSync(join(MAT, "graph", "edges.bin"));
const edges = new Uint32Array(edgeBuf.buffer, edgeBuf.byteOffset, edgeBuf.byteLength / 4);
const edgeCount = edges.length / STRIDE;
console.log(`  ${nodes.count} nodes · ${edgeCount} edges · ${Object.keys(people).length} people`);

const indexOfId = new Map();
nodes.id.forEach((id, i) => indexOfId.set(id, i));

// CSR adjacency, same construction as GraphModel.
const degree = new Uint32Array(nodes.count);
for (let e = 0; e < edgeCount; e++) {
  degree[edges[e * STRIDE + EF.a]]++;
  degree[edges[e * STRIDE + EF.b]]++;
}
const adjOffsets = new Uint32Array(nodes.count + 1);
for (let i = 0; i < nodes.count; i++) adjOffsets[i + 1] = adjOffsets[i] + degree[i];
const adjNode = new Uint32Array(adjOffsets[nodes.count]);
const adjEdge = new Uint32Array(adjOffsets[nodes.count]);
const cursor = adjOffsets.slice(0, nodes.count);
for (let e = 0; e < edgeCount; e++) {
  const a = edges[e * STRIDE + EF.a];
  const b = edges[e * STRIDE + EF.b];
  adjNode[cursor[a]] = b; adjEdge[cursor[a]] = e; cursor[a]++;
  adjNode[cursor[b]] = a; adjEdge[cursor[b]] = e; cursor[b]++;
}

/**
 * One selected person's documented neighbourhood, split into the Arena's
 * three semantic banks. The split is the corpus's own distinction: `opposed`
 * counts documented opposition, `same` counts documented tag partnership, and
 * a pair carrying both is a genuinely different relationship from either.
 * Battle-royal co-presence is kept separate and low-weight because a battle
 * royal does not document a specific meeting (docs/CANONICAL-MODEL.md).
 */
function personScope(anchorId) {
  const ai = indexOfId.get(anchorId);
  if (ai === undefined) throw new Error(`anchor ${anchorId} is not a graph node`);
  const cards = [];
  for (let i = adjOffsets[ai]; i < adjOffsets[ai + 1]; i++) {
    const o = adjEdge[i] * STRIDE;
    const ni = adjNode[i];
    const other = nodes.id[ni];
    const person = people[other];
    if (!person) continue;
    const same = edges[o + EF.same];
    const opposed = edges[o + EF.opposed];
    const br = edges[o + EF.br];
    if (same + opposed + br === 0) continue;
    cards.push({
      id: other,
      name: person.n,
      bank: same > 0 && opposed > 0 ? "mixed" : same > 0 ? "same" : "opposed",
      same, opposed, br,
      titleMatches: edges[o + EF.title],
      strength: same + opposed + br * 0.25,
      firstYear: dayToYear(edges[o + EF.firstDay]),
      lastYear: dayToYear(edges[o + EF.lastDay]),
      // The Echo formation is required to start from the canonical graph
      // positions rather than from anywhere invented. They are already
      // normalized to roughly a unit box by global-layout@3, so "compressed
      // and bounded" costs a scale factor, not a re-layout.
      pos: [nodes.pos[ni * 3], nodes.pos[ni * 3 + 1], nodes.pos[ni * 3 + 2]],
      community: nodes.community[ni],
      reigns: nodes.reigns[ni],
    });
  }
  // matches-desc-then-id, the same stable order the atlas projection uses, so
  // any budget slice is deterministic rather than dependent on adjacency order.
  cards.sort((x, y) => y.strength - x.strength || (x.id < y.id ? -1 : 1));
  const anchor = people[anchorId];
  return {
    kind: "person",
    anchorId,
    anchorName: anchor?.n ?? anchorId,
    anchorMatches: anchor?.m ?? 0,
    total: cards.length,
    banks: {
      opposed: cards.filter((c) => c.bank === "opposed").length,
      same: cards.filter((c) => c.bank === "same").length,
      mixed: cards.filter((c) => c.bank === "mixed").length,
    },
    cards,
  };
}

/**
 * A promotion scope cannot be taken from the edge promoMask: only 30
 * promotions own a bit and pr:c8 is not one of them, so bit 30 means "AAA or
 * any of 540 others". Person-level `promos` counts are exact, and the atlas
 * per-person `routes` give each person's span inside that promotion — which
 * is the honest era, because a wrestler who debuted in 1978 and worked AAA in
 * 2005 belongs to AAA's 2000s, not to a 1970s section AAA never had.
 */
function promotionScope(prId) {
  const atlasIdx = atlasPromos.id.indexOf(prId);
  const cards = [];
  for (const [pid, person] of Object.entries(people)) {
    const inPromo = person.promos?.[prId];
    if (!inPromo) continue;
    const route = atlasPeople[pid]?.routes?.find((r) => r.pr === prId);
    const firstYear = route ? dayToYear(route.firstDay) : dayToYear(0);
    const lastYear = route ? dayToYear(route.lastDay) : firstYear;
    const ni = indexOfId.get(pid);
    cards.push({
      id: pid,
      name: person.n,
      scopedMatches: inPromo,
      scopedCards: route?.cards ?? null,
      strength: inPromo,
      firstYear, lastYear,
      era: decadeOf(firstYear),
      careerFirstYear: Number(person.first.slice(0, 4)),
      spanKnown: Boolean(route),
      pos: ni === undefined ? null : [nodes.pos[ni * 3], nodes.pos[ni * 3 + 1], nodes.pos[ni * 3 + 2]],
      community: ni === undefined ? -1 : nodes.community[ni],
      reigns: ni === undefined ? 0 : nodes.reigns[ni],
    });
  }
  cards.sort((x, y) => y.strength - x.strength || (x.id < y.id ? -1 : 1));

  const eraCounts = {};
  for (const c of cards) eraCounts[c.era] = (eraCounts[c.era] ?? 0) + 1;
  // The distance between scoped era and global debut decade is the trap this
  // scope exists to keep honest; report it rather than discovering it later.
  const eraDiffers = cards.filter((c) => decadeOf(c.careerFirstYear) !== c.era).length;

  return {
    kind: "promotion",
    promotionId: prId,
    promotionName: promotions[prId]?.n ?? prId,
    hasPromoBit: promotions[prId]?.bit !== undefined,
    atlas: atlasIdx >= 0
      ? {
          matches: atlasPromos.matches[atlasIdx], cards: atlasPromos.cards[atlasIdx],
          people: atlasPromos.people[atlasIdx], titles: atlasPromos.titles[atlasIdx],
          yearFrom: atlasPromos.yearFrom[atlasIdx], yearCounts: atlasPromos.yearCounts[atlasIdx],
        }
      : null,
    total: cards.length,
    eraCounts,
    eraDiffersFromGlobalDebut: eraDiffers,
    singleMatchTail: cards.filter((c) => c.strength === 1).length,
    strongTen: cards.filter((c) => c.strength >= 10).length,
    cards,
  };
}

const PERSON_ANCHORS = ["p:d7fbacefc", "p:ccf01da71"]; // Psycho Clown, Chessman — densest AAA careers
const scopes = {};
for (const id of PERSON_ANCHORS) {
  const scope = personScope(id);
  scopes[`person:${id}`] = scope;
  console.log(`  person ${scope.anchorName}: ${scope.total} related (${JSON.stringify(scope.banks)})`);
}
const aaa = promotionScope("pr:c8");
scopes["promotion:pr:c8"] = aaa;
console.log(`  promotion ${aaa.promotionName}: ${aaa.total} people, eras ${JSON.stringify(aaa.eraCounts)}`);
console.log(`    scoped era differs from global debut decade for ${aaa.eraDiffersFromGlobalDebut} of them`);

// A widest-possible neighbourhood, so the 600-card budget is exercised by a
// real career rather than by padding AAA out with invented cards.
const widest = Object.entries(people)
  .filter(([id]) => indexOfId.has(id))
  .map(([id, p]) => ({ id, n: p.n, deg: adjOffsets[indexOfId.get(id) + 1] - adjOffsets[indexOfId.get(id)] }))
  .sort((a, b) => b.deg - a.deg)[0];
const widestScope = personScope(widest.id);
scopes[`person:${widest.id}`] = widestScope;
console.log(`  widest person ${widestScope.anchorName}: ${widestScope.total} related`);

const nameLengths = aaa.cards.map((c) => c.name.length).sort((a, b) => a - b);
const pct = (q) => nameLengths[Math.min(nameLengths.length - 1, Math.ceil(nameLengths.length * q) - 1)];

const payload = {
  version: 1,
  generator: "arena-spike-corpus@1",
  sourceManifest: { projection_version: manifest.projection_version, built_at: manifest.built_at },
  note: "Generated build artifact for development-only Arena Array spikes. Never committed.",
  nameLengths: { min: nameLengths[0], p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: nameLengths[nameLengths.length - 1] },
  budgets: [160, 360, 600],
  scopes,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(payload)}\n`);
console.log(`wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(0)} KB)`);
console.log(`name lengths: ${JSON.stringify(payload.nameLengths)}`);
