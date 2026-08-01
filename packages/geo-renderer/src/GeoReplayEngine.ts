import { CityBeaconLayer } from "./CityBeaconLayer";
import { GeoArcLayer } from "./GeoArcLayer";
import { GeoCameraController } from "./GeoCameraController";
import { GeoHeatLayer } from "./GeoHeatLayer";
import { GeoLabelLayer, type LabelSpec } from "./GeoLabelLayer";
import { GEO_TIERS, GeoQualityGovernor } from "./GeoQualityGovernor";
import type {
  ArcSpec, BeaconSpec, CameraMode, GeoPlace, GeoRendererStats, QualityTier,
} from "./types";

/**
 * The Cesium globe behind the GEO lens.
 *
 * Ported from the stlradar-3d spike only at the level of CONCEPTS — viewer
 * construction with the widget chrome off, camera damping, depth-tested
 * overlays, explicit teardown of the app-created input handler, and the
 * timeline-to-renderer seam. None of its weather, wind, radar, ship, plane,
 * terrain-proxy or Ion-token code is here, and unlike the spike the map
 * credits stay on screen.
 *
 * Deliberate departures from the donor:
 *
 *  * Cesium comes from npm and its static assets are served from the app's own
 *    origin, not a CDN <script> tag.
 *  * The basemap is Cesium's bundled Natural Earth II imagery, darkened
 *    through the imagery layer's own colour controls. It needs no key, no
 *    token and no network, so the globe renders identically offline and in CI.
 *  * requestRenderMode is on. The globe renders when something changes, so an
 *    idle GEO lens costs nothing.
 */

export interface GeoEngineOptions {
  reducedMotion?: boolean;
  tier?: QualityTier;
  /** Where Cesium's Workers/Assets/Widgets are served from. */
  baseUrl?: string;
  onPick?: (placeIdx: number | null) => void;
  onTierChange?: (tier: QualityTier) => void;
}

/** Module-level lifecycle counters. A leaking viewer shows up as created
 * outrunning destroyed across lens switches, which the stats panel surfaces. */
let viewersCreated = 0;
let viewersDestroyed = 0;

export class GeoReplayEngine {
  private Cesium: any;
  private viewer: any;
  private handler: any = null;
  private beacons: CityBeaconLayer;
  private heat: GeoHeatLayer;
  private arcs: GeoArcLayer;
  private labels: GeoLabelLayer;
  camera: GeoCameraController;
  governor: GeoQualityGovernor;

  private places: GeoPlace[] = [];
  /** GLOBAL place index -> place. The scope's array is a filtered subset, so
   * its positions are not place indices; every public method here takes the
   * global index the app and the projection use. Indexing the array directly
   * made a click on one city select a different one. */
  private placeByIndex = new Map<number, GeoPlace>();
  private raf = 0;
  private lastFrame = 0;
  private animating = false;
  private destroyed = false;
  private reducedMotion: boolean;
  private onPick?: (placeIdx: number | null) => void;

  private intentsReceived = 0;
  private intentsGrouped = 0;
  private intentsDropped = 0;

  private constructor(Cesium: any, viewer: any, opts: GeoEngineOptions) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.reducedMotion = !!opts.reducedMotion;
    this.onPick = opts.onPick;
    this.governor = new GeoQualityGovernor(opts.tier ?? "high");
    const s = this.governor.settings;

    const scene = viewer.scene;
    this.heat = new GeoHeatLayer(Cesium, scene);
    this.arcs = new GeoArcLayer(Cesium, scene, s.arcCap);
    this.beacons = new CityBeaconLayer(Cesium, scene, s);
    this.labels = new GeoLabelLayer(Cesium, scene, s.labelCap);
    this.beacons.setDurations(s.beaconMs, s.ringMs);
    this.beacons.setReducedMotion(this.reducedMotion);
    this.arcs.setReducedMotion(this.reducedMotion);
    this.camera = new GeoCameraController(Cesium, viewer);
    this.camera.reducedMotion = this.reducedMotion;

    this.governor.onChange = (tier, set) => {
      this.beacons.setCaps(set);
      this.beacons.setDurations(set.beaconMs, set.ringMs);
      this.arcs.setCap(set.arcCap);
      this.labels.setCap(set.labelCap);
      scene.skyAtmosphere.show = set.atmosphere;
      scene.globe.showGroundAtmosphere = set.atmosphere;
      viewer.resolutionScale = set.resolutionScale;
      opts.onTierChange?.(tier);
      this.requestRender();
    };

    this.wireInput();
  }

  static async create(container: HTMLElement, opts: GeoEngineOptions = {}): Promise<GeoReplayEngine> {
    // Cesium resolves its workers and assets against this at import time, so it
    // must be set before the module is evaluated.
    const base = opts.baseUrl ?? "/cesium/";
    (globalThis as any).CESIUM_BASE_URL = base;
    const Cesium: any = await import("cesium");
    // Cesium's widget stylesheet is what sizes the canvas to its container.
    // Without it the canvas sits at its intrinsic 300x150 and the globe renders
    // into a postage stamp in the corner — visible only as a few stray points.
    // Imported here, inside the dynamic path, so it lands in the GEO chunk.
    await import("cesium/Build/Cesium/Widgets/widgets.css");

    const viewer = new Cesium.Viewer(container, {
      // Every widget off: the lens supplies its own controls, and Cesium's
      // animation/timeline widgets would compete with the History Pulse clock.
      baseLayer: false,
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      // Render on demand. Playback and camera movement request frames
      // explicitly; a paused globe costs nothing.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // The credit container is left at its default so map and data
      // attribution stays visible. The donor hid it; required attribution is
      // not decoration.
    });
    viewersCreated++;

    const scene = viewer.scene;
    // Bundled Natural Earth II — ships inside the cesium package, so this
    // resolves from the app's own origin with no key and no network.
    const base_ = await Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII"),
    );
    const layer = scene.imageryLayers.addImageryProvider(base_);
    // Natural Earth II is a bright physical map. Pull it down into an archival
    // dark register rather than shipping a second basemap: dark oceans, land
    // present but subdued, no colour competing with the beacons.
    layer.brightness = 0.32;
    layer.saturation = 0.22;
    layer.contrast = 1.3;
    layer.gamma = 0.62;

    // Attribution stays ON SCREEN, not folded into Cesium's expandable
    // lightbox. Both credits are legally required: Natural Earth II ships with
    // Cesium under its own terms, and GeoNames is CC BY 4.0 — every coordinate
    // this globe plots came from it.
    try {
      const credits = scene.frameState.creditDisplay;
      credits.addStaticCredit(
        new Cesium.Credit(
          '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">' +
            "Natural Earth II</a> via " +
            '<a href="https://cesium.com/platform/cesiumjs/" target="_blank" rel="noopener">' +
            "CesiumJS</a>",
          true,
        ),
      );
      credits.addStaticCredit(
        new Cesium.Credit(
          'Places: <a href="https://www.geonames.org" target="_blank" rel="noopener">' +
            'GeoNames</a> <a href="https://creativecommons.org/licenses/by/4.0/" ' +
            'target="_blank" rel="noopener">CC BY 4.0</a>',
          true,
        ),
      );
    } catch {
      /* credit API moved: the default credit container still shows Cesium's own */
    }

    scene.globe.baseColor = Cesium.Color.fromCssColorString("#070b12");
    scene.backgroundColor = Cesium.Color.fromCssColorString("#04060b");
    scene.globe.showGroundAtmosphere = true;
    scene.skyAtmosphere.show = true;
    // No day/night terminator: this globe shows records spanning eighty years,
    // and lighting it by today's sun would dim half of them for no reason.
    scene.globe.enableLighting = false;
    scene.globe.depthTestAgainstTerrain = false;
    scene.fog.enabled = false;
    scene.moon = undefined;
    scene.sun = undefined;
    if (scene.skyBox) scene.skyBox.show = false;

    // Camera feel, carried over from the donor: Cesium's defaults keep the
    // globe drifting after a drag and dive in huge wheel steps.
    const cc = scene.screenSpaceCameraController;
    cc.inertiaSpin = 0;
    cc.inertiaZoom = 0;
    cc.inertiaTranslate = 0;
    cc.minimumZoomDistance = 40_000;
    cc.maximumZoomDistance = 40_000_000;
    (cc as any)._zoomFactor = 2.0;

    const engine = new GeoReplayEngine(Cesium, viewer, opts);
    engine.observeResize(container);
    engine.camera.world();
    engine.requestRender();
    return engine;
  }

  private resizeObserver: ResizeObserver | null = null;

  /** requestRenderMode means Cesium only reconciles its drawing buffer during
   * a render, so a container that changes size while the globe is idle would
   * stay stretched until the next event. Watch it explicitly. */
  private observeResize(container: HTMLElement): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.destroyed || !this.viewer || this.viewer.isDestroyed()) return;
      this.viewer.resize();
      this.viewer.scene.requestRender();
    });
    this.resizeObserver.observe(container);
  }

  private wireInput(): void {
    const C = this.Cesium;
    const scene = this.viewer.scene;
    // App-created handler: Viewer.destroy() does NOT tear this down, so the
    // reference is kept and destroyed explicitly (the donor's one real
    // lifecycle lesson).
    this.handler = new C.ScreenSpaceEventHandler(scene.canvas);
    this.handler.setInputAction((m: any) => {
      const picked = scene.pick(m.position);
      const id = picked?.id;
      const placeIdx =
        id && typeof id === "object" && typeof id.placeIdx === "number" ? id.placeIdx : null;
      this.onPick?.(placeIdx);
      this.requestRender();
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    const manual = () => {
      this.camera.noteManualInput(performance.now());
      this.requestRender();
    };
    for (const type of [
      C.ScreenSpaceEventType.LEFT_DOWN,
      C.ScreenSpaceEventType.RIGHT_DOWN,
      C.ScreenSpaceEventType.MIDDLE_DOWN,
      C.ScreenSpaceEventType.WHEEL,
      C.ScreenSpaceEventType.PINCH_START,
    ]) {
      this.handler.setInputAction(manual, type);
    }
  }

  // ------------------------------------------------------------------ scope

  /** Install the places the active scope can reach. Resets accumulated heat —
   * a new scope must never inherit the previous scope's footprint. */
  setPlaces(places: GeoPlace[]): void {
    this.places = places;
    this.placeByIndex = new Map(places.map((p) => [p.index, p]));
    this.heat.setPlaces(places, this.governor.settings.heatCap);
    this.beacons.clear();
    this.arcs.clear();
    this.labels.clear();
    this.requestRender();
  }

  get placeCount(): number {
    return this.places.length;
  }

  get placesTruncated(): number {
    return this.heat.truncated;
  }

  // --------------------------------------------------------------- playback

  /**
   * Ignite this tick's beacons.
   *
   * Specs arriving for the same place are folded into one beacon before
   * anything is drawn — that is VISUAL aggregation and it is reported, not
   * hidden. The caller has already counted every underlying card, so grouping
   * here changes the picture and never the arithmetic.
   */
  pulse(specs: BeaconSpec[]): void {
    if (this.destroyed || !specs.length) return;
    this.intentsReceived += specs.reduce((n, s) => n + s.cardCount, 0);
    const merged = new Map<number, BeaconSpec>();
    for (const s of specs) {
      const prev = merged.get(s.placeIdx);
      if (prev) {
        prev.energy = Math.min(1, prev.energy + s.energy * 0.5);
        prev.gold = prev.gold || s.gold;
        prev.cardCount += s.cardCount;
        this.intentsGrouped++;
      } else {
        merged.set(s.placeIdx, { ...s });
      }
    }
    for (const s of merged.values()) {
      if (!this.beacons.ignite(s)) this.intentsGrouped++;
      this.heat.add(s.placeIdx, s.energy > 0 ? s.cardCount : s.cardCount);
    }
    this.startAnimation();
  }

  addArc(spec: ArcSpec): void {
    if (this.destroyed) return;
    this.arcs.add(spec);
    this.startAnimation();
  }

  setLabels(specs: LabelSpec[]): void {
    if (this.destroyed) return;
    this.labels.set(specs);
    this.requestRender();
  }

  setHeatWeights(weights: Float64Array): void {
    this.heat.setWeights(weights);
    this.requestRender();
  }

  resetHeat(): void {
    this.heat.reset();
    this.requestRender();
  }

  setHeatVisible(on: boolean): void {
    this.heat.setVisible(on);
    this.requestRender();
  }

  selectPlace(placeIdx: number): void {
    this.heat.setSelected(placeIdx);
    this.requestRender();
  }

  clearTransient(): void {
    this.beacons.clear();
    this.arcs.clear();
    this.requestRender();
  }

  // ----------------------------------------------------------------- camera

  setCameraMode(mode: CameraMode): void {
    this.camera.setMode(mode);
    this.requestRender();
  }

  focusPlace(placeIdx: number): void {
    const p = this.placeByIndex.get(placeIdx);
    if (!p) return;
    this.camera.focus(p.latitude, p.longitude);
    this.startAnimation();
  }

  fitPlaces(indices: number[]): void {
    const coords: Array<[number, number]> = [];
    for (const i of indices) {
      const p = this.placeByIndex.get(i);
      if (p) coords.push([p.latitude, p.longitude]);
    }
    this.camera.fit(coords);
    this.startAnimation();
  }

  worldView(): void {
    this.camera.world();
    this.startAnimation();
  }

  followEvent(placeIdx: number, eventsPerSecond: number): void {
    const p = this.placeByIndex.get(placeIdx);
    if (!p) return;
    if (this.camera.onEvent(p.latitude, p.longitude, eventsPerSecond)) this.startAnimation();
  }

  // ---------------------------------------------------------------- quality

  setTier(tier: QualityTier): void {
    this.governor.set(tier);
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.beacons.setReducedMotion(on);
    this.arcs.setReducedMotion(on);
    this.camera.reducedMotion = on;
  }

  requestRender(): void {
    if (!this.destroyed && this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.scene.requestRender();
    }
  }

  /** Drive the pooled animations. The loop runs only while something is alive,
   * so a paused, settled globe issues no frames at all. */
  private startAnimation(): void {
    if (this.animating || this.destroyed) return;
    this.animating = true;
    this.lastFrame = performance.now();
    const step = () => {
      if (this.destroyed) return;
      const now = performance.now();
      const dt = Math.min(64, now - this.lastFrame);
      this.lastFrame = now;
      this.governor.frame(dt);
      const a = this.beacons.update(dt);
      const b = this.arcs.update(dt);
      this.requestRender();
      if (a || b || this.camera.isFlying) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.animating = false;
        this.raf = 0;
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  stats(): GeoRendererStats {
    const b = this.beacons.activeCounts;
    return {
      beaconsActive: b.cores,
      ringsActive: b.rings,
      columnsActive: b.columns,
      arcsActive: this.arcs.active,
      labelsActive: this.labels.active,
      heatPoints: this.heat.drawn,
      viewersCreated,
      viewersDestroyed,
      webglContexts: viewersCreated - viewersDestroyed,
      intentsReceived: this.intentsReceived,
      intentsGrouped: this.intentsGrouped,
      intentsDropped: this.intentsDropped,
      frameMs: Math.round(this.governor.frameMs * 10) / 10,
      tier: this.governor.tier,
    };
  }

  resetCounters(): void {
    this.intentsReceived = 0;
    this.intentsGrouped = 0;
    this.intentsDropped = 0;
  }

  /** Full teardown. Order matters: the app-created input handler first (the
   * canvas must still be attached), then the layers, then the viewer. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.animating = false;
    try { this.handler?.destroy(); } catch { /* canvas already gone */ }
    this.handler = null;
    const scene = this.viewer?.scene;
    if (scene) {
      try { this.beacons.destroy(scene); } catch { /* torn down mid-frame */ }
      try { this.arcs.destroy(scene); } catch { /* */ }
      try { this.heat.destroy(scene); } catch { /* */ }
      try { this.labels.destroy(scene); } catch { /* */ }
    }
    try {
      if (this.viewer && !this.viewer.isDestroyed()) {
        this.viewer.destroy();
        viewersDestroyed++;
      }
    } catch { /* race on unmount */ }
    this.viewer = null;
    this.places = [];
    this.placeByIndex.clear();
  }

  /**
   * Where a place currently projects on the canvas, in CSS pixels, or null if
   * it is behind the globe or off screen.
   *
   * A QA seam. Hit-testing a 6px point by guessing coordinates is flaky, but
   * the click path itself — scene.pick -> onPick -> selectPlace — is exactly
   * what a reader uses, so it has to be exercised for real rather than routed
   * around. This lets a test click the precise pixel.
   */
  windowCoordinatesOf(placeIdx: number): { x: number; y: number } | null {
    const p = this.placeByIndex.get(placeIdx);
    if (!p || !this.viewer || this.viewer.isDestroyed()) return null;
    const C = this.Cesium;
    const world = C.Cartesian3.fromDegrees(p.longitude, p.latitude);
    const win = C.SceneTransforms.worldToWindowCoordinates(this.viewer.scene, world);
    if (!win) return null;
    // Reject the far hemisphere: a point behind the globe still projects.
    const occluder = new C.EllipsoidalOccluder(
      this.viewer.scene.globe.ellipsoid, this.viewer.camera.positionWC,
    );
    if (!occluder.isPointVisible(world)) return null;
    return { x: win.x, y: win.y };
  }

  /** Test/QA seam: lifecycle counters survive engine instances, so a Playwright
   * run can assert that switching lenses does not leak a WebGL context. */
  static lifecycle(): { created: number; destroyed: number } {
    return { created: viewersCreated, destroyed: viewersDestroyed };
  }
}

export { GEO_TIERS };
