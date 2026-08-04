/**
 * The focus bubble: a thin transparent shell riding the playhead.
 *
 * It is the timeline lens made visible — its world radius IS the half-width
 * the tanh focus field wins on the axis, so what sits inside the glass is
 * exactly what the lens is expanding. Restrained on purpose: a fresnel rim
 * and a faint caustic ring at the wall, no refraction pass, no giant glass
 * sphere obscuring labels (the audit rejected full-screen feedback effects on
 * this stack, and refraction needs a second scene render this tier ladder
 * won't pay for). The medium tier keeps it; low drops it entirely.
 */
import {
  BackSide, Mesh, ShaderMaterial, SphereGeometry,
} from "three";

export class WarpBubble {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor() {
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: BackSide,
      uniforms: {
        uRim: { value: [0.55, 0.78, 1.0] },
      },
      vertexShader: /* glsl */ `
        varying vec3 vNormalW; varying vec3 vPosW;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vec4 w = modelMatrix * vec4(position, 1.0);
          vPosW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uRim;
        varying vec3 vNormalW; varying vec3 vPosW;
        void main() {
          vec3 toEye = normalize(cameraPosition - vPosW);
          float fres = pow(1.0 - abs(dot(vNormalW, toEye)), 3.0);
          float alpha = fres * 0.32 + 0.015;
          gl_FragColor = vec4(uRim, alpha);
        }`,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** Centre on the playhead's axis position with the lens's true half-width. */
  set(x: number, halfWidth: number, lateral: number): void {
    this.mesh.position.set(x, 0, 0);
    this.mesh.scale.set(Math.max(0.5, halfWidth), lateral, lateral);
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }
  get visible(): boolean {
    return this.mesh.visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
