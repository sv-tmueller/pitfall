// Teleporters and portals: entry points that relocate the player.
// Paired portals, one-way teleporters, trigger-based destinations.
// Momentum handling: velocity is zeroed on exit (safe default).

import { aabbOverlap, type Body } from '../engine/physics';

export interface Teleporter {
  x: number; y: number;
  width: number; height: number;
  destX: number; destY: number;
  oneWay: boolean;
  cooldown: number;        // steps before re-trigger
  currentCooldown: number;
  preserveMomentum: boolean;
}

export function createTeleporter(
  x: number, y: number, destX: number, destY: number,
  oneWay: boolean = false, preserveMomentum: boolean = false,
): Teleporter {
  return {
    x, y, width: 16, height: 16, destX, destY, oneWay,
    cooldown: 10, currentCooldown: 0, preserveMomentum,
  };
}

export function stepTeleporter(tp: Teleporter, _dt: number): Teleporter {
  void _dt;
  if (tp.currentCooldown <= 0) return tp;
  return { ...tp, currentCooldown: tp.currentCooldown - 1 };
}

/**
 * Geometry-only overlap test. Ignores the cooldown so the contact hook can
 * track whether the body is currently inside the portal volume (used to
 * re-arm the trigger after the body leaves) independently of whether a
 * relocation is allowed this step.
 */
export function teleporterOverlaps(tp: Teleporter, body: Body): boolean {
  return aabbOverlap(body, {
    x: tp.x, y: tp.y, width: tp.width, height: tp.height,
  });
}

export function checkTeleport(tp: Teleporter, body: Body): boolean {
  if (tp.currentCooldown > 0) return false;
  return teleporterOverlaps(tp, body);
}

export function applyTeleport(tp: Teleporter, body: Body): Body {
  const velocity = tp.preserveMomentum ? body.velocity : { x: 0, y: 0 };
  return {
    ...body,
    x: tp.destX,
    y: tp.destY,
    velocity,
    grounded: false,
  };
}

export function triggerCooldown(tp: Teleporter): Teleporter {
  return { ...tp, currentCooldown: tp.cooldown };
}

export function resetTeleporter(tp: Teleporter): Teleporter {
  return { ...tp, currentCooldown: 0 };
}

// Portal pair: bidirectional teleporters
export function createPortalPair(
  ax: number, ay: number, bx: number, by: number,
): [Teleporter, Teleporter] {
  const a = createTeleporter(ax, ay, bx, by, false, false);
  const b = createTeleporter(bx, by, ax, ay, false, false);
  return [a, b];
}
