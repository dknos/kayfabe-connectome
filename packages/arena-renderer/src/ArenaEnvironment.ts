/**
 * The stadium shell, and the decision about when it is allowed to be rebuilt.
 *
 * The rebuild policy is the load-bearing part of this file. `applyTier()`
 * cascades into `setScope()` and then `setFormation()` (ArenaRenderer), so the
 * quality governor stepping down would otherwise rebuild the entire shell
 * inside a frame that was already too slow — making the miss worse and risking
 * exactly the oscillation the governor is designed to avoid. Every rebuild is
 * therefore keyed on a signature, and anything that does not change the
 * signature costs a string compare.
 *
 * Visibility is a flag, never a rebuild. The shell belongs to the ARENA
 * reading, the same way the championship rail does: the Index is an archive
 * wall and the Echo is a source topology, and a stadium around either would be
 * claiming a venue for a thing that is not an event. Switching to the Index and
 * back costs nothing.
 *
 * Nothing here is pickable. `ArenaPicking.pick` is handed the card field
 * explicitly, so no architecture can ever intercept a click on a wrestler — a
 * property of the design rather than of a filter that could be forgotten.
 */
import {
  BackSide, DoubleSide, FrontSide, Mesh, MeshBasicMaterial, MeshLambertMaterial, Scene,
  type BufferGeometry,
} from "three";
import { buildArchitecture } from "./ArenaArchitecture";
import { ArenaLighting, lightConeMaterial, makeLightConeMesh, ribbonMaterial } from "./ArenaLighting";
import { ArenaScoreboard } from "./ArenaScoreboard";
import { ArenaSignage } from "./ArenaSignage";
import { buildStage } from "./ArenaStage";
import type { ArenaFormation, ArenaQualityTier, ArenaSectionReport } from "./types";

export interface ArenaEnvironmentInput {
  formation: ArenaFormation;
  tier: ArenaQualityTier;
  extent: number;
  sections: readonly ArenaSectionReport[];
  /** Cards the budget could not seat. Surfaced ON the signage, because a
   *  truncated roster that reads as a complete one is a false claim. */
  dropped?: number;
}

type Detail = "full" | "medium" | "simple";

const DETAIL_FOR_TIER: Record<ArenaQualityTier, Detail> = {
  high: "full",
  medium: "medium",
  low: "simple",
};

/** Light shafts per tier. Zero at low, where there is no truss to hang them
 *  from and the fill cost buys nothing. */
const CONES_FOR_DETAIL: Record<Detail, number> = { full: 4, medium: 2, simple: 0 };

export class ArenaEnvironment {
  private stage: Mesh | null = null;
  private structure: Mesh | null = null;
  private bowl: Mesh | null = null;
  private ribbons: Mesh | null = null;
  private cones: Mesh | null = null;
  private readonly lighting: ArenaLighting;
  readonly signage: ArenaSignage;
  readonly scoreboard: ArenaScoreboard;

  private signature = "";
  private visible = false;

  /** How many times the shell has actually been rebuilt. The acceptance test
   *  for "no per-frame geometry rebuild" reads this. */
  rebuilds = 0;
  /** Wall-clock cost of the last rebuild, for the performance table. */
  lastBuildMs = 0;

  constructor(private readonly scene: Scene) {
    this.lighting = new ArenaLighting(scene);
    this.lighting.setVisible(false);
    this.signage = new ArenaSignage(scene);
    this.signage.setVisible(false);
    this.scoreboard = new ArenaScoreboard(scene);
    this.scoreboard.setVisible(false);
  }

  /**
   * Reconcile the shell with the current reading.
   *
   * Cheap by default: a signature compare and, at most, a visibility flip.
   */
  sync(input: ArenaEnvironmentInput): void {
    const wanted = input.formation === "arena";
    if (!wanted) {
      // Do NOT tear the shell down — a reader flipping to the Index and back is
      // the common case, and rebuilding both ways would put a geometry build on
      // an interaction that should be free.
      this.setVisible(false);
      return;
    }
    const signature = this.signatureOf(input);
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild(input);
    }
    this.setVisible(true);
  }

  /**
   * What the shell actually depends on.
   *
   * Section COUNTS are in it because a section's row depth follows from them,
   * and the terraces are built to that depth. The formation is not — the shell
   * exists only for the Arena, and including it would rebuild on every trip to
   * the Index and back for a shell that is merely hidden.
   */
  private signatureOf(input: ArenaEnvironmentInput): string {
    const sections = input.sections
      .map((s) => `${s.key}:${s.count}:${s.arc ? s.arc.rows : 0}`)
      .join(",");
    // Quantised: a sub-decimal change in extent is not a different stadium, and
    // keying on the raw float would rebuild whenever a layout jittered.
    return `${input.tier}|${input.extent.toFixed(1)}|${sections}`;
  }

  private rebuild(input: ArenaEnvironmentInput): void {
    const t0 = performance.now();
    this.disposeMeshes();
    const detail = DETAIL_FOR_TIER[input.tier];
    const maxRows = input.sections.reduce((n, s) => Math.max(n, s.arc?.rows ?? 0), 1);

    const stageGeo = buildStage({
      extent: input.extent,
      detail: detail === "simple" ? "simple" : "full",
    });
    this.stage = new Mesh(stageGeo, this.shellMaterial(FrontSide));
    this.stage.frustumCulled = false;
    this.stage.renderOrder = -2;
    this.scene.add(this.stage);

    const arch = buildArchitecture({
      extent: input.extent,
      maxRows,
      sections: input.sections,
      detail,
    });
    // Terraces, aisles and truss are all SHORT, so they can be seen from either
    // face without ever standing between the reader and the arena.
    this.structure = new Mesh(arch.structure, this.shellMaterial(DoubleSide));
    this.structure.frustumCulled = false;
    this.structure.renderOrder = -1;
    this.scene.add(this.structure);

    // The enclosing silhouette is the one piece that SURROUNDS the camera, and
    // it is the single most load-bearing material decision in the shell.
    //
    // The camera frames from the cards' bounding box, which for a 382-opponent
    // bank sits at ~40 units while the upper bowl stands at ~32 — so the reader
    // is regularly outside it. Rendered DoubleSide, its near wall covers the
    // entire arena, and because the shell is deliberately near-black that does
    // not read as a wall. It reads as a renderer drawing nothing at all.
    //
    // BackSide shows only the faces pointing away from the camera, so the bowl
    // is something the reader always looks INTO, from inside or out — which is
    // also the correct reading of a stadium.
    if (arch.bowl) {
      const material = this.shellMaterial(BackSide);
      // Belt and braces, and worth the line. Correct winding already keeps the
      // near wall culled, but the bowl is the one surface whose failure mode is
      // "the entire lens renders black" rather than "something looks wrong".
      // Drawn first and writing no depth, it is a BACKDROP: whatever the
      // winding turns out to be on some future edit, it can never occlude a
      // card, because there is no depth for a card to fail against.
      material.depthWrite = false;
      this.bowl = new Mesh(arch.bowl, material);
      this.bowl.frustumCulled = false;
      this.bowl.renderOrder = -3;
      this.scene.add(this.bowl);
    }

    if (arch.lights) {
      this.ribbons = new Mesh(arch.lights, ribbonMaterial());
      this.ribbons.frustumCulled = false;
      this.ribbons.renderOrder = 2;
      this.scene.add(this.ribbons);
    }

    const coneCount = CONES_FOR_DETAIL[detail];
    if (coneCount > 0) {
      this.cones = makeLightConeMesh(coneCount);
      this.scene.add(this.cones);
    }

    this.lighting.apply({ detail });
    // Signage is rebuilt with the shell but keyed independently: the labels and
    // counts can change without the terraces moving at all.
    this.signage.build(
      input.sections,
      input.dropped && input.dropped > 0 ? `+${input.dropped} not seated` : null,
    );
    this.rebuilds++;
    this.lastBuildMs = performance.now() - t0;
  }

  /**
   * Lambert, not Standard.
   *
   * The shell is matte structural surface — graphite, charcoal and steel under
   * three fixed lights — and PBR buys it nothing a reader can see. It costs a
   * great deal, though, because the shell covers most of the frame and the
   * quality governor's worst case is a fill-bound software rasteriser.
   * Measured at 1920x1080 on that path, a Standard shell cost 25-30 ms a frame
   * at EVERY tier, which took the low tier from 16.7 ms (60 fps) to 42.2 ms
   * (24 fps) and broke the one promise the low tier has to keep.
   */
  private shellMaterial(side: typeof FrontSide | typeof DoubleSide | typeof BackSide): MeshLambertMaterial {
    return new MeshLambertMaterial({
      vertexColors: true,
      side,
      // The shell must never write into the emphasis pass. Bloom is a closed
      // list in this renderer and this material is not on it.
      fog: true,
    });
  }

  private setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    for (const mesh of [this.stage, this.structure, this.bowl, this.ribbons, this.cones]) {
      if (mesh) mesh.visible = visible;
    }
    this.lighting.setVisible(visible);
    this.signage.setVisible(visible);
    this.scoreboard.setVisible(visible);
  }

  /** Draw calls this shell contributes, for the tier budget table. Counted
   *  from what is actually in the scene rather than from what was intended. */
  get drawCalls(): number {
    if (!this.visible) return 0;
    let n = this.signage.drawCalls + this.scoreboard.drawCalls;
    for (const mesh of [this.stage, this.structure, this.bowl, this.ribbons, this.cones]) {
      if (mesh && mesh.visible) n++;
    }
    return n;
  }

  /** Temporarily hide the shell so a caller can measure the frame without it.
   *  Used by the draw-call probe to attribute cost honestly. */
  suspend(): boolean {
    const was = this.visible;
    this.setVisible(false);
    return was;
  }
  restore(was: boolean): void {
    this.setVisible(was);
  }

  private disposeMeshes(): void {
    for (const mesh of [this.stage, this.structure, this.bowl, this.ribbons, this.cones]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      (mesh.geometry as BufferGeometry).dispose();
      const material = mesh.material as MeshLambertMaterial | MeshBasicMaterial;
      material.dispose();
    }
    this.stage = null;
    this.structure = null;
    this.bowl = null;
    this.ribbons = null;
    this.cones = null;
  }

  /** Force the next sync to rebuild. Context restore needs this: three
   *  re-uploads its own GPU resources, but the signature would otherwise say
   *  the shell is already correct and skip the rebuild entirely. */
  invalidate(): void {
    this.signature = "";
    this.signage.invalidate();
    this.scoreboard.invalidate();
  }

  /**
   * Reveal the signage on the formation's clock.
   *
   * The names of the sections resolve as the cards settle into them, the same
   * ordering the evidence routes follow. Reduced motion is handed 1 outright
   * by the caller, because a sign animating in is a decorative entrance and
   * the brief forbids one.
   */
  setReveal(t: number): void {
    this.signage.setReveal(t);
  }

  dispose(): void {
    this.disposeMeshes();
    this.signage.dispose();
    this.scoreboard.dispose();
    this.lighting.dispose();
  }
}

/** Re-exported so callers can build a cone material without reaching past this
 *  module into the lighting internals. */
export { lightConeMaterial };
