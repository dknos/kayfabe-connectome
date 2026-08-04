/**
 * SPIKE 3 + 4 — evidence routes and selective postprocessing.
 *
 * These share one page because they share one render stack: the question
 * "what do 100 curved fat routes with 10 travelling pulses cost" and the
 * question "what does selective bloom add on top" are only answerable against
 * the same scene.
 *
 * SPIKE 3 findings this is built on, both verified against installed r182:
 *   - setDrawRange does NOT work on Line2: the fat line is an instanced quad
 *     expansion, not a plain line list. The equivalent IS available though —
 *     LineSegmentsGeometry extends InstancedBufferGeometry, and the renderer
 *     honours geometry.instanceCount (WebGLRenderer.js:1317). Setting it to k
 *     reveals a k-segment prefix, which is exactly the progressive draw-in the
 *     brief asks for.
 *   - Raycaster.params has NO Line2 key by default (Mesh/Line/LOD/Points/Sprite),
 *     and LineSegments2.js:329 reads `params.Line2 !== undefined ? ... : 0`, so
 *     route hover tolerance is SILENTLY ZERO unless the bucket is created.
 *
 * SPIKE 4 needs an unclamped instrument, because rAF reads a flat 16.7 ms for
 * every configuration. Render-submission time, draw calls and render-target
 * count are used instead, and are labelled as CPU submission rather than GPU
 * execution wherever quoted.
 */
import {
  AdditiveBlending, Color, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedMesh, Layers, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry,
  Raycaster, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { AfterimagePass } from "three/examples/jsm/postprocessing/AfterimagePass.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { CS, FormationTransition, SlotPool } from "./formation-transition";
import { layoutArena, personSections } from "./formation-layouts";
import { budgetSlice, loadSpikeCorpus, type SpikeCard, type SpikeCorpus } from "./spike-corpus";

const CAPACITY = 640;
const ROUTE_CAP = 120;
const ROUTE_SAMPLES = 24;
const PULSE_CAP = 16;
/** Bloom reads this layer only. Nothing else is allowed to opt in. */
const BLOOM_LAYER = 1;

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new Scene();
const camera = new PerspectiveCamera(46, 1, 0.1, 400);
camera.position.set(0, 7.5, 21);
camera.lookAt(0, 0.5, 0);

// ------------------------------------------------------------- card field
const geometry = new PlaneGeometry(1, 1);
const instanceRole = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
const instanceState = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
instanceRole.setUsage(DynamicDrawUsage);
instanceState.setUsage(DynamicDrawUsage);
geometry.setAttribute("instanceRole", instanceRole);
geometry.setAttribute("instanceState", instanceState);

const cardMaterial = new ShaderMaterial({
  transparent: true, depthWrite: false, side: DoubleSide,
  vertexShader: /* glsl */ `
    attribute float instanceRole; attribute float instanceState;
    varying vec2 vUv; varying float vRole; varying float vState;
    void main() {
      vUv = uv; vRole = instanceRole; vState = instanceState;
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv; varying float vRole; varying float vState;
    void main() {
      if (vState < 0.5) discard;
      vec2 p = abs(vUv - 0.5) * 2.0;
      float border = smoothstep(0.955, 1.0, max(p.x, p.y));
      vec3 accent = vRole < 0.5 ? vec3(1.0,0.48,0.30) : vRole < 1.5 ? vec3(0.29,0.84,1.0) : vec3(0.91,0.87,0.81);
      gl_FragColor = vec4(mix(vec3(0.06,0.08,0.11), accent, border), 0.92);
    }`,
});
const cards = new InstancedMesh(geometry, cardMaterial, CAPACITY);
cards.instanceMatrix.setUsage(DynamicDrawUsage);
cards.frustumCulled = false;
scene.add(cards);

const transition = new FormationTransition(CAPACITY);
const pool = new SlotPool(CAPACITY);
const matrices = cards.instanceMatrix.array as Float32Array;
transition.setOnReleased((slot) => { const id = pool.idOf(slot); if (id) pool.release(id); });

// ------------------------------------------------------------ route field
/**
 * Routes are pooled Line2 objects, never rebuilt per frame. Each owns a
 * LineGeometry sized once at ROUTE_SAMPLES and refilled in place, and a shared
 * LineMaterial per semantic colour so route count does not multiply materials.
 */
interface Route {
  line: Line2;
  geo: LineGeometry;
  points: Float32Array;
  active: boolean;
  key: string;
  reveal: number;
}
const routes: Route[] = [];
const routeMaterials = {
  opposed: new LineMaterial({ color: 0xff7a4d, linewidth: 2.4, transparent: true, opacity: 0.72, dashed: false }),
  same: new LineMaterial({ color: 0x49d7ff, linewidth: 2.4, transparent: true, opacity: 0.72, dashed: false }),
  mixed: new LineMaterial({ color: 0xe8dfcf, linewidth: 2.8, transparent: true, opacity: 0.8, dashed: false }),
};
const routeMatList = Object.values(routeMaterials);

for (let i = 0; i < ROUTE_CAP; i++) {
  const geo = new LineGeometry();
  const points = new Float32Array(ROUTE_SAMPLES * 3);
  geo.setPositions(points);
  const line = new Line2(geo, routeMaterials.opposed);
  line.computeLineDistances();
  line.frustumCulled = false;
  line.visible = false;
  scene.add(line);
  routes.push({ line, geo, points, active: false, key: "", reveal: 1 });
}

const ctrl = new Vector3();
const from = new Vector3();
const to = new Vector3();

/**
 * A route bows BENEATH the seating rather than cutting across the cards, which
 * is the brief's "curve beneath or behind cards" requirement expressed as a
 * control point rather than as a hope.
 */
function fillRoute(route: Route, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  from.set(ax, ay, az);
  to.set(bx, by, bz);
  ctrl.addVectors(from, to).multiplyScalar(0.5);
  ctrl.y -= 2.2 + from.distanceTo(to) * 0.16;
  for (let s = 0; s < ROUTE_SAMPLES; s++) {
    const t = s / (ROUTE_SAMPLES - 1);
    const u = 1 - t;
    route.points[s * 3] = u * u * ax + 2 * u * t * ctrl.x + t * t * bx;
    route.points[s * 3 + 1] = u * u * ay + 2 * u * t * ctrl.y + t * t * by;
    route.points[s * 3 + 2] = u * u * az + 2 * u * t * ctrl.z + t * t * bz;
  }
  route.geo.setPositions(route.points);
  route.line.computeLineDistances();
}

/**
 * Progressive reveal. setDrawRange is inert on a fat line; the working lever is
 * instanceCount on the underlying InstancedBufferGeometry, honoured by the
 * renderer at WebGLRenderer.js:1317.
 */
function setRouteReveal(route: Route, reveal: number): void {
  route.reveal = reveal;
  const segments = ROUTE_SAMPLES - 1;
  route.geo.instanceCount = Math.max(0, Math.ceil(segments * Math.min(1, Math.max(0, reveal))));
}

let routeCount = 0;
function buildRoutes(count: number, activeCards: SpikeCard[], anchorId: string): void {
  const anchorSlot = pool.slotOf(anchorId);
  routeCount = 0;
  for (const route of routes) { route.active = false; route.line.visible = false; }
  if (anchorSlot === undefined) return;
  const a3 = anchorSlot * 3;
  for (const card of activeCards) {
    if (routeCount >= Math.min(count, ROUTE_CAP)) break;
    if (card.id === anchorId) continue;
    const slot = pool.slotOf(card.id);
    if (slot === undefined || transition.state[slot] === CS.ABSENT) continue;
    const route = routes[routeCount]!;
    const b3 = slot * 3;
    fillRoute(route,
      transition.posCur[a3]!, transition.posCur[a3 + 1]!, transition.posCur[a3 + 2]!,
      transition.posCur[b3]!, transition.posCur[b3 + 1]!, transition.posCur[b3 + 2]!);
    route.line.material = card.bank === "same" ? routeMaterials.same
      : card.bank === "mixed" ? routeMaterials.mixed : routeMaterials.opposed;
    route.active = true;
    route.line.visible = true;
    route.key = `${anchorId}~${card.id}`;
    setRouteReveal(route, 1);
    routeCount++;
  }
}

// ----------------------------------------------------------------- pulses
/**
 * A pulse is a short bright segment travelling along an existing route. The
 * route itself never changes, so the animation cannot imply a direction the
 * evidence does not support — it only says "this happened along here".
 */
const pulseGeo = new PlaneGeometry(0.42, 0.42);
const pulseMat = new MeshBasicMaterial({ color: new Color(0xffd479), blending: AdditiveBlending, transparent: true, depthWrite: false });
const pulses = new InstancedMesh(pulseGeo, pulseMat, PULSE_CAP);
pulses.frustumCulled = false;
pulses.instanceMatrix.setUsage(DynamicDrawUsage);
pulses.layers.set(BLOOM_LAYER); // only the pulse layer is allowed to bloom
scene.add(pulses);
const pulseMatrices = pulses.instanceMatrix.array as Float32Array;
let pulseCount = 0;
const pulsePhase = new Float32Array(PULSE_CAP);

function setPulseCount(n: number): void {
  pulseCount = Math.min(PULSE_CAP, Math.max(0, n));
  pulses.count = pulseCount;
  for (let i = 0; i < pulseCount; i++) pulsePhase[i] = i / Math.max(1, pulseCount);
}

function updatePulses(dt: number): void {
  for (let i = 0; i < pulseCount; i++) {
    pulsePhase[i] = (pulsePhase[i]! + dt * 0.45) % 1;
    const route = routes[i % Math.max(1, routeCount)];
    const m = i * 16;
    if (!route || !route.active) { pulseMatrices[m] = 0; pulseMatrices[m + 5] = 0; pulseMatrices[m + 10] = 0; pulseMatrices[m + 15] = 1; continue; }
    const t = pulsePhase[i]! * (ROUTE_SAMPLES - 1);
    const s0 = Math.min(ROUTE_SAMPLES - 1, Math.floor(t));
    const f = t - s0;
    const s1 = Math.min(ROUTE_SAMPLES - 1, s0 + 1);
    for (let k = 0; k < 16; k++) pulseMatrices[m + k] = k % 5 === 0 ? 1 : 0;
    pulseMatrices[m + 12] = route.points[s0 * 3]! + (route.points[s1 * 3]! - route.points[s0 * 3]!) * f;
    pulseMatrices[m + 13] = route.points[s0 * 3 + 1]! + (route.points[s1 * 3 + 1]! - route.points[s0 * 3 + 1]!) * f;
    pulseMatrices[m + 14] = route.points[s0 * 3 + 2]! + (route.points[s1 * 3 + 2]! - route.points[s0 * 3 + 2]!) * f;
  }
  pulses.instanceMatrix.needsUpdate = true;
}

// -------------------------------------------------------- postprocessing
/**
 * Selective bloom via the two-composer technique from
 * webgl_postprocessing_unreal_bloom_selective, reduced to what the brief
 * allows: ONLY the pulse layer blooms. Cards, labels, section text and the
 * background are excluded by construction, not by tuning a threshold.
 */
const bloomLayers = new Layers();
bloomLayers.set(BLOOM_LAYER);

const bloomComposer = new EffectComposer(renderer);
bloomComposer.renderToScreen = false;
bloomComposer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new Vector2(1, 1), 0.62, 0.5, 0.2);
bloomComposer.addPass(bloomPass);

const finalComposer = new EffectComposer(renderer);
finalComposer.addPass(new RenderPass(scene, camera));
const combinePass = new ShaderPass(new ShaderMaterial({
  uniforms: { baseTexture: { value: null }, bloomTexture: { value: bloomComposer.renderTarget2.texture } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D baseTexture; uniform sampler2D bloomTexture; varying vec2 vUv;
    void main(){ gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv); }`,
}), "baseTexture");
combinePass.needsSwap = true;
finalComposer.addPass(combinePass);
const afterimagePass = new AfterimagePass(0.88);
afterimagePass.enabled = false;
finalComposer.addPass(afterimagePass);
finalComposer.addPass(new OutputPass());

export type PostMode = "none" | "bloom" | "bloom+afterimage";
let postMode: PostMode = "none";

/** Non-bloom objects are hidden for the bloom pass rather than darkened: the
 *  card field is one InstancedMesh, so a material swap would blanket it. */
function renderBloomPass(): void {
  const cardsVisible = cards.visible;
  const routeVisible: boolean[] = [];
  for (let i = 0; i < routes.length; i++) { routeVisible.push(routes[i]!.line.visible); routes[i]!.line.visible = false; }
  cards.visible = false;
  bloomComposer.render();
  cards.visible = cardsVisible;
  for (let i = 0; i < routes.length; i++) routes[i]!.line.visible = routeVisible[i]!;
}

let renderEmaMs = 0;
function renderFrame(): void {
  const t0 = performance.now();
  if (postMode === "none") {
    renderer.render(scene, camera);
  } else {
    renderBloomPass();
    afterimagePass.enabled = postMode === "bloom+afterimage";
    finalComposer.render();
  }
  const ms = performance.now() - t0;
  renderEmaMs = renderEmaMs === 0 ? ms : renderEmaMs * 0.9 + ms * 0.1;
}

// ---------------------------------------------------------------- driving
let corpus: SpikeCorpus | null = null;
let active: SpikeCard[] = [];
let anchorId = "";
let hoverRouteKey: string | null = null;

const raycaster = new Raycaster();
/**
 * Without this bucket the threshold read at LineSegments2.js:329 falls back to
 * 0 and a 2.4 px route becomes essentially unhoverable. Creating it is not
 * optional.
 */
raycaster.params.Line2 = { threshold: 6 };
const ndc = new Vector2();

function hoverRoute(px: number, py: number): string | null {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const live = routes.filter((r) => r.active).map((r) => r.line);
  const hits = raycaster.intersectObjects(live, false);
  const hit = hits[0];
  if (!hit) return null;
  const found = routes.find((r) => r.line === hit.object);
  return found?.key ?? null;
}

function resize(): void {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // LineMaterial.resolution must be in CSS PIXELS, not drawing-buffer pixels.
  // linewidth is a CSS-pixel width and the shader divides by this, so feeding
  // it w*devicePixelRatio halves the apparent line width at dpr 2. Measured:
  // onBeforeRender sets it from renderer.getViewport(), which three keeps in
  // CSS pixels, so it stays 1920x1080 even when the buffer is 3840x2160.
  // Rendering self-corrects either way; RAYCASTING reads this value directly
  // and does not, which is why the hand-set call has to be right.
  for (const m of routeMatList) m.resolution.set(w, h);
  bloomComposer.setSize(w, h);
  finalComposer.setSize(w, h);
  bloomPass.setSize(w, h);
}
window.addEventListener("resize", resize);

canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
canvas.addEventListener("webglcontextrestored", () => { resize(); rebuild(); });

function rebuild(): void {
  layoutArena(transition, pool, active, anchorId, personSections());
  transition.commit(performance.now(), true);
  const roleOf = (c: SpikeCard): number =>
    c.id === anchorId ? 3 : c.bank === "opposed" ? 0 : c.bank === "same" ? 1 : 2;
  (instanceRole.array as Float32Array).fill(0);
  for (const c of active) {
    const slot = pool.slotOf(c.id);
    if (slot !== undefined) (instanceRole.array as Float32Array)[slot] = roleOf(c);
  }
  instanceRole.needsUpdate = true;
  buildRoutes(routeCount || 40, active, anchorId);
}

let lastMs = 0;
function tick(now: number): void {
  requestAnimationFrame(tick);
  const dt = lastMs ? Math.min(0.05, (now - lastMs) / 1000) : 0;
  lastMs = now;
  transition.tick(now);
  transition.writeMatrices(matrices);
  cards.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < CAPACITY; i++) (instanceState.array as Float32Array)[i] = transition.state[i]!;
  instanceState.needsUpdate = true;
  updatePulses(dt);
  renderFrame();
  hud.textContent = `routes=${routeCount} pulses=${pulseCount} post=${postMode} render=${renderEmaMs.toFixed(2)}ms calls=${renderer.info.render.calls}`;
}

declare global {
  interface Window { __arenaRoutes?: Record<string, unknown> }
}

async function boot(): Promise<void> {
  corpus = await loadSpikeCorpus();
  const scope = corpus.scopes["person:p:d7fbacefc"]!;
  anchorId = scope.anchorId!;
  active = budgetSlice(scope, 203);
  resize();
  layoutArena(transition, pool, active, anchorId, personSections());
  transition.commit(performance.now(), true);
  rebuild();
  buildRoutes(40, active, anchorId);
  setPulseCount(0);
  requestAnimationFrame(tick);

  window.__arenaRoutes = {
    ready: true,
    contextLost: () => renderer.getContext().isContextLost(),
    setRoutes: (n: number) => buildRoutes(n, active, anchorId),
    routeCount: () => routeCount,
    setPulses: (n: number) => setPulseCount(n),
    setPost: (m: PostMode) => { postMode = m; },
    setReveal: (r: number) => { for (const route of routes) if (route.active) setRouteReveal(route, r); },
    revealedSegments: () => routes.filter((r) => r.active).map((r) => r.geo.instanceCount),
    setPixelRatio: (r: number) => { renderer.setPixelRatio(r); resize(); },
    resolutionOf: () => [routeMatList[0]!.resolution.x, routeMatList[0]!.resolution.y],
    viewportDebug: () => {
      const v = new Vector2();
      renderer.getDrawingBufferSize(v);
      return {
        pixelRatio: renderer.getPixelRatio(),
        canvasW: renderer.domElement.width,
        canvasH: renderer.domElement.height,
        clientW: renderer.domElement.clientWidth,
        drawingBuffer: [v.x, v.y],
        materialResolution: [routeMatList[0]!.resolution.x, routeMatList[0]!.resolution.y],
      };
    },
    /** Offset perpendicular from a route's midpoint, to probe hover TOLERANCE
     *  rather than a dead-centre hit. */
    routeScreenNear: (i: number, offsetPx: number) => {
      const route = routes.filter((r) => r.active)[i];
      if (!route) return null;
      const s0 = Math.floor(ROUTE_SAMPLES / 2);
      const a = new Vector3(route.points[s0 * 3]!, route.points[s0 * 3 + 1]!, route.points[s0 * 3 + 2]!);
      const b = new Vector3(route.points[(s0 + 1) * 3]!, route.points[(s0 + 1) * 3 + 1]!, route.points[(s0 + 1) * 3 + 2]!);
      a.project(camera); b.project(camera);
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      const ax = (a.x * 0.5 + 0.5) * w, ay = (-a.y * 0.5 + 0.5) * h;
      const bx = (b.x * 0.5 + 0.5) * w, by = (-b.y * 0.5 + 0.5) * h;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      return { x: ax + (-dy / len) * offsetPx, y: ay + (dx / len) * offsetPx, key: route.key };
    },
    hoverRoute: (x: number, y: number) => hoverRoute(x, y),
    setLine2Threshold: (t: number | null) => {
      if (t === null) delete (raycaster.params as unknown as Record<string, unknown>).Line2;
      else raycaster.params.Line2 = { threshold: t };
    },
    routeScreenMid: (i: number) => {
      const route = routes.filter((r) => r.active)[i];
      if (!route) return null;
      const s = Math.floor(ROUTE_SAMPLES / 2);
      const v = new Vector3(route.points[s * 3]!, route.points[s * 3 + 1]!, route.points[s * 3 + 2]!);
      v.project(camera);
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, key: route.key };
    },
    renderEmaMs: () => renderEmaMs,
    resetRenderEma: () => { renderEmaMs = 0; },
    drawCalls: () => renderer.info.render.calls,
    renderTargetCount: () => (postMode === "none" ? 0 : 4 + (postMode === "bloom+afterimage" ? 2 : 0)),
    gpu: () => {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      return String((gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null) ?? "unknown");
    },
    hoverKey: () => hoverRouteKey,
  };
  void hoverRouteKey;
}

void boot().catch((error: unknown) => {
  hud.textContent = `spike failed: ${String(error)}`;
  throw error;
});
