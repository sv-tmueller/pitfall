// Particle system: deterministic bursts driven by a seeded PRNG.
// Cosmetic only; particles are FillRects in the effects layer.

import { createPrng } from '../engine/prng';
import type { PaletteToken } from '../render/palette';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  /** Palette token, not a hex string: particles render as FillRects. */
  color: PaletteToken;
  size: number;
}

export interface ParticleSystem {
  particles: Particle[];
  seed: number;
  intensity: number;
  prngState: number;
}

const GRAVITY = 200; // px/s^2

export function createParticles(seed: number, intensity: number): ParticleSystem {
  return { particles: [], seed, intensity, prngState: seed };
}

export function burst(
  system: ParticleSystem,
  x: number,
  y: number,
  count: number,
  color: PaletteToken,
): ParticleSystem {
  if (system.intensity <= 0) return system;
  const scaledCount = Math.round(count * system.intensity);
  if (scaledCount <= 0) return system;

  const prng = createPrng(system.prngState);
  const newParticles: Particle[] = [];
  for (let i = 0; i < scaledCount; i++) {
    const angle = prng.next() * Math.PI * 2;
    const speed = 20 + prng.next() * 60;
    const life = 20 + Math.floor(prng.next() * 20);
    newParticles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      color,
      size: 1 + Math.floor(prng.next() * 2),
    });
  }
  return {
    ...system,
    particles: [...system.particles, ...newParticles],
    prngState: prng.getState(),
  };
}

export function stepParticles(system: ParticleSystem, dt: number): ParticleSystem {
  if (system.particles.length === 0) return system;
  const alive: Particle[] = [];
  for (const p of system.particles) {
    const np: Particle = {
      ...p,
      x: p.x + p.vx * dt,
      y: p.y + p.vy * dt,
      vy: p.vy + GRAVITY * dt,
      life: p.life - 1,
    };
    if (np.life > 0) alive.push(np);
  }
  return { ...system, particles: alive };
}
