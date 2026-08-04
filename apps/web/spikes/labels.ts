/**
 * SPIKE 5 — the label field.
 *
 * The audit rejected CSS2DRenderer: it offers less than the pooled DOM
 * labelling this repository already ships in MorphLabels.ts, and its layer
 * "gate" still runs the projection maths for hidden labels. This spike
 * validates the pooled approach against the real corpus, where names are long
 * (AAA's p90 is 17 characters, longest 27) and the field is dense.
 *
 * What it has to prove:
 *   - DOM nodes are reused, never created per frame
 *   - collision suppression is deterministic and priority-ordered
 *   - selected / focused labels are NEVER dropped, whatever the density
 *   - the update cadence is capped without labels visibly lagging the cards
 */
import {
  DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh,
  PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, Vector3, WebGLRenderer,
} from "three";
import { CS, FormationTransition, SlotPool, easeQuintic } from "./formation-transition";
import { eraSections, layoutArena, layoutIndex, personSections } from "./formation-layouts";
import { budgetSlice, loadSpikeCorpus, type SpikeCard, type SpikeCorpus, type SpikeScope } from "./spike-corpus";

const CAPACITY = 640;
const LABEL_POOL = 96;

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const labelLayer = document.getElementById("labels") as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new Scene();
const camera = new PerspectiveCamera(46, 1, 0.1, 400);

const geometry = new PlaneGeometry(1, 1);
const instanceState = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
instanceState.setUsage(DynamicDrawUsage);
geometry.setAttribute("instanceState", instanceState);
const cards = new InstancedMesh(geometry, new ShaderMaterial({
  transparent: true, depthWrite: false, side: DoubleSide,
  vertexShader: `attribute float instanceState; varying vec2 vUv; varying float vState;
    void main(){ vUv=uv; vState=instanceState;
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.0); }`,
  fragmentShader: `precision highp float; varying vec2 vUv; varying float vState;
    void main(){ if (vState < 0.5) discard;
      vec2 p = abs(vUv-0.5)*2.0; float b = smoothstep(0.955,1.0,max(p.x,p.y));
      gl_FragColor = vec4(mix(vec3(0.06,0.08,0.11), vec3(0.55,0.62,0.72), b), 0.92); }`,
}), CAPACITY);
cards.instanceMatrix.setUsage(DynamicDrawUsage);
cards.frustumCulled = false;
scene.add(cards);

const transition = new FormationTransition(CAPACITY);
const pool = new SlotPool(CAPACITY);
const matrices = cards.instanceMatrix.array as Float32Array;
transition.setOnReleased((slot) => { const id = pool.idOf(slot); if (id) pool.release(id); });

// ----------------------------------------------------------- label pooling
/**
 * A fixed pool of DOM nodes, allocated once. A label is bound to a card by
 * assignment, never by creation, so a dense frame costs text and transform
 * writes rather than DOM churn.
 */
interface LabelSlot {
  el: HTMLDivElement;
  boundId: string | null;
  text: string;
  shown: boolean;
}
const labelSlots: LabelSlot[] = [];
for (let i = 0; i < LABEL_POOL; i++) {
  const el = document.createElement("div");
  el.className = "arena-label";
  el.style.display = "none";
  labelLayer.appendChild(el);
  labelSlots.push({ el, boundId: null, text: "", shown: false });
}
let domCreations = LABEL_POOL;

/** Priority ladder, straight from the brief. Lower number wins. */
const PRIORITY = { SELECTED: 0, FOCUS: 1, HOVER: 2, HEADING: 3, PINNED: 4, TOP: 5, REST: 6 } as const;

interface Candidate {
  id: string;
  slot: number;
  name: string;
  priority: number;
  x: number;
  y: number;
  depth: number;
  w: number;
  h: number;
}
/** Preallocated candidate scratch — the label pass allocates nothing. */
const candidates: Candidate[] = [];
for (let i = 0; i < CAPACITY; i++) {
  candidates.push({ id: "", slot: -1, name: "", priority: PRIORITY.REST, x: 0, y: 0, depth: 0, w: 0, h: 0 });
}
let candidateCount = 0;

/**
 * Real measured text width, cached per string.
 *
 * Estimating from character count (`8 + name.length * 6.1`) produced 1-3
 * genuinely overlapping label pairs per view in SPIKE 5, because proportional
 * type makes "Pimpinela Escarlata" and "El Hijo Del Vikingo" different widths
 * at identical length. Canvas measureText is exact for the same font and costs
 * one measurement per distinct name for the life of the page.
 */
const measureCtx = document.createElement("canvas").getContext("2d")!;
measureCtx.font = '11px ui-sans-serif, system-ui, sans-serif';
const widthCache = new Map<string, number>();
function textWidth(text: string): number {
  let w = widthCache.get(text);
  if (w === undefined) {
    w = measureCtx.measureText(text).width;
    widthCache.set(text, w);
  }
  return w;
}

const projVec = new Vector3();
let selectedId: string | null = null;
let hoverId: string | null = null;

let labelReport = { wanted: 0, shown: 0, suppressed: 0, updateMs: 0 };

/**
 * Deterministic collision suppression: sort by priority then by a stable id,
 * and accept a label only if its box clears everything already accepted.
 * Nothing is dropped at random and nothing is shrunk to fit.
 */
function updateLabels(cardsById: Map<string, SpikeCard>, budget: number): void {
  const t0 = performance.now();
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  candidateCount = 0;

  for (let slot = 0; slot < CAPACITY; slot++) {
    if (transition.state[slot] === CS.ABSENT) continue;
    const id = pool.idOf(slot);
    if (!id) continue;
    const card = cardsById.get(id);
    if (!card) continue;
    const i3 = slot * 3;
    projVec.set(transition.posCur[i3]!, transition.posCur[i3 + 1]!, transition.posCur[i3 + 2]!);
    projVec.project(camera);
    if (projVec.z < -1 || projVec.z > 1) continue;
    const x = (projVec.x * 0.5 + 0.5) * w;
    const y = (-projVec.y * 0.5 + 0.5) * h;
    if (x < -60 || y < -20 || x > w + 60 || y > h + 20) continue;
    const c = candidates[candidateCount]!;
    c.id = id;
    c.slot = slot;
    c.name = card.name;
    c.priority = id === selectedId ? PRIORITY.SELECTED
      : id === hoverId ? PRIORITY.HOVER
      : card.strength >= 10 ? PRIORITY.TOP : PRIORITY.REST;
    c.x = x;
    c.y = y;
    c.depth = projVec.z;
    // Measured, not estimated, and padded by the gap a reader needs between
    // two adjacent names.
    c.w = textWidth(card.name) + 10;
    c.h = 17;
    candidateCount++;
  }

  const live = candidates.slice(0, candidateCount);
  live.sort((a, b) => a.priority - b.priority || a.depth - b.depth || (a.id < b.id ? -1 : 1));

  const acceptedX: number[] = [];
  const acceptedY: number[] = [];
  const acceptedW: number[] = [];
  const acceptedH: number[] = [];
  let shown = 0;
  let suppressed = 0;

  for (const c of live) {
    if (shown >= Math.min(budget, LABEL_POOL)) { suppressed++; continue; }
    // Top-left boxes, because that is how the labels are actually positioned:
    // transform: translate(x, y) with transform-origin 0 0. Testing
    // centre-based boxes against top-left-rendered elements left real overlaps
    // on screen while the suppression pass believed it had cleared them.
    let clashes = false;
    for (let i = 0; i < acceptedX.length; i++) {
      if (c.x < acceptedX[i]! + acceptedW[i]! && c.x + c.w > acceptedX[i]! &&
          c.y < acceptedY[i]! + acceptedH[i]! && c.y + c.h > acceptedY[i]!) { clashes = true; break; }
    }
    // Selected and focused labels are never collision-dropped: they displace
    // whatever is under them instead of disappearing.
    if (clashes && c.priority > PRIORITY.HOVER) { suppressed++; continue; }
    const slot = labelSlots[shown]!;
    if (slot.boundId !== c.id || slot.text !== c.name) {
      slot.el.textContent = c.name;
      slot.text = c.name;
      slot.boundId = c.id;
    }
    slot.el.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`;
    slot.el.style.opacity = c.priority <= PRIORITY.HOVER ? "1" : "0.78";
    if (!slot.shown) { slot.el.style.display = "block"; slot.shown = true; }
    acceptedX.push(c.x); acceptedY.push(c.y); acceptedW.push(c.w); acceptedH.push(c.h);
    shown++;
  }
  for (let i = shown; i < LABEL_POOL; i++) {
    const slot = labelSlots[i]!;
    if (slot.shown) { slot.el.style.display = "none"; slot.shown = false; }
  }
  labelReport = { wanted: candidateCount, shown, suppressed, updateMs: performance.now() - t0 };
}

// ------------------------------------------------------------------ driving
let corpus: SpikeCorpus | null = null;
let scope: SpikeScope | null = null;
let active: SpikeCard[] = [];
let byId = new Map<string, SpikeCard>();
let anchorId = "";
let labelBudget = 48;
let formation: "arena" | "index" = "arena";
let cadenceHz = 30;
let lastLabelMs = 0;

function applyFormation(name: "arena" | "index", immediate = false): void {
  if (!scope) return;
  formation = name;
  transition.captureCurrent();
  if (name === "arena") {
    layoutArena(transition, pool, active, anchorId,
      scope.kind === "promotion" ? eraSections(active) : personSections());
    camera.position.set(0, 7.5, 21); camera.lookAt(0, 0.5, 0);
  } else {
    layoutIndex(transition, pool, active, anchorId,
      (c) => (scope!.kind === "promotion" ? (c.era ?? "?") : (c.bank ?? "?")));
    camera.position.set(0, -8, 26); camera.lookAt(0, -8, 0);
  }
  transition.commit(performance.now(), immediate);
}

function selectScope(key: string, budget: number): void {
  if (!corpus) return;
  const next = corpus.scopes[key];
  if (!next) throw new Error(`unknown scope ${key}`);
  for (const c of active) pool.release(c.id);
  if (anchorId) pool.release(anchorId);
  transition.state.fill(CS.ABSENT);
  transition.present.fill(0);
  scope = next;
  anchorId = next.anchorId ?? `${next.promotionId}`;
  active = budgetSlice(next, budget);
  byId = new Map(active.map((c) => [c.id, c]));
  selectedId = anchorId;
  applyFormation(formation, true);
}

function resize(): void {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
canvas.addEventListener("webglcontextrestored", () => { resize(); applyFormation(formation, true); });

function tick(now: number): void {
  requestAnimationFrame(tick);
  transition.tick(now);
  transition.writeMatrices(matrices);
  cards.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < CAPACITY; i++) (instanceState.array as Float32Array)[i] = transition.state[i]!;
  instanceState.needsUpdate = true;
  // Labels update at a capped cadence, not every frame; cards keep moving at
  // full rate underneath.
  const interval = 1000 / cadenceHz;
  if (now - lastLabelMs >= interval) { lastLabelMs = now; updateLabels(byId, labelBudget); }
  renderer.render(scene, camera);
  hud.textContent = `${formation} cards=${active.length} labels ${labelReport.shown}/${labelReport.wanted} (suppressed ${labelReport.suppressed}) update=${labelReport.updateMs.toFixed(2)}ms dom=${domCreations}`;
}

declare global {
  interface Window { __arenaLabels?: Record<string, unknown> }
}

async function boot(): Promise<void> {
  corpus = await loadSpikeCorpus();
  resize();
  selectScope("person:p:d7fbacefc", 203);
  requestAnimationFrame(tick);
  window.__arenaLabels = {
    ready: true,
    contextLost: () => renderer.getContext().isContextLost(),
    select: (k: string, n: number) => selectScope(k, n),
    setFormation: (f: "arena" | "index") => applyFormation(f),
    animating: () => transition.animating,
    setBudget: (n: number) => { labelBudget = n; },
    setCadence: (hz: number) => { cadenceHz = hz; },
    setSelected: (id: string | null) => { selectedId = id; },
    setHover: (id: string | null) => { hoverId = id; },
    report: () => ({ ...labelReport }),
    selectedId: () => selectedId,
    domNodes: () => labelLayer.childElementCount,
    domCreations: () => domCreations,
    /** Which ids currently have a visible label. */
    shownIds: () => labelSlots.filter((s) => s.shown).map((s) => s.boundId),
    labelBoxes: () => labelSlots.filter((s) => s.shown).map((s) => {
      const r = s.el.getBoundingClientRect();
      return { id: s.boundId, x: r.x, y: r.y, w: r.width, h: r.height };
    }),
    forceUpdate: () => updateLabels(byId, labelBudget),
    gpu: () => {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      return String((gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null) ?? "unknown");
    },
  };
  void easeQuintic;
}

void boot().catch((error: unknown) => {
  hud.textContent = `spike failed: ${String(error)}`;
  throw error;
});
