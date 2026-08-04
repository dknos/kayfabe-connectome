/**
 * The worldline field: every drawn career line in ONE batched ribbon draw.
 *
 * Fat routes cost one draw call each (measured in the arena spikes), so 150
 * worldlines cannot be 150 Line2 objects. Instead every line is extruded in
 * the vertex shader — two vertices per sample, screen-space width, DoubleSide
 * (the morph ribbons proved winding flips with travel direction and FrontSide
 * silently erases half the field).
 *
 * Positions are NOT baked: each vertex carries its (day, y, z) source
 * coordinates and the vertex shader applies the SAME closed-form time lens as
 * types.timeAxisX — the GLSL below must stay numerically identical to the TS
 * twin or event beads (CPU-positioned) shear off their worldlines. Moving the
 * playhead is therefore a uniform update, never a rebuild.
 *
 * In Bridge mode the same shader warps each vertex through the LUT texture
 * (rgba8, sampled in the vertex stage — WebGL2 guarantees vertex texture
 * units). uWarpMix blends it in; hold-U drives it back out.
 */
import {
  BufferAttribute, BufferGeometry, DataTexture, DoubleSide, DynamicDrawUsage,
  Mesh, RedFormat, ShaderMaterial, Sphere, UnsignedByteType, Vector2, Vector3,
} from "three";
import type { WorldlinePath } from "./SpacetimeLayout";
import { SAMPLE_STRIDE } from "./SpacetimeLayout";
import type { WarpLookup } from "./WarpLookup";

/** GLSL twins of lnCosh / focusIntegral / timeAxisX / warp. Kept in one
 *  exported chunk so EventField's caustics and the bubble share it verbatim. */
export const LENS_GLSL = /* glsl */ `
  uniform float uDay0; uniform float uPlayhead;
  uniform float uR; uniform float uSigma; uniform float uGain; uniform float uScale;
  uniform sampler2D uWarpLut; uniform float uWarpRow; uniform float uWarpMix;
  uniform vec3 uObserver; uniform float uNearRadius;

  const float DAYS_PER_YEAR = 365.25;
  const float LOG_DELTA_MAX = 6.0;
  const float LOG_MAG_MAX = 3.0;

  float lnCosh(float u) {
    float a = abs(u);
    return a + log(1.0 + exp(-2.0 * a)) - 0.6931471805599453;
  }
  /** the paper's shape function over years-from-playhead (types.focusF twin) */
  float focusF(float d) {
    return (tanh(uSigma * (d + uR)) - tanh(uSigma * (d - uR)))
         / (2.0 * tanh(uSigma * uR));
  }
  float focusIntegral(float s) {
    return (lnCosh(uSigma * (s + uR)) - lnCosh(uSigma * (s - uR)))
         / (2.0 * uSigma * tanh(uSigma * uR));
  }
  float timeAxisX(float day) {
    float y = (day - uDay0) / DAYS_PER_YEAR;
    float p = (uPlayhead - uDay0) / DAYS_PER_YEAR;
    return uScale * (y + uGain * (focusIntegral(y - p) - focusIntegral(-p)));
  }
  /** LUT warp of a world position for the bridge observer. Returns the moved
   *  position; delta/mag/vis ride out through the out params. */
  vec3 warpLut(vec3 pos, out float delta, out float mag, out float vis) {
    delta = 1.0; mag = 1.0; vis = 1.0;
    if (uWarpMix <= 0.001) return pos;
    vec3 d = pos - uObserver;
    float dist = length(d);
    if (dist < 1e-6) return pos;
    float thetaSrc = acos(clamp(d.x / dist, -1.0, 1.0));
    vec4 t = texture2D(uWarpLut, vec2(thetaSrc / 3.14159265, uWarpRow));
    float near = smoothstep(0.0, uNearRadius, dist);
    float m = uWarpMix * near;
    float theta = mix(thetaSrc, t.r * 3.14159265, m);
    float perp = length(d.yz);
    vec2 u = perp < 1e-6 ? vec2(0.0) : d.yz / perp;
    delta = mix(1.0, exp(t.g * 2.0 * LOG_DELTA_MAX - LOG_DELTA_MAX), m);
    mag = mix(1.0, pow(10.0, t.b * 2.0 * LOG_MAG_MAX - LOG_MAG_MAX), m);
    vis = mix(1.0, t.a, m);
    return uObserver + vec3(dist * cos(theta), dist * sin(theta) * u);
  }
`;

export const LENS_UNIFORMS = (): Record<string, { value: unknown }> => ({
  uDay0: { value: 0 },
  uPlayhead: { value: 0 },
  uR: { value: 1.5 },
  uSigma: { value: 1.1 },
  uGain: { value: 9 },
  uScale: { value: 1.6 },
  uWarpLut: { value: null },
  uWarpRow: { value: 0 },
  uWarpMix: { value: 0 },
  uObserver: { value: new Vector3() },
  uNearRadius: { value: 6 },
});

const MAX_LINES = 256;

export class WorldlineField {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly geometry = new BufferGeometry();
  /** per-line emphasis, sampled by aLine in the vertex shader */
  private readonly emphasisTex: DataTexture;
  private readonly emphasisData: Uint8Array;
  private lineCount = 0;

  constructor(lut: WarpLookup) {
    this.emphasisData = new Uint8Array(MAX_LINES).fill(64);
    this.emphasisTex = new DataTexture(
      this.emphasisData, MAX_LINES, 1, RedFormat, UnsignedByteType);
    this.emphasisTex.needsUpdate = true;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        ...LENS_UNIFORMS(),
        uWarpLut: { value: lut.texture },
        uEmphasis: { value: this.emphasisTex },
        uResolution: { value: new Vector2(1, 1) },
        uWidthPx: { value: 1.6 },
        uCenter: { value: [1.0, 0.83, 0.47] },
        uOpposed: { value: [1.0, 0.48, 0.30] },
        uSame: { value: [0.29, 0.84, 1.0] },
        uMixed: { value: [0.65, 0.55, 0.98] },
        uBr: { value: [0.45, 0.50, 0.60] },
      },
      vertexShader: /* glsl */ `
        attribute float aDay; attribute vec2 aLane; attribute vec2 aRest;
        attribute float aDayN; attribute vec2 aLaneN; attribute vec2 aRestN;
        attribute float aSide; attribute float aFade; attribute float aDash;
        attribute float aPersona; attribute float aClass; attribute float aLine;
        uniform sampler2D uEmphasis;
        uniform vec2 uResolution; uniform float uWidthPx;
        varying float vClass; varying float vFade; varying float vDash;
        varying float vPersona; varying float vSide; varying float vEmph;
        varying float vDelta; varying float vVis; varying float vDay;
        ${LENS_GLSL}
        void main() {
          // Convergence articulates with the focus field: inside the bubble a
          // shared match pulls the line to the centre; in compressed history
          // the line rests in its lane and the beads carry the record.
          float conv = focusF((aDay - uPlayhead) / DAYS_PER_YEAR);
          float convN = focusF((aDayN - uPlayhead) / DAYS_PER_YEAR);
          vec2 lane = mix(aRest, aLane, conv);
          vec2 laneN2 = mix(aRestN, aLaneN, convN);
          float delta; float mag; float vis;
          vec3 pos = warpLut(vec3(timeAxisX(aDay), lane), delta, mag, vis);
          float dN; float mN; float vN;
          vec3 posN = warpLut(vec3(timeAxisX(aDayN), laneN2), dN, mN, vN);
          vClass = aClass; vFade = aFade; vDash = aDash; vPersona = aPersona;
          vSide = aSide; vDelta = delta; vVis = vis; vDay = aDay;
          vEmph = texture2D(uEmphasis, vec2((aLine + 0.5) / ${MAX_LINES}.0, 0.5)).r * 4.0;

          vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          vec4 clipN = projectionMatrix * modelViewMatrix * vec4(posN, 1.0);
          vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
          vec2 dir = clipN.xy / max(1e-6, clipN.w) - clip.xy / max(1e-6, clip.w);
          dir *= aspect;
          float len = length(dir);
          dir = len < 1e-6 ? vec2(1.0, 0.0) : dir / len;
          vec2 normal = vec2(-dir.y, dir.x) / aspect;
          float centerBoost = aLine < 0.5 ? 1.9 : 1.0;
          float width = uWidthPx * centerBoost * (0.75 + vEmph * 0.6) * sqrt(max(mag, 0.05));
          clip.xy += normal * aSide * width * 2.0 * clip.w / uResolution.y;
          gl_Position = clip;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uCenter; uniform vec3 uOpposed; uniform vec3 uSame;
        uniform vec3 uMixed; uniform vec3 uBr;
        varying float vClass; varying float vFade; varying float vDash;
        varying float vPersona; varying float vSide; varying float vEmph;
        varying float vDelta; varying float vVis; varying float vDay;
        void main() {
          vec3 col = vClass < 0.5 ? uCenter
                   : vClass < 1.5 ? uOpposed
                   : vClass < 2.5 ? uSame
                   : vClass < 3.5 ? uMixed : uBr;
          // Persona segments on the subject's own line: a cooler cast marks a
          // documented ring-name era; the label layer names it.
          if (vClass < 0.5 && vPersona > 0.5) col = mix(col, vec3(0.62, 0.80, 1.0), 0.45);
          // The unrecorded interval reads as sparse breath, never as activity.
          float dashGate = vDash > 0.5 ? step(0.62, fract(vDay / 90.0)) * 0.5 : 1.0;
          // Soft edge for the extruded ribbon.
          float edge = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
          // Frequency shift brushes the halo temperature only; the semantic
          // core hue is corpus meaning and is not overwritten.
          vec3 shift = vDelta > 1.0 ? vec3(0.75, 0.85, 1.0) : vec3(1.0, 0.82, 0.72);
          col = mix(col, col * shift, clamp(abs(log(max(vDelta, 1e-3))) * 0.4, 0.0, 0.55));
          float alpha = vFade * dashGate * edge * vVis
                      * (vClass < 0.5 ? 0.85 : vClass > 3.5 ? 0.22 : 0.35)
                      * (0.55 + vEmph * 0.5);
          if (alpha <= 0.004) discard;
          gl_FragColor = vec4(col, alpha);
        }`,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  /** Rebuild the vertex buffers from layout paths. Static until the scope or
   *  tier changes; the playhead never comes here. */
  build(lines: WorldlinePath[]): void {
    this.lineCount = Math.min(lines.length, MAX_LINES);
    let samples = 0;
    for (let i = 0; i < this.lineCount; i++) {
      samples += lines[i]!.samples.length / SAMPLE_STRIDE;
    }
    const vcount = samples * 2;
    const day = new Float32Array(vcount);
    const lane = new Float32Array(vcount * 2);
    const rest = new Float32Array(vcount * 2);
    const dayN = new Float32Array(vcount);
    const laneN = new Float32Array(vcount * 2);
    const restN = new Float32Array(vcount * 2);
    const side = new Float32Array(vcount);
    const fade = new Float32Array(vcount);
    const dash = new Float32Array(vcount);
    const persona = new Float32Array(vcount);
    const cls = new Float32Array(vcount);
    const lineIdx = new Float32Array(vcount);
    const index: number[] = [];

    let v = 0;
    for (let li = 0; li < this.lineCount; li++) {
      const path = lines[li]!;
      const s = path.samples;
      const n = s.length / SAMPLE_STRIDE;
      const lineStart = v;
      for (let k = 0; k < n; k++) {
        const o = k * SAMPLE_STRIDE;
        const last = k === n - 1;
        const oN = (last ? k : k + 1) * SAMPLE_STRIDE;
        // The final sample has no next point; extrapolate the incoming
        // direction so the ribbon cap keeps its width instead of collapsing.
        const oP = (last && n > 1) ? (k - 1) * SAMPLE_STRIDE : o;
        for (const sd of [-1, 1]) {
          day[v] = s[o]!;
          lane[v * 2] = s[o + 1]!;
          lane[v * 2 + 1] = s[o + 2]!;
          rest[v * 2] = s[o + 6]!;
          rest[v * 2 + 1] = s[o + 7]!;
          if (last) {
            dayN[v] = s[o]! + Math.max(1, s[o]! - s[oP]!);
            laneN[v * 2] = 2 * s[o + 1]! - s[oP + 1]!;
            laneN[v * 2 + 1] = 2 * s[o + 2]! - s[oP + 2]!;
            restN[v * 2] = s[o + 6]!;
            restN[v * 2 + 1] = s[o + 7]!;
          } else {
            dayN[v] = s[oN]!;
            laneN[v * 2] = s[oN + 1]!;
            laneN[v * 2 + 1] = s[oN + 2]!;
            restN[v * 2] = s[oN + 6]!;
            restN[v * 2 + 1] = s[oN + 7]!;
          }
          side[v] = sd;
          fade[v] = s[o + 3]!;
          dash[v] = s[o + 4]!;
          persona[v] = s[o + 5]!;
          cls[v] = path.cls;
          lineIdx[v] = li;
          v++;
        }
        if (k > 0) {
          const a = lineStart + (k - 1) * 2;
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }

    const set = (name: string, arr: Float32Array, size: number): void => {
      const attr = new BufferAttribute(arr, size);
      attr.setUsage(DynamicDrawUsage);
      this.geometry.setAttribute(name, attr);
    };
    // three needs a `position` attribute to exist even though the shader
    // derives the real one; a zero buffer satisfies the bounding machinery.
    set("position", new Float32Array(vcount * 3), 3);
    set("aDay", day, 1);
    set("aLane", lane, 2);
    set("aRest", rest, 2);
    set("aDayN", dayN, 1);
    set("aLaneN", laneN, 2);
    set("aRestN", restN, 2);
    set("aSide", side, 1);
    set("aFade", fade, 1);
    set("aDash", dash, 1);
    set("aPersona", persona, 1);
    set("aClass", cls, 1);
    set("aLine", lineIdx, 1);
    this.geometry.setIndex(index);
    // Positions are derived in the vertex shader, so the zero `position`
    // buffer must never be measured: the renderer's depth sort reads
    // boundingSphere.center unconditionally (a null sphere crashes the whole
    // frame), so the sphere is pinned generously and kept pinned.
    const pinned = new Sphere(new Vector3(0, 0, 0), 1e6);
    this.geometry.boundingSphere = pinned;
    this.geometry.computeBoundingSphere = () => {
      this.geometry.boundingSphere = pinned;
    };
  }

  /** Per-line emphasis: 0..1, line 0 is the subject. */
  setEmphasis(lineIndex: number, value: number): void {
    if (lineIndex < 0 || lineIndex >= MAX_LINES) return;
    this.emphasisData[lineIndex] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    this.emphasisTex.needsUpdate = true;
  }

  clearEmphasis(): void {
    this.emphasisData.fill(64);
    this.emphasisData[0] = 200; // the subject's line is always unmistakable
    this.emphasisTex.needsUpdate = true;
  }

  get uniforms(): Record<string, { value: unknown }> {
    return this.material.uniforms as Record<string, { value: unknown }>;
  }

  setResolution(w: number, h: number): void {
    (this.material.uniforms.uResolution!.value as Vector2).set(w, h);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.emphasisTex.dispose();
  }
}
