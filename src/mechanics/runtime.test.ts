import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Body } from '../engine/physics';
import type { ControllerActions } from '../engine/controller';
import type { JsonValue, LevelData, MechanicEntry } from '../levels/types';
import { clearRegistry, registerMechanicType } from './registry';
import { registerAllMechanicTypes } from './register';
import {
  applyMechanicContacts,
  createMechanicsRuntime,
  resetMechanics,
  stepMechanics,
} from './runtime';
import type { MechanicInstance, MechanicStepResult } from './types';

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

function noActions(): ControllerActions {
  return { left: false, right: false, jumpPressed: false, jumpHeld: false };
}

function makeEntry(
  type: string,
  params: Record<string, unknown>,
  id?: string,
): MechanicEntry {
  return {
    id: id ?? `test-${type}`,
    type,
    params: params as unknown as Readonly<Record<string, JsonValue>>,
  };
}

/** Minimal level skeleton with optional mechanics. */
function makeLevel(mechanics: MechanicEntry[] = []): LevelData {
  return {
    name: 'mech-runtime-test',
    cols: 4,
    rows: 3,
    spawn: { col: 0, row: 0 },
    exit: { col: 3, row: 0 },
    tiles: [
      0, 0, 0, 0,
      0, 0, 0, 0,
      1, 1, 1, 1,
    ],
    traps: [],
    mechanics,
  };
}

beforeEach(() => {
  clearRegistry();
  registerAllMechanicTypes();
});

afterEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// createMechanicsRuntime
// ---------------------------------------------------------------------------

describe('createMechanicsRuntime', () => {
  it('instantiates mechanics from level.mechanics via the registry', () => {
    const level = makeLevel([
      makeEntry('spring', { x: 0, y: 0, impulseY: -400 }),
      makeEntry('teleporter', { x: 32, y: 0, destX: 64, destY: 0 }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    expect(rt.mechanics).toHaveLength(2);
    expect(rt.mechanics[0]?.id).toBe('test-spring');
    expect(rt.mechanics[1]?.id).toBe('test-teleporter');
  });

  it('produces an inert runtime when level has no mechanics field', () => {
    const level: LevelData = {
      name: 'no-mech',
      cols: 4,
      rows: 3,
      spawn: { col: 0, row: 0 },
      exit: { col: 3, row: 0 },
      tiles: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      traps: [],
    };
    const rt = createMechanicsRuntime(level, makeBody());

    expect(rt.mechanics).toHaveLength(0);
    expect(rt.publishedSolids).toHaveLength(0);
    expect(rt.publishedHazards).toHaveLength(0);
  });

  it('starts with empty published buffers', () => {
    const level = makeLevel([
      makeEntry('spring', { x: 0, y: 0, impulseY: -400 }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    expect(rt.publishedSolids).toHaveLength(0);
    expect(rt.publishedHazards).toHaveLength(0);
    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(0);
    expect(rt.cosmeticEffects.fakeUiStates!).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stepMechanics - publishing dynamics
// ---------------------------------------------------------------------------

describe('stepMechanics - publishing', () => {
  it('publishes dynamic solids from moving-platform mechanics', () => {
    const level = makeLevel([
      makeEntry('moving-platform', {
        startX: 0, startY: 100, width: 32, height: 16,
        dx: 1, dy: 0, speed: 16, distance: 48,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.publishedSolids).toHaveLength(1);
    expect(rt.publishedSolids[0]!.width).toBe(32);
    expect(rt.publishedSolids[0]!.solid).toBe(true);
    expect(rt.publishedSolids[0]!.lethal).toBe(false);
  });

  it('publishes hazards from buzzsaw mechanics', () => {
    const level = makeLevel([
      makeEntry('buzzsaw', {
        radius: 8,
        waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        speed: 10,
        pingpong: false,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.publishedHazards).toHaveLength(1);
    expect(rt.publishedHazards[0]!.width).toBe(16);
    expect(rt.publishedHazards[0]!.height).toBe(16);
  });

  it('publishes hazards from rotating-arm mechanics', () => {
    const level = makeLevel([
      makeEntry('rotating-arm', {
        pivotX: 50, pivotY: 50, length: 30, angularSpeed: 0.1, initialAngle: 0,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.publishedHazards).toHaveLength(1);
  });

  it('accumulates hazards from multiple hazard-producing mechanics', () => {
    const level = makeLevel([
      makeEntry('buzzsaw', {
        radius: 8,
        waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        speed: 10,
        pingpong: false,
      }),
      makeEntry('rotating-arm', {
        pivotX: 50, pivotY: 50, length: 30, angularSpeed: 0.1, initialAngle: 0,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.publishedHazards).toHaveLength(2);
  });

  it('publishes cosmetic state from camera-troll mechanics', () => {
    const level = makeLevel([
      makeEntry('camera-troll', { kind: 'zoom', intensity: 0.5 }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(1);
    expect(rt.cosmeticEffects.cameraTrolls![0]!.active).toBe(true);
  });

  it('publishes cosmetic state from fake-ui mechanics', () => {
    const level = makeLevel([
      makeEntry('fake-ui', { kind: 'fake-crash' }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.cosmeticEffects.fakeUiStates!).toHaveLength(1);
    expect(rt.cosmeticEffects.fakeUiStates![0]!.active).toBe(true);
  });

  it('aggregates cosmetics from multiple cosmetic mechanics', () => {
    const level = makeLevel([
      makeEntry('camera-troll', { kind: 'zoom', intensity: 0.5 }),
      makeEntry('camera-troll', { kind: 'flip', intensity: 1 }, 'ct-2'),
      makeEntry('fake-ui', { kind: 'fake-crash' }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(2);
    expect(rt.cosmeticEffects.fakeUiStates!).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stepMechanics - clearing each step
// ---------------------------------------------------------------------------

describe('stepMechanics - per-step clearing', () => {
  it('clears published solids and hazards at the start of each step', () => {
    const level = makeLevel([
      makeEntry('buzzsaw', {
        radius: 8,
        waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        speed: 10,
        pingpong: false,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    // Step 0: one hazard published.
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.publishedHazards).toHaveLength(1);

    // Step 1: previous hazard cleared, new one published.
    stepMechanics(rt, makeBody(0, 0), noActions(), 1);
    expect(rt.publishedHazards).toHaveLength(1);
  });

  it('clears cosmetics at the start of each step', () => {
    const level = makeLevel([
      makeEntry('camera-troll', { kind: 'zoom', intensity: 0.5 }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(1);

    stepMechanics(rt, makeBody(0, 0), noActions(), 1);
    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stepMechanics - inert runtime (no mechanics)
// ---------------------------------------------------------------------------

describe('stepMechanics - inert runtime', () => {
  it('produces no published state when there are no mechanics', () => {
    const level = makeLevel([]);
    const rt = createMechanicsRuntime(level, makeBody());

    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.publishedSolids).toHaveLength(0);
    expect(rt.publishedHazards).toHaveLength(0);
    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(0);
    expect(rt.cosmeticEffects.fakeUiStates!).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('same inputs and step produce the same published state', () => {
    const level = makeLevel([
      makeEntry('buzzsaw', {
        radius: 8,
        waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        speed: 10,
        pingpong: false,
      }),
      makeEntry('moving-platform', {
        startX: 0, startY: 100, width: 32, height: 16,
        dx: 1, dy: 0, speed: 16, distance: 48,
      }),
    ]);

    function run(): {
      solids: number;
      hazards: number;
      solidX: number;
      hazardX: number;
    } {
      const rt = createMechanicsRuntime(level, makeBody());
      stepMechanics(rt, makeBody(0, 0), noActions(), 0);
      stepMechanics(rt, makeBody(0, 0), noActions(), 1);
      return {
        solids: rt.publishedSolids.length,
        hazards: rt.publishedHazards.length,
        solidX: rt.publishedSolids[0]?.x ?? -1,
        hazardX: rt.publishedHazards[0]?.x ?? -1,
      };
    }

    const a = run();
    const b = run();
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// resetMechanics
// ---------------------------------------------------------------------------

describe('resetMechanics', () => {
  it('resets all mechanics to initial state', () => {
    const level = makeLevel([
      makeEntry('moving-platform', {
        startX: 0, startY: 100, width: 32, height: 16,
        dx: 1, dy: 0, speed: 16, distance: 48,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    // Step a few times to move the platform away from start.
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    stepMechanics(rt, makeBody(0, 0), noActions(), 1);
    stepMechanics(rt, makeBody(0, 0), noActions(), 2);
    expect(rt.publishedSolids[0]!.x).toBeGreaterThan(0);

    // Reset: platform should be back at startX.
    resetMechanics(rt, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.publishedSolids[0]!.x).toBe(0);
  });

  it('clears published buffers on reset', () => {
    const level = makeLevel([
      makeEntry('buzzsaw', {
        radius: 8,
        waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        speed: 10,
        pingpong: false,
      }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.publishedHazards).toHaveLength(1);

    resetMechanics(rt, makeBody());
    expect(rt.publishedHazards).toHaveLength(0);
    expect(rt.publishedSolids).toHaveLength(0);
    expect(rt.cosmeticEffects.cameraTrolls!).toHaveLength(0);
    expect(rt.cosmeticEffects.fakeUiStates!).toHaveLength(0);
  });

  it('allows stepping normally after reset', () => {
    const level = makeLevel([
      makeEntry('spring', { x: 0, y: 0, impulseY: -400 }),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    resetMechanics(rt, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    // Should not throw and runtime is usable.
    expect(rt.mechanics).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stepMechanics - merged overrides
// ---------------------------------------------------------------------------

/**
 * Test-only mechanic that emits configurable overrides straight from its
 * params, so the merge semantics can be pinned without reaching through a
 * real adapter. `bodyX` sets a body override, `vy` an additive velocity mod,
 * and `left` an actions override.
 */
function createStubMechanic(entry: MechanicEntry): MechanicInstance {
  return {
    id: entry.id,
    type: entry.type,
    step(): MechanicStepResult {
      const p = entry.params;
      return {
        ...(typeof p['bodyX'] === 'number' ? { bodyOverride: makeBody(p['bodyX'], 0) } : {}),
        ...(typeof p['vy'] === 'number' ? { velocityMod: { y: p['vy'] } } : {}),
        ...(typeof p['left'] === 'boolean'
          ? {
              actionsOverride: {
                left: p['left'],
                right: false,
                jumpPressed: false,
                jumpHeld: false,
              },
            }
          : {}),
      };
    },
    reset() {},
  };
}

describe('stepMechanics - merged overrides', () => {
  beforeEach(() => {
    registerMechanicType('stub', createStubMechanic);
  });

  it('starts with a zeroed additive velocity mod and no overrides', () => {
    const rt = createMechanicsRuntime(makeLevel([]), makeBody());
    expect(rt.publishedOverrides.velocityMod).toEqual({ x: 0, y: 0 });
    expect(rt.publishedOverrides.bodyOverride).toBeUndefined();
    expect(rt.publishedOverrides.actionsOverride).toBeUndefined();
  });

  it('accumulates velocityMod additively across mechanics', () => {
    const level = makeLevel([
      makeEntry('stub', { vy: -100 }, 'a'),
      makeEntry('stub', { vy: -50 }, 'b'),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.publishedOverrides.velocityMod.y).toBe(-150);
  });

  it('resolves body and actions overrides last-writer-wins', () => {
    const level = makeLevel([
      makeEntry('stub', { bodyX: 10, left: true }, 'a'),
      makeEntry('stub', { bodyX: 40, left: false }, 'b'),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    expect(rt.publishedOverrides.bodyOverride?.x).toBe(40);
    expect(rt.publishedOverrides.actionsOverride?.left).toBe(false);
  });

  it('clears overrides at the start of each step', () => {
    const level = makeLevel([makeEntry('stub', { vy: -100, bodyX: 5 }, 'a')]);
    const rt = createMechanicsRuntime(level, makeBody());

    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.publishedOverrides.velocityMod.y).toBe(-100);

    // Same level, but a stub that emits nothing this step: buffers cleared.
    const quiet = makeLevel([makeEntry('stub', {}, 'a')]);
    const rt2 = createMechanicsRuntime(quiet, makeBody());
    stepMechanics(rt2, makeBody(0, 0), noActions(), 0);
    stepMechanics(rt2, makeBody(0, 0), noActions(), 1);
    expect(rt2.publishedOverrides.velocityMod).toEqual({ x: 0, y: 0 });
    expect(rt2.publishedOverrides.bodyOverride).toBeUndefined();
  });

  it('clears published overrides on reset', () => {
    const level = makeLevel([makeEntry('stub', { vy: -100 }, 'a')]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    expect(rt.publishedOverrides.velocityMod.y).toBe(-100);

    resetMechanics(rt, makeBody());
    expect(rt.publishedOverrides.velocityMod).toEqual({ x: 0, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// applyMechanicContacts - runtime-owned contact pass
// ---------------------------------------------------------------------------

describe('applyMechanicContacts', () => {
  it('applies a spring declared before a teleporter, then the teleport halts', () => {
    const level = makeLevel([
      makeEntry('spring', { x: 0, y: 0, impulseY: -400 }, 'sp'),
      makeEntry(
        'teleporter',
        { x: 0, y: 0, destX: 100, destY: 0, preserveMomentum: true },
        'tp',
      ),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    const body = applyMechanicContacts(rt, makeBody(0, 0));
    // Spring fired first (velocity preserved through the teleport), then the
    // teleporter relocated the body and stopped the pass.
    expect(body.x).toBe(100);
    expect(body.velocity.y).toBe(-400);
  });

  it('skips a further teleporter but still fires a spring after the first relocation', () => {
    const level = makeLevel([
      makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 0 }, 'tp-a'),
      makeEntry('teleporter', { x: 100, y: 0, destX: 200, destY: 0 }, 'tp-b'),
      makeEntry('spring', { x: 100, y: 0, impulseY: -400 }, 'sp'),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    const body = applyMechanicContacts(rt, makeBody(0, 0));
    // tp-a relocates the body to (100, 0). tp-b shares the 'relocation'
    // category, so the halt skips it (no chaining). The spring is a different
    // category and still fires on the relocated body.
    expect(body.x).toBe(100);
    expect(body.velocity.y).toBe(-400);
  });

  it('cools a paired twin so the arrival tile cannot bounce the player back', () => {
    const level = makeLevel([
      makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 0 }, 'tp-a'),
      makeEntry('teleporter', { x: 100, y: 0, destX: 0, destY: 0 }, 'tp-b'),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());

    // Frame 1: contact at tp-a relocates the body onto tp-b and cools both.
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);
    const arrived = applyMechanicContacts(rt, makeBody(0, 0));
    expect(arrived.x).toBe(100);

    // Next frame: the body sits on tp-b but the twin cooldown blocks a
    // straight bounce back to the origin.
    stepMechanics(rt, makeBody(100, 0), noActions(), 1);
    const stayed = applyMechanicContacts(rt, makeBody(100, 0));
    expect(stayed.x).toBe(100);
  });

  it('leaves the body untouched when no mechanic has a contact hook', () => {
    const level = makeLevel([
      makeEntry('jetpack', { maxFuel: 10, thrustPower: 100 }, 'jp'),
    ]);
    const rt = createMechanicsRuntime(level, makeBody());
    stepMechanics(rt, makeBody(0, 0), noActions(), 0);

    const body = makeBody(5, 7);
    expect(applyMechanicContacts(rt, body)).toBe(body);
  });
});
