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
  attribute float aId;
  uniform float uTime;
`;

/**
 * How much taller and narrower a seated PERSON is than the plaque whose slot
 * they occupy.
 *
 * The layout allots every seat the same footprint, and a standing figure has
 * to live inside it without the layout knowing anything changed — so the quad
 * is reshaped in the vertex shader and anchored at the seat's bottom edge
 * rather than resized in `ArenaLayouts`. Seat pitch, tier spacing and the
 * camera fit all keep working off the original footprint, and figures rise out
 * of their row and overlap the row behind exactly as a crowd does.
 *
 * FIGURE_X is margin, not size: a body's proportions come from FIGURE_Y and
 * the card height, so widening the quad only buys room around the figure. It
 * has to buy enough. At 0.55 a tag pair needed 0.326 of frame half-width and
 * had 0.281, so both partners had their OUTER ARMS SLICED OFF at the quad
 * edge — and the arm that survived was the inner one, which is why a pair read
 * as two people fused together. Any change to the pair spacing, the arm reach
 * or the lean amplitude has to be checked against this number.
 */
const FIGURE_X = 0.7;
const FIGURE_Y = 1.65;
/** The figure's own frame: x in ±ASPECT/2, y from 0 at the feet to 1 at the
 *  top of a raised belt. Every number in FIGURE_GLSL is in these units. */
const FIGURE_ASPECT = (CARD_W * FIGURE_X) / (CARD_H * FIGURE_Y);

/**
 * A tag pair's two bodies: how far apart, and how much smaller.
 *
 * These are shared by three places — the visible shader, the pick shader and
 * the legend — and they must agree, so they live here rather than as literals
 * in each. The separation is set by the ARMS, not the torsos: at the first
 * spacing the inner arms reached past the midline and crossed into an X
 * between the two bodies, which reads as a rendering fault rather than as two
 * people. An arm reaches PAIR_SCALE * 0.165, so the gap has to clear that.
 */
export const PAIR_SCALE = 0.72;
export const PAIR_DX = 0.15;

/**
 * Where a belt is worn, in figure units. Shared with the legend for the same
 * reason the pair spacing is.
 *
 * Both sit at the waist, the tag belt below the singles one, close enough that
 * someone carrying two reads as carrying two rather than as wearing a thick
 * band.
 *
 * The scale is set by the BODY, not by taste: a raised belt could be small
 * because it was silhouetted against the background, and the first worn
 * version kept that size and vanished into the torso. A belt is as wide as the
 * hips it is strapped around — 0.128 of frame width against a torso half-width
 * of 0.088 — which stops just inside the arms hanging at 0.156.
 */
export const BELT_SCALE = 1.12;
export const BELT_Y_SINGLES = 0.455;
export const BELT_Y_TAG = 0.35;

/**
 * The seat's local vertex position.
 *
 * Shared verbatim by the visible material and the pick material. They MUST
 * agree: the pick pass reads an id out of a colour buffer, so a figure that
 * sways one way while its pick silhouette sways the other is a card the reader
 * can see and cannot click. That failure is silent and intermittent, which is
 * the worst kind, so there is one copy of this and both materials include it.
 *
 * The quad itself no longer moves. Swaying it moved everything drawn inside
 * it as ONE rigid thing, which is fine for a lone figure and wrong for a tag
 * pair: two people who lean in perfect lockstep read as a cardboard cutout of
 * two people. The motion lives in the fragment shader now, per BODY — see
 * `arenaBody` — so partners drift in and out of step with each other the way
 * two people standing together actually do.
 */
const SEAT_VERTEX_GLSL = /* glsl */ `
  vec3 arenaSeat(vec3 pos, float glyph) {
    if (glyph < 0.5) return pos;
    float up = pos.y + 0.5;
    return vec3(
      pos.x * ${FIGURE_X.toFixed(3)},
      up * ${FIGURE_Y.toFixed(3)} - 0.5,
      pos.z);
  }
  /**
   * A plaque is a SIGN and is yawed to face centre stage; a person is not.
   * Left on the sign's orientation, everyone on the far side of the horseshoe
   * was viewed edge-on and drew as a vertical streak — a body squashed to
   * nothing with its legs trailing off. Figures always face the reader, which
   * is also just what a crowd does.
   */
  vec4 arenaSeatClip(vec3 seat, float billboard, mat4 im, mat4 mv, mat4 pm) {
    if (billboard > 0.5) {
      // Face the viewer: take the instance's translation into view space and
      // offset in screen-aligned axes, keeping its own scale.
      vec4 c = mv * im * vec4(0.0, 0.0, 0.0, 1.0);
      c.xy += vec2(seat.x * length(im[0].xyz), seat.y * length(im[1].xyz));
      return pm * c;
    }
    return pm * mv * im * vec4(seat, 1.0);
  }
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

/**
 * The person in the seat.
 *
 * A wrestler, not a pictogram of one: head, torso, arms and legs as one
 * union of distance fields, so the silhouette stays clean at every size the
 * arena is read at — 20 px in the back row of a promotion, half the viewport
 * when the reader walks up to a card. A sprite atlas would have needed a
 * resolution chosen for one of those and wrong for the other.
 *
 * Everyone stands the same way. An earlier version raised a champion's arms —
 * the sport's own gesture, and it read badly: a crowd where most people held a
 * belt (a promotion's roster is mostly champions) turned into a field of
 * identical raised arms, and in a tag pair the two sets of raised arms tangled.
 * The championship is carried entirely by the BELT now, which is the part that
 * was legible anyway:
 *
 *   one plate    reigns held ALONE
 *   two plates   reigns held WITH A PARTNER, worn below the first
 *
 * Both can be true at once and both are drawn, stacked at the waist, because a
 * person who held a singles belt and a tag belt held two different things.
 *
 * A documented tag PARTNER of the subject is two figures rather than one. They
 * are one card and one person: the second figure says what the relationship is,
 * so the belts stay centred on the pair and are drawn once. Two sets would
 * claim reigns the corpus attributes to one of them.
 */
const FIGURE_GLSL = /* glsl */ `
  /**
   * Into one body's own frame: feet planted at y = 0, weight shifting over
   * them. Returning the INVERSE of the motion means the body moves while the
   * quad it is drawn on stays still, which is what lets two partners on a
   * shared quad move independently.
   *
   * Nothing in here may have a corner in it. An early version bobbed on
   * abs(sin(t)), whose derivative flips sign at every zero crossing — a hard
   * kick twice a cycle, and exactly what "sudden" looks like on screen. The
   * vertical term is 0.5 - 0.5*cos, the same shape without the corner. Phase
   * alone left the whole arena moving at one rate, so the rate varies too.
   */
  vec2 arenaBody(vec2 f, float seed, float time) {
    float ph = seed * 1.61803;
    float t = time * (0.78 + fract(seed * 0.61803) * 0.44);
    float lean = sin(t * 0.62 + ph) * 0.052 + sin(t * 0.27 + ph * 1.7) * 0.020;
    float bob = (0.5 - 0.5 * cos(t * 0.62 + ph * 1.3)) * 0.016;
    return vec2(f.x - lean * f.y, f.y - bob);
  }
  float sdSeg(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
  }
  float sdWrestler(vec2 q) {
    float d = length(q - vec2(0.0, 0.795)) - 0.076;
    // A neck, because the head and the torso do not otherwise meet: the gap is
    // invisible at back-row size and unmistakable the moment a reader walks up
    // to the subject, who is drawn half a viewport tall.
    d = min(d, sdSeg(q, vec2(0.0, 0.660), vec2(0.0, 0.745), 0.026));
    d = min(d, sdBox(q - vec2(0.0, 0.545), vec2(0.058, 0.100)) - 0.030);
    d = min(d, sdSeg(q, vec2(-0.036, 0.410), vec2(-0.062, 0.036), 0.030));
    d = min(d, sdSeg(q, vec2( 0.036, 0.410), vec2( 0.062, 0.036), 0.030));
    // Arms hang clear of the torso rather than out of it, or the silhouette
    // reads as one wide slab with no shoulders. PAIR_DX is set from this reach.
    d = min(d, sdSeg(q, vec2(-0.094, 0.665), vec2(-0.165, 0.425), 0.027));
    d = min(d, sdSeg(q, vec2( 0.094, 0.665), vec2( 0.165, 0.425), 0.027));
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
      // Depth is UNWRITTEN, and there is a known problem behind that.
      //
      // The whole population is one instanced draw, so the order bodies paint
      // in is their INSTANCE INDEX and has nothing to do with where they stand.
      // Measured on a 160-card arena: 1,380 pairs of figures overlap on screen
      // and 664 of them — 48% — paint the farther body over the nearer one.
      // Which pairs overlap changes as the camera moves, so bodies can swap in
      // front of each other while the reader orbits. It was invisible with flat
      // plaques and is not with billboarded figures 1.65 seat-heights tall.
      //
      // depthWrite: true resolves it in principle, and a controlled A/B at two
      // framings (same camera, one variable) showed NO visible difference — so
      // it has not been taken on that evidence, and the cost is real: a body
      // that writes depth has to be a hard cutout, which loses the anti-aliased
      // silhouette, and the transition fade has to become a screen door.
      //
      // The fix that would actually pay is sorting the instances back to front
      // each frame, which keeps the soft edge. It is not free: every
      // per-instance attribute has to be permuted along with the matrices, and
      // aId has to keep carrying the original slot so picking still resolves.
      depthWrite: false,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        ${VERTEX_HEAD}
        ${SEAT_VERTEX_GLSL}
        varying vec2 vUv; varying float vBank; varying float vEmphasis;
        varying float vStrength; varying float vFade; varying float vBillboard;
        varying float vGlyph; varying float vSeed;
        void main() {
          vUv = uv; vBank = aBank; vEmphasis = aEmphasis; vStrength = aStrength;
          vBillboard = aBillboard; vGlyph = aGlyph; vSeed = aId;
          // Retained cards stay fully opaque so they remain trackable through
          // the whole morph; only entering and leaving cards dissolve.
          vFade = aState < 0.5 ? 0.0
                : aState < 1.5 ? aProgress
                : aState < 2.5 ? 1.0
                : 1.0 - aProgress;
          vec3 seat = arenaSeat(position, aGlyph);
          gl_Position = arenaSeatClip(
            seat, max(aBillboard, aGlyph > 0.5 ? 1.0 : 0.0),
            instanceMatrix, modelViewMatrix, projectionMatrix);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uOpposed; uniform vec3 uSame; uniform vec3 uMixed; uniform vec3 uCenter;
        uniform vec3 uAggregate;
        uniform float uLift;
        uniform vec3 uGold;
        uniform float uTime;
        varying vec2 vUv; varying float vBank; varying float vEmphasis;
        varying float vStrength; varying float vFade; varying float vBillboard;
        varying float vGlyph; varying float vSeed;

        ${GLYPH_GLSL}
        ${FIGURE_GLSL}

        void main() {
          if (vFade <= 0.003) discard;
          vec3 accent = vBank < 0.5 ? uCenter
                      : vBank < 1.5 ? uOpposed
                      : vBank < 2.5 ? uSame
                      : vBank < 3.5 ? uMixed : uAggregate;

          // A person gets a body. The plaque is kept only for the cards that
          // are NOT people — era aggregates and a promotion anchor — because a
          // figure standing for "+971 more" would be a person the corpus never
          // named, and a promotion is not someone who can sit down.
          if (vGlyph > 0.5) {
            vec2 f = vec2((vUv.x - 0.5) * ${FIGURE_ASPECT.toFixed(4)}, vUv.y);
            // ROUND the mask before reading bits out of it.
            //
            // vGlyph and vSeed are per-instance constants, but they arrive as
            // INTERPOLATED varyings, so a fragment can see 1.9999996 where the
            // instance holds 2. Every bit test is a floor(), and the pair bit
            // is the one whose test lands exactly on an integer: floor(2/2) is
            // 1 and floor(1.9999996/2) is 0. Masks 2, 6, 10 and 14 — every one
            // that carries a tag partner — flip, while no solo mask can, which
            // is why a PAIR would flicker between one body and two as the
            // camera moved and a lone figure never did. Measured through the
            // pick buffer: nudging the camera 14 times, one pair's second body
            // answered 5 times and another 0.
            float m = floor(vGlyph + 0.5);
            float seed = floor(vSeed + 0.5);
            float pair = mod(floor(m / 2.0), 2.0);
            float belt = mod(floor(m / 4.0), 2.0);
            float tagBelt = mod(floor(m / 8.0), 2.0);

            // A documented tag partner is two bodies, both a little smaller so
            // the pair still occupies one seat, each on its own seed so they
            // are never in step with one another.
            float s = pair > 0.5 ? ${PAIR_SCALE.toFixed(3)} : 1.0;
            float dx = pair > 0.5 ? ${PAIR_DX.toFixed(3)} : 0.0;
            vec2 b0 = arenaBody(f + vec2(dx, 0.0), seed, uTime);
            float dFig = sdWrestler(b0 / s) * s;
            if (pair > 0.5) {
              vec2 b1 = arenaBody(f - vec2(dx, 0.0), seed + 37.0, uTime);
              dFig = min(dFig, sdWrestler(b1 / s) * s);
            }

            // Worn, both of them, and by the LEFT body in a pair: these are
            // this card's person's reigns, and hanging them between two figures
            // would attribute them to a partnership the corpus records against
            // one name. Read in that body's frame so they lean with the waist
            // they are strapped to.
            float dBelt = 1e9;
            float k = ${BELT_SCALE.toFixed(3)} * s;
            if (belt > 0.5) {
              dBelt = min(dBelt, sdBelt((b0 - vec2(0.0, ${BELT_Y_SINGLES.toFixed(3)} * s)) / k, 0.0) * k);
            }
            if (tagBelt > 0.5) {
              dBelt = min(dBelt, sdBelt((b0 - vec2(0.0, ${BELT_Y_TAG.toFixed(3)} * s)) / k, 1.0) * k);
            }

            float aa = max(fwidth(f.x), 0.0006) * 1.15;
            float mFig = smoothstep(aa, -aa, dFig);
            float mBelt = smoothstep(aa, -aa, dBelt);
            float a = max(mFig, mBelt);
            if (a <= 0.004) discard;

            // Lit from above, and darkened along its own edge. The edge is the
            // load-bearing part: cards do not write depth, so without it two
            // people standing in front of each other blend into one shape.
            vec3 body = accent * (0.50 + 0.60 * smoothstep(0.0, 0.95, f.y));
            body *= 0.58 + 0.42 * smoothstep(0.0, 0.020, -dFig);
            body += accent * vEmphasis * 0.45;
            body += (accent * 0.22 + vec3(0.05, 0.06, 0.08)) * uLift;
            vec3 lit = mix(body, uGold, mBelt);
            // Echo is a SOURCE, not a reading: its crowd stays quiet so the
            // arena that peels out of it is what the eye follows.
            float quiet = vBillboard > 0.5 ? 0.55 : 1.0;
            gl_FragColor = vec4(lit * quiet, vFade * a * (0.86 + vEmphasis * 0.14) * quiet);
            return;
          }

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
        // Belts are the only gold in the crowd, so a champion reads as a
        // champion across the whole arena without a legend lookup.
        uGold: { value: [1.0, 0.80, 0.38] },
        uTime: { value: 0 },
      },
    });

    /** Mirrors the visible vertex path exactly, so the picked pixel is the
     *  pixel the card draws — INCLUDING the seat reshape and the sway, which
     *  move a figure by most of its own width. A pick pass that skipped them
     *  would return the id of whoever used to be under the cursor.
     *
     *  It mirrors the figure SILHOUETTE too, dilated by a forgiving margin.
     *  A person's quad is 1.65x taller than the seat it stands in, so the
     *  transparent air above their head covers the row behind: on the full
     *  footprint, a probe at a body's own label anchor returned the id of a
     *  taller neighbour standing in front of it. Bodies are clickable, gaps
     *  fall through to whoever is actually behind them.
     *
     *  Id comes from an attribute because one draw call has to distinguish
     *  every instance. */
    this.pickMaterial = new ShaderMaterial({
      side: DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aId; attribute float aState; attribute float aGlyph;
        attribute float aBillboard;
        uniform float uTime;
        ${SEAT_VERTEX_GLSL}
        varying float vId; varying float vState; varying float vGlyph; varying vec2 vUv;
        varying float vSeed;
        void main() {
          vId = aId; vState = aState; vGlyph = aGlyph; vUv = uv; vSeed = aId;
          vec3 seat = arenaSeat(position, aGlyph);
          gl_Position = arenaSeatClip(
            seat, max(aBillboard, aGlyph > 0.5 ? 1.0 : 0.0),
            instanceMatrix, modelViewMatrix, projectionMatrix);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        varying float vId; varying float vState; varying float vGlyph; varying vec2 vUv;
        varying float vSeed;
        ${GLYPH_GLSL}
        ${FIGURE_GLSL}
        void main() {
          if (vState < 0.5) discard;
          if (vGlyph > 0.5) {
            vec2 f = vec2((vUv.x - 0.5) * ${FIGURE_ASPECT.toFixed(4)}, vUv.y);
            // ROUND the mask before reading bits out of it.
            //
            // vGlyph and vSeed are per-instance constants, but they arrive as
            // INTERPOLATED varyings, so a fragment can see 1.9999996 where the
            // instance holds 2. Every bit test is a floor(), and the pair bit
            // is the one whose test lands exactly on an integer: floor(2/2) is
            // 1 and floor(1.9999996/2) is 0. Masks 2, 6, 10 and 14 — every one
            // that carries a tag partner — flip, while no solo mask can, which
            // is why a PAIR would flicker between one body and two as the
            // camera moved and a lone figure never did. Measured through the
            // pick buffer: nudging the camera 14 times, one pair's second body
            // answered 5 times and another 0.
            float m = floor(vGlyph + 0.5);
            float seed = floor(vSeed + 0.5);
            float pair = mod(floor(m / 2.0), 2.0);
            float s = pair > 0.5 ? ${PAIR_SCALE.toFixed(3)} : 1.0;
            float dx = pair > 0.5 ? ${PAIR_DX.toFixed(3)} : 0.0;
            float d = sdWrestler(arenaBody(f + vec2(dx, 0.0), seed, uTime) / s) * s;
            if (pair > 0.5) {
              d = min(d, sdWrestler(arenaBody(f - vec2(dx, 0.0), seed + 37.0, uTime) / s) * s);
            }
            // Forgiveness: a 20 px-tall body in the back row is not a target a
            // reader can hit on its exact outline.
            if (d > 0.035) discard;
          }
          gl_FragColor = vec4(
            mod(vId, 256.0) / 255.0,
            mod(floor(vId / 256.0), 256.0) / 255.0,
            mod(floor(vId / 65536.0), 256.0) / 255.0, 1.0);
        }`,
      uniforms: { uTime: { value: 0 } },
    });

    this.mesh = new InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.matrices = this.mesh.instanceMatrix.array as Float32Array;
  }

  /**
   * How far above a seat's centre this slot's nameplate belongs.
   *
   * A figure is anchored at the bottom of its seat and reaches FIGURE_Y seat
   * heights up, so the top of the head sits (FIGURE_Y - 0.5) * height above the
   * centre the layout placed. A plaque slot lifts by nothing — it IS its seat.
   */
  nameplateLift(slot: number, worldHeight: number): number {
    if ((this.aGlyph.array as Float32Array)[slot]! < 0.5) return 0;
    return worldHeight * (FIGURE_Y - 0.5) * 0.94;
  }

  /** The crowd's clock, in seconds. Both materials read it: the visible one to
   *  sway a body, the pick one to sway its hit area with it. */
  setTime(seconds: number): void {
    this.material.uniforms.uTime!.value = seconds;
    this.pickMaterial.uniforms.uTime!.value = seconds;
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
