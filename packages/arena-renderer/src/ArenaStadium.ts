/**
 * The stadium environment.
 *
 * Everything physical about the Stadium formation lives here: the composed
 * bowl, the ring, the ringside chairs, the jumbotron, the entrance tron, the
 * floodlights and the crowd flashes. The card field never knows any of it —
 * cards seat on tier ellipses in ArenaLayouts that were MEASURED from this
 * geometry, and this module owes those numbers stability:
 *
 *   composed by scratchpad stadium-assets/compose.py, manifest 2026-08-04:
 *   seating rises y -1.05..9.33 between ellipse radii ~(17,19) inner and
 *   (28.4, 34.8) outer; field surface y=0; ring 6.2 wide, mat top y 0.82;
 *   chair 0.51 x 0.66 x 0.89.
 *
 * The GLBs are loaded lazily on the formation's first activation, so readers
 * who never open the Stadium never pay the 26 MB download. Until they arrive
 * the procedural pieces (lights, screens, flashes) already compose a scene —
 * a slow connection sees the show rig come up before the building does.
 *
 * Emissive surfaces join BLOOM_LAYER deliberately, honouring ArenaBloom's
 * closed-list rule: screens, light heads, LED strips and flashes may glow;
 * the building, the ring and the chairs may not.
 */
import {
  AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry,
  CanvasTexture, ConeGeometry, CylinderGeometry, DoubleSide, Group,
  HemisphereLight, InstancedMesh, Material, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PlaneGeometry, Points, RepeatWrapping,
  Scene, ShaderMaterial, SpotLight, SphereGeometry, SRGBColorSpace, Sphere, Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { BLOOM_LAYER } from "./ArenaBloom";

const ACCENT = "#59d8ff";
const ACCENT_WARM = "#ffb45e";

/** Floodlight masts on the bowl rim (the roof was cut in compose — an open
 *  bowl lights from masts), at the 45-degree points of the rim ellipse
 *  (29.2, 39.7), heads above the stands top (y 11). */
const LIGHT_HEADS: readonly [number, number, number][] = [
  [-20.6, 15, -28.1], [20.6, 15, -28.1], [-20.6, 15, 28.1], [20.6, 15, 28.1],
];
/** Stands-top rim height the masts rise from. */
const RIM_Y = 10.6;

export class ArenaStadium {
  readonly root = new Group();
  private readonly loader = new GLTFLoader();
  private loadStarted = false;
  private active = false;
  private time = 0;

  private subjectName = "";
  private subjectLine = "";
  /** What the LED ribbon crawls — the reader's current selection, or the
   *  subject when they have not pointed at anyone. */
  private bannerName = "";
  private bannerLine = "";

  private jumboTexture: CanvasTexture | null = null;
  private tronTexture: CanvasTexture | null = null;
  private ledTexture: CanvasTexture | null = null;
  private flashMaterial: ShaderMaterial | null = null;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(scene: Scene) {
    this.root.visible = false;
    scene.add(this.root);
  }

  /** Formation switch. The first activation starts the asset loads; the scene
   *  is procedural-first, so it is presentable before they resolve. */
  setActive(active: boolean): void {
    this.active = active;
    if (active && !this.loadStarted) {
      this.loadStarted = true;
      this.buildRig();
      void this.loadAssets();
    }
    this.root.visible = active;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The big screens bill the arena's headliner: jumbotron and entrance tron
   *  carry the subject the whole show is built around. */
  setSubject(name: string, line: string): void {
    if (name === this.subjectName && line === this.subjectLine) return;
    this.subjectName = name;
    this.subjectLine = line;
    if (this.jumboTexture) this.paintJumbo();
    if (this.tronTexture) this.paintTron();
    if (this.ledTexture) this.paintLed();
  }

  /**
   * The ribbon reads whoever the reader is pointing at.
   *
   * Split from the subject on purpose: a real board crawls the card while the
   * tron holds the headliner, and here that division does actual work — the
   * screens say what this arena IS, the ribbon says what you are looking at,
   * so selecting someone across the bowl names them without moving the camera
   * or opening a panel. Empty falls back to the subject, so the ribbon is
   * never blank.
   */
  setBanner(name: string, line: string): void {
    if (name === this.bannerName && line === this.bannerLine) return;
    this.bannerName = name;
    this.bannerLine = line;
    if (this.ledTexture) this.paintLed();
  }

  update(dt: number): void {
    if (!this.active) return;
    this.time += dt;
    // The ribbon crawls like a real one. Texture offset, not geometry.
    if (this.ledTexture) this.ledTexture.offset.x = (this.time * 0.016) % 1;
    if (this.flashMaterial) this.flashMaterial.uniforms.uTime!.value = this.time;
  }

  // ------------------------------------------------------------- procedural

  private buildRig(): void {
    this.buildSky();
    this.buildLights();
    this.buildJumbotron();
    this.buildEntrance();
    this.buildLedRibbon();
    this.buildFlashes();
  }

  /**
   * Night over an open bowl.
   *
   * The composed stadium has no roof, so until the camera could tilt up this
   * was never visible and never needed. Freeing the pitch made it the first
   * thing a reader finds when they look up, and an empty black frame reads as
   * the scene having failed rather than as sky.
   *
   * One inverted sphere with a vertical gradient — no texture, no stars, no
   * horizon line. It is deliberately barely-there: the arena is lit like a
   * night show and anything brighter overhead flattens the floodlights, which
   * are the only reason the bowl reads as three-dimensional at all. It stays
   * off BLOOM_LAYER for the same reason the building does.
   */
  private buildSky(): void {
    const sky = new Mesh(
      new SphereGeometry(150, 24, 16),
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying float vUp;
          void main() {
            vec4 world = modelMatrix * vec4(position, 1.0);
            vUp = clamp(world.y / 150.0, -1.0, 1.0);
            gl_Position = projectionMatrix * viewMatrix * world;
          }`,
        fragmentShader: /* glsl */ `
          precision highp float;
          varying float vUp;
          void main() {
            // Horizon haze fading to near-black overhead: the bowl rim sits at
            // y 10.6, so the reader mostly sees the bottom of this range.
            //
            // These are DISPLAY values, not linear ones. This renderer writes
            // its buffer without an sRGB encode, so a colour here lands on
            // screen at roughly value x 255 — the first pass used 0.02 and
            // rendered (5,8,14), which is why the sky read as a black void
            // rather than as night.
            vec3 horizon = vec3(0.165, 0.215, 0.300);
            vec3 zenith = vec3(0.055, 0.075, 0.120);
            gl_FragColor = vec4(mix(horizon, zenith, smoothstep(-0.05, 0.55, vUp)), 1.0);
          }`,
      }),
    );
    sky.frustumCulled = false;
    // Behind everything: the bowl, the masts and the flashes all draw over it.
    sky.renderOrder = -1;
    this.root.add(sky);
    this.track(sky.geometry, sky.material as Material);
  }

  private buildLights(): void {
    // A night bowl: cool sky bounce, near-black ground, and four hard white
    // key spots on the ring. decay 0 keeps the physical falloff out of it —
    // these are theatrical lights, tuned by eye against the seat texture.
    const hemi = new HemisphereLight(0x33415e, 0x05070c, 0.85);
    this.root.add(hemi);
    for (const [x, y, z] of LIGHT_HEADS) {
      const spot = new SpotLight(0xf4f8ff, 2.6, 0, 0.5, 0.55, 0);
      spot.position.set(x, y, z);
      spot.target.position.set(0, 0.8, 0);
      this.root.add(spot);
      this.root.add(spot.target);

      // The visible fixture: a bright head that blooms, and two nested
      // additive cones faking the haze. Dim enough to stay under the bloom
      // threshold — the glow belongs to the head, the shaft only suggests air.
      // Small and slightly cool: at bloom tuning a full-size white plane is a
      // supernova, and the head only needs to say where the beam starts.
      const head = new Mesh(
        new PlaneGeometry(1.3, 0.75),
        new MeshBasicMaterial({ color: 0xbcd2f0 }),
      );
      head.position.set(x, y, z);
      head.lookAt(0, 0.8, 0);
      head.layers.enable(BLOOM_LAYER);
      this.root.add(head);
      this.track(head.geometry, head.material as Material);

      // The mast under the head, footed on the stands rim.
      const mast = new Mesh(
        new CylinderGeometry(0.14, 0.2, y - RIM_Y + 1.2, 8),
        new MeshStandardMaterial({ color: 0x11141a, metalness: 0.6, roughness: 0.5 }),
      );
      mast.position.set(x * 0.985, (y + RIM_Y) / 2 - 0.4, z * 0.985);
      this.root.add(mast);
      this.track(mast.geometry, mast.material as Material);

      const target = new Vector3(0, 0.8, 0);
      const from = new Vector3(x, y, z);
      const dir = target.clone().sub(from);
      const length = dir.length();
      // Narrow and faint: four DoubleSide cones cross most sightlines twice,
      // so opacity here is a whole-frame veil, not a local effect — at 0.045
      // it washed every card in the bowl toward white.
      for (const [radius, opacity] of [[2.6, 0.028], [1.2, 0.04]] as const) {
        const cone = new ConeGeometry(radius, length, 24, 1, true);
        cone.translate(0, -length / 2, 0); // apex at the fixture
        const mesh = new Mesh(cone, new MeshBasicMaterial({
          color: 0x9fc4ff, transparent: true, opacity,
          blending: AdditiveBlending, depthWrite: false, side: DoubleSide,
        }));
        mesh.position.copy(from);
        mesh.quaternion.setFromUnitVectors(new Vector3(0, -1, 0), dir.clone().normalize());
        this.root.add(mesh);
        this.track(cone, mesh.material as Material);
      }
    }
  }

  private buildJumbotron(): void {
    const rig = new Group();
    // High under the roof line (~12): clear of the anchor card at 3.4 and out
    // of the hard cam's center frame, the way a real rig hangs over the ring.
    rig.position.set(0, 10.1, 0);
    // Housing and suspension: dark structure, deliberately not glowing.
    const frame = new Mesh(
      new BoxGeometry(4.9, 2.9, 4.9),
      new MeshStandardMaterial({ color: 0x171a21, metalness: 0.55, roughness: 0.5 }),
    );
    rig.add(frame);
    this.track(frame.geometry, frame.material as Material);
    // Open-air rigging: four cables rising outward, the way a flown screen
    // hangs when there is no roof to bolt to. They read at night as lines
    // against the sky and stop the rig looking pasted on.
    const cableMat = new MeshStandardMaterial({ color: 0x0d0f14, metalness: 0.4, roughness: 0.6 });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const from = new Vector3(sx * 2.3, 1.45, sz * 2.3);
      const to = new Vector3(sx * 9, 12, sz * 9);
      const span = to.clone().sub(from);
      const cable = new Mesh(new CylinderGeometry(0.045, 0.045, span.length(), 6), cableMat);
      cable.position.copy(from).addScaledVector(span, 0.5);
      cable.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), span.clone().normalize());
      rig.add(cable);
      this.track(cable.geometry);
    }
    this.track(cableMat);

    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 576;
    this.jumboTexture = new CanvasTexture(canvas);
    this.jumboTexture.colorSpace = SRGBColorSpace;
    this.paintJumbo();
    const screenMat = new MeshBasicMaterial({ map: this.jumboTexture });
    const screenGeo = new PlaneGeometry(4.5, 2.55);
    this.track(screenGeo, screenMat, this.jumboTexture);
    for (let i = 0; i < 4; i++) {
      const screen = new Mesh(screenGeo, screenMat);
      screen.rotation.y = (i * Math.PI) / 2;
      screen.position.set(
        Math.sin((i * Math.PI) / 2) * 2.47, 0, Math.cos((i * Math.PI) / 2) * 2.47,
      );
      screen.layers.enable(BLOOM_LAYER);
      rig.add(screen);
    }
    this.root.add(rig);
  }

  /** The entrance: tron screen, truss, and an LED-edged ramp to the ring —
   *  parked in the sweep gap the layout leaves at the back of the bowl. */
  private buildEntrance(): void {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 576;
    this.tronTexture = new CanvasTexture(canvas);
    this.tronTexture.colorSpace = SRGBColorSpace;
    this.paintTron();
    // Backed onto the bowl's long-axis end (seat inner z 26.4).
    const tron = new Mesh(
      new PlaneGeometry(11, 6.2),
      new MeshBasicMaterial({ map: this.tronTexture }),
    );
    tron.position.set(0, 4.4, -26.0);
    tron.layers.enable(BLOOM_LAYER);
    this.root.add(tron);
    this.track(tron.geometry, tron.material as Material, this.tronTexture);

    const trussMat = new MeshStandardMaterial({ color: 0x161920, metalness: 0.6, roughness: 0.45 });
    const column = new BoxGeometry(0.5, 8.6, 0.5);
    for (const x of [-5.95, 5.95]) {
      const post = new Mesh(column, trussMat);
      post.position.set(x, 4.3, -26.0);
      this.root.add(post);
    }
    const beam = new Mesh(new BoxGeometry(12.6, 0.5, 0.5), trussMat);
    beam.position.set(0, 8.0, -26.0);
    this.root.add(beam);
    this.track(column, beam.geometry, trussMat);

    const ramp = new Mesh(
      new BoxGeometry(3.6, 0.14, 19.6),
      new MeshStandardMaterial({ color: 0x14161c, metalness: 0.2, roughness: 0.8 }),
    );
    ramp.position.set(0, 0.07, -15.0);
    this.root.add(ramp);
    this.track(ramp.geometry, ramp.material as Material);
    const stripGeo = new BoxGeometry(0.09, 0.06, 19.6);
    const stripMat = new MeshBasicMaterial({ color: 0x59d8ff });
    for (const x of [-1.86, 1.86]) {
      const strip = new Mesh(stripGeo, stripMat);
      strip.position.set(x, 0.16, -15.0);
      strip.layers.enable(BLOOM_LAYER);
      this.root.add(strip);
    }
    this.track(stripGeo, stripMat);
  }

  /** The ribbon board on the bowl's inner lip, crawling the billing. BackSide:
   *  it is read from inside the bowl, and seen from outside it is the back of
   *  a fixture, not a second screen. */
  private buildLedRibbon(): void {
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 96;
    this.ledTexture = new CanvasTexture(canvas);
    this.ledTexture.colorSpace = SRGBColorSpace;
    this.ledTexture.wrapS = RepeatWrapping;
    // Negative: the band is read on its inner face (BackSide), which mirrors
    // U — without the flip the crawl runs backwards in mirror writing.
    this.ledTexture.repeat.x = -3;
    this.paintLed();
    const geo = new CylinderGeometry(1, 1, 0.62, 96, 1, true);
    const mesh = new Mesh(geo, new MeshBasicMaterial({ map: this.ledTexture, side: BackSide }));
    // Just inside the seat bowl's inner lip (manifest2: 17.1, 26.4).
    mesh.scale.set(16.8, 1, 26.1);
    mesh.position.y = 1.9;
    mesh.layers.enable(BLOOM_LAYER);
    this.root.add(mesh);
    this.track(geo, mesh.material as Material, this.ledTexture);
  }

  /** Camera flashes in the crowd: a few hundred points scattered over the
   *  seating band, each popping on its own clock. The pop is the whole
   *  reading — pow(sin, 48) keeps a point dark almost always, so the bowl
   *  twinkles the way a stadium crowd photographs a main event. */
  private buildFlashes(): void {
    const COUNT = 320;
    const positions = new Float32Array(COUNT * 3);
    const phase = new Float32Array(COUNT);
    const speed = new Float32Array(COUNT);
    // Deterministic scatter — same seed every mount, matching the repo's
    // "same scope, byte-identical targets" rule for anything a probe reads.
    let s = 1234567;
    const rand = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let i = 0; i < COUNT; i++) {
      const angle = (rand() * 2 - 1) * 2.9;
      const t = rand(); // 0 bottom of bowl .. 1 top
      // The seat band from manifest2: (18.2, 27.4) inner to (29.2, 39.7) out.
      const rx = 18.2 + t * 10.6 + rand() * 1.2;
      const rz = 27.4 + t * 12.0 + rand() * 1.2;
      positions[i * 3] = Math.sin(angle) * rx;
      positions[i * 3 + 1] = 2.0 + t * 8.6 + rand() * 0.5;
      positions[i * 3 + 2] = Math.cos(angle) * rz;
      phase[i] = rand();
      // Slow clocks: a real crowd photographs in scattered singles, and at
      // 0.35+ Hz the whole bowl strobed at once.
      speed[i] = 0.05 + rand() * 0.09;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    geo.setAttribute("aPhase", new BufferAttribute(phase, 1));
    geo.setAttribute("aSpeed", new BufferAttribute(speed, 1));
    // Real positions, so a real sphere — and pinned, honouring the r182
    // sortObjects requirement that every transparent object carries one.
    geo.computeBoundingSphere();
    geo.boundingSphere ??= new Sphere(new Vector3(0, 5, 0), 40);
    this.flashMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aPhase; attribute float aSpeed;
        uniform float uTime;
        varying float vGlow;
        void main() {
          vGlow = pow(max(0.0, sin(uTime * aSpeed * 6.2831 + aPhase * 6.2831)), 48.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          // Clamped size: an unclamped point is a supernova on portrait DPR.
          gl_PointSize = min(7.0, 2.5 + vGlow * 3.5);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vGlow;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = vGlow * smoothstep(0.5, 0.05, d);
          if (a < 0.004) discard;
          gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), a);
        }`,
    });
    const points = new Points(geo, this.flashMaterial);
    points.layers.enable(BLOOM_LAYER);
    this.root.add(points);
    this.track(geo, this.flashMaterial);
  }

  // ------------------------------------------------------------------ GLBs

  private async loadAssets(): Promise<void> {
    // Relative to the served page, matching the app's hash routing: works at
    // dev root and under a Pages base without knowing either.
    await Promise.all([
      this.loadEnvironment("arena/environment.glb"),
      this.loadRing("arena/ring.glb"),
      this.loadChairs("arena/chair.glb"),
    ]);
  }

  private async loadEnvironment(url: string): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(url);
      // The bowl is a SketchUp shell lit only by a cool hemi + four ring spots.
      // MeshStandard on that setup paints every under-lit face the sky colour,
      // so the stands and upper tiers read as translucent blue glass even when
      // opacity is 1. Swap the env to MeshBasic (unlit, fully opaque) so the
      // seat atlas and structure flats keep their own colour and write depth.
      //
      // Materials are SHARED across many primitives (Seat alone on 9). Build
      // one replacement per source material, then rebind every mesh.
      const replace = new Map<Material, Material>();
      const take = (mat: Material): Material => {
        const hit = replace.get(mat);
        if (hit) return hit;
        const std = mat as MeshStandardMaterial;
        const name = mat.name || "";
        const isGlass = /glass|transparent/i.test(name);
        const isSeat = /^Seat$/i.test(name);
        const isGrass = /^Grass/i.test(name);

        if (std.map) {
          std.map.colorSpace = SRGBColorSpace;
          std.map.needsUpdate = true;
        }

        // Night flats: pull daylight greys down. Seats keep full map strength.
        let color = std.color ? std.color.clone() : undefined;
        if (color && !isSeat) color.multiplyScalar(std.map ? 0.7 : 0.45);
        if (color && isSeat) color.setRGB(1, 1, 1);
        // Grass stays recognisable green under the unlit path.
        if (color && isGrass) color.multiplyScalar(1.15);

        const next = new MeshBasicMaterial({
          name: mat.name,
          map: std.map ?? null,
          color: color ?? 0x888888,
          side: DoubleSide,
          transparent: isGlass,
          opacity: isGlass ? 0.28 : 1,
          depthWrite: !isGlass,
          alphaTest: 0,
          // Still pass through ACES so the bowl matches the lit ring/rig.
          toneMapped: true,
        });
        replace.set(mat, next);
        this.disposables.push(next);
        return next;
      };

      gltf.scene.traverse((obj) => {
        if (!(obj as Mesh).isMesh) return;
        const mesh = obj as Mesh;
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map((m) => take(m));
        } else if (mesh.material) {
          mesh.material = take(mesh.material);
        }
      });
      this.root.add(gltf.scene);
    } catch (err) {
      console.warn("stadium environment failed to load; the rig stands alone", err);
    }
  }

  private async loadRing(url: string): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(url);
      this.root.add(gltf.scene);
    } catch (err) {
      console.warn("stadium ring failed to load", err);
    }
  }

  private async loadChairs(url: string): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(url);
      let source: Mesh | null = null;
      gltf.scene.traverse((obj) => {
        if ((obj as Mesh).isMesh && !source) source = obj as Mesh;
      });
      if (!source) return;
      const mesh = source as Mesh;
      // Ringside furniture is black at a night show; the sourced chair is
      // near-white and read as rows of teeth under the spots.
      const chairMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of chairMats) {
        const std = mat as MeshStandardMaterial;
        if (std.color) std.color.multiplyScalar(0.3);
      }
      // Ringside: two rows per side, the wrestling furniture everyone knows.
      const rows = [4.6, 5.5];
      const perRow = 11;
      const count = 4 * rows.length * perRow;
      const chairs = new InstancedMesh(mesh.geometry, mesh.material, count);
      const dummy = new Object3D();
      const m = new Matrix4();
      let i = 0;
      for (let side = 0; side < 4; side++) {
        const yaw = (side * Math.PI) / 2;
        for (const dist of rows) {
          for (let k = 0; k < perRow; k++) {
            const lateral = (k - (perRow - 1) / 2) * 0.62;
            dummy.position.set(lateral, 0, dist);
            dummy.rotation.set(0, Math.PI, 0); // face the ring
            dummy.updateMatrix();
            m.makeRotationY(yaw).multiply(dummy.matrix);
            chairs.setMatrixAt(i++, m);
          }
        }
      }
      chairs.instanceMatrix.needsUpdate = true;
      this.root.add(chairs);
      this.disposables.push(chairs);
    } catch (err) {
      console.warn("stadium chairs failed to load", err);
    }
  }

  // -------------------------------------------------------------- canvases

  private paintJumbo(): void {
    const canvas = this.jumboTexture!.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#06090f");
    bg.addColorStop(1, "#0a1018");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 10;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.textAlign = "center";
    ctx.fillStyle = "#eef6ff";
    ctx.font = `700 ${this.fitFont(ctx, this.subjectName || "—", w - 120, 128)}px Inter, system-ui, sans-serif`;
    ctx.fillText(this.subjectName || "—", w / 2, h * 0.46);
    ctx.fillStyle = ACCENT_WARM;
    ctx.font = "600 44px Inter, system-ui, sans-serif";
    ctx.fillText(this.subjectLine.toUpperCase(), w / 2, h * 0.72);
    this.jumboTexture!.needsUpdate = true;
  }

  private paintTron(): void {
    const canvas = this.tronTexture!.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    const bg = ctx.createRadialGradient(w / 2, h / 2, 60, w / 2, h / 2, w * 0.7);
    bg.addColorStop(0, "#0d1b2a");
    bg.addColorStop(1, "#05070c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.fillStyle = ACCENT;
    ctx.font = "700 64px Inter, system-ui, sans-serif";
    ctx.fillText("KAYFABE CONNECTOME", w / 2, h * 0.3);
    ctx.fillStyle = "#eef6ff";
    ctx.font = `800 ${this.fitFont(ctx, this.subjectName || "—", w - 100, 150)}px Inter, system-ui, sans-serif`;
    ctx.fillText(this.subjectName || "—", w / 2, h * 0.62);
    ctx.fillStyle = "#8fa8bf";
    ctx.font = "500 40px Inter, system-ui, sans-serif";
    ctx.fillText(this.subjectLine, w / 2, h * 0.82);
    this.tronTexture!.needsUpdate = true;
  }

  private paintLed(): void {
    const canvas = this.ledTexture!.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { width: w, height: h } = canvas;
    ctx.fillStyle = "#04070c";
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = ACCENT;
    ctx.font = "700 56px Inter, system-ui, sans-serif";
    const name = this.bannerName || this.subjectName || "";
    const line = this.bannerName ? this.bannerLine : this.subjectLine;
    const text = `${name.toUpperCase()}  ✦  ${line.toUpperCase()}  ✦  `;
    // Tile to the canvas edge so the wrap seam lands between repeats.
    const span = Math.max(1, ctx.measureText(text).width);
    for (let x = 0; x < w; x += span) ctx.fillText(text, x, h / 2);
    this.ledTexture!.needsUpdate = true;
  }

  private fitFont(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startPx: number): number {
    let px = startPx;
    for (; px > 40; px -= 6) {
      ctx.font = `700 ${px}px Inter, system-ui, sans-serif`;
      if (ctx.measureText(text).width <= maxWidth) break;
    }
    return px;
  }

  private track(...items: { dispose(): void }[]): void {
    this.disposables.push(...items);
  }

  dispose(): void {
    this.root.removeFromParent();
    // GLB scenes: geometry and material live on their meshes.
    this.root.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh && !(obj as Points).isPoints) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) mat?.dispose();
    });
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
  }
}
