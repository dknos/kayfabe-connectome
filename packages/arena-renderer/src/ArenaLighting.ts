/**
 * Arena light: three real lights, additive cones for the shafts, and fog for
 * the room.
 *
 * The expensive way to do this is a volumetric raymarch. It is rejected here —
 * the bloom chain alone measures ~89 ms a frame half-resolution on the software
 * path (docs/ARENA_ARRAY.md), and a march would land on exactly the devices the
 * quality governor is already rescuing. Additive cone meshes read as light
 * shafts from every angle a reader can reach and cost one draw call.
 *
 * The haze is `scene.fog`, and it has a property worth stating because it looks
 * like an accident: the card field is a raw ShaderMaterial with no fog uniforms
 * (ArenaCards), so fog acts on the ARCHITECTURE and not on the cards. The shell
 * recedes with distance while every card stays at full legibility, which is the
 * subordination this lens needs, for free.
 */
import {
  AdditiveBlending, AmbientLight, ConeGeometry, FogExp2, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, PointLight, Scene,
  type BufferGeometry,
} from "three";
import { SEAT_Z_SQUASH, mergePositions } from "./ArenaStadiumKit";

/** Fog colour. Matches the page background, so the bowl fades into the room
 *  rather than into a visible grey wall. */
const FOG_COLOR = 0x05070b;

export interface ArenaLightingOptions {
  detail: "full" | "medium" | "simple";
}

export class ArenaLighting {
  readonly group = new Group();
  private readonly ambient: AmbientLight;
  private readonly hemi: HemisphereLight;
  private readonly key: PointLight;

  constructor(private readonly scene: Scene) {
    // Deliberately few. Every light is a per-fragment cost across the whole
    // bowl, and the shell is matte structural surface that gains nothing from
    // a fourth. Shadows are off at every tier: a shadow map would be a second
    // full render of the architecture to make a step edge slightly crisper.
    this.ambient = new AmbientLight(0x2c3644, 0.55);
    this.hemi = new HemisphereLight(0x35506e, 0x05070a, 0.85);
    // Well below the truss. Sat at 9.0 against a truss at 9.4, the steel was
    // effectively inside the lamp and blew out into a bright slab hanging over
    // the arena — the single brightest thing in a frame whose subject is the
    // cards.
    this.key = new PointLight(0xdce8ff, 70, 54, 2);
    this.key.position.set(0, 6.2, 0);
    this.group.add(this.ambient, this.hemi, this.key);
    scene.add(this.group);
  }

  apply(options: ArenaLightingOptions): void {
    const full = options.detail === "full";
    const simple = options.detail === "simple";
    // Fog density scales with what is actually built: a simple bowl has no
    // upper tier to lose, and fogging it only dims the terraces.
    this.scene.fog = simple ? null : new FogExp2(FOG_COLOR, full ? 0.0125 : 0.0092);
    this.key.intensity = simple ? 52 : 70;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    // Fog is a scene property rather than an object, so hiding the group is not
    // enough — a hidden arena would still fog the Index wall.
    if (!visible) this.scene.fog = null;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ambient.dispose();
    this.hemi.dispose();
    this.key.dispose();
    this.scene.fog = null;
  }
}

/**
 * Light shafts from the truss down onto the ring.
 *
 * Open-ended cones, additive, no depth write — so they brighten what they
 * cross instead of occluding it, and a card behind one is dimmed by nothing.
 * Merged into a single geometry.
 */
export function buildLightCones(count: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const trussY = 9.4;
  const span = 6.4;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(angle) * span;
    const z = Math.sin(angle) * span * SEAT_Z_SQUASH;
    const height = trussY + 1.4;
    // openEnded: a capped cone shows a bright disc at the truss that reads as
    // a solid object rather than as a beam.
    const cone = new ConeGeometry(1.9, height, 18, 1, true);
    cone.translate(0, -height / 2, 0);
    // Tilt each shaft in towards the ring so they converge on the mat.
    const tilt = 0.20;
    cone.rotateX(Math.sin(angle) * tilt);
    cone.rotateZ(-Math.cos(angle) * tilt);
    cone.translate(x, trussY, z);
    parts.push(cone);
  }
  return mergePositions(parts);
}

/** The shared material for the cones. Very low opacity: a shaft that reads
 *  clearly on its own is far too strong once four of them overlap the ring. */
export function lightConeMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: 0x9fc4ff,
    transparent: true,
    // Four additive shafts overlapping a near-black room compound fast. At
    // 0.038 they stopped reading as light and became pale solid triangles
    // standing in front of the seating, washing out the cards behind them.
    opacity: 0.013,
    blending: AdditiveBlending,
    depthWrite: false,
  });
}

/** The shared material for ribbon strips and distant marker lights. Bright,
 *  additive, and NOT on the bloom layer — see ArenaArchitecture. */
export function ribbonMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: 0x6fa8d8,
    transparent: true,
    opacity: 0.42,
    blending: AdditiveBlending,
    depthWrite: false,
  });
}

/** Helper for callers that want the cone mesh assembled. */
export function makeLightConeMesh(count: number): Mesh {
  const mesh = new Mesh(buildLightCones(count), lightConeMaterial());
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return mesh;
}
