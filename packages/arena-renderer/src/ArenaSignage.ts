/**
 * Section signage.
 *
 * A sign per section, standing behind the back row of the seating it names,
 * carrying that section's documented label and its card count. This is what
 * turns a bank of plaques into "OPPONENTS · 382" — the arena stops being a
 * shape and starts being a reading.
 *
 * Built from the layout's MEASURED sections (ArenaSectionReport.arc), not from
 * the section definitions: the outer radius depends on how many cards actually
 * fit, so a sign placed from the definition floats away from its own seating
 * exactly when a bank is crowded, which is when it matters most.
 *
 * One texture and one draw call for every sign in the arena. The alternative —
 * a mesh and a texture per section — is a draw call per section and a fresh
 * GPU allocation on every rebuild. The canvas is allocated once and REDRAWN,
 * because a scope change must not allocate a texture.
 *
 * Nothing here is pickable. Signs are not people, and a sign that answered a
 * click like a wrestler card would be claiming to be one.
 */
import {
  BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, LinearFilter,
  Mesh, Scene, ShaderMaterial, SRGBColorSpace,
} from "three";
import { seatX, seatZ } from "./ArenaStadiumKit";
import { SEAT_BASE_Y, SEAT_TIER_RISE, type ArenaSectionReport } from "./types";

/** Texture rows. One per sign; the atlas is sized to the worst case so the
 *  canvas never has to be reallocated for an unusually sectioned scope. */
const MAX_SIGNS = 12;
const ROW_W = 1024;
const ROW_H = 96;

/** World size of a sign face. */
const SIGN_W = 6.6;
const SIGN_H = 0.62;

export class ArenaSignage {
  private mesh: Mesh | null = null;
  private texture: CanvasTexture | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly material: ShaderMaterial;
  private signature = "";

  /** What the last build actually put on screen, for QA and screenshots. */
  signs: { key: string; label: string; count: number }[] = [];

  constructor(private readonly scene: Scene) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = ROW_W;
    this.canvas.height = ROW_H * MAX_SIGNS;
    this.ctx = this.canvas.getContext("2d");
    // Signs BILLBOARD about the vertical axis, in the vertex shader.
    //
    // A fixed orientation cannot work here and it is worth saying why, because
    // the failure is subtle and looks like a texture bug. The horseshoe wraps
    // past 90 degrees on both flanks, so some sections sit between the reader
    // and centre stage while others sit beyond it. Whichever winding is
    // chosen, the reader sees the correct face of one group and the MIRRORED
    // face of the other — "FOUGHT AND TEAMED" comes back right-to-left while
    // "OPPONENTS" reads fine. Orbiting swaps which group is broken.
    //
    // Billboarding about Y keeps every sign upright and readable from any
    // angle while its POSITION stays on the section arc, which is what the
    // signage has to do: follow the seating, and stay legible. One draw call,
    // no per-frame CPU work, no geometry rebuild on camera movement.
    this.material = new ShaderMaterial({
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      uniforms: {
        map: { value: null },
        uOpacity: { value: 1 },
      },
      vertexShader: `
        attribute vec3 center;
        attribute vec2 corner;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          // Row 0 of the view matrix is the camera's right axis in world
          // space. Flattened onto the ground plane it keeps signs upright
          // instead of rolling with the orbit.
          vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
          vec3 p = center + right * corner.x + vec3(0.0, corner.y, 0.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D map;
        uniform float uOpacity;
        varying vec2 vUv;
        void main() {
          vec4 texel = texture2D(map, vUv);
          gl_FragColor = vec4(texel.rgb, texel.a * uOpacity);
          if (gl_FragColor.a < 0.01) discard;
        }`,
    });
  }

  /**
   * Rebuild the signs for these sections, or do nothing if they are unchanged.
   *
   * Keyed the same way the shell is: label and count, because those are what
   * the sign says, plus the arc, because that is where it stands.
   */
  build(sections: readonly ArenaSectionReport[], truncatedNote: string | null): void {
    const usable = sections.filter((s) => s.arc && s.count > 0).slice(0, MAX_SIGNS);
    const signature = usable
      .map((s) => `${s.key}:${s.label}:${s.count}:${s.arc!.outerRadius.toFixed(1)}`)
      .join("|") + `|${truncatedNote ?? ""}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.disposeMesh();
    this.signs = usable.map((s) => ({ key: s.key, label: s.label, count: s.count }));
    if (usable.length === 0 || !this.ctx) return;

    this.drawAtlas(usable, truncatedNote);
    this.buildGeometry(usable);
  }

  /** Redraw the atlas in place. The canvas and its texture are reused; only
   *  the pixels change, so a scope change costs an upload rather than an
   *  allocation. */
  private drawAtlas(sections: ArenaSectionReport[], truncatedNote: string | null): void {
    const ctx = this.ctx!;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    sections.forEach((section, i) => {
      const y = i * ROW_H;
      // A dim plate behind the type. Signage has to read against both the dark
      // upper bowl and the lit terraces, and type alone survives neither.
      ctx.fillStyle = "rgba(9,13,19,0.82)";
      ctx.fillRect(0, y + 6, ROW_W, ROW_H - 12);
      ctx.fillStyle = "rgba(120,150,180,0.5)";
      ctx.fillRect(0, y + ROW_H - 10, ROW_W, 2);

      ctx.textBaseline = "middle";
      ctx.font = "600 44px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = "#cfe0f0";
      const label = section.label.toUpperCase();
      ctx.fillText(label, 26, y + ROW_H / 2);
      const labelW = ctx.measureText(label).width;

      // The count sits with the name because a section's size IS part of what
      // it means: "OPPONENTS 382" and "TAG PARTNERS 35" is the reading.
      ctx.font = "500 38px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
      ctx.fillStyle = "#7f97ad";
      ctx.fillText(String(section.count), 26 + labelW + 22, y + ROW_H / 2);

      // A truncated roster must never read as a complete one. The note is
      // right-aligned on the sign for the section it actually applies to.
      if (truncatedNote) {
        ctx.font = "500 30px ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
        ctx.fillStyle = "#c2a25f";
        const w = ctx.measureText(truncatedNote).width;
        ctx.fillText(truncatedNote, ROW_W - w - 26, y + ROW_H / 2);
      }
    });

    if (!this.texture) {
      this.texture = new CanvasTexture(this.canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = LinearFilter;
      this.texture.magFilter = LinearFilter;
      this.texture.generateMipmaps = false;
      this.material.uniforms.map!.value = this.texture;
      this.material.needsUpdate = true;
    }
    this.texture.needsUpdate = true;
  }

  /** One quad per sign, merged, with UVs selecting that sign's atlas row. */
  private buildGeometry(sections: ArenaSectionReport[]): void {
    const n = sections.length;
    const position = new Float32Array(n * 4 * 3);
    const center = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const uv = new Float32Array(n * 4 * 2);
    const index = new Uint16Array(n * 6);

    sections.forEach((section, i) => {
      const arc = section.arc!;
      const mid = (arc.from + arc.to) / 2;
      // Behind the back row, and above it. The sign belongs to the seating it
      // names, so it is placed from that section's own outer radius.
      const radius = arc.outerRadius + 2.2;
      // Clear of the back row rather than level with it. Level, the sign sits
      // among the cards it names and competes with them for the same pixels.
      const y = SEAT_BASE_Y + arc.rows * SEAT_TIER_RISE + 2.1;
      const cx = seatX(mid, radius);
      const cz = seatZ(mid, radius);
      // Position is the section's own arc; ORIENTATION is resolved per frame in
      // the vertex shader. `position` is filled too so three can compute a
      // bounding volume, but the shader never reads it.
      const offsets = [
        [-SIGN_W / 2, -SIGN_H / 2], [SIGN_W / 2, -SIGN_H / 2],
        [SIGN_W / 2, SIGN_H / 2], [-SIGN_W / 2, SIGN_H / 2],
      ];
      for (let c = 0; c < 4; c++) {
        const k = (i * 4 + c) * 3;
        position[k] = cx + offsets[c]![0]!;
        position[k + 1] = y + offsets[c]![1]!;
        position[k + 2] = cz;
        center[k] = cx;
        center[k + 1] = y;
        center[k + 2] = cz;
        corner[(i * 4 + c) * 2] = offsets[c]![0]!;
        corner[(i * 4 + c) * 2 + 1] = offsets[c]![1]!;
      }
      // Canvas rows run top-down and texture V runs bottom-up, so row i sits
      // between these two V values rather than the obvious ones.
      const v1 = 1 - (i * ROW_H) / this.canvas.height;
      const v0 = 1 - ((i + 1) * ROW_H) / this.canvas.height;
      const uvs = [[0, v0], [1, v0], [1, v1], [0, v1]];
      for (let c = 0; c < 4; c++) {
        uv[(i * 4 + c) * 2] = uvs[c]![0]!;
        uv[(i * 4 + c) * 2 + 1] = uvs[c]![1]!;
      }
      const o = i * 4;
      index.set([o, o + 1, o + 2, o, o + 2, o + 3], i * 6);
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(position, 3));
    geometry.setAttribute("center", new BufferAttribute(center, 3));
    geometry.setAttribute("corner", new BufferAttribute(corner, 2));
    geometry.setAttribute("uv", new BufferAttribute(uv, 2));
    geometry.setIndex(new BufferAttribute(index, 1));
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.scene.add(this.mesh);
  }

  /**
   * Fade the signage in with the formation, or show it outright.
   *
   * Reduced motion passes 1 immediately: the brief forbids a decorative
   * entrance, and a sign that animates in is exactly that.
   */
  setReveal(t: number): void {
    this.material.uniforms.uOpacity!.value = Math.max(0, Math.min(1, t));
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  get drawCalls(): number {
    return this.mesh && this.mesh.visible ? 1 : 0;
  }

  private disposeMesh(): void {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh = null;
  }

  /** Force the next build to rebuild — context restore needs it. */
  invalidate(): void {
    this.signature = "";
  }

  dispose(): void {
    this.disposeMesh();
    this.texture?.dispose();
    this.texture = null;
    this.material.dispose();
  }
}
