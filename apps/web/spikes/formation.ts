/**
 * SPIKE 1 — formation morph.
 *
 * Development-only. Not reachable from the application, not part of the
 * production bundle (vite builds index.html only), and deliberately ugly: it
 * exists to produce numbers, not a look.
 *
 * What it measures, per the spec's SPIKE 1 list: layout generation time,
 * transition CPU time, frame time, allocations, draw calls and memory — at
 * 160 / 360 / 600 cards, across Echo → Arena → Index, including a retarget
 * fired mid-flight.
 */
import {
  BufferGeometry, Color, DynamicDrawUsage,
  InstancedBufferAttribute, InstancedMesh, PerspectiveCamera, PlaneGeometry,
  Scene, ShaderMaterial, Vector3, WebGLRenderer,
} from "three";
import { CS, FormationTransition, SlotPool, easeQuintic } from "./formation-transition";
import {
  eraSections, layoutArena, layoutEcho, layoutIndex, personSections, type LayoutResult,
} from "./formation-layouts";
import { budgetSlice, loadSpikeCorpus, type SpikeCard, type SpikeCorpus, type SpikeScope } from "./spike-corpus";

const CAPACITY = 640; // 600-card budget plus headroom for leaving cards

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new Scene();
const camera = new PerspectiveCamera(46, 1, 0.1, 400);

/** One shared plane, one shared material, one draw call for the whole field. */
const base = new PlaneGeometry(1, 1) as BufferGeometry;
const geometry = base.clone();

const instanceRole = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
const instanceEmphasis = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
const instanceStrength = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
const instanceProgress = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
const instanceState = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
for (const attribute of [instanceRole, instanceEmphasis, instanceStrength, instanceProgress, instanceState]) {
  attribute.setUsage(DynamicDrawUsage);
}
geometry.setAttribute("instanceRole", instanceRole);
geometry.setAttribute("instanceEmphasis", instanceEmphasis);
geometry.setAttribute("instanceStrength", instanceStrength);
geometry.setAttribute("instanceProgress", instanceProgress);
geometry.setAttribute("instanceState", instanceState);

/** One scratch vector for the probe seam; the render path allocates nothing. */
const probeVec = new Vector3();

const material = new ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uOpposed: { value: new Color(0xff7a4d) },
    uSame: { value: new Color(0x49d7ff) },
    uMixed: { value: new Color(0xe8dfcf) },
    uCenter: { value: new Color(0xffd479) },
  },
  vertexShader: /* glsl */ `
    attribute float instanceRole;
    attribute float instanceEmphasis;
    attribute float instanceStrength;
    attribute float instanceProgress;
    attribute float instanceState;
    varying vec2 vUv;
    varying float vRole;
    varying float vEmphasis;
    varying float vStrength;
    varying float vFade;
    void main() {
      vUv = uv;
      vRole = instanceRole;
      vEmphasis = instanceEmphasis;
      vStrength = instanceStrength;
      // entering cards dissolve in, leaving cards dissolve out; retained cards
      // stay fully opaque so they remain trackable through the whole morph
      vFade = instanceState < 0.5 ? 0.0
            : instanceState < 1.5 ? instanceProgress
            : instanceState < 2.5 ? 1.0
            : 1.0 - instanceProgress;
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform vec3 uOpposed; uniform vec3 uSame; uniform vec3 uMixed; uniform vec3 uCenter;
    varying vec2 vUv; varying float vRole; varying float vEmphasis; varying float vStrength; varying float vFade;
    void main() {
      if (vFade <= 0.001) discard;
      vec3 accent = vRole < 0.5 ? uOpposed : vRole < 1.5 ? uSame : vRole < 2.5 ? uMixed : uCenter;
      vec2 p = abs(vUv - 0.5) * 2.0;
      float edge = max(p.x, p.y);
      // a restrained plaque: dark body, accent rail down one side, edge light
      float rail = smoothstep(0.90, 0.94, p.x) * step(vUv.x, 0.5);
      float border = smoothstep(0.955, 1.0, edge);
      vec3 body = mix(vec3(0.055, 0.070, 0.098), vec3(0.10, 0.12, 0.16), 1.0 - p.y * 0.5);
      vec3 col = mix(body, accent, max(rail, border * (0.35 + vEmphasis * 0.5)));
      col += accent * vStrength * 0.10;
      gl_FragColor = vec4(col, vFade * (0.55 + vEmphasis * 0.45));
    }
  `,
});

const mesh = new InstancedMesh(geometry, material, CAPACITY);
mesh.instanceMatrix.setUsage(DynamicDrawUsage);
mesh.frustumCulled = false;
scene.add(mesh);

const transition = new FormationTransition(CAPACITY);
const pool = new SlotPool(CAPACITY);
const matrices = mesh.instanceMatrix.array as Float32Array;
// A leaving card's slot returns to the pool only after its exit has played.
transition.setOnReleased((slot) => {
  const id = pool.idOf(slot);
  if (id) pool.release(id);
});

type FormationName = "echo" | "arena" | "index";
let corpus: SpikeCorpus | null = null;
let scope: SpikeScope | null = null;
let active: SpikeCard[] = [];
let anchorId = "";
let formation: FormationName = "echo";
let lastLayout: LayoutResult | null = null;
let lastRetargetMs = 0;
let lastDropped = 0;
let cpuEmaMs = 0;
let renderEmaMs = 0;

/** Per-instance semantic attributes are rewritten only when the population
 *  changes, never per frame. */
function writeInstanceAttributes(): void {
  const roleOf = (card: SpikeCard): number =>
    card.id === anchorId ? 3 : card.bank === "opposed" ? 0 : card.bank === "same" ? 1 : 2;
  const maxStrength = active.reduce((m, c) => Math.max(m, c.strength), 1);
  instanceRole.array.fill(0);
  instanceEmphasis.array.fill(0);
  instanceStrength.array.fill(0);
  for (const card of active) {
    const slot = pool.slotOf(card.id);
    if (slot === undefined) continue;
    (instanceRole.array as Float32Array)[slot] = roleOf(card);
    (instanceEmphasis.array as Float32Array)[slot] = card.id === anchorId ? 1 : 0.25;
    (instanceStrength.array as Float32Array)[slot] = Math.min(1, card.strength / maxStrength);
  }
  instanceRole.needsUpdate = true;
  instanceEmphasis.needsUpdate = true;
  instanceStrength.needsUpdate = true;
}

function applyFormation(name: FormationName, immediate = false): void {
  if (!scope) return;
  formation = name;
  transition.captureCurrent();
  const groupOf = (card: SpikeCard): string =>
    scope!.kind === "promotion" ? (card.era ?? "unknown") : (card.bank ?? "unknown");
  lastLayout =
    name === "echo" ? layoutEcho(transition, pool, active, anchorId)
    : name === "arena" ? layoutArena(
        transition, pool, active, anchorId,
        scope.kind === "promotion" ? eraSections(active) : personSections(),
      )
    : layoutIndex(transition, pool, active, anchorId, groupOf);
  frameCamera(name, immediate);
  const stats = transition.commit(performance.now(), immediate);
  lastRetargetMs = stats.retargetMs;
  lastDropped = lastLayout.dropped;
  writeInstanceAttributes();
  updateCamera();
}

/**
 * The camera travels on the SAME clock as the cards.
 *
 * SPIKE 1 measured this: with perfectly interpolated cards but an instant
 * camera cut, a tracked card's projected position jumped 0.786 NDC in one
 * frame against a 0.0003 NDC ordinary step — a 2800x seam. The cards were
 * never the problem; snapping the camera is itself a teleport, and it breaks
 * the one thing the Arena to Index transformation has to deliver, which is
 * that a reader can follow a named card across it.
 */
const CAM_POS: Record<FormationName, [number, number, number]> = {
  echo: [0, 0, 22],
  arena: [0, 7.5, 21],
  index: [0, -8, 26],
};
const CAM_LOOK: Record<FormationName, [number, number, number]> = {
  echo: [0, 0.5, 0],
  arena: [0, 0.5, 0],
  index: [0, -8, 0],
};
const camFrom = new Vector3();
const camTo = new Vector3();
const lookFrom = new Vector3();
const lookTo = new Vector3();
const camScratch = new Vector3();
const lookScratch = new Vector3();

function frameCamera(name: FormationName, immediate: boolean): void {
  camFrom.copy(immediate ? new Vector3(...CAM_POS[name]) : camScratch);
  lookFrom.copy(immediate ? new Vector3(...CAM_LOOK[name]) : lookScratch);
  camTo.set(...CAM_POS[name]);
  lookTo.set(...CAM_LOOK[name]);
}

function updateCamera(): void {
  const e = easeQuintic(transition.progressRaw);
  camScratch.lerpVectors(camFrom, camTo, e);
  lookScratch.lerpVectors(lookFrom, lookTo, e);
  camera.position.copy(camScratch);
  camera.lookAt(lookScratch);
}

function resize(): void {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

const frameDeltas: number[] = [];
let lastFrame = 0;

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (lastFrame > 0) {
    frameDeltas.push(now - lastFrame);
    if (frameDeltas.length > 240) frameDeltas.shift();
  }
  lastFrame = now;

  const t0 = performance.now();
  const animating = transition.tick(now);
  transition.writeMatrices(matrices);
  mesh.instanceMatrix.needsUpdate = true;
  // progress and state feed the dissolve; both are cheap flat copies
  (instanceProgress.array as Float32Array).set(transition.progress);
  for (let i = 0; i < CAPACITY; i++) (instanceState.array as Float32Array)[i] = transition.state[i]!;
  instanceProgress.needsUpdate = true;
  instanceState.needsUpdate = true;
  updateCamera();
  const cpu = performance.now() - t0;
  cpuEmaMs = cpuEmaMs === 0 ? cpu : cpuEmaMs * 0.9 + cpu * 0.1;

  // rAF is vsync-clamped and reads a flat 16.7 ms for every configuration
  // tested here, so it can gate a budget but cannot compare two render stacks.
  // This is the unclamped CPU-side signal; it measures command submission, not
  // GPU execution, and is labelled that way wherever it is quoted.
  const r0 = performance.now();
  renderer.render(scene, camera);
  const renderMs = performance.now() - r0;
  renderEmaMs = renderEmaMs === 0 ? renderMs : renderEmaMs * 0.9 + renderMs * 0.1;
  void animating;
  if (!transition.animating && hud.dataset.settled !== formation) hud.dataset.settled = formation;
  hud.textContent =
    `${formation}  cards=${active.length}  live=${pool.liveCount}  ` +
    `layout=${lastLayout?.layoutMs.toFixed(2)}ms  retarget=${lastRetargetMs.toFixed(2)}ms  ` +
    `cpu=${cpuEmaMs.toFixed(2)}ms  calls=${renderer.info.render.calls}  ` +
    `raw=${transition.progressRaw.toFixed(2)}`;
}

const percentile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0;
};

function selectScope(key: string, budget: number): void {
  if (!corpus) return;
  const next = corpus.scopes[key];
  if (!next) throw new Error(`unknown scope ${key}`);
  for (const card of active) pool.release(card.id);
  if (anchorId) pool.release(anchorId);
  transition.state.fill(CS.ABSENT);
  transition.present.fill(0);
  scope = next;
  anchorId = next.anchorId ?? `${next.promotionId}`;
  active = budgetSlice(next, budget);
  applyFormation("echo", true);
}

/** The probe seam, mirroring the repository's __kayfabe* convention. */
declare global {
  interface Window {
    __arenaSpike?: Record<string, unknown>;
  }
}

async function boot(): Promise<void> {
  corpus = await loadSpikeCorpus();
  resize();
  selectScope("person:p:d7fbacefc", 360);
  requestAnimationFrame(tick);

  window.__arenaSpike = {
    ready: true,
    scopes: () => Object.keys(corpus?.scopes ?? {}),
    select: (key: string, budget: number) => selectScope(key, budget),
    /** Change the represented population WITHOUT rebuilding the slot mapping.
     *  This is the drill-down / aggregate-expand path, and the only one that
     *  exercises enter, leave, slot release and slot re-acquisition. */
    setBudget: (budget: number) => {
      if (!scope) return;
      active = budgetSlice(scope, budget);
      applyFormation(formation);
    },
    setFormation: (name: FormationName) => applyFormation(name),
    churnStats: () => ({ ...transition.lastStats }),
    freeSlots: () => CAPACITY - pool.liveCount,
    slotOf: (id: string) => pool.slotOf(id) ?? -1,
    renderEmaMs: () => renderEmaMs,
    /** World-space position, so a path-curvature claim can be made about the
     *  cards rather than about a camera that is itself moving. */
    cardWorldPos: (id: string) => {
      const slot = pool.slotOf(id);
      if (slot === undefined) return null;
      const i3 = slot * 3;
      return { x: transition.posCur[i3]!, y: transition.posCur[i3 + 1]!, z: transition.posCur[i3 + 2]! };
    },
    timerQuery: () => {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      return Boolean(gl.getExtension("EXT_disjoint_timer_query_webgl2"));
    },
    formation: () => formation,
    animating: () => transition.animating,
    cardCount: () => active.length,
    liveSlots: () => pool.liveCount,
    layoutMs: () => lastLayout?.layoutMs ?? 0,
    retargetMs: () => lastRetargetMs,
    cpuEmaMs: () => cpuEmaMs,
    drawCalls: () => renderer.info.render.calls,
    notes: () => lastLayout?.notes ?? [],
    dropped: () => lastDropped,
    resetFrames: () => { frameDeltas.length = 0; },
    frameStats: () => ({
      samples: frameDeltas.length,
      p50: percentile(frameDeltas, 0.5),
      p95: percentile(frameDeltas, 0.95),
      worst: frameDeltas.length ? Math.max(...frameDeltas) : 0,
    }),
    /** Position of one card in screen space — used to prove a retained card
     *  travels continuously rather than teleporting. */
    cardScreenPos: (id: string) => {
      const slot = pool.slotOf(id);
      if (slot === undefined) return null;
      const i3 = slot * 3;
      camera.updateMatrixWorld();
      probeVec.set(transition.posCur[i3]!, transition.posCur[i3 + 1]!, transition.posCur[i3 + 2]!);
      probeVec.project(camera);
      return { x: probeVec.x, y: probeVec.y, z: probeVec.z, slot };
    },
    gpu: () => {
      const gl = renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
    },
    setReducedMotion: (on: boolean) => { transition.reducedMotion = on; },
  };
}

void boot().catch((error: unknown) => {
  hud.textContent = `spike failed: ${String(error)}`;
  throw error;
});
