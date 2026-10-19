import { describe, expect, it } from 'vitest';
import { burst, createParticles, stepParticles } from './particles';
import type { PaletteToken } from '../render/palette';

describe('particles', () => {
  it('particle colors are palette tokens', () => {
    let ps = createParticles(42, 1);
    ps = burst(ps, 100, 50, 10, 'lethal');
    for (const p of ps.particles) {
      expect(['void', 'night', 'dusk', 'edge', 'bone', 'lethal']).toContain(p.color satisfies PaletteToken);
    }
  });

  it('starts empty', () => {
    const ps = createParticles(42, 1);
    expect(ps.particles).toHaveLength(0);
  });

  it('burst spawns particles', () => {
    let ps = createParticles(42, 1);
    ps = burst(ps, 100, 50, 10, 'lethal');
    expect(ps.particles).toHaveLength(10);
  });

  it('intensity 0 spawns no particles', () => {
    let ps = createParticles(42, 0);
    ps = burst(ps, 100, 50, 10, 'lethal');
    expect(ps.particles).toHaveLength(0);
  });

  it('intensity 0.5 spawns half the particles', () => {
    let ps = createParticles(42, 0.5);
    ps = burst(ps, 100, 50, 10, 'lethal');
    expect(ps.particles).toHaveLength(5);
  });

  it('dead particles are removed after stepParticles', () => {
    let ps = createParticles(42, 1);
    ps = burst(ps, 100, 50, 5, 'lethal');
    expect(ps.particles).toHaveLength(5);
    // Step many times to let them die
    for (let i = 0; i < 60; i++) {
      ps = stepParticles(ps, 1/60);
    }
    expect(ps.particles).toHaveLength(0);
  });

  it('particles have velocity and life', () => {
    let ps = createParticles(42, 1);
    ps = burst(ps, 100, 50, 1, 'lethal');
    const p = ps.particles[0]!;
    expect(p.x).toBe(100);
    expect(p.y).toBe(50);
    expect(p.life).toBeGreaterThan(0);
    expect(typeof p.vx).toBe('number');
    expect(typeof p.vy).toBe('number');
  });

  it('is deterministic: same seed produces same particles', () => {
    let ps1 = createParticles(42, 1);
    ps1 = burst(ps1, 100, 50, 5, 'lethal');

    let ps2 = createParticles(42, 1);
    ps2 = burst(ps2, 100, 50, 5, 'lethal');

    expect(ps1.particles).toEqual(ps2.particles);
  });
});
