/**
 * SPIKE 2 — picking.
 *
 * Three mechanisms, one card field, identical conditions.
 *
 *   A. PROJECTED   the incumbent. packages/morph-renderer/src/MorphPicking.ts
 *                  already does an allocation-free projected-distance scan with
 *                  a deterministic comparator, proven at this corpus's scale.
 *                  It is the baseline the newcomers have to beat, not a third
 *                  option.
 *   B. RAYCAST     three's InstancedMesh raycast (webgl_instancing_raycast),
 *                  yielding intersection.instanceId.
 *   C. GPU_ID      integer-ID buffer, 1-pixel scissored readback
 *                  (webgl_interactive_cubes_gpu).
 *
 * GPU_ID is treated as ground truth for AGREEMENT, because it samples exactly
 * the pixel the user is pointing at, using the same vertex path as the visible
 * card. That makes it the only mechanism that stays correct by construction
 * while cards transform — and therefore the right yardstick for asking how
 * wrong the cheap methods are.
 *
 * The audit flagged a specific trap this spike must exercise:
 * InstancedMesh.boundingSphere is null until computed and is NOT recomputed as
 * instances move, so raycast against a transitioning field can silently miss.
 */
import {
  DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, NearestFilter,
  PerspectiveCamera, PlaneGeometry, RGBAFormat, Raycaster, Scene, ShaderMaterial,
  UnsignedByteType, Vector2, Vector3, WebGLRenderTarget, WebGLRenderer,
} from "three";
import { CS, FormationTransition, SlotPool, easeQuintic } from "./formation-transition";
import { eraSections, layoutArena, layoutEcho, layoutIndex, personSections } from "./formation-layouts";
import { budgetSlice, loadSpikeCorpus, type SpikeCard, type SpikeCorpus, type SpikeScope } from "./spike-corpus";

const CAPACITY = 640;
const canvas = document.getElementById("gl") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new Scene();
const camera = new PerspectiveCamera(46, 1, 0.1, 400);

const geometry = new PlaneGeometry(1, 1);
const instanceRole = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
const instanceState = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
instanceRole.setUsage(DynamicDrawUsage);
instanceState.setUsage(DynamicDrawUsage);
geometry.setAttribute("instanceRole", instanceRole);
geometry.setAttribute("instanceState", instanceState);

const VERT = /* glsl */ `
  attribute float instanceRole;
  attribute float instanceState;
  varying vec2 vUv; varying float vRole; varying float vState;
  void main() {
    vUv = uv; vRole = instanceRole; vState = instanceState;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const material = new ShaderMaterial({
  transparent: true, depthWrite: false,
  // Cards are physical plaques seated around a horseshoe facing centre stage,
  // which leaves roughly half the field back-facing from any given camera.
  // Single-sided cards silently vanish — SPIKE 2 measured GPU picking missing
  // 45% of card centres before this was set.
  side: DoubleSide,
  uniforms: { uHover: { value: -1 } },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv; varying float vRole; varying float vState;
    void main() {
      if (vState < 0.5) discard;
      vec2 p = abs(vUv - 0.5) * 2.0;
      float border = smoothstep(0.955, 1.0, max(p.x, p.y));
      vec3 accent = vRole < 0.5 ? vec3(1.0,0.48,0.30) : vRole < 1.5 ? vec3(0.29,0.84,1.0) : vec3(0.91,0.87,0.81);
      gl_FragColor = vec4(mix(vec3(0.06,0.08,0.11), accent, border), 0.92);
    }
  `,
});

const mesh = new InstancedMesh(geometry, material, CAPACITY);
mesh.instanceMatrix.setUsage(DynamicDrawUsage);
mesh.frustumCulled = false;
scene.add(mesh);

/**
 * The picking pass mirrors the visible vertex path exactly — same
 * instanceMatrix, same instanceState discard — so a card's picked pixel is the
 * same pixel it draws. The id comes from a per-instance ATTRIBUTE, not a
 * uniform, because one draw call has to distinguish every instance. Encoding
 * into RGB at 8 bits per channel covers 16.7M ids against a capacity of 640,
 * so there are no packing subtleties to get wrong.
 */
const instanceId = new InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
for (let i = 0; i < CAPACITY; i++) (instanceId.array as Float32Array)[i] = i + 1;
geometry.setAttribute("instanceId", instanceId);

const pickMat = new ShaderMaterial({
  side: DoubleSide,
  vertexShader: /* glsl */ `
    attribute float instanceId;
    attribute float instanceState;
    varying float vId; varying float vState;
    void main() {
      vId = instanceId; vState = instanceState;
      gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying float vId; varying float vState;
    void main() {
      if (vState < 0.5) discard;
      gl_FragColor = vec4(
        mod(vId, 256.0) / 255.0,
        mod(floor(vId / 256.0), 256.0) / 255.0,
        mod(floor(vId / 65536.0), 256.0) / 255.0,
        1.0);
    }
  `,
});
/**
 * The pick pass swaps the material on the ONE real mesh rather than keeping a
 * parallel picking mesh.
 *
 * The parallel-mesh version of this spike rendered nothing at all — a 64x64
 * full-frame probe of the picking scene came back with 0 of 4096 pixels set,
 * while the visible arena drew perfectly. A second InstancedMesh sharing the
 * same BufferGeometry does not reliably get its own instanceMatrix bound,
 * because three keys its vertex-array state on the geometry. Swapping the
 * material sidesteps the question entirely: the picked pixel is produced by
 * literally the same object, the same instanceMatrix and the same
 * instanceState the reader is looking at, so the two cannot drift.
 */
function renderPickPass(): void {
  const visible = mesh.material;
  mesh.material = pickMat;
  renderer.render(scene, camera);
  mesh.material = visible;
}

const pickTarget = new WebGLRenderTarget(1, 1, {
  format: RGBAFormat, type: UnsignedByteType,
  minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true,
});
const pixel = new Uint8Array(4);

const transition = new FormationTransition(CAPACITY);
const pool = new SlotPool(CAPACITY);
const matrices = mesh.instanceMatrix.array as Float32Array;
transition.setOnReleased((slot) => { const id = pool.idOf(slot); if (id) pool.release(id); });

type FormationName = "echo" | "arena" | "index";
let corpus: SpikeCorpus | null = null;
let scope: SpikeScope | null = null;
let active: SpikeCard[] = [];
let anchorId = "";
let formation: FormationName = "arena";

const CAM: Record<FormationName, [number, number, number]> = {
  echo: [0, 0, 22], arena: [0, 7.5, 21], index: [0, -8, 26],
};
const LOOK: Record<FormationName, [number, number, number]> = {
  echo: [0, 0.5, 0], arena: [0, 0.5, 0], index: [0, -8, 0],
};
const camFrom = new Vector3(); const camTo = new Vector3();
const lookFrom = new Vector3(); const lookTo = new Vector3();
const camCur = new Vector3(); const lookCur = new Vector3();
let camOrbit = 0;

function frameCamera(name: FormationName, immediate: boolean): void {
  if (immediate) { camCur.set(...CAM[name]); lookCur.set(...LOOK[name]); }
  camFrom.copy(camCur); lookFrom.copy(lookCur);
  camTo.set(...CAM[name]); lookTo.set(...LOOK[name]);
}
function updateCamera(): void {
  const e = easeQuintic(transition.progressRaw);
  camCur.lerpVectors(camFrom, camTo, e);
  lookCur.lerpVectors(lookFrom, lookTo, e);
  camera.position.set(
    camCur.x * Math.cos(camOrbit) - camCur.z * Math.sin(camOrbit),
    camCur.y,
    camCur.x * Math.sin(camOrbit) + camCur.z * Math.cos(camOrbit),
  );
  camera.lookAt(lookCur);
  camera.updateMatrixWorld();
}

function writeAttributes(): void {
  const roleOf = (c: SpikeCard): number =>
    c.id === anchorId ? 3 : c.bank === "opposed" ? 0 : c.bank === "same" ? 1 : 2;
  (instanceRole.array as Float32Array).fill(0);
  for (const c of active) {
    const slot = pool.slotOf(c.id);
    if (slot !== undefined) (instanceRole.array as Float32Array)[slot] = roleOf(c);
  }
  instanceRole.needsUpdate = true;
}

function applyFormation(name: FormationName, immediate = false): void {
  if (!scope) return;
  formation = name;
  transition.captureCurrent();
  const groupOf = (c: SpikeCard): string =>
    scope!.kind === "promotion" ? (c.era ?? "unknown") : (c.bank ?? "unknown");
  if (name === "echo") layoutEcho(transition, pool, active, anchorId);
  else if (name === "arena") {
    layoutArena(transition, pool, active, anchorId,
      scope.kind === "promotion" ? eraSections(active) : personSections());
  } else layoutIndex(transition, pool, active, anchorId, groupOf);
  frameCamera(name, immediate);
  transition.commit(performance.now(), immediate);
  writeAttributes();
  updateCamera();
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
  applyFormation("arena", true);
}

// ---------------------------------------------------------------- pickers

export type PickMethod = "projected" | "raycast" | "gpu";

const raycaster = new Raycaster();
const ndc = new Vector2();
const projScratch = new Vector3();

/**
 * A. PROJECTED — the incumbent's technique, adapted from points to quads.
 * Card centres are projected and compared in screen pixels against a radius
 * derived from the card's own projected size. Allocation-free, no GPU work,
 * and it mirrors shader interpolation by reading posCur rather than posTo.
 */
function pickProjected(px: number, py: number): number {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < CAPACITY; i++) {
    if (transition.state[i] === CS.ABSENT) continue;
    const i3 = i * 3;
    projScratch.set(transition.posCur[i3]!, transition.posCur[i3 + 1]!, transition.posCur[i3 + 2]!);
    projScratch.project(camera);
    if (projScratch.z < -1 || projScratch.z > 1) continue;
    const sx = (projScratch.x * 0.5 + 0.5) * w;
    const sy = (-projScratch.y * 0.5 + 0.5) * h;
    // Approximate the card's projected half-extent from its world scale and
    // depth. This is the approximation the accuracy test is here to quantify.
    const scaleX = transition.scaleCur[i3]!;
    const scaleY = transition.scaleCur[i3 + 1]!;
    const depth = Math.max(0.001, camera.position.distanceTo(projScratch.set(
      transition.posCur[i3]!, transition.posCur[i3 + 1]!, transition.posCur[i3 + 2]!)));
    const pxPerUnit = (h * 0.5) / (Math.tan((camera.fov * Math.PI) / 360) * depth);
    const hw = (scaleX * 0.5) * pxPerUnit;
    const hh = (scaleY * 0.5) * pxPerUnit;
    const dx = Math.abs(px - sx) / Math.max(1, hw);
    const dy = Math.abs(py - sy) / Math.max(1, hh);
    if (dx > 1 || dy > 1) continue;
    const score = Math.max(dx, dy) + depth * 1e-4;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** B. RAYCAST — three's InstancedMesh raycast. */
let boundsPolicy: "never" | "always" = "always";
function pickRaycast(px: number, py: number): number {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  // The audit's trap: boundingSphere is null until computed and is never
  // recomputed as instances move. "never" reproduces the stale-bounds bug on
  // purpose so the spike can measure how wrong it gets.
  if (boundsPolicy === "always") {
    mesh.computeBoundingSphere();
    mesh.computeBoundingBox();
  }
  const hits = raycaster.intersectObject(mesh, false);
  for (const hit of hits) {
    const id = hit.instanceId;
    if (id === undefined) continue;
    if (transition.state[id] === CS.ABSENT) continue;
    return id;
  }
  return -1;
}

/** C. GPU_ID — 1-pixel scissored readback of an integer id buffer. */
function pickGpu(px: number, py: number): number {
  const dpr = renderer.getPixelRatio();
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  // camera.setViewOffset selects exactly the pixel under the pointer, so the
  // render target stays 1x1 regardless of viewport size or devicePixelRatio.
  camera.setViewOffset(w * dpr, h * dpr, Math.floor(px * dpr), Math.floor(py * dpr), 1, 1);
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(pickTarget);
  renderer.clear();
  renderPickPass();
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pixel);
  renderer.setRenderTarget(prevTarget);
  camera.clearViewOffset();
  const id = pixel[0]! + pixel[1]! * 256 + pixel[2]! * 65536;
  return id === 0 ? -1 : id - 1;
}

export function pick(method: PickMethod, px: number, py: number): number {
  return method === "projected" ? pickProjected(px, py)
    : method === "raycast" ? pickRaycast(px, py)
    : pickGpu(px, py);
}

function resize(): void {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);

/**
 * Context loss is not hypothetical here: this page reliably loses its context
 * once during boot under SwiftShader and restores about 1.5 s later. three
 * re-uploads its own GPU resources, but the formation has to be re-committed
 * because our authoritative transforms live in typed arrays on our side.
 *
 * Measuring before the restore is what produced a whole run of silent zeros:
 * WebGLRenderer.render() early-returns while the context is lost, so every
 * draw reported 0 calls and every picked pixel came back empty.
 */
let contextGeneration = 0;
canvas.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
});
canvas.addEventListener("webglcontextrestored", () => {
  contextGeneration++;
  resize();
  if (scope) applyFormation(formation, true);
});

let orbiting = false;
function tick(now: number): void {
  requestAnimationFrame(tick);
  if (orbiting) camOrbit += 0.004;
  transition.tick(now);
  transition.writeMatrices(matrices);
  mesh.instanceMatrix.needsUpdate = true;
  for (let i = 0; i < CAPACITY; i++) (instanceState.array as Float32Array)[i] = transition.state[i]!;
  instanceState.needsUpdate = true;
  updateCamera();
  renderer.render(scene, camera);
  hud.textContent = `${formation} cards=${active.length} orbit=${orbiting ? "on" : "off"} raw=${transition.progressRaw.toFixed(2)}`;
}

declare global {
  interface Window { __arenaPick?: Record<string, unknown> }
}

async function boot(): Promise<void> {
  corpus = await loadSpikeCorpus();
  resize();
  selectScope("person:p:d7fbacefc", 203);
  requestAnimationFrame(tick);

  window.__arenaPick = {
    ready: true,
    contextLost: () => renderer.getContext().isContextLost(),
    contextGeneration: () => contextGeneration,
    select: (key: string, budget: number) => selectScope(key, budget),
    setFormation: (n: FormationName) => applyFormation(n),
    animating: () => transition.animating,
    setOrbit: (on: boolean) => { orbiting = on; },
    setBoundsPolicy: (p: "never" | "always") => { boundsPolicy = p; },
    setPixelRatio: (r: number) => { renderer.setPixelRatio(r); resize(); },
    pick: (m: PickMethod, x: number, y: number) => pick(m, x, y),
    /** Renders the pick scene full-frame into a coarse target and counts
     *  non-zero pixels. Separates "the pick scene draws nothing" from "the
     *  1x1 view-offset selects the wrong pixel". */
    pickSceneProbe: (useVisibleMaterial = false) => {
      const size = 64;
      const target = new WebGLRenderTarget(size, size, {
        format: RGBAFormat, type: UnsignedByteType,
        minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true,
      });
      const buf = new Uint8Array(size * size * 4);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.clear();
      if (useVisibleMaterial) renderer.render(scene, camera);
      else renderPickPass();
      renderer.readRenderTargetPixels(target, 0, 0, size, size, buf);
      renderer.setRenderTarget(prev);
      let nonZero = 0;
      const ids = new Set<number>();
      for (let i = 0; i < size * size; i++) {
        const r = buf[i * 4]!, g = buf[i * 4 + 1]!, b = buf[i * 4 + 2]!;
        if (r || g || b) { nonZero++; ids.add(r + g * 256 + b * 65536); }
      }
      const info = {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        contextLost: renderer.getContext().isContextLost(),
      };
      // Same render, but to the screen, as a control: if this also reports 0
      // calls the problem is the context, not the render-target path.
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      const screenCalls = renderer.info.render.calls;
      target.dispose();
      return {
        nonZero, total: size * size, distinctIds: ids.size, sampleIds: [...ids].slice(0, 6),
        info, screenCalls, alphaSample: [buf[0], buf[1], buf[2], buf[3]],
      };
    },
    pickDebug: (x: number, y: number) => {
      const id = pickGpu(x, y);
      return {
        id,
        pixel: [pixel[0], pixel[1], pixel[2], pixel[3]],
        dpr: renderer.getPixelRatio(),
        clientW: renderer.domElement.clientWidth,
        clientH: renderer.domElement.clientHeight,
        drawW: renderer.domElement.width,
        drawH: renderer.domElement.height,
        meshCount: mesh.count,
        liveStates: Array.from(instanceState.array as Float32Array).slice(0, 6),
        firstMatrix: Array.from(mesh.instanceMatrix.array as Float32Array).slice(12, 15),
      };
    },
    cardCount: () => active.length,
    liveSlots: () => pool.liveCount,
    slotOf: (id: string) => pool.slotOf(id) ?? -1,
    /** Screen-space centre of a live slot, for aiming synthetic pointers. */
    slotScreen: (slot: number) => {
      if (transition.state[slot] === CS.ABSENT) return null;
      const i3 = slot * 3;
      projScratch.set(transition.posCur[i3]!, transition.posCur[i3 + 1]!, transition.posCur[i3 + 2]!);
      projScratch.project(camera);
      const w = renderer.domElement.clientWidth;
      const h = renderer.domElement.clientHeight;
      return {
        x: (projScratch.x * 0.5 + 0.5) * w,
        y: (-projScratch.y * 0.5 + 0.5) * h,
        front: projScratch.z >= -1 && projScratch.z <= 1,
      };
    },
    liveSlotList: () => {
      const out: number[] = [];
      for (let i = 0; i < CAPACITY; i++) if (transition.state[i] !== CS.ABSENT) out.push(i);
      return out;
    },
    gpu: () => {
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      const unmasked = gl && dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      return String(unmasked ?? gl?.getParameter(gl.RENDERER) ?? "unknown");
    },
  };
}

void boot().catch((error: unknown) => {
  hud.textContent = `spike failed: ${String(error)}`;
  throw error;
});
