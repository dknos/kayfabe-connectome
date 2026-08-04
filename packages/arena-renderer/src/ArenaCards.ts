/**
 * The instanced card field.
 *
 * One shared quad, one shared material, one draw call for the whole
 * population — measured at 600 cards in SPIKE 1. Per-instance semantics ride
 * InstancedBufferAttributes, the pattern `RatingPeaks.ts` already validates in
 * this repository against this exact three version.
 *
 * Two settings here are load-bearing and were both learned the hard way:
 *
 *   side: DoubleSide  Cards are yawed to face centre stage, which leaves
 *                     roughly half the horseshoe back-facing from any camera.
 *                     Single-sided plaques are silently culled: SPIKE 2
 *                     measured pixel-exact picking finding only 55.3% of card
 *                     centres before this was set. A data plaque must not
 *                     vanish because of viewing angle.
 *
 *   pick material     The pick pass SWAPS THE MATERIAL on this same mesh
 *                     rather than keeping a parallel picking mesh. A second
 *                     InstancedMesh sharing one BufferGeometry rendered zero
 *                     of 4096 probed pixels while the arena drew perfectly.
 */
import {
  DoubleSide, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh,
  PlaneGeometry, ShaderMaterial, type Material,
} from "three";
import type { ArenaTransition } from "./ArenaTransition";
import { CARD_H, CARD_W, CS } from "./types";

const VERTEX_HEAD = /* glsl */ `
  attribute float aBank;
  attribute float aEmphasis;
  attribute float aStrength;
  attribute float aProgress;
  attribute float aState;
  attribute float aBillboard;
  attribute float aGlyph;
`;

/**
 * The glyph strip: signed-distance marks printed on the card's top-right.
 *
 * Drawn procedurally in the same fragment shader rather than from a sprite
 * atlas, for the same reason the card face is procedural — one material, one
 * draw call for the whole population, and no texture to keep in step with the
 * card's own resolution.
 *
 * Two constraints on any mark added here:
 *
 *   symmetry   the material is DoubleSide, so the back half of the horseshoe
 *              draws the whole face mirrored. Every mark is left-right
 *              symmetric by construction, which makes the mirroring invisible
 *              — an asymmetric glyph would read backwards from half the arena.
 *
 *   height-units  UV is a unit square but the card is CARD_W x CARD_H world
 *              units, so drawing in raw UV would squash a circle into an
 *              ellipse. Marks are laid out in `g`, where x is scaled by the
 *              card's aspect and both axes measure fractions of card HEIGHT.
 */
export const GLYPH_GLSL = /* glsl */ `
  float sdBox(vec2 q, vec2 b) {
    vec2 d = abs(q) - b;
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
  }
  /** A wrestler: head over shoulders. \`pair\` draws two, for a documented
   *  tag partner. */
  float sdFigure(vec2 q, float pair) {
    float dx = pair > 0.5 ? 0.062 : 0.0;
    float scale = pair > 0.5 ? 0.80 : 1.0;
    float d = 1e9;
    for (int i = 0; i < 2; i++) {
      if (i == 1 && pair < 0.5) break;
      vec2 c = vec2(q.x + (i == 0 ? -dx : dx), q.y);
      d = min(d, length(c - vec2(0.0, 0.052 * scale)) - 0.038 * scale);
      d = min(d, sdBox(c - vec2(0.0, -0.045 * scale), vec2(0.052, 0.050) * scale) - 0.016 * scale);
    }
    return d;
  }
  /** A belt: strap with a centre plate, or with two plates for a reign the
   *  corpus records as held by a team. */
  float sdBelt(vec2 q, float tag) {
    float d = sdBox(q, vec2(0.115, 0.020)) - 0.010;
    if (tag > 0.5) {
      d = min(d, length(q - vec2(-0.052, 0.0)) - 0.042);
      d = min(d, length(q - vec2(0.052, 0.0)) - 0.042);
    } else {
      d = min(d, length(q) - 0.056);
    }
    return d;
  }
`;

export class ArenaCards {
  readonly geometry: PlaneGeometry;
  readonly mesh: InstancedMesh;
  readonly material: ShaderMaterial;
  readonly pickMaterial: ShaderMaterial;

  readonly aBank: InstancedBufferAttribute;
  readonly aEmphasis: InstancedBufferAttribute;
  readonly aStrength: InstancedBufferAttribute;
  readonly aProgress: InstancedBufferAttribute;
  readonly aState: InstancedBufferAttribute;
  readonly aId: InstancedBufferAttribute;
  /** 1 = always face the viewer, and read as subdued. Only Echo uses it: that
   *  formation is a compressed source topology, and full-size plaques pitched
   *  at arbitrary angles read as scattered debris rather than as a cloud. */
  readonly aBillboard: InstancedBufferAttribute;
  /** Packed AG bitmask: which marks this card prints. */
  readonly aGlyph: InstancedBufferAttribute;

  private readonly matrices: Float32Array;

  constructor(readonly capacity: number) {
    this.geometry = new PlaneGeometry(1, 1);
    this.aBank = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aEmphasis = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aStrength = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aProgress = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aState = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aId = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aBillboard = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.aGlyph = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (let i = 0; i < capacity; i++) (this.aId.array as Float32Array)[i] = i + 1;
    for (const a of [this.aBank, this.aEmphasis, this.aStrength, this.aProgress, this.aState, this.aBillboard, this.aGlyph]) {
      a.setUsage(DynamicDrawUsage);
    }
    this.geometry.setAttribute("aBank", this.aBank);
    this.geometry.setAttribute("aEmphasis", this.aEmphasis);
    this.geometry.setAttribute("aStrength", this.aStrength);
    this.geometry.setAttribute("aProgress", this.aProgress);
    this.geometry.setAttribute("aState", this.aState);
    this.geometry.setAttribute("aId", this.aId);
    this.geometry.setAttribute("aBillboard", this.aBillboard);
    this.geometry.setAttribute("aGlyph", this.aGlyph);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        ${VERTEX_HEAD}
        varying vec2 vUv; varying float vBank; varying float vEmphasis;
        varying float vStrength; varying float vFade; varying float vBillboard;
        varying float vGlyph;
        void main() {
          vUv = uv; vBank = aBank; vEmphasis = aEmphasis; vStrength = aStrength;
          vBillboard = aBillboard; vGlyph = aGlyph;
          // Retained cards stay fully opaque so they remain trackable through
          // the whole morph; only entering and leaving cards dissolve.
          vFade = aState < 0.5 ? 0.0
                : aState < 1.5 ? aProgress
                : aState < 2.5 ? 1.0
                : 1.0 - aProgress;
          if (aBillboard > 0.5) {
            // Face the viewer: take the instance's translation into view space
            // and offset in screen-aligned axes, keeping its own scale.
            vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float sx = length(instanceMatrix[0].xyz);
            float sy = length(instanceMatrix[1].xyz);
            mv.xy += vec2(position.x * sx, position.y * sy);
            gl_Position = projectionMatrix * mv;
          } else {
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          }
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uOpposed; uniform vec3 uSame; uniform vec3 uMixed; uniform vec3 uCenter;
        uniform vec3 uAggregate;
        uniform float uLift;
        uniform vec3 uGold; uniform vec3 uInk;
        varying vec2 vUv; varying float vBank; varying float vEmphasis;
        varying float vStrength; varying float vFade; varying float vBillboard;
        varying float vGlyph;

        ${GLYPH_GLSL}

        void main() {
          if (vFade <= 0.003) discard;
          vec3 accent = vBank < 0.5 ? uCenter
                      : vBank < 1.5 ? uOpposed
                      : vBank < 2.5 ? uSame
                      : vBank < 3.5 ? uMixed : uAggregate;

          vec2 p = vUv;
          vec2 d = abs(p - 0.5) * 2.0;

          // Rounded silhouette, cut with a signed distance field so the card
          // reads as a manufactured object rather than a rectangle.
          vec2 q = d - vec2(0.90, 0.80);
          float sdf = min(max(q.x, q.y), 0.0) + length(max(q, 0.0));
          if (sdf > 0.09) discard;

          // A dark slate face. An earlier version put a sin() grain on this to
          // suggest brushed metal; at card size that frequency aliases into
          // visible banding, so the surface is a plain gradient and the
          // material reads through its EDGE instead.
          vec3 body = mix(vec3(0.055, 0.065, 0.085), vec3(0.105, 0.120, 0.150), 1.0 - p.y);

          // A machined bevel, deliberately restrained: bright along the top lip,
          // shadowed along the bottom, enough to give thickness without turning
          // the card into a glowing frame.
          float lip = smoothstep(0.045, 0.0, abs(sdf + 0.022));
          float top = smoothstep(0.35, 1.0, 1.0 - p.y);
          body += lip * (top * 0.10 - (1.0 - top) * 0.045);

          // Accent rail, inset like a printed stripe. Its weight carries
          // documented strength; it is the only saturated thing on the card.
          float rail = smoothstep(0.048, 0.036, abs(p.x - 0.085));
          float rule = smoothstep(0.011, 0.005, abs(p.y - 0.26)) * 0.10;

          vec3 col = body;
          col = mix(col, accent * 0.85, rail * (0.55 + vStrength * 0.30));
          col += accent * rule * 0.30;
          // Emphasis lifts only the silhouette, so selection reads at the edge
          // rather than washing across the face.
          col += accent * lip * (0.03 + vEmphasis * 0.30);

          // The Stadium reads its cards as SCREENS in the stands, so they get
          // a small emissive lift there — and only there: uLift is zero in
          // every other formation, which keeps them rendering untouched.
          col += (accent * 0.20 + vec3(0.05, 0.06, 0.08)) * uLift;

          // The glyph strip. Echo is skipped deliberately: its chips are a
          // compressed source topology drawn subdued, and printing marks on
          // them puts detail where the reading is density.
          if (vGlyph > 0.5 && vBillboard < 0.5) {
            // Height-units, origin at the card's top-right corner.
            vec2 g = vec2((p.x - 1.0) * ${(CARD_W / CARD_H).toFixed(4)}, p.y - 1.0);
            float m = vGlyph;
            float solo = mod(m, 2.0);
            float pair = mod(floor(m / 2.0), 2.0);
            float belt = mod(floor(m / 4.0), 2.0);
            float tagBelt = mod(floor(m / 8.0), 2.0);

            // Right-aligned, belts outermost so the championship marks sit at
            // the card's corner where they survive the smallest on-screen size.
            float x = -0.20;
            float cy = -0.21;
            float dBelt = 1e9;
            if (tagBelt > 0.5) { dBelt = min(dBelt, sdBelt(g - vec2(x, cy), 1.0)); x -= 0.30; }
            if (belt > 0.5) { dBelt = min(dBelt, sdBelt(g - vec2(x, cy), 0.0)); x -= 0.30; }
            float dFig = 1e9;
            if (pair > 0.5) dFig = sdFigure(g - vec2(x, cy), 1.0);
            else if (solo > 0.5) dFig = sdFigure(g - vec2(x, cy), 0.0);

            float aa = max(fwidth(g.x), 0.0015) * 1.1;
            float mFig = smoothstep(aa, -aa, dFig);
            float mBelt = smoothstep(aa, -aa, dBelt);
            // Marks are printed, not lit: they replace the face rather than
            // adding to it, so a card never brightens by being decorated.
            col = mix(col, uInk, mFig * (0.55 + vEmphasis * 0.45));
            col = mix(col, uGold, mBelt * (0.70 + vEmphasis * 0.30));
          }

          // Echo is a SOURCE, not a reading: its chips stay quiet so the arena
          // that peels out of them is what the eye follows.
          float subdued = vBillboard > 0.5 ? 0.45 : 1.0;
          col *= subdued;
          float alpha = vFade * (0.80 + vEmphasis * 0.20) * subdued;
          gl_FragColor = vec4(col, alpha);
        }`,
      uniforms: {
        uCenter: { value: [1.0, 0.83, 0.47] },
        uOpposed: { value: [1.0, 0.48, 0.30] },
        uSame: { value: [0.29, 0.84, 1.0] },
        uMixed: { value: [0.91, 0.87, 0.81] },
        uAggregate: { value: [0.62, 0.66, 0.74] },
        uLift: { value: 0 },
        // Championship marks are the only gold on a card face, so a belt reads
        // as a belt across the whole arena without a legend lookup.
        uGold: { value: [1.0, 0.80, 0.38] },
        uInk: { value: [0.78, 0.82, 0.90] },
      },
    });

    /** Mirrors the visible vertex path exactly, so the picked pixel is the
     *  pixel the card draws. Id comes from an attribute because one draw call
     *  has to distinguish every instance. */
    this.pickMaterial = new ShaderMaterial({
      side: DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aId; attribute float aState;
        varying float vId; varying float vState;
        void main() {
          vId = aId; vState = aState;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying float vId; varying float vState;
        void main() {
          if (vState < 0.5) discard;
          gl_FragColor = vec4(
            mod(vId, 256.0) / 255.0,
            mod(floor(vId / 256.0), 256.0) / 255.0,
            mod(floor(vId / 65536.0), 256.0) / 255.0, 1.0);
        }`,
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
  }

  /** Compose transforms and push the per-frame dynamic attributes. */
  sync(transition: ArenaTransition): void {
    transition.writeMatrices(this.matrices);
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.aProgress.array as Float32Array).set(transition.progress);
    const state = this.aState.array as Float32Array;
    for (let i = 0; i < this.capacity; i++) state[i] = transition.state[i]!;
    this.aProgress.needsUpdate = true;
    this.aState.needsUpdate = true;
  }

  setBillboard(slot: number, on: boolean): void {
    (this.aBillboard.array as Float32Array)[slot] = on ? 1 : 0;
  }

  /** Semantic attributes change only when the population or emphasis does. */
  setSemantics(slot: number, bank: number, emphasis: number, strength01: number): void {
    (this.aBank.array as Float32Array)[slot] = bank;
    (this.aEmphasis.array as Float32Array)[slot] = emphasis;
    (this.aStrength.array as Float32Array)[slot] = strength01;
  }

  /** AG bitmask. Cleared with the rest of the semantics, because the slot pool
   *  recycles instances across subjects and a stale mask would print the
   *  previous occupant's championships on the new one. */
  setGlyph(slot: number, mask: number): void {
    (this.aGlyph.array as Float32Array)[slot] = mask;
  }

  commitSemantics(): void {
    this.aBillboard.needsUpdate = true;
    this.aBank.needsUpdate = true;
    this.aEmphasis.needsUpdate = true;
    this.aStrength.needsUpdate = true;
    this.aGlyph.needsUpdate = true;
  }

  clearSemantics(): void {
    (this.aBillboard.array as Float32Array).fill(0);
    (this.aBank.array as Float32Array).fill(0);
    (this.aEmphasis.array as Float32Array).fill(0);
    (this.aStrength.array as Float32Array).fill(0);
    (this.aGlyph.array as Float32Array).fill(0);
  }

  isLive(slot: number): boolean {
    return (this.aState.array as Float32Array)[slot] !== CS.ABSENT;
  }

  /** Swap to the id-encoding material for a pick pass, then back. */
  withPickMaterial(fn: () => void): void {
    const visible: Material | Material[] = this.mesh.material;
    this.mesh.material = this.pickMaterial;
    try {
      fn();
    } finally {
      this.mesh.material = visible;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.pickMaterial.dispose();
    this.mesh.dispose();
  }
}
