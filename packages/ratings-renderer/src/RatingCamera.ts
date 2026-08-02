import * as THREE from "three";
import { MorphCamera, type MorphView } from "@kayfabe/morph-renderer";
import type { RatingBounds } from "./types";

const OVERVIEW: MorphView = {
  cx: 0,
  cy: 92,
  cz: 420,
  distance: 1380,
  theta: THREE.MathUtils.degToRad(31),
  phi: THREE.MathUtils.degToRad(63),
};

/** Independent camera instance with a restrained ratings-instrument default. */
export class RatingCamera extends MorphCamera {
  private ratingInsets = { left: 0, right: 0, top: 0, bottom: 0 };

  constructor(canvas: HTMLCanvasElement) {
    super(canvas);
    this.minDistance = 34;
    this.maxDistance = 7200;
    this.restore(OVERVIEW);
  }

  overview(bounds: RatingBounds, durationS = 0.75): void {
    this.fit(bounds, 0.08, durationS, {
      theta: OVERVIEW.theta,
      phi: OVERVIEW.phi,
    });
  }

  analyst(bounds: RatingBounds, durationS = 0.65): void {
    this.fit(bounds, 0.06, durationS, {
      theta: THREE.MathUtils.degToRad(0.01),
      phi: THREE.MathUtils.degToRad(1.5),
    });
  }

  override setInsets(next: { left?: number; right?: number; top?: number; bottom?: number }): void {
    super.setInsets(next);
    this.ratingInsets = {
      left: Math.max(0, next.left ?? this.ratingInsets.left),
      right: Math.max(0, next.right ?? this.ratingInsets.right),
      top: Math.max(0, next.top ?? this.ratingInsets.top),
      bottom: Math.max(0, next.bottom ?? this.ratingInsets.bottom),
    };
  }

  usableScreenRect(): { left: number; right: number; top: number; bottom: number } {
    return {
      left: this.ratingInsets.left,
      right: Math.max(this.ratingInsets.left + 1, this.el.clientWidth - this.ratingInsets.right),
      top: this.ratingInsets.top,
      bottom: Math.max(this.ratingInsets.top + 1, this.el.clientHeight - this.ratingInsets.bottom),
    };
  }
}
