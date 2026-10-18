import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Body } from '../../engine/physics';
import { Tile } from '../../engine/physics';
import type { WorldState } from '../types';
import { clearRegistry, createTrap } from '../registry';
import { registerVanishingFloor } from './vanishing-floor';

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

describe('vanishing-floor: registration', () => {
  it('registers under type "vanishing-floor"', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf1',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 0,
        returns: false,
      },
    });
    expect(trap.type).toBe('vanishing-floor');
    expect(trap.id).toBe('vf1');
  });

  it('parses trigger string into TriggerKind', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf2',
      type: 'vanishing-floor',
      trigger: 'on-approach',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 0,
        returns: false,
        distance: 50,
      },
    });
    expect(trap.trigger.kind).toBe('on-approach');
  });

  it('throws on invalid trigger string', () => {
    registerVanishingFloor();
    expect(() =>
      createTrap({
        id: 'vf-bad',
        type: 'vanishing-floor',
        trigger: 'on-invalid',
        params: {
          tiles: [{ col: 0, row: 2 }],
          delaySteps: 0,
          returns: false,
        },
      }),
    ).toThrow(/invalid trigger/);
  });
});

// ---------------------------------------------------------------------------
// evaluate() - on-land trigger
// ---------------------------------------------------------------------------

describe('vanishing-floor: evaluate on-land', () => {
  it('returns true when player transitions to grounded within the tile region', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-land',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 2, row: 2 }],
        delaySteps: 0,
        returns: false,
      },
    });

    // Player landing on tile (2,2) which is at pixels (32, 32)-(48, 48).
    // Player body bottom at y=48 means y=32 (16px tall). Grounded=true, prev=false.
    const world = makeWorld({
      playerBody: makeBody(32, 32, true),
      playerPrevGrounded: false,
    });

    expect(trap.evaluate(world, 0)).toBe(true);
  });

  it('returns false when player is grounded but was already grounded', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-already',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 2, row: 2 }],
        delaySteps: 0,
        returns: false,
      },
    });

    const world = makeWorld({
      playerBody: makeBody(32, 32, true),
      playerPrevGrounded: true,
    });

    expect(trap.evaluate(world, 0)).toBe(false);
  });

  it('returns false when player lands outside the tile region', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-miss',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 2, row: 2 }],
        delaySteps: 0,
        returns: false,
      },
    });

    const world = makeWorld({
      playerBody: makeBody(0, 0, true),
      playerPrevGrounded: false,
    });

    expect(trap.evaluate(world, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluate() - on-approach trigger
// ---------------------------------------------------------------------------

describe('vanishing-floor: evaluate on-approach', () => {
  it('returns true when player is within distance of the tile region', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-appr',
      type: 'vanishing-floor',
      trigger: 'on-approach',
      params: {
        tiles: [{ col: 3, row: 2 }],
        delaySteps: 0,
        returns: false,
        distance: 50,
      },
    });

    // Tile at (3,2) = pixels (48, 32)-(64, 48). Player at (0, 32) is 48px away (< 50).
    const world = makeWorld({
      playerBody: makeBody(0, 32, false),
    });

    expect(trap.evaluate(world, 0)).toBe(true);
  });

  it('returns false when player is farther than distance', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-far',
      type: 'vanishing-floor',
      trigger: 'on-approach',
      params: {
        tiles: [{ col: 3, row: 2 }],
        delaySteps: 0,
        returns: false,
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

describe('vanishing-floor: evaluate on-timer', () => {
  it('returns true after delaySteps have elapsed', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-time',
      type: 'vanishing-floor',
      trigger: 'on-timer',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 3,
        returns: false,
      },
    });

    const world = makeWorld();

    // Steps 0, 1, 2: not yet.
    expect(trap.evaluate(world, 0)).toBe(false);
    trap.stepsSinceArm++;
    expect(trap.evaluate(world, 1)).toBe(false);
    trap.stepsSinceArm++;
    expect(trap.evaluate(world, 2)).toBe(false);
    trap.stepsSinceArm++;

    // Step 3: should fire (stepsSinceArm >= delaySteps).
    expect(trap.evaluate(world, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// apply() - vanishing tiles
// ---------------------------------------------------------------------------

describe('vanishing-floor: apply', () => {
  it('sets specified tiles to Empty (0)', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-vanish',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [
          { col: 1, row: 2 },
          { col: 2, row: 2 },
        ],
        delaySteps: 0,
        returns: false,
      },
    });

    const cols = 4;
    const rows = 3;
    const tiles = new Array(cols * rows).fill(Tile.Solid);
    const world = makeWorld({ cols, rows, tiles });

    trap.apply(world);

    // Tiles at (1,2) and (2,2) should be Empty.
    expect(tiles[2 * cols + 1]).toBe(Tile.Empty);
    expect(tiles[2 * cols + 2]).toBe(Tile.Empty);
    // Others remain Solid.
    expect(tiles[0]).toBe(Tile.Solid);
  });

  it('with returns=true schedules restoration after returnDelaySteps', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-return',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 0,
        returns: true,
        returnDelaySteps: 5,
      },
    });

    const cols = 4;
    const rows = 3;
    const tiles = new Array(cols * rows).fill(Tile.Solid);
    const world = makeWorld({ cols, rows, tiles });

    // Apply once: tiles vanish.
    trap.apply(world);
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);

    // Simulate stepping forward: call apply repeatedly to advance internal counter.
    for (let s = 0; s < 4; s++) {
      trap.apply(world);
    }
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);

    // After returnDelaySteps total applications, tiles restored.
    trap.apply(world); // 5th application after initial
    expect(tiles[2 * cols + 0]).toBe(Tile.Solid);
  });

  it('without returns leaves tiles permanently vanished', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-perm',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 0,
        returns: false,
      },
    });

    const cols = 4;
    const rows = 3;
    const tiles = new Array(cols * rows).fill(Tile.Solid);
    const world = makeWorld({ cols, rows, tiles });

    trap.apply(world);
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);

    // Multiple applies: stays empty.
    trap.apply(world);
    trap.apply(world);
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('vanishing-floor: reset', () => {
  it('restores armed state and allows re-triggering', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-reset',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 0,
        returns: false,
      },
    });

    trap.fired = true;
    trap.stepsSinceArm = 10;

    trap.reset();

    expect(trap.armed).toBe(true);
    expect(trap.fired).toBe(false);
    expect(trap.stepsSinceArm).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('vanishing-floor: determinism', () => {
  it('same inputs produce same outputs', () => {
    registerVanishingFloor();

    function runOnce(): { fired: boolean; tileVal: number } {
      const trap = createTrap({
        id: 'vf-det',
        type: 'vanishing-floor',
        trigger: 'on-land',
        params: {
          tiles: [{ col: 0, row: 2 }],
          delaySteps: 0,
          returns: false,
        },
      });
      const cols = 4;
      const rows = 3;
      const tiles = new Array(cols * rows).fill(Tile.Solid);
      const world = makeWorld({ cols, rows, tiles });

      const evalResult = trap.evaluate(world, 0);
      if (evalResult) {
        trap.apply(world);
      }
      return { fired: trap.fired, tileVal: tiles[2 * cols + 0] };
    }

    const a = runOnce();
    const b = runOnce();
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: exact timing, original-tile restore, single return, player safety
// (issue #160)
// ---------------------------------------------------------------------------

describe('vanishing-floor: lifecycle (issue #160)', () => {
  /** Mirrors the runtime's per-step contract: fire once, then animate. */
  function drive(trap: ReturnType<typeof createTrap>, world: WorldState, steps: number): void {
    for (let step = 0; step < steps; step++) {
      if (!trap.fired) {
        if (trap.evaluate(world, step)) {
          trap.fired = true;
          trap.apply(world);
        }
      } else {
        trap.apply(world);
      }
      trap.stepsSinceArm++;
    }
  }

  it('an on-timer floor vanishes at exactly delaySteps, not twice the delay', () => {
    registerVanishingFloor();
    const trap = createTrap({
      id: 'vf-timer-exact',
      type: 'vanishing-floor',
      trigger: 'on-timer',
      params: { tiles: [{ col: 0, row: 2 }], delaySteps: 5, returns: false },
    });

    const cols = 4;
    const tiles = new Array(cols * 3).fill(Tile.Solid);
    const world = makeWorld({ tiles });

    // Steps 0 through 4: still there.
    drive(trap, world, 5);
    expect(tiles[2 * cols + 0]).toBe(Tile.Solid);

    // Step 5: the authored delay has elapsed, the floor is gone.
    drive(trap, world, 1);
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);
  });

  it('restore replays the recorded originals instead of forcing Solid', () => {
    registerVanishingFloor();
    const cols = 4;
    const tiles = new Array(cols * 3).fill(Tile.Solid);
    tiles[2 * cols + 1] = Tile.OneWay; // (1,2) authored as a one-way ledge
    tiles[2 * cols + 2] = Tile.Empty;  // (2,2) authored as a pit

    const trap = createTrap({
      id: 'vf-originals',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [
          { col: 0, row: 2 },
          { col: 1, row: 2 },
          { col: 2, row: 2 },
        ],
        delaySteps: 0,
        returns: true,
        returnDelaySteps: 0,
      },
    });

    const world = makeWorld({ cols, tiles });

    trap.apply(world);
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);
    expect(tiles[2 * cols + 1]).toBe(Tile.Empty);
    expect(tiles[2 * cols + 2]).toBe(Tile.Empty);

    trap.apply(world); // returnDelaySteps 0: restored on the next apply
    expect(tiles[2 * cols + 0]).toBe(Tile.Solid);
    expect(tiles[2 * cols + 1]).toBe(Tile.OneWay);
    expect(tiles[2 * cols + 2]).toBe(Tile.Empty);
  });

  it('a returning floor restores at most once and then no-ops', () => {
    registerVanishingFloor();
    const cols = 4;
    const tiles = new Array(cols * 3).fill(Tile.Solid);
    const trap = createTrap({
      id: 'vf-once',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [{ col: 0, row: 2 }],
        delaySteps: 0,
        returns: true,
        returnDelaySteps: 2,
      },
    });

    const world = makeWorld({ cols, tiles });

    trap.apply(world); // vanish
    trap.apply(world); // wait 1
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);
    trap.apply(world); // wait 2 -> restore
    expect(tiles[2 * cols + 0]).toBe(Tile.Solid);

    // The runtime's animation pass keeps calling apply() forever; the floor
    // must never vanish a second time.
    for (let i = 0; i < 50; i++) {
      trap.apply(world);
      expect(tiles[2 * cols + 0]).toBe(Tile.Solid);
    }
  });

  it('never restores a tile into the player: a parked body defers the return', () => {
    registerVanishingFloor();
    const cols = 4;
    const tiles = new Array(cols * 3).fill(Tile.Solid);
    const trap = createTrap({
      id: 'vf-parked',
      type: 'vanishing-floor',
      trigger: 'on-land',
      params: {
        tiles: [
          { col: 0, row: 2 },
          { col: 1, row: 2 },
        ],
        delaySteps: 0,
        returns: true,
        returnDelaySteps: 0,
      },
    });

    // Body parked over tile (0,2): rect (0,32)-(16,48).
    const world = makeWorld({ cols, tiles, playerBody: makeBody(0, 32, false) });

    trap.apply(world); // vanish both
    trap.apply(world); // return attempt

    // The occupied tile stays vanished; the clear one comes back.
    expect(tiles[2 * cols + 0]).toBe(Tile.Empty);
    expect(tiles[2 * cols + 1]).toBe(Tile.Solid);

    // Once the player walks clear, the deferred tile returns.
    world.playerBody = makeBody(200, 0, false);
    trap.apply(world);
    expect(tiles[2 * cols + 0]).toBe(Tile.Solid);
  });
});
