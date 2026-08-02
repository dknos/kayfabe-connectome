import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { RATING_PALETTE } from "./palette";
import { ratingTrendEligible, type RatingAggregateVisual } from "./types";

/** Materialized global/promotion time summaries. One instance is one disclosed bin. */
export class RatingAggregateRidges {
  readonly mesh: THREE.InstancedMesh;
  readonly medianTrace: LineSegments2;
  bins: RatingAggregateVisual[] = [];

  private material: THREE.MeshBasicMaterial;
  private traceGeometry: LineSegmentsGeometry;
  private traceMaterial: LineMaterial;
  private matrix = new THREE.Matrix4();
  private position = new THREE.Vector3();
  private scale = new THREE.Vector3();
  private color = new THREE.Color();
  private positiveQ = new THREE.Quaternion();
  private negativeQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

  constructor(capacity = 24_000) {
    const geometry = new THREE.CylinderGeometry(0.42, 0.72, 1, 4, 1, false);
    geometry.rotateY(Math.PI / 4);
    this.material = new THREE.MeshBasicMaterial({
      color: RATING_PALETTE.ratedWarm,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;

    this.traceGeometry = new LineSegmentsGeometry();
    this.traceMaterial = new LineMaterial({
      color: RATING_PALETTE.datum,
      linewidth: 1.25,
      transparent: true,
      opacity: 0.54,
      depthWrite: false,
      alphaToCoverage: true,
    });
    this.medianTrace = new LineSegments2(this.traceGeometry, this.traceMaterial);
    this.medianTrace.frustumCulled = false;
    this.medianTrace.renderOrder = 3;
  }

  setBins(bins: RatingAggregateVisual[]): void {
    const max = this.mesh.instanceMatrix.count;
    this.bins = bins.slice(0, max);
    this.mesh.count = this.bins.length;
    const segments: number[] = [];
    for (let i = 0; i < this.bins.length; i++) {
      const b = this.bins[i]!;
      const h = b.maxHeight;
      this.position.set(b.x, h * 0.5, b.z);
      const depth = b.coverageBasis === "global-denominator"
        ? 2.4
        : Math.max(1.4, Math.sqrt(b.ratedCount) * 0.32);
      this.scale.set(Math.max(0.5, b.width), Math.max(0.001, Math.abs(h)), depth);
      this.matrix.compose(this.position, h < 0 ? this.negativeQ : this.positiveQ, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
      const heat = Math.max(0, Math.min(1, (b.max + 1) / 8));
      this.color.set(RATING_PALETTE.ratedWarm).lerp(new THREE.Color(RATING_PALETTE.datum), heat * 0.48);
      this.mesh.setColorAt(i, this.color);
      if (ratingTrendEligible(b.ratedCount)) {
        const x0 = b.x - b.width * 0.46;
        const x1 = b.x + b.width * 0.46;
        segments.push(x0, b.medianHeight + 0.55, b.z, x1, b.medianHeight + 0.55, b.z);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.traceGeometry.setPositions(segments.length ? segments : [0, 0, 0, 0, 0, 0]);
    this.medianTrace.visible = segments.length > 0;
  }

  setOpacity(v: number): void {
    this.material.opacity = 0.28 * v;
    this.traceMaterial.opacity = 0.54 * v;
  }

  setResolution(w: number, h: number): void {
    this.traceMaterial.resolution.set(Math.max(1, w), Math.max(1, h));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.traceGeometry.dispose();
    this.traceMaterial.dispose();
  }
}
