import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Body } from '../../engine/physics';
import { Tile } from '../../engine/physics';
import type { WorldState } from '../types';
import { clearRegistry, createTrap } from '../registry';
import { registerEmergingSpikes } from './emerging-spikes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBody(x = 0, y = 0, grounded = false): Body {
  return {
    x,
    y,
    width: 16,
    height: 16,
    velocity: { x: 0, y: 0 },
    grounded,
  };
}

function makeWorld(opts: Partial<WorldState> = {}): WorldState {
  const cols = opts.cols ?? 4;
  const rows = opts.rows ?? 3;
  const tiles = opts.tiles ?? new Array(cols * rows).fill(Tile.Solid);
  return {
    tiles,
    cols,
    rows,
    hazards: [],
    dynamicSolids: [],
    playerBody: makeBody(),
    playerPrevGrounded: false,
    exitReached: false,
    firedTrapIds: [],
    exitPos: { col: 3, row: 0 },
    ...opts,
  };
}

beforeEach(() => {
  clearRegistry();
});

afterEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// Registration & factory
// ---------------------------------------------------------------------------

describe('emerging-spikes: registration', () => {
  it('registers under type "emerging-spikes"', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es1',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 3,
        repeats: false,
      },
    });
    expect(trap.type).toBe('emerging-spikes');
    expect(trap.id).toBe('es1');
  });

  it('parses trigger string into TriggerKind', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es2',
      type: 'emerging-spikes',
      trigger: 'on-approach',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 3,
        repeats: false,
        distance: 40,
      },
    });
    expect(trap.trigger.kind).toBe('on-approach');
  });

  it('throws on invalid trigger string', () => {
    registerEmergingSpikes();
    expect(() =>
      createTrap({
        id: 'es-bad',
        type: 'emerging-spikes',
        trigger: 'on-garbage',
        params: {
          surface: 'floor',
          col: 2,
          row: 1,
          extendSteps: 3,
          repeats: false,
        },
      }),
    ).toThrow(/invalid trigger/);
  });

  it('throws on invalid surface', () => {
    registerEmergingSpikes();
    expect(() =>
      createTrap({
        id: 'es-badsurf',
        type: 'emerging-spikes',
        trigger: 'on-enter',
        params: {
          surface: 'sideways',
          col: 2,
          row: 1,
          extendSteps: 3,
          repeats: false,
        },
      }),
    ).toThrow(/surface/);
  });
});

// ---------------------------------------------------------------------------
// evaluate() - on-enter trigger
// ---------------------------------------------------------------------------

describe('emerging-spikes: evaluate on-enter', () => {
  it('returns true when player enters the spike tile region', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-enter',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 3,
        repeats: false,
      },
    });

    // Spike at (2,1) = pixels (32, 16)-(48, 32). Player overlapping that area.
    const world = makeWorld({
      playerBody: makeBody(32, 16, false),
    });

    expect(trap.evaluate(world, 0)).toBe(true);
  });

  it('returns false when player is outside the spike tile region', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-away',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 3,
        repeats: false,
      },
    });

    const world = makeWorld({
      playerBody: makeBody(0, 0, false),
    });

    expect(trap.evaluate(world, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate() - on-approach trigger
// ---------------------------------------------------------------------------

describe('emerging-spikes: evaluate on-approach', () => {
  it('returns true when player is within distance', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-appr',
      type: 'emerging-spikes',
      trigger: 'on-approach',
      params: {
        surface: 'floor',
        col: 3,
        row: 1,
        extendSteps: 3,
        repeats: false,
        distance: 50,
      },
    });

    // Spike at (3,1) = pixels (48, 16)-(64, 32). Player at (0, 16) is 48px away (< 50).
    const world = makeWorld({
      playerBody: makeBody(0, 16, false),
    });

    expect(trap.evaluate(world, 0)).toBe(true);
  });

  it('returns false when player is beyond distance', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-far',
      type: 'emerging-spikes',
      trigger: 'on-approach',
      params: {
        surface: 'floor',
        col: 3,
        row: 1,
        extendSteps: 3,
        repeats: false,
        distance: 10,
      },
    });

    const world = makeWorld({
      playerBody: makeBody(0, 0, false),
    });

    expect(trap.evaluate(world, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate() - on-timer trigger
// ---------------------------------------------------------------------------

describe('emerging-spikes: evaluate on-timer', () => {
  it('returns true after delaySteps have elapsed', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-time',
      type: 'emerging-spikes',
      trigger: 'on-timer',
      params: {
        surface: 'floor',
        col: 0,
        row: 1,
        extendSteps: 3,
        repeats: false,
        delaySteps: 2,
      },
    });

    const world = makeWorld();

    expect(trap.evaluate(world, 0)).toBe(false);
    trap.stepsSinceArm++;
    expect(trap.evaluate(world, 1)).toBe(false);
    trap.stepsSinceArm++;
    expect(trap.evaluate(world, 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// apply() - gradual extension
// ---------------------------------------------------------------------------

describe('emerging-spikes: apply', () => {
  it('gradually extends a hazard from the floor surface over extendSteps', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-grow',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 4,
        repeats: false,
      },
    });

    const world = makeWorld();

    // Step 1: spike begins extending. Height should be 4px (16/4).
    trap.apply(world);
    expect(world.hazards).toHaveLength(1);
    expect(world.hazards[0]?.height).toBe(4);

    // Step 2: height grows to 8.
    trap.apply(world);
    expect(world.hazards[0]?.height).toBe(8);

    // Step 3: height 12.
    trap.apply(world);
    expect(world.hazards[0]?.height).toBe(12);

    // Step 4: fully extended at 16.
    trap.apply(world);
    expect(world.hazards[0]?.height).toBe(16);
  });

  it('fully extended spike is at the correct position for floor surface', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-pos',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 1,
        repeats: false,
      },
    });

    const world = makeWorld();
    trap.apply(world);

    // Floor spike: base at bottom of tile (y=32), grows upward.
    // At full extension: x=32, y=16, width=16, height=16.
    expect(world.hazards[0]).toEqual({
      x: 32,
      y: 16,
      width: 16,
      height: 16,
    });
  });

  it('ceiling spike grows downward from the top of the tile', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-ceil',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'ceiling',
        col: 2,
        row: 1,
        extendSteps: 1,
        repeats: false,
      },
    });

    const world = makeWorld();
    trap.apply(world);

    // Ceiling spike: base at top of tile (y=16), grows downward.
    expect(world.hazards[0]).toEqual({
      x: 32,
      y: 16,
      width: 16,
      height: 16,
    });
  });

  it('wall spike grows horizontally from the left', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-wall',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'wall',
        col: 2,
        row: 1,
        extendSteps: 1,
        repeats: false,
      },
    });

    const world = makeWorld();
    trap.apply(world);

    // Wall spike: grows from left edge outward (width increases).
    expect(world.hazards[0]).toEqual({
      x: 32,
      y: 16,
      width: 16,
      height: 16,
    });
  });

  it('retracted spike has no hazard in the world', () => {
    registerEmergingSpikes();
    const world = makeWorld();
    // Before apply: no hazard.
    expect(world.hazards).toHaveLength(0);
  });

  it('with repeats=true retracts and re-arms after full extension', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-repeat',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 2,
        retractSteps: 2,
        repeats: true,
      },
    });

    const world = makeWorld();

    // Extend over 2 steps.
    trap.apply(world);
    expect(world.hazards[0]?.height).toBe(8);
    trap.apply(world);
    expect(world.hazards[0]?.height).toBe(16);

    // Retract over 2 steps.
    trap.apply(world);
    expect(world.hazards[0]?.height).toBe(8);
    trap.apply(world);
    // Fully retracted: hazard removed or zero-height.
    expect(world.hazards.length === 0 || world.hazards[0]?.height === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('emerging-spikes: reset', () => {
  it('restores armed state and resets extension progress', () => {
    registerEmergingSpikes();
    const trap = createTrap({
      id: 'es-reset',
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col: 2,
        row: 1,
        extendSteps: 3,
        repeats: false,
      },
    });

    const world = makeWorld();
    trap.apply(world);
    trap.fired = true;
    trap.stepsSinceArm = 5;

    trap.reset();

    expect(trap.armed).toBe(true);
    expect(trap.fired).toBe(false);
    expect(trap.stepsSinceArm).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('emerging-spikes: determinism', () => {
  it('same inputs produce same outputs', () => {
    registerEmergingSpikes();

    function runOnce(): { hazardHeight: number; hazardCount: number } {
      const trap = createTrap({
        id: 'es-det',
        type: 'emerging-spikes',
        trigger: 'on-enter',
        params: {
          surface: 'floor',
          col: 2,
          row: 1,
          extendSteps: 3,
          repeats: false,
        },
      });
      const world = makeWorld();
      trap.apply(world);
      trap.apply(world);
      return {
        hazardHeight: world.hazards[0]?.height ?? -1,
        hazardCount: world.hazards.length,
      };
    }

    const a = runOnce();
    const b = runOnce();
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Repeating siblings: stable hazard identity across cycles (issue #160)
// ---------------------------------------------------------------------------

describe('emerging-spikes: repeating siblings keep hazard identity', () => {
  function makeRepeating(id: string, col: number): ReturnType<typeof createTrap> {
    return createTrap({
      id,
      type: 'emerging-spikes',
      trigger: 'on-enter',
      params: {
        surface: 'floor',
        col,
        row: 1,
        extendSteps: 2,
        retractSteps: 2,
        repeats: true,
      },
    });
  }

  it('two out-of-phase repeating spikes cycle without stale or duplicate hazards', () => {
    registerEmergingSpikes();
    const world = makeWorld({ cols: 6, rows: 3 });
    const a = makeRepeating('spike-a', 1);
    const b = makeRepeating('spike-b', 3);

    let sawBothExtended = false;
    // b enters the cycle one step after a: interleaved, out of phase.
    a.apply(world);
    for (let s = 0; s < 60; s++) {
      a.apply(world);
      b.apply(world);

      // At every sampled step: at most one rect per spike (no orphan), no
      // zero-height stale rect, and no two rects sharing a column.
      expect(world.hazards.length).toBeLessThanOrEqual(2);
      for (const h of world.hazards) {
        expect(h.height).toBeGreaterThan(0);
      }
      const cols = world.hazards.map((h) => h.x);
      expect(new Set(cols).size).toBe(cols.length);
      if (world.hazards.length === 2) sawBothExtended = true;
    }
    expect(sawBothExtended).toBe(true);
  });

  it('a sibling retracting fully does not orphan the other spike rect', () => {
    registerEmergingSpikes();
    const world = makeWorld({ cols: 6, rows: 3 });
    const a = makeRepeating('spike-a', 1);
    const b = makeRepeating('spike-b', 3);

    // Both fully extended: two live hazards.
    a.apply(world);
    a.apply(world);
    b.apply(world);
    b.apply(world);
    expect(world.hazards.length).toBe(2);

    // Retract a to nothing (this splices a's rect out of the shared array).
    a.apply(world);
    a.apply(world);
    expect(world.hazards.length).toBe(1);

    // Retract b to nothing: identity tracking must find and remove b's own
    // rect even though a's splice shifted every index. Index-based tracking
    // left b's rect behind here.
    b.apply(world);
    b.apply(world);
    expect(world.hazards.length).toBe(0);
  });
});
