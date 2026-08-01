import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { CameraController } from "./CameraController";
import { CommunityHaze } from "./CommunityHaze";
import { EdgeLines } from "./EdgeLines";
import { NodePoints } from "./NodePoints";
import { PulseSystem } from "./PulseSystem";
import { QualityGovernor, type QualityTier } from "./QualityGovernor";
import { RibbonHighlight } from "./RibbonHighlight";

/**
 * Tissue treatments: three readings of the same corpus, as renderer parameter
 * sets rather than new chrome. Each is a stated point of view about what the
 * connectome is FOR at that moment, not a decoration.
 *
 * `fiber` multiplies the exposure control (which still owns saturation), so a
 * treatment can change the reading without being able to reintroduce the white
 * plateau. `haze` and the soma terms scale on top of the corpus-density
 * compensation for the same reason.
 */
export type Tissue = "cortex" | "myelin" | "deep";

export interface TissueParams {
  soma: number;
  somaAlpha: number;
  fiber: number;
  haze: number;
  note: string;
}

export const TISSUE: Record<Tissue, TissueParams> = {
  cortex: {
    soma: 0.86, somaAlpha: 0.72, fiber: 1.0, haze: 0.26,
    note: "Dense and cool. Every fiber above the weight floor is drawn — the reading is population, not narrative.",
  },
  myelin: {
    soma: 1.2, somaAlpha: 0.95, fiber: 1.55, haze: 0.14,
    note: "Stained tissue. Fibers thicken and gold championship tracks come forward; cell bodies gain a sheath.",
  },
  deep: {
    soma: 0.7, somaAlpha: 0.5, fiber: 0.5, haze: 0.04,
    note: "Long exposure. Only the strongest tracts survive the falloff; the corpus reads as structure, not detail.",
  },
};

/** Normalised layout radius — nodes.json positions reach ~1.03. */
const GRAPH_RADIUS = 1.03;
/**
 * Fiber exposure calibration. Measured on the full corpus at the default
 * fit-all framing: 24,000 fibers, 812px canvas, camera distance 2.8, where a
 * uniform multiplier of ~0.18 against the old per-edge budget was the point
 * the white plateau resolved into visible structure with labels still legible.
 */
const FIBER_EXPOSURE_K = 0.01046;
/**
 * Sub-linear response. The purely geometric model — overlap = fibers / area,
 * so exposure should rise as area — assumes the graph is uniformly dense. It
 * is not: zooming in means zooming INTO the core, where the fibers you newly
 * resolve are the densest ones, so overlap falls far slower than area grows.
 * Measured with a linear response, zooming in twice took exposure 0.041 -> 1.91
 * and put 8% of the view back at pure white. A square-root response tracks the
 * real fall-off instead of the idealised one.
 */
const FIBER_EXPOSURE_P = 0.5;
/** Floor: a huge drawn count zoomed all the way out still shows something. */
const FIBER_EXPOSURE_MIN = 0.02;
/** Ceiling: close-in views brighten, but never past the point where a few
 * overlapping fibers can saturate on their own. */
const FIBER_EXPOSURE_MAX = 0.6;
import { COLORS, communityColor, edgeColor, hash01 } from "./palette";

export interface RendererGraphInput {
  count: number;
  pos: number[]; // flat xyz, normalized
  type: number[];
  community: number[];
  degree: number[];
  firstDay: number[];
  lastDay: number[];
  communityCenters: number[]; // flat xyz
  communitySizes: number[];
}

export interface ViewEdges {
  /** edge record index list */
  edges: number[];
  a: (e: number) => number;
  b: (e: number) => number;
  weights: (e: number) => { same: number; opposed: number; br: number; title: number };
}

export interface EmphasisState {
  selectedNode: number | null;
  selectedEdge: number | null;
  hoverNode: number | null;
  pathNodes: number[];
  pathEdges: number[];
  pinned: number[];
  /**
   * Node indices to light regardless of edges.
   *
   * The graph's edges are person-person only, so promotion and championship
   * nodes have none and edge-derived emphasis lights nothing for them. The app
   * resolves membership per node type and hands the answer in here.
   */
  members?: number[];
}

export interface TimeVisibility {
  mode: "off" | "snapshot" | "accumulate" | "window";
  day: number;
  windowDays: number;
}

export interface PickResult {
  kind: "node" | "edge";
  index: number;
}

export class ConnectomeRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cameraCtl: CameraController;
  readonly governor = new QualityGovernor();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;

  private nodes: NodePoints;
  private edges = new EdgeLines();
  private ribbons = new RibbonHighlight();
  private pulses = new PulseSystem();
  private haze: CommunityHaze;

  private g: RendererGraphInput;
  private posArr: Float32Array;
  private view: ViewEdges | null = null;
  private shownEdges: number[] = [];
  private emphasisState: EmphasisState = {
    selectedNode: null, selectedEdge: null, hoverNode: null,
    pathNodes: [], pathEdges: [], pinned: [],
  };
  private visFactor: Float32Array;
  /** When set, ONLY these nodes are drawn and only fibers between them.
   * Dimming everything else still leaves 30,000 points on screen; the reading
   * the user wants is "just this wrestler and their opponents", which means
   * the rest has to be gone, not quiet. */
  private isolateSet: Set<number> | null = null;
  private hotNodes = new Set<number>();
  private clock = new THREE.Clock();
  private raf = 0;
  private running = false;
  private contextLost = false;
  /**
   * Whether this renderer is the lens the reader is looking at.
   *
   * A second lens (ATLAS, GEO) keeps the connectome MOUNTED so its camera
   * framing survives the round trip, but a mounted renderer must not burn a
   * requestAnimationFrame loop behind an opaque surface. `start()` is a no-op
   * while inactive, which also stops the visibility handler from resurrecting
   * a paused — or disposed — loop when the tab is refocused.
   */
  private active = true;
  private onVisibility: () => void;

  /** edges dropped by the quality cap on the last rebuild — surfaced, never silent */
  droppedEdges = 0;
  onDropChange: ((dropped: number, shown: number) => void) | null = null;
  private emphasisAlpha = 1;
  private fiberExposure = 1;
  private tissue: Tissue = "cortex";
  private hazeBase = 1;
  onTierChange: ((tier: QualityTier) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, graph: RendererGraphInput) {
    this.canvas = canvas;
    this.g = graph;
    this.posArr = Float32Array.from(graph.pos);
    this.visFactor = new Float32Array(graph.count).fill(1);

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // screenshot support
    });
    this.gl.setClearColor(COLORS.bg, 1);

    const colors = new Float32Array(graph.count * 3);
    const sizes = new Float32Array(graph.count);
    const shapes = new Float32Array(graph.count);
    const c = new THREE.Color();
    for (let i = 0; i < graph.count; i++) {
      const t = graph.type[i]!;
      if (t === 0) c.copy(communityColor(graph.community[i]!));
      else if (t === 1) c.copy(COLORS.promotion);
      else c.copy(COLORS.gold);
      colors.set([c.r, c.g, c.b], i * 3);
      sizes[i] =
        t === 0
          ? 0.02 + 0.04 * Math.min(1, Math.sqrt(graph.degree[i]!) / 26)
          : t === 1
            ? 0.085
            : 0.034;
      shapes[i] = t;
    }
    this.nodes = new NodePoints(this.posArr, colors, sizes, shapes);
    // corpus-density adaptation: neutral (=1) at the ~6k-person scale the
    // additive budgets were tuned on, scaling down as the corpus grows
    let personCount = 0;
    for (let i = 0; i < graph.count; i++) if (graph.type[i] === 0) personCount++;
    this.nodes.setDensity(Math.min(1, Math.max(0.4, Math.sqrt(6500 / Math.max(1, personCount)))));
    this.scene.add(this.nodes.points);
    this.scene.add(this.edges.lines);
    this.scene.add(this.ribbons.mesh);
    this.scene.add(this.pulses.points);

    const K = graph.communitySizes.length;
    const hazeColors = new Float32Array(K * 3);
    const hazeSizes = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      const cc = communityColor(k);
      hazeColors.set([cc.r, cc.g, cc.b], k * 3);
      hazeSizes[k] = 0.25 + 0.5 * Math.min(1, Math.sqrt(graph.communitySizes[k]!) / 30);
    }
    // Baseline atmosphere for this corpus size; a tissue treatment scales it
    // rather than replacing it, so 371 communities never wash out whatever the
    // treatment asks for.
    const hazeIntensity = Math.min(1, Math.max(0.3, Math.sqrt(55 / Math.max(1, K))));
    this.hazeBase = hazeIntensity;
    this.haze = new CommunityHaze(
      Float32Array.from(graph.communityCenters), hazeSizes, hazeColors, hazeIntensity,
    );
    this.scene.add(this.haze.points);

    this.cameraCtl = new CameraController(canvas, 1);

    this.composer = new EffectComposer(this.gl);
    this.composer.addPass(new RenderPass(this.scene, this.cameraCtl.camera));
    // bloom thresholds in the HDR domain (pre-tonemap): only genuinely hot
    // accumulation blooms, not the whole dense-lobe field
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.5, 1.05);
    this.composer.addPass(this.bloom);
    // ACES roll-off: the additive HDR field accumulates far past 1.0 in dense
    // lobes — without tone mapping it hard-clips into a white plateau. With
    // it, density reads as a graded ember instead of a burnout.
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 0.95;
    this.composer.addPass(new OutputPass());

    this.governor.onChange = (tier, s) => {
      this.applyQuality();
      this.onTierChange?.(tier);
      if (this.view) this.setView(this.view); // re-apply edge cap
      void s;
    };

    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      if (this.view) this.setView(this.view);
    });
    this.onVisibility = () => {
      if (document.hidden) this.stop();
      else this.start();
    };
    document.addEventListener("visibilitychange", this.onVisibility);

    this.resize();
    this.applyQuality();
  }

  /* ---------- data ---------- */

  nodePosition(i: number): THREE.Vector3 {
    return new THREE.Vector3(this.posArr[i * 3]!, this.posArr[i * 3 + 1]!, this.posArr[i * 3 + 2]!);
  }

  private bowFor(e: number, pa: THREE.Vector3, pb: THREE.Vector3): THREE.Vector3 {
    const ia = this.view!.a(e);
    const ib = this.view!.b(e);
    const ca = this.g.community[ia]!;
    const cb = this.g.community[ib]!;
    const mid = pa.clone().lerp(pb, 0.5);
    if (ca >= 0 && cb >= 0 && ca !== cb) {
      // bow through the corridor between the two community centers → visual bundling
      const cma = new THREE.Vector3().fromArray(this.g.communityCenters, ca * 3);
      const cmb = new THREE.Vector3().fromArray(this.g.communityCenters, cb * 3);
      mid.lerp(cma.lerp(cmb, 0.5), 0.35);
      // hollow core: with hundreds of communities every cross-lobe corridor
      // passes near the origin and the integrated field burns white — push
      // central midpoints outward so tracts wrap the core instead
      const r = mid.length();
      if (r < 0.42) {
        const dir =
          r > 1e-3 ? mid.clone().multiplyScalar(1 / r) : pa.clone().add(pb).normalize();
        mid.addScaledVector(dir, (0.42 - r) * 0.85);
      }
    } else if (ca >= 0 && ca === cb) {
      // intra-community fibers wrap the lobe surface instead of skewering its
      // center — a straight-chord core integrates into a white plateau
      const cm = new THREE.Vector3().fromArray(this.g.communityCenters, ca * 3);
      const away = mid.clone().sub(cm);
      const len = away.length();
      if (len > 1e-4) mid.addScaledVector(away.normalize(), 0.10 + len * 0.45);
    }
    const j = hash01(e);
    mid.x += (j - 0.5) * 0.05;
    mid.y += (hash01(e + 7919) - 0.5) * 0.05;
    mid.z += (hash01(e + 104729) - 0.5) * 0.05;
    return mid;
  }

  setView(view: ViewEdges): void {
    this.view = view;
    const cap = this.governor.settings.edgeCap;
    let shown = view.edges;
    const iso = this.isolateSet;
    if (iso) {
      // Both endpoints must be in the set, so an isolated wrestler shows their
      // own fibers and not their opponents' fibers to everyone else.
      shown = shown.filter((e) => iso.has(view.a(e)) && iso.has(view.b(e)));
    }
    this.droppedEdges = 0;
    // The cap applies to what is ACTUALLY being drawn. Scoring from
    // view.edges here instead of from `shown` silently discarded the isolate
    // filter and put all 24,000 fibers back on screen.
    if (shown.length > cap) {
      const scored = [...shown].sort((x, y) => {
        const wx = view.weights(x);
        const wy = view.weights(y);
        return wy.same + wy.opposed + wy.br - (wx.same + wx.opposed + wx.br);
      });
      this.droppedEdges = shown.length - cap;
      shown = scored.slice(0, cap);
    }
    this.shownEdges = shown;
    this.onDropChange?.(this.droppedEdges, shown.length);

    this.edges.rebuild(
      shown,
      (e) => [this.posArr, view.a(e), view.b(e)],
      (e, pa, pb) => this.bowFor(e, pa, pb),
      (e) => {
        const w = view.weights(e);
        const c = edgeColor(w.same, w.opposed, w.br, w.title);
        return [c.r, c.g, c.b];
      },
      (e) => {
        const w = view.weights(e);
        const total = w.same + w.opposed + w.br;
        // This callback sets only the RELATIVE weight of one fiber against
        // another. Compensating for how many fibers are drawn belongs to
        // updateFiberExposure(), because the thing that actually saturates is
        // overlap PER PIXEL — which depends on the zoom as much as the count,
        // and a per-edge constant cannot see the camera.
        // Inside one lobe, overlap also scales with lobe population: a
        // 9k-person community's interior fibers can never all be visible.
        // Interiors become texture; inter-lobe tracts carry the light.
        const ca = this.g.community[view.a(e)]!;
        const cb = this.g.community[view.b(e)]!;
        let intraScale = 1;
        if (ca >= 0 && ca === cb) {
          const size = this.g.communitySizes[ca] ?? 1;
          intraScale = Math.min(1, Math.max(0.13, Math.sqrt(420 / Math.max(1, size))));
        }
        // steep weight curve + low floor: the alpha budget concentrates in the
        // strongest documented relationships instead of a uniform wash
        const t = Math.min(1, total / 14);
        return (0.025 + 0.26 * Math.pow(t, 1.4)) * intraScale;
      },
    );
    this.applyEmphasis(this.emphasisState);
  }

  /* ---------- emphasis / selection ---------- */

  incidentShownEdges(node: number): number[] {
    if (!this.view) return [];
    return this.shownEdges.filter((e) => this.view!.a(e) === node || this.view!.b(e) === node);
  }

  applyEmphasis(st: EmphasisState): void {
    this.emphasisState = st;
    const em = this.nodes.emphasis;
    const anyFocus =
      st.selectedNode !== null ||
      st.selectedEdge !== null ||
      st.pathNodes.length > 0 ||
      (st.members?.length ?? 0) > 0;

    const neighbor = new Set<number>(st.members ?? []);
    const fibers: { curve: THREE.Vector3[]; color: THREE.Color; width: number }[] = [];
    const addFiber = (e: number, width: number, brighten: number) => {
      if (!this.view) return;
      const ia = this.view.a(e);
      const ib = this.view.b(e);
      const pa = this.nodePosition(ia);
      const pb = this.nodePosition(ib);
      const mid = this.bowFor(e, pa, pb);
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s <= 14; s++) {
        const t = s / 14;
        const it = 1 - t;
        pts.push(
          new THREE.Vector3(
            it * it * pa.x + 2 * it * t * mid.x + t * t * pb.x,
            it * it * pa.y + 2 * it * t * mid.y + t * t * pb.y,
            it * it * pa.z + 2 * it * t * mid.z + t * t * pb.z,
          ),
        );
      }
      const w = this.view.weights(e);
      const col = edgeColor(w.same, w.opposed, w.br, w.title).lerp(COLORS.select, brighten);
      fibers.push({ curve: pts, color: col, width });
    };

    if (st.selectedNode !== null && this.view) {
      const inc = this.incidentShownEdges(st.selectedNode);
      const strongest = inc
        .map((e) => {
          const w = this.view!.weights(e);
          return [e, w.same + w.opposed + w.br] as const;
        })
        .sort((x, y) => y[1] - x[1])
        .slice(0, 160);
      for (const [e] of strongest) {
        addFiber(e, 0.0022, 0.12);
        neighbor.add(this.view.a(e));
        neighbor.add(this.view.b(e));
      }
    }
    if (st.selectedEdge !== null && this.view) {
      addFiber(st.selectedEdge, 0.0042, 0.3);
      neighbor.add(this.view.a(st.selectedEdge));
      neighbor.add(this.view.b(st.selectedEdge));
    }
    for (const e of st.pathEdges) {
      addFiber(e, 0.0048, 0.45);
      if (this.view) {
        neighbor.add(this.view.a(e));
        neighbor.add(this.view.b(e));
      }
    }
    this.ribbons.rebuild(fibers);

    const iso = this.isolateSet;
    for (let i = 0; i < this.g.count; i++) {
      if (iso && !iso.has(i)) {
        em[i] = 0;
        continue;
      }
      let v = anyFocus ? (iso ? 0.85 : 0.24) : 1;
      if (neighbor.has(i)) v = 0.95;
      if (st.pinned.includes(i)) v = Math.max(v, 1.15);
      if (st.pathNodes.includes(i)) v = 1.45;
      if (i === st.hoverNode) v = Math.max(v, 1.3);
      if (i === st.selectedNode) v = 1.6;
      em[i] = v * this.visFactor[i]!;
    }
    this.nodes.commitEmphasis();
    // Emphasis is a FACTOR now; the exposure control owns the uniform and
    // multiplies the two, so dimming for a selection cannot undo the
    // saturation compensation (or vice versa).
    this.emphasisAlpha = anyFocus ? 0.16 : 1;
  }

  /* ---------- timeline ---------- */

  /**
   * Isolate to a set of nodes, or pass null to show the whole corpus again.
   * Rebuilds the fiber set, because hiding nodes without hiding the fibers
   * that reach them leaves lines running off into nothing.
   */
  setIsolate(nodes: number[] | null): void {
    this.isolateSet = nodes && nodes.length ? new Set(nodes) : null;
    if (this.view) this.setView(this.view);
    this.applyEmphasis(this.emphasisState);
  }

  get isolated(): boolean {
    return this.isolateSet !== null;
  }

  setTimeVisibility(tv: TimeVisibility): void {
    const { mode, day, windowDays } = tv;
    for (let i = 0; i < this.g.count; i++) {
      const f = this.g.firstDay[i]!;
      const l = this.g.lastDay[i]!;
      let v = 1;
      if (mode !== "off" && this.g.type[i] === 0 && f >= 0) {
        if (mode === "accumulate") v = f <= day ? 1 : 0.04;
        else if (mode === "snapshot") v = f <= day && l >= day ? 1 : 0.06;
        else if (mode === "window") v = f <= day && l >= day - windowDays ? 1 : 0.05;
      }
      this.visFactor[i] = v;
    }
    this.applyEmphasis(this.emphasisState);
  }

  igniteNode(i: number): void {
    this.nodes.activity[i] = 1;
    this.hotNodes.add(i);
  }

  pulseBetween(ia: number, ib: number, kind: "same" | "opposed" | "br" | "gold"): void {
    const pa = this.nodePosition(ia);
    const pb = this.nodePosition(ib);
    const mid = pa.clone().lerp(pb, 0.5);
    mid.y += 0.02 + hash01(ia * 31 + ib) * 0.04;
    const color =
      kind === "gold" ? COLORS.gold : kind === "same" ? COLORS.same : kind === "br" ? COLORS.br : COLORS.opposed;
    this.pulses.spawn(
      [pa.x, pa.y, pa.z],
      [mid.x, mid.y, mid.z],
      [pb.x, pb.y, pb.z],
      color,
      this.clock.elapsedTime,
      kind === "gold" ? 1.6 : 1.0,
      kind === "gold" ? 5 : 3,
    );
  }

  clearPulses(): void {
    this.pulses.clearAll(this.clock.elapsedTime);
  }

  /* ---------- picking & projection ---------- */

  private projTmp = new THREE.Vector3();

  project(i: number): { x: number; y: number; front: boolean } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.projTmp.set(this.posArr[i * 3]!, this.posArr[i * 3 + 1]!, this.posArr[i * 3 + 2]!);
    this.projTmp.project(this.cameraCtl.camera);
    return {
      x: (this.projTmp.x * 0.5 + 0.5) * w,
      y: (-this.projTmp.y * 0.5 + 0.5) * h,
      front: this.projTmp.z < 1,
    };
  }

  /**
   * The nodes the camera is currently among, nearest first.
   *
   * Flying through the tissue should make names resolve out of it as you
   * approach, the way a label on a distant object does — so the ambient label
   * tier is ranked by WORLD proximity to the camera rather than by a global
   * degree ordering that never changes no matter where you fly.
   *
   * `t` is the reveal weight in [0,1]: 1 at the camera, 0 at `radius`. The
   * label layer maps it to opacity so names fade up instead of popping.
   *
   * Runs over the raw position array with no per-node allocation — it is
   * called on the label cadence over the whole corpus (30k nodes).
   */
  nearestNodes(
    radius: number,
    limit: number,
    accept?: (i: number) => boolean,
  ): { i: number; t: number }[] {
    const cam = this.cameraCtl.camera.position;
    const r2 = radius * radius;
    const out: { i: number; t: number }[] = [];
    const p = this.posArr;
    for (let i = 0; i < this.g.count; i++) {
      if (this.nodes.emphasis[i]! < 0.05) continue; // hidden by isolate/time
      if (accept && !accept(i)) continue;
      const dx = p[i * 3]! - cam.x;
      const dy = p[i * 3 + 1]! - cam.y;
      const dz = p[i * 3 + 2]! - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      out.push({ i, t: 1 - Math.sqrt(d2) / radius });
    }
    // Ties broken by index so the ranking is stable frame to frame — an
    // unstable sort here makes labels flicker between equidistant nodes.
    out.sort((a, b) => b.t - a.t || a.i - b.i);
    return out.length > limit ? out.slice(0, limit) : out;
  }

  /** Distance from the camera to the orbit target — the reading of "how deep
   * into the tissue am I", used to scale the proximity shell. */
  get cameraDistance(): number {
    return this.cameraCtl.distance();
  }

  pick(px: number, py: number): PickResult | null {
    // nodes first: nearest projected node within its screen radius
    let best = -1;
    let bestD = 14 * 14;
    for (let i = 0; i < this.g.count; i++) {
      if (this.nodes.emphasis[i]! < 0.1) continue;
      const p = this.project(i);
      if (!p.front) continue;
      const dx = p.x - px;
      const dy = p.y - py;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) return { kind: "node", index: best };

    // edges: only the currently-ribboned (selected-neighborhood/path) fibers are pickable
    const st = this.emphasisState;
    const candidates =
      st.selectedNode !== null ? this.incidentShownEdges(st.selectedNode) : [...st.pathEdges];
    let bestE = -1;
    let bestED = 9 * 9;
    for (const e of candidates) {
      if (!this.view) break;
      const ia = this.view.a(e);
      const ib = this.view.b(e);
      const pa = this.project(ia);
      const pb = this.project(ib);
      if (!pa.front || !pb.front) continue;
      for (let s = 0; s <= 8; s++) {
        const t = s / 8;
        const x = pa.x + (pb.x - pa.x) * t;
        const y = pa.y + (pb.y - pa.y) * t;
        const dx = x - px;
        const dy = y - py;
        const d = dx * dx + dy * dy;
        if (d < bestED) {
          bestED = d;
          bestE = e;
        }
      }
    }
    return bestE >= 0 ? { kind: "edge", index: bestE } : null;
  }

  /* ---------- frame loop ---------- */

  private applyQuality(): void {
    const s = this.governor.settings;
    const pr = Math.min(devicePixelRatio || 1, s.pixelRatioCap);
    this.gl.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.bloom.enabled = s.bloom;
    this.nodes.setPixelRatio(pr);
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.gl.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.cameraCtl.setAspect(w / h);
  }

  /**
   * Fiber exposure: hold additive overlap PER PIXEL roughly constant.
   *
   * Additive blending saturates on how many fiber segments land on the same
   * pixel, which is (fibers drawn) / (screen area the graph covers). Both
   * terms move: the drawn count changes with filters and the quality tier, and
   * the covered area changes every time the camera moves. A per-edge constant
   * can only be right at one zoom on one corpus — which is why the full corpus
   * at the default framing integrated to a white plateau (measured: 7.4% of
   * the graph region at pure white, fibers alone reproducing all of it) while
   * a filtered view looked fine.
   *
   * K is calibrated against that measurement: 24,000 fibers, an 812px-tall
   * canvas and camera distance 2.8 must land just under saturation.
   */
  private updateFiberExposure(): void {
    const h = Math.max(1, this.canvas.clientHeight) * this.gl.getPixelRatio();
    const dist = Math.max(0.05, this.cameraCtl.distance());
    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.cameraCtl.camera.fov) / 2);
    // On-screen radius of the graph, in device pixels.
    const spanPx = (GRAPH_RADIUS * h) / (dist * Math.max(1e-3, tanHalfFov));
    const area = Math.max(1, spanPx * spanPx);
    const n = Math.max(1, this.shownEdges.length);
    const exposure = THREE.MathUtils.clamp(
      FIBER_EXPOSURE_K * Math.pow(area / n, FIBER_EXPOSURE_P) * TISSUE[this.tissue].fiber,
      FIBER_EXPOSURE_MIN,
      FIBER_EXPOSURE_MAX,
    );
    this.fiberExposure = exposure;
    this.edges.setGlobalAlpha(exposure * this.emphasisAlpha);
  }

  /** QA seam: what the exposure control settled on this frame. */
  get exposure(): number {
    return this.fiberExposure;
  }

  /** Pause/resume without losing camera framing or GPU buffers. */
  setActive(v: boolean): void {
    if (this.active === v) return;
    this.active = v;
    // WASD is a window-level listener; a paused lens must not steal it.
    this.cameraCtl.setFlyEnabled(v);
    if (v) this.start();
    else this.stop();
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.running || !this.active) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, this.clock.getDelta());
      const t0 = performance.now();
      this.cameraCtl.update(dt);

      if (this.hotNodes.size) {
        const decay = Math.exp(-dt * 2.4);
        for (const i of [...this.hotNodes]) {
          this.nodes.activity[i]! *= decay;
          if (this.nodes.activity[i]! < 0.02) {
            this.nodes.activity[i] = 0;
            this.hotNodes.delete(i);
          }
        }
        this.nodes.commitActivity();
      }
      this.updateFiberExposure();
      const dist = this.cameraCtl.distance();
      this.nodes.setFar(THREE.MathUtils.smoothstep(dist, 1.2, 2.6));
      this.pulses.tick(this.clock.elapsedTime, this.gl.getPixelRatio());
      this.ribbons.tick(this.clock.elapsedTime, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
      this.haze.tick(
        dist,
        Math.min(this.canvas.clientWidth, this.canvas.clientHeight) * this.gl.getPixelRatio() * 0.34,
      );

      if (!this.contextLost) this.composer.render();
      this.governor.frame(performance.now() - t0);
    };
    loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  focusNode(i: number, distance = 0.55): void {
    this.cameraCtl.flyTo(this.nodePosition(i), distance);
  }

  fitAll(): void {
    this.cameraCtl.reset();
  }

  screenshot(): string {
    return this.canvas.toDataURL("image/png");
  }

  /** Apply a tissue treatment. Cheap: uniforms only, no rebuild. */
  setTissue(t: Tissue): void {
    this.tissue = t;
    const p = TISSUE[t];
    this.nodes.setSoma(p.soma, p.somaAlpha);
    this.haze.setIntensity(p.haze * this.hazeBase);
  }

  get tissueTreatment(): Tissue {
    return this.tissue;
  }

  setHazeVisible(v: boolean): void {
    this.haze.points.visible = v;
  }

  setReducedMotion(v: boolean): void {
    this.cameraCtl.reducedMotion = v;
    if (v) this.clearPulses();
  }

  dispose(): void {
    this.active = false;
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.nodes.dispose();
    this.edges.dispose();
    this.ribbons.dispose();
    this.pulses.dispose();
    this.haze.dispose();
    this.cameraCtl.dispose();
    this.composer.dispose();
    this.gl.dispose();
  }
}
