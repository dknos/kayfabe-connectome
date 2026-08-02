import * as THREE from "three";
import { hexRgb, RATING_PALETTE } from "./palette";
import type { RatingLayout } from "./types";

const VERT = /* glsl */ `
  attribute vec3 aFromPosition;
  attribute vec3 aToPosition;
  attribute vec2 aHeight;
  attribute vec2 aScale;
  attribute vec2 aOpacity;
  attribute float aRating;
  attribute float aEmphasis;
  uniform float uMorph;
  uniform float uLodAlpha;
  varying float vRating;
  varying float vOpacity;
  varying float vEmphasis;
  varying vec3 vNormal;
  void main() {
    vec3 p = mix(aFromPosition, aToPosition, uMorph);
    float h = mix(aHeight.x, aHeight.y, uMorph);
    float s = mix(aScale.x, aScale.y, uMorph);
    vec3 local = position;
    local.xz *= s;
    // Signed scaling puts the broad foot on rating zero for positive AND
    // negative observations; the precise tip lands at the exact rating.
    local.y *= h;
    local.y += h * 0.5;
    vec4 mv = modelViewMatrix * vec4(p + local, 1.0);
    gl_Position = projectionMatrix * mv;
    vNormal = normalize(normalMatrix * normal);
    vRating = aRating;
    vOpacity = max(mix(aOpacity.x, aOpacity.y, uMorph) * uLodAlpha, min(1.0, aEmphasis) * 0.92);
    vEmphasis = aEmphasis;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float uThreshold;
  uniform vec3 uWarm;
  uniform vec3 uHot;
  uniform vec3 uDatum;
  uniform vec3 uNegative;
  varying float vRating;
  varying float vOpacity;
  varying float vEmphasis;
  varying vec3 vNormal;
  void main() {
    if (vOpacity < 0.008) discard;
    float normalized = clamp((vRating + 1.0) / 8.0, 0.0, 1.0);
    vec3 base = vRating < 0.0
      ? uNegative
      : mix(uWarm, uHot, smoothstep(0.12, 0.86, normalized));
    float crossing = smoothstep(uThreshold - 0.035, uThreshold + 0.035, vRating);
    base = mix(base, uDatum, crossing * 0.36);
    base = mix(base, vec3(1.0), clamp(vEmphasis / 3.0, 0.0, 1.0) * 0.58);
    vec3 lightDir = normalize(vec3(-0.42, 0.82, 0.36));
    float lambert = 0.32 + 0.68 * abs(dot(normalize(vNormal), lightDir));
    float rim = pow(1.0 - abs(vNormal.z), 3.0) * 0.18;
    gl_FragColor = vec4(base * (lambert + rim + crossing * 0.16 + vEmphasis * 0.09), vOpacity);
  }
`;

const TIP_VERT = /* glsl */ `
  attribute vec3 aFromPosition;
  attribute vec3 aToPosition;
  attribute float aFromHeight;
  attribute float aToHeight;
  attribute float aFromOpacity;
  attribute float aToOpacity;
  attribute float aRating;
  attribute float aEmphasis;
  uniform float uMorph;
  uniform float uLodAlpha;
  uniform float uPixelRatio;
  varying float vRating;
  varying float vOpacity;
  varying float vEmphasis;
  void main() {
    vec3 p = mix(aFromPosition, aToPosition, uMorph);
    float h = mix(aFromHeight, aToHeight, uMorph);
    vec4 mv = modelViewMatrix * vec4(p + vec3(0.0, h, 0.0), 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (3.0 + min(3.0, aEmphasis * 1.3)) * uPixelRatio;
    vRating = aRating;
    vOpacity = max(mix(aFromOpacity, aToOpacity, uMorph) * uLodAlpha, min(1.0, aEmphasis) * 0.95);
    vEmphasis = aEmphasis;
  }
`;

const TIP_FRAG = /* glsl */ `
  precision highp float;
  uniform float uThreshold;
  uniform vec3 uWarm;
  uniform vec3 uDatum;
  uniform vec3 uNegative;
  varying float vRating;
  varying float vOpacity;
  varying float vEmphasis;
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    if (dot(q, q) > 0.24 || vOpacity < 0.008) discard;
    vec3 c = vRating < 0.0 ? uNegative : uWarm;
    if (vRating >= uThreshold) c = mix(c, uDatum, 0.74);
    c = mix(c, vec3(1.0), clamp(vEmphasis / 3.0, 0.0, 1.0));
    gl_FragColor = vec4(c, vOpacity);
  }
`;

function attr(data: Float32Array, size: number): THREE.InstancedBufferAttribute {
  return new THREE.InstancedBufferAttribute(data, size).setUsage(THREE.DynamicDrawUsage);
}

export class RatingPeaks {
  readonly mesh: THREE.InstancedMesh;
  readonly tips: THREE.Points;
  readonly count: number;
  readonly fromPosition: Float32Array;
  readonly toPosition: Float32Array;
  readonly fromHeight: Float32Array;
  readonly toHeight: Float32Array;
  readonly fromScale: Float32Array;
  readonly toScale: Float32Array;
  readonly fromOpacity: Float32Array;
  readonly toOpacity: Float32Array;
  readonly rating: Float32Array;
  readonly emphasis: Float32Array;
  private heightPair: Float32Array;
  private scalePair: Float32Array;
  private opacityPair: Float32Array;

  private material: THREE.ShaderMaterial;
  private tipMaterial: THREE.ShaderMaterial;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private selected = -1;
  private hovered = -1;
  private current = -1;

  constructor(count: number) {
    this.count = count;
    this.fromPosition = new Float32Array(count * 3);
    this.toPosition = new Float32Array(count * 3);
    this.fromHeight = new Float32Array(count);
    this.toHeight = new Float32Array(count);
    this.fromScale = new Float32Array(count);
    this.toScale = new Float32Array(count);
    this.fromOpacity = new Float32Array(count);
    this.toOpacity = new Float32Array(count);
    this.rating = new Float32Array(count);
    this.emphasis = new Float32Array(count);
    this.heightPair = new Float32Array(count * 2);
    this.scalePair = new Float32Array(count * 2);
    this.opacityPair = new Float32Array(count * 2);

    const geometry = new THREE.CylinderGeometry(0.035, 0.52, 1, 4, 1, false);
    // The custom shader never samples UVs. Dropping them keeps the instanced
    // contract at the WebGL-guaranteed 16 attribute slots (including the four
    // instance-matrix columns) instead of failing on conservative GPUs.
    geometry.deleteAttribute("uv");
    geometry.setAttribute("aFromPosition", attr(this.fromPosition, 3));
    geometry.setAttribute("aToPosition", attr(this.toPosition, 3));
    geometry.setAttribute("aHeight", attr(this.heightPair, 2));
    geometry.setAttribute("aScale", attr(this.scalePair, 2));
    geometry.setAttribute("aOpacity", attr(this.opacityPair, 2));
    geometry.setAttribute("aRating", attr(this.rating, 1));
    geometry.setAttribute("aEmphasis", attr(this.emphasis, 1));
    const warm = hexRgb(RATING_PALETTE.ratedWarm);
    const hot = hexRgb(RATING_PALETTE.ratedHot);
    const datum = hexRgb(RATING_PALETTE.datum);
    const negative = hexRgb(RATING_PALETTE.negative);
    const uniforms = {
      uMorph: { value: 1 },
      uLodAlpha: { value: 1 },
      uThreshold: { value: 5 },
      uWarm: { value: new THREE.Vector3(...warm) },
      uHot: { value: new THREE.Vector3(...hot) },
      uDatum: { value: new THREE.Vector3(...datum) },
      uNegative: { value: new THREE.Vector3(...negative) },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, count);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;

    const tipGeometry = new THREE.BufferGeometry();
    // A zero-valued position attribute supplies the vertex; all data is per instance.
    tipGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    // Points cannot consume InstancedBufferAttributes, so each exact row is one
    // ordinary vertex and the same typed arrays are exposed as BufferAttributes.
    tipGeometry.setAttribute("aFromPosition", new THREE.BufferAttribute(this.fromPosition, 3));
    tipGeometry.setAttribute("aToPosition", new THREE.BufferAttribute(this.toPosition, 3));
    tipGeometry.setAttribute("aFromHeight", new THREE.BufferAttribute(this.fromHeight, 1));
    tipGeometry.setAttribute("aToHeight", new THREE.BufferAttribute(this.toHeight, 1));
    tipGeometry.setAttribute("aFromOpacity", new THREE.BufferAttribute(this.fromOpacity, 1));
    tipGeometry.setAttribute("aToOpacity", new THREE.BufferAttribute(this.toOpacity, 1));
    tipGeometry.setAttribute("aRating", new THREE.BufferAttribute(this.rating, 1));
    tipGeometry.setAttribute("aEmphasis", new THREE.BufferAttribute(this.emphasis, 1));
    this.tipMaterial = new THREE.ShaderMaterial({
      vertexShader: TIP_VERT,
      fragmentShader: TIP_FRAG,
      uniforms: {
        uMorph: { value: 1 },
        uLodAlpha: { value: 1 },
        uThreshold: { value: 5 },
        uPixelRatio: { value: 1 },
        uWarm: { value: new THREE.Vector3(...warm) },
        uDatum: { value: new THREE.Vector3(...datum) },
        uNegative: { value: new THREE.Vector3(...negative) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.tips = new THREE.Points(tipGeometry, this.tipMaterial);
    this.tips.frustumCulled = false;
    this.tips.renderOrder = 3;
  }

  retarget(layout: RatingLayout, currentMorph: number, immediate = false): void {
    if (layout.positions.length !== this.count * 3 || layout.heights.length !== this.count) {
      throw new Error("RatingPeaks layout size does not match immutable projection count");
    }
    const t = immediate ? 1 : Math.max(0, Math.min(1, currentMorph));
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      for (let k = 0; k < 3; k++) {
        const p = i3 + k;
        this.fromPosition[p] = this.fromPosition[p]! + (this.toPosition[p]! - this.fromPosition[p]!) * t;
        this.toPosition[p] = layout.positions[p]!;
      }
      this.fromHeight[i] = this.fromHeight[i]! + (this.toHeight[i]! - this.fromHeight[i]!) * t;
      this.fromScale[i] = this.fromScale[i]! + (this.toScale[i]! - this.fromScale[i]!) * t;
      this.fromOpacity[i] = this.fromOpacity[i]! + (this.toOpacity[i]! - this.fromOpacity[i]!) * t;
      this.toHeight[i] = layout.heights[i]!;
      this.toScale[i] = layout.scales[i]!;
      this.toOpacity[i] = layout.opacity[i]!;
      this.heightPair[i * 2] = this.fromHeight[i]!;
      this.heightPair[i * 2 + 1] = this.toHeight[i]!;
      this.scalePair[i * 2] = this.fromScale[i]!;
      this.scalePair[i * 2 + 1] = this.toScale[i]!;
      this.opacityPair[i * 2] = this.fromOpacity[i]!;
      this.opacityPair[i * 2 + 1] = this.toOpacity[i]!;
      this.rating[i] = layout.rating[i]!;

      // The visible shader is GPU-interpolated. The destination matrix exists
      // solely for Three's official InstancedMesh raycaster after settling.
      this.position.set(layout.positions[i3]!, layout.positions[i3 + 1]! + layout.heights[i]! * 0.5, layout.positions[i3 + 2]!);
      this.scale.set(layout.scales[i]!, Math.max(0.001, Math.abs(layout.heights[i]!)), layout.scales[i]!);
      this.matrix.compose(this.position, layout.heights[i]! < 0
        ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
        : new THREE.Quaternion(), this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.commitMotion();
    if (immediate) this.setMorph(1);
  }

  setMorph(t: number): void {
    this.material.uniforms.uMorph!.value = t;
    this.tipMaterial.uniforms.uMorph!.value = t;
  }

  setLodAlpha(exact: number, tips: number): void {
    this.material.uniforms.uLodAlpha!.value = exact;
    this.tipMaterial.uniforms.uLodAlpha!.value = tips;
  }

  setThreshold(v: number): void {
    this.material.uniforms.uThreshold!.value = v;
    this.tipMaterial.uniforms.uThreshold!.value = v;
  }

  setPixelRatio(v: number): void {
    this.tipMaterial.uniforms.uPixelRatio!.value = v;
  }

  setQualityTier(tier: "low" | "medium" | "high"): void {
    // LOW retains every exact identity as a pickable point tip while the
    // materialized aggregate carries shape. Removing the prism pass is the
    // meaningful GPU reduction; opacity caps alone would still transform all
    // prism vertices.
    this.mesh.visible = tier !== "low";
    this.tips.visible = true;
  }

  setEmphasis(selected: number, hovered: number, current: number): void {
    const dirty = new Set([this.selected, this.hovered, this.current, selected, hovered, current]);
    this.selected = selected;
    this.hovered = hovered;
    this.current = current;
    for (const i of dirty) {
      if (i < 0 || i >= this.count) continue;
      this.emphasis[i] = i === selected ? 3 : i === hovered ? 2 : i === current ? 1 : 0;
    }
    const a = this.mesh.geometry.getAttribute("aEmphasis") as THREE.BufferAttribute;
    a.needsUpdate = true;
    const ta = this.tips.geometry.getAttribute("aEmphasis") as THREE.BufferAttribute;
    ta.needsUpdate = true;
  }

  currentTip(index: number, t: number): [number, number, number] | null {
    const out = new Float32Array(3);
    return this.currentTipInto(index, t, out) ? [out[0]!, out[1]!, out[2]!] : null;
  }

  /** Allocation-free form used by the bounded projected picking fallback. */
  currentTipInto(index: number, t: number, out: Float32Array): boolean {
    if (index < 0 || index >= this.count) return false;
    const q = Math.max(0, Math.min(1, t));
    const i3 = index * 3;
    const x = this.fromPosition[i3]! + (this.toPosition[i3]! - this.fromPosition[i3]!) * q;
    const baseY = this.fromPosition[i3 + 1]! + (this.toPosition[i3 + 1]! - this.fromPosition[i3 + 1]!) * q;
    const z = this.fromPosition[i3 + 2]! + (this.toPosition[i3 + 2]! - this.fromPosition[i3 + 2]!) * q;
    const h = this.fromHeight[index]! + (this.toHeight[index]! - this.fromHeight[index]!) * q;
    out[0] = x;
    out[1] = baseY + h;
    out[2] = z;
    return true;
  }

  opacityAt(index: number, t: number): number {
    if (index < 0 || index >= this.count) return 0;
    return this.fromOpacity[index]! + (this.toOpacity[index]! - this.fromOpacity[index]!) * t;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.tips.geometry.dispose();
    this.tipMaterial.dispose();
  }

  private commitMotion(): void {
    for (const name of ["aFromPosition", "aToPosition", "aHeight", "aScale", "aOpacity", "aRating"]) {
      (this.mesh.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
    for (const name of [
      "aFromPosition", "aToPosition", "aFromHeight", "aToHeight",
      "aFromOpacity", "aToOpacity", "aRating",
    ]) {
      (this.tips.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
