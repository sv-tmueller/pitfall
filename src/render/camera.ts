// Pure camera computation: no DOM, no randomness, no clock.
// Centers on a target and clamps so the 320x180 viewport never shows
// out-of-bounds area.

import { BASE_HEIGHT, BASE_WIDTH } from '../scale';

export interface Camera {
  /** Top-left corner in world pixels. */
  readonly x: number;
  readonly y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeCamera(
  targetCenterX: number,
  targetCenterY: number,
  levelW: number,
  levelH: number,
): Camera {
  const maxX = Math.max(0, levelW - BASE_WIDTH);
  const maxY = Math.max(0, levelH - BASE_HEIGHT);

  // Whole-pixel camera: interpolated centers arrive fractional and are
  // rounded so every downstream screen coord lands on the pixel grid.
  return {
    x: Math.round(clamp(targetCenterX - BASE_WIDTH / 2, 0, maxX)),
    y: Math.round(clamp(targetCenterY - BASE_HEIGHT / 2, 0, maxY)),
  };
}
