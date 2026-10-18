import { describe, expect, it } from 'vitest';
import { createMovingPlatform, stepMovingPlatform, isPlayerOnPlatform, resetMovingPlatform } from './moving-terrain';
import type { Body } from '../engine/physics';

const DT = 1 / 60;

function makeBody(x: number, y: number): Body {
  return { x, y, width: 16, height: 16, velocity: { x: 0, y: 0 }, grounded: false };
}

function makePlatform(speed: number, distance: number) {
  return createMovingPlatform(100, 100, 48, 16, 1, 0, speed, distance);
}

describe('moving-terrain', () => {
  it('moves speed * dt pixels per step (speed is px/s)', () => {
    // 600 px/s at a fixed 60 Hz is exactly 10 px this step.
    const p = stepMovingPlatform(makePlatform(600, 200), DT);
    expect(p.x).toBeCloseTo(110, 6);
    expect(p.direction).toBe(1);
  });

  it('reverses at max distance', () => {
    let p = makePlatform(600, 60);
    for (let i = 0; i < 8; i++) {
      p = stepMovingPlatform(p, DT);
    }
    // 60 px band, 10 px/step: the seventh step reaches the end, the eighth
    // travels back.
    expect(p.direction).toBe(-1);
    expect(p.x).toBeLessThanOrEqual(160);
  });

  it('reflects the turnaround overshoot so the platform stays in its band', () => {
    // distance 1.5 px, 1 px/step: the second step overshoots by 0.5 px and
    // must spend that remainder travelling back, not park past the end.
    let p = createMovingPlatform(100, 100, 48, 16, 1, 0, 60, 1.5);
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) {
      p = stepMovingPlatform(p, DT);
      xs.push(p.x);
    }
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(101.5);
    }
    // x = 101 (forward), 101 (reflected back to offset 1), 100, 101, 101, 100
    expect(xs[0]).toBeCloseTo(101, 6);
    expect(xs[1]).toBeCloseTo(101, 6);
    expect(xs[2]).toBeCloseTo(100, 6);
    expect(p.traveled).toBeLessThan(3);
  });

  it('holds still when the authored distance is zero', () => {
    const p = stepMovingPlatform(makePlatform(600, 0), DT);
    expect(p.x).toBe(100);
    expect(p.traveled).toBe(0);
  });

  it('detects player on platform', () => {
    const p = createMovingPlatform(100, 100, 48, 16, 1, 0, 10, 200);
    expect(isPlayerOnPlatform(p, makeBody(100, 100))).toBe(true);
  });

  it('reset restores start position', () => {
    let p = createMovingPlatform(100, 100, 48, 16, 1, 0, 10, 200);
    p = stepMovingPlatform(p, DT);
    p = resetMovingPlatform(p);
    expect(p.x).toBe(100);
    expect(p.y).toBe(100);
    expect(p.direction).toBe(1);
  });
});
