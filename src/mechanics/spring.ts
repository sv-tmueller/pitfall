// Springs and launchers: surfaces that impart velocity on contact.
// Impulse OVERWRITES vy (not additive). Cooldown prevents rapid re-trigger.

import { aabbOverlap, type Body } from '../engine/physics';

export interface Spring {
  x: number;
  y: number;
  width: number;
  height: number;
  impulseX: number;
  impulseY: number;
  cooldown: number;
  currentCooldown: number;
}

export function createSpring(x: number, y: number, impulseX: number, impulseY: number): Spring {
  return {
    x,
    y,
    width: 16,
    height: 16,
    impulseX,
    impulseY,
    cooldown: 10,
    currentCooldown: 0,
  };
}

export function stepSpring(spring: Spring, _dt: number): Spring {
  void _dt;
  if (spring.currentCooldown <= 0) return spring;
  return { ...spring, currentCooldown: spring.currentCooldown - 1 };
}

/**
 * Geometry-only overlap test. Ignores the cooldown so the contact hook can
 * track whether the body is currently inside the trigger volume (used to
 * re-arm after the body leaves) independently of whether a launch is allowed.
 */
export function springOverlaps(spring: Spring, playerBody: Body): boolean {
  return aabbOverlap(playerBody, {
    x: spring.x,
    y: spring.y,
    width: spring.width,
    height: spring.height,
  });
}

export function checkSpringHit(spring: Spring, playerBody: Body): boolean {
  if (spring.currentCooldown > 0) return false;
  return springOverlaps(spring, playerBody);
}

export function applySpringImpulse(spring: Spring, body: Body): Body {
  return {
    ...body,
    velocity: {
      x: body.velocity.x + spring.impulseX,
      y: spring.impulseY,
    },
  };
}

export function triggerSpring(spring: Spring): Spring {
  return { ...spring, currentCooldown: spring.cooldown };
}

export function resetSpring(spring: Spring): Spring {
  return { ...spring, currentCooldown: 0 };
}
