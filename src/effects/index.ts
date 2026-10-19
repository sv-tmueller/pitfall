// Effects manager: combines screen shake, particles, and hit-stop.
// All effects are cosmetic, deterministic, and intensity-scaled.

import { createShake, stepShake, triggerShake } from './screen-shake';
import type { ShakeState } from './screen-shake';
import { burst, createParticles, stepParticles } from './particles';
import type { ParticleSystem, Particle } from './particles';
import { createHitStop, isFrozen, stepHitStop, triggerHitStop } from './hit-stop';
import type { HitStopState } from './hit-stop';

export type { ShakeState, ParticleSystem, Particle, HitStopState };

export interface EffectsManager {
  shake: ShakeState;
  particles: ParticleSystem;
  hitStop: HitStopState;
}

export function createEffects(seed: number, intensity: number): EffectsManager {
  return {
    shake: createShake(seed, intensity),
    particles: createParticles(seed ^ 0xBEEF, intensity),
    hitStop: createHitStop(intensity),
  };
}

export function stepEffects(manager: EffectsManager, dt: number): EffectsManager {
  return {
    shake: stepShake(manager.shake, dt),
    particles: stepParticles(manager.particles, dt),
    hitStop: stepHitStop(manager.hitStop, dt),
  };
}

export function onDeath(manager: EffectsManager, x: number, y: number): EffectsManager {
  return {
    shake: triggerShake(manager.shake, 8),
    particles: burst(manager.particles, x, y, 20, 'lethal'),
    hitStop: triggerHitStop(manager.hitStop, 3),
  };
}

export function onLand(manager: EffectsManager, x: number, y: number, impactVy: number): EffectsManager {
  const hardImpact = Math.abs(impactVy) > 150;
  return {
    ...manager,
    shake: hardImpact ? triggerShake(manager.shake, 2) : manager.shake,
    particles: burst(manager.particles, x, y, 4, 'edge'),
  };
}

export function onTrapFire(manager: EffectsManager, x: number, y: number): EffectsManager {
  return {
    shake: triggerShake(manager.shake, 4),
    particles: burst(manager.particles, x, y, 8, 'bone'),
    hitStop: manager.hitStop,
  };
}

export function isEffectsFrozen(manager: EffectsManager): boolean {
  return isFrozen(manager.hitStop);
}
