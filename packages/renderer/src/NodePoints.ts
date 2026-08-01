import * as THREE from "three";

/**
 * All graph nodes as one Points batch: soft luminous somata.
 * Per-instance attributes drive size, color, emphasis (selection/dim), and
 * activity (timeline ignition). One geometry, one material, zero per-node objects.
 */
export class NodePoints {
  readonly points: THREE.Points;
  readonly count: number;
  private geo: THREE.BufferGeometry;
  private emphasisAttr: THREE.BufferAttribute;
  private activityAttr: THREE.BufferAttribute;
  readonly emphasis: Float32Array;
  readonly activity: Float32Array;

  constructor(positions: Float32Array, colors: Float32Array, sizes: Float32Array, shapes: Float32Array) {
    this.count = sizes.length;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.geo.setAttribute("aShape", new THREE.BufferAttribute(shapes, 1));
    this.emphasis = new Float32Array(this.count).fill(1);
    this.activity = new Float32Array(this.count);
    this.emphasisAttr = new THREE.BufferAttribute(this.emphasis, 1);
    this.activityAttr = new THREE.BufferAttribute(this.activity, 1);
    this.geo.setAttribute("aEmphasis", this.emphasisAttr);
    this.geo.setAttribute("aActivity", this.activityAttr);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uPixelRatio: { value: 1 }, uFar: { value: 0 }, uDensity: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize, aEmphasis, aActivity, aShape;
        varying vec3 vColor;
        varying float vEmphasis, vActivity, vShape, vFar;
        uniform float uPixelRatio, uFar;
        void main() {
          vColor = aColor; vEmphasis = aEmphasis; vActivity = aActivity; vShape = aShape;
          vFar = uFar;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float size = aSize * (1.0 + aActivity * 0.9) * (0.4 + 0.6 * min(aEmphasis, 1.5));
          size *= mix(1.0, 0.78, uFar); // somata recede at observatory range
          gl_PointSize = clamp(size * 340.0 / max(1.0, -mv.z) * uPixelRatio, 1.5, 64.0 * uPixelRatio);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vEmphasis, vActivity, vShape, vFar;
        uniform float uDensity;
        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r = length(uv);
          if (r > 1.0) discard;
          // soma: bright core + soft membrane halo. Promotions (shape 1) get a ring;
          // titles (shape 2) a diamond-ish core — shape encodes type, not just color.
          float core = smoothstep(0.32, 0.0, r);
          float halo = exp(-2.6 * r);
          if (vShape > 0.5 && vShape < 1.5) {
            float ring = smoothstep(0.08, 0.0, abs(r - 0.55));
            core = max(core * 0.6, ring);
          } else if (vShape >= 1.5) {
            float d = abs(uv.x) + abs(uv.y);
            core = max(core, smoothstep(0.5, 0.1, d) * 0.9);
          }
          vec3 col = vColor * (0.4 * halo + 1.2 * core);
          col += vec3(1.0) * vActivity * core * 0.9;           // ignition burns white-hot
          col *= vEmphasis * mix(1.0, 0.72, vFar);
          float alpha = (halo * 0.3 + core * 0.9) * min(1.0, vEmphasis)
                        * mix(1.0, 0.38, vFar * (1.0 - vActivity));
          // corpus-density adaptation: 30k additive somata integrate to white
          // at the alpha 6k somata need to stay visible. Selected/active
          // somata keep full presence.
          alpha *= mix(uDensity, 1.0, max(vActivity, step(1.5, vEmphasis)));
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  setPixelRatio(pr: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uPixelRatio!.value = pr;
  }

  /** 0 = close-up detail, 1 = observatory range (dims soma accumulation). */
  setFar(far: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uFar!.value = far;
  }

  /** Corpus-density alpha scale (1 at ~6k people, <1 for larger corpora). */
  setDensity(d: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uDensity!.value = d;
  }

  commitEmphasis(): void {
    this.emphasisAttr.needsUpdate = true;
  }
  commitActivity(): void {
    this.activityAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
