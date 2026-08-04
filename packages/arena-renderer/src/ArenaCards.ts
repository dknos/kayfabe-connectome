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
import { CS } from "./types";

const VERTEX_HEAD = /* glsl */ `
  attribute float aBank;
  attribute float aEmphasis;
  attribute float aStrength;
  attribute float aProgress;
  attribute float aState;
  attribute float aBillboard;
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
    for (let i = 0; i < capacity; i++) (this.aId.array as Float32Array)[i] = i + 1;
    for (const a of [this.aBank, this.aEmphasis, this.aStrength, this.aProgress, this.aState, this.aBillboard]) {
      a.setUsage(DynamicDrawUsage);
    }
    this.geometry.setAttribute("aBank", this.aBank);
    this.geometry.setAttribute("aEmphasis", this.aEmphasis);
    this.geometry.setAttribute("aStrength", this.aStrength);
    this.geometry.setAttribute("aProgress", this.aProgress);
    this.geometry.setAttribute("aState", this.aState);
    this.geometry.setAttribute("aId", this.aId);
    this.geometry.setAttribute("aBillboard", this.aBillboard);

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      vertexShader: /* glsl */ `
        ${VERTEX_HEAD}
        varying vec2 vUv; varying float vBank; varying float vEmphasis;
        varying float vStrength; varying float vFade; varying float vBillboard;
        void main() {
          vUv = uv; vBank = aBank; vEmphasis = aEmphasis; vStrength = aStrength;
          vBillboard = aBillboard;
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
        varying vec2 vUv; varying float vBank; varying float vEmphasis;
        varying float vStrength; varying float vFade; varying float vBillboard;

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

  commitSemantics(): void {
    this.aBillboard.needsUpdate = true;
    this.aBank.needsUpdate = true;
    this.aEmphasis.needsUpdate = true;
    this.aStrength.needsUpdate = true;
  }

  clearSemantics(): void {
    (this.aBillboard.array as Float32Array).fill(0);
    (this.aBank.array as Float32Array).fill(0);
    (this.aEmphasis.array as Float32Array).fill(0);
    (this.aStrength.array as Float32Array).fill(0);
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
