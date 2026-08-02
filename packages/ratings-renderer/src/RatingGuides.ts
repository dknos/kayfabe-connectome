import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { RATING_PALETTE } from "./palette";
import type { RatingBounds } from "./types";

export class RatingGuides {
  readonly group = new THREE.Group();
  readonly thresholdPlane: THREE.Mesh;
  readonly timeCurtain: THREE.Mesh;
  readonly lines: LineSegments2;

  private lineGeometry = new LineSegmentsGeometry();
  private lineMaterial = new LineMaterial({
    color: RATING_PALETTE.rail,
    linewidth: 0.9,
    transparent: true,
    opacity: 0.33,
    depthWrite: false,
    alphaToCoverage: true,
  });
  private thresholdMaterial = new THREE.MeshBasicMaterial({
    color: RATING_PALETTE.datum,
    transparent: true,
    opacity: 0.065,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  private curtainMaterial = new THREE.MeshBasicMaterial({
    color: RATING_PALETTE.paper,
    transparent: true,
    opacity: 0.11,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private threshold = 5;
  private ratingScale = 42;
  private bounds: RatingBounds = { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };

  constructor() {
    this.lines = new LineSegments2(this.lineGeometry, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = -1;
    this.group.add(this.lines);

    this.thresholdPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.thresholdMaterial);
    this.thresholdPlane.rotation.x = -Math.PI / 2;
    this.thresholdPlane.renderOrder = -2;
    this.thresholdPlane.frustumCulled = false;
    this.group.add(this.thresholdPlane);

    this.timeCurtain = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.curtainMaterial);
    this.timeCurtain.rotation.y = Math.PI / 2;
    this.timeCurtain.renderOrder = 5;
    this.timeCurtain.visible = false;
    this.timeCurtain.frustumCulled = false;
    this.group.add(this.timeCurtain);
  }

  setLayout(bounds: RatingBounds, ratingRange: readonly [number, number], ratingScale: number): void {
    this.bounds = { ...bounds };
    this.ratingScale = ratingScale;
    const positions: number[] = [];
    const z0 = bounds.minZ - 8;
    const z1 = bounds.maxZ + 8;
    const x0 = bounds.minX;
    const x1 = bounds.maxX;
    const lo = Math.floor(Math.min(0, ratingRange[0]));
    const hi = Math.ceil(Math.max(5, ratingRange[1]));
    for (let rating = lo; rating <= hi; rating++) {
      const y = rating * ratingScale;
      positions.push(x0, y, z0, x1, y, z0);
      positions.push(x0, y, z1, x1, y, z1);
    }
    // Baseline uprights make depth lanes readable without turning the floor
    // into a decorative grid.
    positions.push(x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1);
    this.lineGeometry.setPositions(positions.length ? positions : [0, 0, 0, 0, 0, 0]);
    this.updatePlanes();
  }

  setThreshold(value: number): void {
    this.threshold = value;
    this.updatePlanes();
  }

  setOpacity(value: number): void {
    const opacity = Math.max(0, Math.min(1, value));
    this.lineMaterial.opacity = 0.33 * opacity;
    this.thresholdMaterial.opacity = 0.065 * opacity;
  }

  setTimeX(x: number | null, reducedMotion: boolean): void {
    this.timeCurtain.visible = x !== null;
    if (x === null) return;
    this.timeCurtain.position.x = x;
    this.curtainMaterial.opacity = reducedMotion ? 0.18 : 0.11;
  }

  setResolution(w: number, h: number): void {
    this.lineMaterial.resolution.set(Math.max(1, w), Math.max(1, h));
  }

  dispose(): void {
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.thresholdPlane.geometry.dispose();
    this.thresholdMaterial.dispose();
    this.timeCurtain.geometry.dispose();
    this.curtainMaterial.dispose();
  }

  private updatePlanes(): void {
    const b = this.bounds;
    const width = Math.max(1, b.maxX - b.minX);
    const depth = Math.max(1, b.maxZ - b.minZ + 16);
    this.thresholdPlane.scale.set(width, depth, 1);
    this.thresholdPlane.position.set((b.minX + b.maxX) * 0.5, this.threshold * this.ratingScale, (b.minZ + b.maxZ) * 0.5);
    const height = Math.max(1, b.maxY - b.minY + 36);
    this.timeCurtain.scale.set(depth, height, 1);
    this.timeCurtain.position.y = (b.minY + b.maxY) * 0.5;
    this.timeCurtain.position.z = (b.minZ + b.maxZ) * 0.5;
  }
}
