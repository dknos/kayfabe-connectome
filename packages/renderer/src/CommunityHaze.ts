import * as THREE from "three";

/**
 * One soft billboard per computed community: the macrostructure "lobes" that make
 * the connectome readable at wide zoom. Fades out as the camera approaches so
 * close-range work stays crisp.
 */
export class CommunityHaze {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;

  constructor(centers: Float32Array, sizes: Float32Array, colors: Float32Array, intensity = 1) {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(centers, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    this.geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      // intensity scales with community count: 51 sprites read as atmosphere,
      // 371 identical ones integrate into a white wash
      uniforms: { uCamDist: { value: 5 }, uMaxPx: { value: 380 }, uIntensity: { value: intensity } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute vec3 aColor;
        varying vec3 vColor;
        varying float vFade;
        uniform float uCamDist, uMaxPx;
        void main() {
          vColor = aColor;
          vFade = smoothstep(1.6, 4.2, uCamDist); // only breathes at observatory range
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(aSize * 650.0 / max(1.0, -mv.z), uMaxPx);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vFade;
        uniform float uIntensity;
        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r = length(uv);
          if (r > 1.0) discard;
          float g = exp(-3.4 * r * r);
          gl_FragColor = vec4(vColor * g * 0.13 * uIntensity, g * 0.085 * vFade * uIntensity);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -2;
  }

  tick(camDist: number, maxPx: number): void {
    const u = (this.points.material as THREE.ShaderMaterial).uniforms;
    u.uCamDist!.value = camDist;
    u.uMaxPx!.value = maxPx;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
