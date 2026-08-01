import * as THREE from "three";
import type { MorphRegion } from "./types";

/**
 * Board furniture — backplanes, rails, buses, gold modules, shelves, hatched
 * gaps — as one instanced draw call. Regions belong to a layout rather than
 * to an entity, so they do not travel: the outgoing set fades down while the
 * incoming set fades up, both under the shared morph clock. Two generations
 * live in the buffer at once (incoming first, outgoing appended after).
 */

export class MorphRegions {
  readonly mesh: THREE.Mesh;

  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cap = 0;

  private pos!: Float32Array;
  private size!: Float32Array;
  private color!: Float32Array;
  // x = alphaFrom, y = alphaTo, z = kind, w = param
  private params!: Float32Array;

  /** the regions currently fading in — becomes the outgoing set next swap */
  private current: MorphRegion[] = [];
  /** the previous generation, still fading down; kept one more swap so a
   *  rapid double-retarget fades instead of popping */
  private outgoing: { region: MorphRegion; aFrom: number }[] = [];

  constructor() {
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    this.geo.setAttribute("position", new THREE.BufferAttribute(quad, 3));
    this.geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex([0, 1, 2, 1, 3, 2]);
    this.grow(4096);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMorph: { value: 1 },
        uPxPerWorld: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 iPos;
        attribute vec2 iSize;
        attribute vec3 iColor;
        attribute vec4 iParams;
        uniform float uMorph;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vAlpha, vKind, vParam;
        varying vec2 vSizeW;
        void main() {
          vUv = uv;
          vColor = iColor;
          vKind = iParams.z;
          vParam = iParams.w;
          vSizeW = iSize;
          vAlpha = mix(iParams.x, iParams.y, uMorph);
          vec3 p = vec3(position.xy * iSize, 0.0) + iPos;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uPxPerWorld;
        varying vec2 vUv;
        varying vec3 vColor;
        varying float vAlpha, vKind, vParam;
        varying vec2 vSizeW;

        float capsule(vec2 uvp, vec2 sizeW) {
          vec2 px = (uvp - 0.5) * sizeW * uPxPerWorld;
          vec2 half_ = sizeW * uPxPerWorld * 0.5;
          float r = min(half_.y, half_.x) ;
          vec2 q = abs(px) - (half_ - vec2(r));
          float d = length(max(q, 0.0)) - r;
          return 1.0 - smoothstep(-1.0, 1.0, d);
        }

        void main() {
          float a = vAlpha;
          vec3 col = vColor;
          float k = vKind;
          if (a < 0.003) discard;
          if (k < 0.5) {
            // PLATE — flat with a faint vertical gradient
            col *= 0.9 + vUv.y * 0.2;
          } else if (k < 1.5) {
            // RAIL — rounded capsule
            a *= capsule(vUv, vSizeW);
          } else if (k < 2.5) {
            // GOLD — capsule with a sheen band
            float cov = capsule(vUv, vSizeW);
            float sheen = exp(-pow((vUv.y - 0.68) * 6.0, 2.0)) * (0.35 + vParam * 0.4);
            col += vec3(1.0, 0.92, 0.66) * sheen * 0.4;
            a *= cov;
          } else if (k < 3.5) {
            // TICK — hard rectangle
          } else if (k < 4.5) {
            // GRID — hairline handled by geometry; soften ends
            a *= 0.9;
          } else if (k < 5.5) {
            // HATCH — unrecorded gap; diagonal hatching, never a claim
            vec2 px = vUv * vSizeW * uPxPerWorld;
            float h = step(0.55, fract((px.x + px.y) / 9.0));
            a *= 0.25 + h * 0.5;
          } else if (k < 6.5) {
            // OPEN — right edge dissolves out of the corpus
            float tail = smoothstep(0.55, 1.0, vUv.x);
            float dash = step(0.45, fract(vUv.x * vSizeW.x * uPxPerWorld / 7.0));
            a *= capsule(vUv, vSizeW) * (1.0 - tail * (0.92 - dash * 0.35));
          } else {
            // HEADER — gradient backplate with lit top lip
            col *= 0.85 + vUv.y * 0.3;
            float lip = smoothstep(1.0 - 2.2 / max(2.2, vSizeW.y * uPxPerWorld), 1.0, vUv.y);
            col += vec3(0.35, 0.5, 0.75) * lip * 0.35;
          }
          gl_FragColor = vec4(col, a);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
    this.geo.instanceCount = 0;
  }

  setMorph(raw: number): void {
    this.mat.uniforms.uMorph!.value = raw;
  }
  setPixelsPerWorld(v: number): void {
    this.mat.uniforms.uPxPerWorld!.value = v;
  }

  /** Swap to a new region set: incoming fades up, outgoing fades down. */
  setRegions(next: MorphRegion[], currentAlphaAt: number): void {
    const nextOutgoing = [
      // the set that was fading in, at the opacity it reached
      ...this.current.map((r) => ({ region: r, aFrom: r.alpha * currentAlphaAt })),
      // the set that was still fading down — carry its remaining light
      ...this.outgoing
        .map((o) => ({ region: o.region, aFrom: o.aFrom * (1 - currentAlphaAt) }))
        .filter((o) => o.aFrom > 0.01),
    ];
    const total = next.length + nextOutgoing.length;
    if (total > this.cap) this.grow(total);
    let w = 0;
    for (const r of next) {
      this.writeInstance(w++, r, 0, r.alpha);
    }
    for (const o of nextOutgoing) {
      this.writeInstance(w++, o.region, o.aFrom, 0);
    }
    this.geo.instanceCount = w;
    this.current = next;
    this.outgoing = nextOutgoing;
    this.commit();
  }

  /** Drop the faded-out generations once a transition completes. */
  truncateToCurrent(): void {
    this.geo.instanceCount = this.current.length;
    this.outgoing = [];
  }

  private writeInstance(i: number, r: MorphRegion, aFrom: number, aTo: number): void {
    this.pos[i * 3] = r.x;
    this.pos[i * 3 + 1] = r.y;
    this.pos[i * 3 + 2] = r.z;
    this.size[i * 2] = r.w;
    this.size[i * 2 + 1] = r.h;
    this.color[i * 3] = r.color[0];
    this.color[i * 3 + 1] = r.color[1];
    this.color[i * 3 + 2] = r.color[2];
    this.params[i * 4] = aFrom;
    this.params[i * 4 + 1] = aTo;
    this.params[i * 4 + 2] = r.kind;
    this.params[i * 4 + 3] = r.param ?? 0;
  }

  private grow(min: number): void {
    let cap = Math.max(4096, this.cap || 1);
    while (cap < min) cap *= 2;
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.size = new Float32Array(cap * 2);
    this.color = new Float32Array(cap * 3);
    this.params = new Float32Array(cap * 4);
    const dyn = (arr: Float32Array, itemSize: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, itemSize);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.geo.setAttribute("iPos", dyn(this.pos, 3));
    this.geo.setAttribute("iSize", dyn(this.size, 2));
    this.geo.setAttribute("iColor", dyn(this.color, 3));
    this.geo.setAttribute("iParams", dyn(this.params, 4));
  }

  private commit(): void {
    for (const name of ["iPos", "iSize", "iColor", "iParams"]) {
      (this.geo.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
