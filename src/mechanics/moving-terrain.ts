// Moving terrain and shifting platforms: solid surfaces that travel along paths.
// The player rides them. Deterministic, phase resets on respawn.

import { aabbOverlap, type Body } from '../engine/physics';

export interface MovingPlatform {
  x: number; y: number;
  startX: number; startY: number;
  width: number; height: number;
  dx: number; dy: number;   // direction vector (normalized)
  speed: number;              // pixels per second
  distance: number;          // max travel distance
  traveled: number;           // ping-pong phase in [0, 2 * distance)
  direction: 1 | -1;          // current travel direction
}

export function createMovingPlatform(
  x: number, y: number, width: number, height: number,
  dx: number, dy: number, speed: number, distance: number,
): MovingPlatform {
  const len = Math.hypot(dx, dy) || 1;
  return {
    x, y, startX: x, startY: y, width, height,
    dx: dx / len, dy: dy / len, speed, distance,
    traveled: 0, direction: 1,
  };
}

/**
 * Advances a ping-pong platform by speed * dt pixels (speed is px/s).
 *
 * Position is derived from a triangle wave over the ping-pong phase rather
 * than accumulated incrementally, so a step that overruns the end of the leg
 * spends its overshoot travelling back (the remainder is reflected) instead
 * of parking the platform past its authored range. The travelled band is
 * therefore [start, start + (dx,dy) * distance] forever, on every turnaround.
 */
export function stepMovingPlatform(platform: MovingPlatform, dt: number): MovingPlatform {
  if (platform.distance <= 0) {
    return platform;
  }

  const stepLen = platform.speed * dt;
  const cycle = platform.distance * 2;
  let phase = (platform.traveled + stepLen) % cycle;
  if (phase < 0) {
    phase += cycle;
  }

  const onForwardLeg = phase <= platform.distance;
  const offset = onForwardLeg ? phase : cycle - phase;
  const direction = (onForwardLeg ? 1 : -1) as 1 | -1;

  return {
    ...platform,
    x: platform.startX + platform.dx * offset,
    y: platform.startY + platform.dy * offset,
    traveled: phase,
    direction,
  };
}

export function isPlayerOnPlatform(platform: MovingPlatform, playerBody: Body): boolean {
  // Player must be overlapping and above the platform
  return aabbOverlap(playerBody, {
    x: platform.x, y: platform.y, width: platform.width, height: platform.height,
  });
}

export function resetMovingPlatform(platform: MovingPlatform): MovingPlatform {
  return { ...platform, x: platform.startX, y: platform.startY, traveled: 0, direction: 1 };
}
