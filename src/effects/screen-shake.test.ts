import { describe, expect, it } from 'vitest';
import { createShake, stepShake, triggerShake } from './screen-shake';

const DT = 1 / 60;

describe('screen-shake', () => {
  it('starts with zero offset', () => {
    const s = createShake(42, 1);
    expect(s.offsetX).toBe(0);
    expect(s.offsetY).toBe(0);
    expect(s.magnitude).toBe(0);
  });

  it('produces non-zero offset when triggered', () => {
    let s = createShake(42, 1);
    s = triggerShake(s, 8);
    s = stepShake(s, DT);
    expect(s.magnitude).toBeGreaterThan(0);
    // Offset should be within [-8, 8]
    expect(Math.abs(s.offsetX)).toBeLessThanOrEqual(8);
    expect(Math.abs(s.offsetY)).toBeLessThanOrEqual(8);
  });

  it('decays over steps', () => {
    let s = createShake(42, 1);
    s = triggerShake(s, 8);
    const mags: number[] = [];
    for (let i = 0; i < 10; i++) {
      s = stepShake(s, DT);
      mags.push(s.magnitude);
    }
    // Magnitude should decrease over time
    expect(mags[9]!).toBeLessThan(mags[0]!);
  });

  it('varies direction across steps at constant magnitude (regression)', () => {
    // Regression: the old implementation re-seeded from the magnitude, so a
    // constant magnitude replayed the SAME angle every step. The evolved
    // prngState must visit different directions while the magnitude decays
    // slower than one step.
    let s = createShake(42, 1);
    s = triggerShake(s, 8);
    const dirs: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 6; i++) {
      s = stepShake(s, DT);
      dirs.push({ x: s.offsetX, y: s.offsetY });
    }
    const distinct = new Set(dirs.map((d) => `${d.x},${d.y}`));
    expect(distinct.size).toBeGreaterThan(1);

    // Even stronger: hold the magnitude artificially constant and confirm
    // successive angles differ (proves the seed, not the magnitude, drives
    // direction).
    let held = createShake(7, 1);
    held = triggerShake(held, 8);
    const a1 = stepShake(held, 0);
    const a2 = stepShake({ ...a1, magnitude: 8 }, 0);
    const a3 = stepShake({ ...a2, magnitude: 8 }, 0);
    const angles = new Set([`${a1.offsetX},${a1.offsetY}`, `${a2.offsetX},${a2.offsetY}`, `${a3.offsetX},${a3.offsetY}`]);
    expect(angles.size).toBe(3);
  });

  it('decays proportionally to dt', () => {
    let s = createShake(42, 1);
    s = triggerShake(s, 8);
    // Half-rate dt halves the decay per call: 90/s * dt.
    const fast = stepShake(triggerShake(createShake(1, 1), 8), DT);
    const slow = stepShake(triggerShake(createShake(1, 1), 8), DT / 2);
    expect(8 - fast.magnitude).toBeCloseTo((8 - slow.magnitude) * 2, 10);
    expect(8 - fast.magnitude).toBeCloseTo(90 * DT, 10);
  });

  it('normalizes negative zero offsets', () => {
    // A straight-down angle (sin = -1) makes cos exactly +-0 territory;
    // whatever the sign of the raw round, the stored offset must not be -0.
    let s = createShake(42, 1);
    s = triggerShake(s, 8);
    for (let i = 0; i < 20; i++) {
      s = stepShake(s, DT);
      expect(Object.is(s.offsetX, -0)).toBe(false);
      expect(Object.is(s.offsetY, -0)).toBe(false);
    }
  });

  it('intensity 0 produces no shake', () => {
    let s = createShake(42, 0);
    s = triggerShake(s, 8);
    expect(s.magnitude).toBe(0);
    s = stepShake(s, DT);
    expect(s.offsetX).toBe(0);
    expect(s.offsetY).toBe(0);
  });

  it('is deterministic: same seed produces same offsets', () => {
    let s1 = createShake(42, 1);
    s1 = triggerShake(s1, 8);
    s1 = stepShake(s1, DT);

    let s2 = createShake(42, 1);
    s2 = triggerShake(s2, 8);
    s2 = stepShake(s2, DT);

    expect(s1.offsetX).toBe(s2.offsetX);
    expect(s1.offsetY).toBe(s2.offsetY);
    expect(s1.prngState).toBe(s2.prngState);
  });

  it('offsets are integers', () => {
    let s = createShake(99, 1);
    s = triggerShake(s, 8);
    s = stepShake(s, DT);
    expect(Number.isInteger(s.offsetX)).toBe(true);
    expect(Number.isInteger(s.offsetY)).toBe(true);
  });
});
