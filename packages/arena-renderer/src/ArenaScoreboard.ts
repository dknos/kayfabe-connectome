/**
 * The suspended scoreboard.
 *
 * A four-sided board over the ring carrying who this arena is about: canonical
 * name, documented aliases, documented span, documented totals, the active
 * scope, and whatever the reader has currently selected.
 *
 * Every field is NULLABLE and every null renders as "not documented" rather
 * than as a zero. That distinction is the whole point of the component. A
 * board reading "0 matches" for a person whose match count the projection
 * simply does not carry is a fabricated record, and it is fabricated in the
 * largest type in the room.
 *
 * One BoxGeometry, one canvas, one texture, one draw call. three's default box
 * UVs map the whole texture onto each face, which is exactly what a four-sided
 * jumbotron does. The canvas is allocated ONCE and redrawn only when the text
 * actually changes — a scoreboard that re-uploaded every frame would cost more
 * than the entire rest of the shell.
 */
import {
  BoxGeometry, CanvasTexture, LinearFilter, Mesh, MeshBasicMaterial, Scene,
  SRGBColorSpace,
} from "three";

const TEX_W = 768;
const TEX_H = 384;

// Sized to be READ from the establishing camera, which sits ~40 units out on a
// large person scope. At 5.6 wide the totals row was present but illegible,
// which is the same as absent for a board whose whole job is to say who this
// arena is about.
const BOARD_W = 7.8;
const BOARD_H = 3.9;
const BOARD_Y = 7.1;

/**
 * What the corpus documents about the subject of this arena.
 *
 * Computed by the ADAPTER, never derived in the renderer. The renderer has no
 * business deciding what a match count is, and a null here has to mean "the
 * projection does not carry this" rather than "nobody filled it in".
 */
export interface ArenaSubjectFacts {
  /** the canonical display name */
  name: string;
  /** documented ring names other than the canonical one */
  aliases?: string[];
  firstYear: number | null;
  lastYear: number | null;
  /** total documented matches across the corpus */
  matches: number | null;
  /** documented relationships (person scope) or roster members (promotion) */
  relationships: number | null;
  /** documented title reigns */
  reigns: number | null;
  /** "Person" / "Promotion", plus anything qualifying the scope */
  scopeLabel: string;
}

export class ArenaScoreboard {
  private mesh: Mesh | null = null;
  private texture: CanvasTexture | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly material: MeshBasicMaterial;
  private signature = "";

  /** How many times the canvas has actually been redrawn and re-uploaded.
   *  The acceptance test for "no synchronous texture work on the hot path"
   *  reads this: it must not move while the reader is only moving the camera. */
  redraws = 0;

  constructor(private readonly scene: Scene) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = TEX_W;
    this.canvas.height = TEX_H;
    this.ctx = this.canvas.getContext("2d");
    // Unlit and untone-mapped: a jumbotron is a light source, not a lit
    // surface, and it must not dim as the arena lighting changes. Deliberately
    // NOT on BLOOM_LAYER — bloom in this renderer is a closed list, and a panel
    // this large on it would cost fill on exactly the devices the quality
    // governor is already rescuing.
    this.material = new MeshBasicMaterial({ toneMapped: false, transparent: false });
  }

  /**
   * Update the board.
   *
   * Cheap when nothing changed: a string compare. The signature covers every
   * value that reaches the canvas, so a selection change redraws and a camera
   * move does not.
   */
  update(facts: ArenaSubjectFacts | null, selection: string | null, replayDate: string | null): void {
    if (!facts || !this.ctx) return;
    const signature = [
      facts.name, (facts.aliases ?? []).join("/"), facts.firstYear, facts.lastYear,
      facts.matches, facts.relationships, facts.reigns, facts.scopeLabel,
      selection ?? "", replayDate ?? "",
    ].join("|");
    if (signature === this.signature) return;
    this.signature = signature;
    this.redraws++;
    this.draw(facts, selection, replayDate);
    if (!this.mesh) this.buildMesh();
  }

  /** "not documented" is a real answer and gets said out loud. */
  private static readonly ABSENT = "not documented";

  private draw(facts: ArenaSubjectFacts, selection: string | null, replayDate: string | null): void {
    const ctx = this.ctx!;
    ctx.clearRect(0, 0, TEX_W, TEX_H);

    // bezel and screen
    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, TEX_W, TEX_H);
    ctx.fillStyle = "#0a0f16";
    ctx.fillRect(10, 10, TEX_W - 20, TEX_H - 20);
    ctx.strokeStyle = "rgba(110,150,190,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(10, 10, TEX_W - 20, TEX_H - 20);

    ctx.textBaseline = "top";

    // scope, small, above the name
    ctx.font = "600 22px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#5f7a92";
    ctx.fillText(facts.scopeLabel.toUpperCase(), 34, 32);

    // the name, as large as it fits
    let size = 62;
    ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    while (ctx.measureText(facts.name).width > TEX_W - 68 && size > 26) {
      size -= 3;
      ctx.font = `700 ${size}px ui-sans-serif, system-ui, sans-serif`;
    }
    ctx.fillStyle = "#e8f1fa";
    ctx.fillText(facts.name, 34, 62);

    let y = 62 + size + 8;

    // Documented aliases. This is a claim about identity, so it is worded as
    // one: the corpus documents these as the same person.
    if (facts.aliases && facts.aliases.length > 0) {
      ctx.font = "500 24px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#c2a25f";
      ctx.fillText(`also documented as ${facts.aliases.join(", ")}`, 34, y);
      y += 32;
    }

    // span
    ctx.font = "500 26px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "#8fa6bb";
    const span = facts.firstYear !== null && facts.lastYear !== null
      ? `${facts.firstYear} – ${facts.lastYear}`
      : ArenaScoreboard.ABSENT;
    ctx.fillText(span, 34, y);
    y += 40;

    // The totals row. Each cell falls back to "not documented" on its own,
    // because the projection can carry one of these and not another.
    const cells: [string, string][] = [
      ["MATCHES", facts.matches === null ? ArenaScoreboard.ABSENT : facts.matches.toLocaleString()],
      [facts.scopeLabel.toLowerCase().startsWith("promotion") ? "ROSTER" : "RELATIONSHIPS",
        facts.relationships === null ? ArenaScoreboard.ABSENT : facts.relationships.toLocaleString()],
      ["REIGNS", facts.reigns === null ? ArenaScoreboard.ABSENT : facts.reigns.toLocaleString()],
    ];
    let x = 34;
    for (const [label, value] of cells) {
      ctx.font = "600 18px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#5f7a92";
      ctx.fillText(label, x, y);
      ctx.font = "700 32px ui-sans-serif, system-ui, sans-serif";
      // Gold is the championship colour throughout this lens, so the reign
      // count gets it and nothing else here does.
      ctx.fillStyle = label === "REIGNS" ? "#d9b871" : "#cfe0f0";
      ctx.fillText(value, x, y + 22);
      x += Math.max(190, ctx.measureText(value).width + 60);
    }

    // The bottom strip carries whatever is live: a replay date takes it when
    // playback is running, otherwise the current selection.
    const strip = replayDate ?? selection;
    if (strip) {
      ctx.fillStyle = "rgba(20,28,38,0.9)";
      ctx.fillRect(10, TEX_H - 58, TEX_W - 20, 48);
      ctx.font = "600 26px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = replayDate ? "#d9b871" : "#a9c0d4";
      ctx.fillText(strip, 34, TEX_H - 46);
    }

    if (!this.texture) {
      this.texture = new CanvasTexture(this.canvas);
      this.texture.colorSpace = SRGBColorSpace;
      this.texture.minFilter = LinearFilter;
      this.texture.magFilter = LinearFilter;
      this.texture.generateMipmaps = false;
      this.material.map = this.texture;
      this.material.needsUpdate = true;
    }
    this.texture.needsUpdate = true;
  }

  private buildMesh(): void {
    // Four-sided: the same board faces every direction a reader can orbit to,
    // which is what a suspended scoreboard is for.
    const geometry = new BoxGeometry(BOARD_W, BOARD_H, BOARD_W);
    geometry.translate(0, BOARD_Y, 0);
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
  }

  setVisible(visible: boolean): void {
    if (this.mesh) this.mesh.visible = visible;
  }

  get drawCalls(): number {
    return this.mesh && this.mesh.visible ? 1 : 0;
  }

  /** Force the next update to redraw. Context restore needs it. */
  invalidate(): void {
    this.signature = "";
  }

  dispose(): void {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.texture?.dispose();
    this.texture = null;
    this.material.dispose();
  }
}
