import * as THREE from "three";
import { easeQuintic, elementProgress } from "./types";

/**
 * Every entity in the corpus as ONE THREE.Points draw call, morphing on the
 * GPU. Each slot carries a from-state and a to-state (position, scale, alpha);
 * a single uMorph uniform advances every node along its own staggered window.
 * Nothing per-node happens on the CPU during a transition — the only bounded
 * CPU write is captureCurrent() when a new layout retargets mid-flight, which
 * folds the interpolated state into the from-buffers so travel continues from
 * exactly where the eye last saw it.
 *
 * Slots [0, corpusCount) are corpus nodes (identity = node index, forever).
 * Slots [corpusCount, corpusCount+virtualCap) are chips for entities with no
 * graph node (most promotions and titles); they fade in place.
 */

const GLSL_PROGRESS = /* glsl */ `
  const float WINDOW = 0.62;
  float elementP(float raw, float delay) {
    return clamp((raw - delay * (1.0 - WINDOW)) / WINDOW, 0.0, 1.0);
  }
  float easeQ(float t) {
    return t < 0.5 ? 16.0 * t * t * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 5.0) / 2.0;
  }
`;

export class MorphNodes {
  readonly points: THREE.Points;
  readonly total: number;

  // raw per-slot buffers — the transition writes these directly, then commit()
  from: Float32Array;
  to: Float32Array;
  scaleFrom: Float32Array;
  scaleTo: Float32Array;
  alphaFrom: Float32Array;
  alphaTo: Float32Array;
  delay: Float32Array;
  color: Float32Array;
  shape: Float32Array; // 0 person disc, 1 promotion ring, 2 title diamond
  emph: Float32Array;
  semantic: Float32Array;
  glow: Float32Array;

  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(corpusCount: number, virtualCap: number) {
    this.total = corpusCount + virtualCap;
    const n = this.total;
    this.from = new Float32Array(n * 3);
    this.to = new Float32Array(n * 3);
    this.scaleFrom = new Float32Array(n);
    this.scaleTo = new Float32Array(n);
    this.alphaFrom = new Float32Array(n);
    this.alphaTo = new Float32Array(n);
    this.delay = new Float32Array(n);
    this.color = new Float32Array(n * 3);
    this.shape = new Float32Array(n);
    this.emph = new Float32Array(n).fill(1);
    this.semantic = new Float32Array(n);
    this.glow = new Float32Array(n);

    this.geo = new THREE.BufferGeometry();
    const dyn = (arr: Float32Array, itemSize: number) => {
      const a = new THREE.BufferAttribute(arr, itemSize);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    // three.js requires an attribute literally named "position"; aFrom serves.
    this.geo.setAttribute("position", dyn(this.from, 3));
    this.geo.setAttribute("aTo", dyn(this.to, 3));
    this.geo.setAttribute("aScaleFrom", dyn(this.scaleFrom, 1));
    this.geo.setAttribute("aScaleTo", dyn(this.scaleTo, 1));
    this.geo.setAttribute("aAlphaFrom", dyn(this.alphaFrom, 1));
    this.geo.setAttribute("aAlphaTo", dyn(this.alphaTo, 1));
    this.geo.setAttribute("aDelay", dyn(this.delay, 1));
    this.geo.setAttribute("aColor", dyn(this.color, 3));
    this.geo.setAttribute("aShape", dyn(this.shape, 1));
    this.geo.setAttribute("aEmph", dyn(this.emph, 1));
    this.geo.setAttribute("aSemantic", dyn(this.semantic, 1));
    this.geo.setAttribute("aGlow", dyn(this.glow, 1));

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uMorph: { value: 1 },
        uViewportHeight: { value: 1 },
        uPixelRatio: { value: 1 },
        uMaxPx: { value: 30 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aTo;
        attribute float aScaleFrom, aScaleTo, aAlphaFrom, aAlphaTo, aDelay;
        attribute vec3 aColor;
        attribute float aShape, aEmph, aSemantic, aGlow;
        uniform float uMorph, uViewportHeight, uPixelRatio, uMaxPx;
        varying vec3 vColor;
        varying float vAlpha, vShape, vGlow, vSemantic;
        ${GLSL_PROGRESS}
        void main() {
          float p = elementP(uMorph, aDelay);
          float e = easeQ(p);
          vec3 pos = mix(position, aTo, e);
          float scale = mix(aScaleFrom, aScaleTo, e);
          // opacity is linear in the raw window — geometry eases, light fades
          float alpha = mix(aAlphaFrom, aAlphaTo, p);
          float em = aEmph;
          vColor = aColor;
          vShape = aShape;
          vGlow = aGlow;
          vSemantic = aSemantic;
          vAlpha = alpha * min(em, 1.25);
          float semanticBoost =
            aSemantic >= 6.0 ? 0.42 :
            aSemantic >= 5.0 ? 0.34 :
            aSemantic >= 4.0 ? 0.24 :
            aSemantic >= 3.0 ? 0.18 :
            aSemantic >= 2.0 ? 0.08 :
            aSemantic >= 1.0 ? 0.05 : 0.0;
          float boost = 1.0 + max(0.0, em - 1.0) * 0.40 + semanticBoost + aGlow * 0.8;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          // projectionMatrix[1][1] is cot(fov/2): this is true perspective
          // screen-size attenuation, not an orthographic world-to-pixel ratio.
          float px = scale * projectionMatrix[1][1] * uViewportHeight * 0.5 /
            max(0.25, -mv.z) * boost * uPixelRatio;
          gl_PointSize = clamp(px, 1.15 * uPixelRatio, uMaxPx * uPixelRatio);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vColor;
        varying float vAlpha, vShape, vGlow, vSemantic;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q);
          float cov;
          if (vShape > 1.5) {
            // title — diamond
            float m = (abs(q.x) + abs(q.y)) * 1.42;
            cov = 1.0 - smoothstep(0.42, 0.5, m);
          } else if (vShape > 0.5) {
            // promotion — ring, never reads as a person
            cov = (1.0 - smoothstep(0.42, 0.5, d)) * smoothstep(0.20, 0.30, d);
            cov += (1.0 - smoothstep(0.16, 0.22, d)) * 0.25;
          } else {
            cov = 1.0 - smoothstep(0.12, 0.5, d);
          }
          // A contained, screen-crisp membrane distinguishes semantic members
          // without turning the whole scene into bloom. Hover and selection
          // whiten the same ring rather than introducing another decoration.
          float semanticOn = step(2.5, vSemantic);
          float hot = smoothstep(4.0, 6.0, vSemantic);
          float ring = semanticOn *
            (1.0 - smoothstep(0.46, 0.5, d)) *
            smoothstep(0.36, 0.405, d);
          float bodyAlpha = cov * vAlpha;
          float ringAlpha = ring * mix(0.48, 0.92, hot) * min(1.0, vAlpha + 0.25);
          float alpha = max(bodyAlpha, ringAlpha);
          if (alpha < 0.003) discard;
          float core = smoothstep(0.30, 0.0, d) * (0.35 + vGlow * 0.9);
          vec3 col = vColor + vec3(1.0) * core * 0.6;
          col = mix(col, vec3(1.0), step(5.5, vSemantic) * 0.82);
          vec3 ringColor = mix(min(vec3(1.0), vColor * 1.18 + vec3(0.1)), vec3(1.0), hot);
          col = mix(col, ringColor, ring * 0.86);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.geo.setDrawRange(0, this.total);
  }

  setMorph(raw: number): void {
    this.mat.uniforms.uMorph!.value = raw;
  }
  setScale(viewportHeight: number, pixelRatio: number): void {
    this.mat.uniforms.uViewportHeight!.value = viewportHeight;
    this.mat.uniforms.uPixelRatio!.value = pixelRatio;
  }

  /**
   * Fold the currently displayed interpolated state into the from-buffers so
   * the next transition starts from what is on screen. One bounded pass; the
   * math mirrors the vertex shader exactly.
   */
  captureCurrent(raw: number): void {
    const n = this.total;
    for (let i = 0; i < n; i++) {
      const p = elementProgress(raw, this.delay[i]!);
      const e = easeQuintic(p);
      const i3 = i * 3;
      this.from[i3] = this.from[i3]! + (this.to[i3]! - this.from[i3]!) * e;
      this.from[i3 + 1] = this.from[i3 + 1]! + (this.to[i3 + 1]! - this.from[i3 + 1]!) * e;
      this.from[i3 + 2] = this.from[i3 + 2]! + (this.to[i3 + 2]! - this.from[i3 + 2]!) * e;
      this.scaleFrom[i] = this.scaleFrom[i]! + (this.scaleTo[i]! - this.scaleFrom[i]!) * e;
      this.alphaFrom[i] = this.alphaFrom[i]! + (this.alphaTo[i]! - this.alphaFrom[i]!) * p;
    }
  }

  /** current interpolated position of one slot (QA seam + selected-card) */
  currentPosition(i: number, raw: number): [number, number, number] {
    const p = elementProgress(raw, this.delay[i]!);
    const e = easeQuintic(p);
    const i3 = i * 3;
    return [
      this.from[i3]! + (this.to[i3]! - this.from[i3]!) * e,
      this.from[i3 + 1]! + (this.to[i3 + 1]! - this.from[i3 + 1]!) * e,
      this.from[i3 + 2]! + (this.to[i3 + 2]! - this.from[i3 + 2]!) * e,
    ];
  }

  commitMotion(): void {
    for (const name of ["position", "aTo", "aScaleFrom", "aScaleTo", "aAlphaFrom", "aAlphaTo", "aDelay"]) {
      (this.geo.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }
  commitStatic(): void {
    (this.geo.getAttribute("aColor") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aShape") as THREE.BufferAttribute).needsUpdate = true;
  }
  commitEmphasis(): void {
    (this.geo.getAttribute("aEmph") as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute("aSemantic") as THREE.BufferAttribute).needsUpdate = true;
  }
  commitGlow(): void {
    (this.geo.getAttribute("aGlow") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
