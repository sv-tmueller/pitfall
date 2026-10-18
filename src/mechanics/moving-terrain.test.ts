import { describe, expect, it } from 'vitest';
import { createMovingPlatform, stepMovingPlatform, isPlayerOnPlatform, resetMovingPlatform } from './moving-terrain';
import type { Body } from '../engine/physics';
import { loadLevel } from '../levels/load';
import { WORLD2_LEVELS } from '../levels/world2/index';
import { WORLD3_LEVELS } from '../levels/world3/index';
import { createMechanicsRuntime, stepMechanics } from './runtime';
import { registerAllMechanicTypes } from './register';

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

// ===========================================================================
// AC4: every shipped moving-platform stays inside its authored travel band
// ===========================================================================

describe('moving-terrain - shipped platform travel band (issue #158 AC4)', () => {
  registerAllMechanicTypes();

  const DUMMY_BODY: Body = {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    velocity: { x: 0, y: 0 },
    grounded: false,
  };

  const IDLE = { left: false, right: false, jumpPressed: false, jumpHeld: false };

  // The seven shipped moving-platform entries: level 29 (1), level 30 (1),
  // level 34 (1), level 35 (1), level 36 (1), level 45 (2).
  const SOURCES: readonly unknown[] = [
    WORLD2_LEVELS['timing'], // level-29
    WORLD2_LEVELS['world-2-finale'], // level-30
    WORLD3_LEVELS['ride-the-wave'], // level-34
    WORLD3_LEVELS['sync-ride'], // level-35
    WORLD3_LEVELS['hybrid-hop'], // level-36
    WORLD3_LEVELS['world-3-finale'], // level-45 (two platforms)
  ];

  it('keeps every platform inside its band across 600 stepped frames', () => {
    let platformCount = 0;

    for (const source of SOURCES) {
      const level = loadLevel(source);
      const runtime = createMechanicsRuntime(level, DUMMY_BODY);

      // Authored band geometry, read straight from the level data.
      const start = new Map<string, { x: number; y: number }>();
      const dir = new Map<string, { x: number; y: number }>();
      const distance = new Map<string, number>();

      for (const entry of level.mechanics ?? []) {
        if (entry.type !== 'moving-platform') continue;
        platformCount++;
        const p = entry.params;
        const startX = p['startX'] as number;
        const startY = p['startY'] as number;
        const dx = p['dx'] as number;
        const dy = p['dy'] as number;
        const len = Math.hypot(dx, dy) || 1;
        start.set(entry.id, { x: startX, y: startY });
        dir.set(entry.id, { x: dx / len, y: dy / len });
        distance.set(entry.id, p['distance'] as number);
      }

      for (let step = 0; step < 600; step++) {
        stepMechanics(runtime, DUMMY_BODY, IDLE, step);
        for (const solid of runtime.publishedSolids) {
          const s0 = start.get(solid.id);
          if (s0 === undefined) continue;
          const d = dir.get(solid.id)!;
          // Project the position onto the travel direction; it must stay in
          // [0, distance] no matter how the turnaround lands.
          const along = (solid.x - s0.x) * d.x + (solid.y - s0.y) * d.y;
          expect(along).toBeGreaterThanOrEqual(-1e-6);
          expect(along).toBeLessThanOrEqual(distance.get(solid.id)! + 1e-6);
        }
      }
    }

    // Guard the sweep actually covered all seven shipped entries.
    expect(platformCount).toBe(7);
  });
});
