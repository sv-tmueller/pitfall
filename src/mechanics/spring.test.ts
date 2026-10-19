import { describe, expect, it } from 'vitest';
import { createSpring, stepSpring, checkSpringHit, applySpringImpulse, triggerSpring, resetSpring } from './spring';
import type { Body } from '../engine/physics';

function makeBody(x: number, y: number): Body {
  return { x, y, width: 16, height: 16, velocity: { x: 0, y: 0 }, grounded: false };
}

describe('spring', () => {
  it('detects player contact', () => {
    const s = createSpring(100, 100, 0, -400);
    expect(checkSpringHit(s, makeBody(100, 100))).toBe(true);
  });
  it('does not detect when player is far', () => {
    const s = createSpring(100, 100, 0, -400);
    expect(checkSpringHit(s, makeBody(500, 500))).toBe(false);
  });
  it('imparts upward velocity', () => {
    const s = createSpring(100, 100, 0, -400);
    const body = makeBody(100, 100);
    const launched = applySpringImpulse(s, body);
    expect(launched.velocity.y).toBe(-400);
  });
  it('imparts horizontal velocity (directional launcher)', () => {
    const s = createSpring(100, 100, 200, -200);
    const body = makeBody(100, 100);
    const launched = applySpringImpulse(s, body);
    expect(launched.velocity.x).toBe(200);
    expect(launched.velocity.y).toBe(-200);
  });
  it('overwrites vy absolutely, independent of gravity direction (#174)', () => {
    // Engine fact backing the validator's spring-in-zone exclusion: the
    // impulse ignores the gravity sign entirely. A spring hit inside an
    // inverted region still launches toward -y (world-down impulse stays
    // world-down), which is why the reachability model must not grant
    // spring launches inside gravity zones.
    const s = createSpring(100, 100, 0, -400);
    const body = makeBody(100, 100);
    const launched = applySpringImpulse(s, body);
    expect(launched.velocity.y).toBe(-400);
    // And a downward-impulse spring (hypothetical) would push world-down
    // even though an inverted player's "up" is +y: the assignment is
    // absolute, not gravity-relative.
    const down = createSpring(100, 100, 0, 300);
    const launchedDown = applySpringImpulse(down, makeBody(100, 100));
    expect(launchedDown.velocity.y).toBe(300);
  });
  it('cooldown prevents rapid re-trigger', () => {
    let s = createSpring(100, 100, 0, -400);
    s = triggerSpring(s);
    expect(checkSpringHit(s, makeBody(100, 100))).toBe(false);
  });
  it('cooldown decreases over steps', () => {
    let s = triggerSpring(createSpring(100, 100, 0, -400));
    s = stepSpring(s, 1/60);
    expect(s.currentCooldown).toBe(9);
  });
  it('reset clears cooldown', () => {
    let s = triggerSpring(createSpring(100, 100, 0, -400));
    s = resetSpring(s);
    expect(s.currentCooldown).toBe(0);
  });
});
