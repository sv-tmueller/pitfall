import { describe, expect, it } from 'vitest';
import { TILE_SIZE, type Body, type TileGrid } from './physics';
import {
  COYOTE_STEPS,
  JUMP_VEL,
  createControllerState,
  stepController,
  type ControllerActions,
  type ControllerState,
} from './controller';
import { parseGrid } from './testGrid';

const DT = 1 / 60;

function makeBody(overrides: Partial<Body> = {}): Body {
  return {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    velocity: { x: 0, y: 0 },
    grounded: false,
    ...overrides,
  };
}

function actions(overrides: Partial<ControllerActions> = {}): ControllerActions {
  return { left: false, right: false, jumpPressed: false, jumpHeld: false, ...overrides };
}

// Walks a grounded body right off a ledge and returns the state from the
// first step whose resolve left it airborne (T+1, where T is the last
// grounded step), so coyote-time tests observe a real transition instead of
// a hand-set coyoteSteps.
function walkOffLedge(grid: TileGrid): ControllerState {
  const walkRight = actions({ right: true });
  let state = createControllerState(makeBody({ x: 0, y: 0, grounded: true }));

  for (let i = 0; i < 100; i++) {
    const wasGrounded = state.body.grounded;
    state = stepController(state, walkRight, grid, DT);
    if (wasGrounded && !state.body.grounded) {
      return state;
    }
  }

  throw new Error('body never walked off the ledge');
}

// Counts the steps a free-falling body takes to land, so buffer tests can
// press a real number of steps before a real landing instead of a hand-set
// jumpBufferSteps.
function stepsUntilGrounded(grid: TileGrid): number {
  let state = createControllerState(makeBody({ x: 0, y: 0 }));
  const noJump = actions();
  let steps = 0;

  while (!state.body.grounded) {
    state = stepController(state, noJump, grid, DT);
    steps++;
  }

  return steps;
}

describe('createControllerState', () => {
  it('seeds coyoteSteps from a grounded body so it can jump on its first step', () => {
    expect(createControllerState(makeBody({ grounded: true })).coyoteSteps).toBe(COYOTE_STEPS);
    expect(createControllerState(makeBody({ grounded: false })).coyoteSteps).toBe(0);
  });
});

describe('stepController - horizontal run', () => {
  it('reaches 40, 80, and 120 px/s of run-up at steps 3, 6, and 10', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody());
    const act = actions({ right: true });
    const observed: Record<number, number> = {};

    for (let step = 1; step <= 10; step++) {
      state = stepController(state, act, grid, DT);
      if (step === 3 || step === 6 || step === 10) {
        observed[step] = state.body.velocity.x;
      }
    }

    expect(observed[3]).toBe(40);
    expect(observed[6]).toBe(80);
    expect(observed[10]).toBe(120);
  });

  it('applies friction from 120 down through 100, 80, 60, 40, 20, 0 and holds', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody({ velocity: { x: 120, y: 0 } }));
    const act = actions();
    const expected = [100, 80, 60, 40, 20, 0];

    for (const value of expected) {
      state = stepController(state, act, grid, DT);
      expect(state.body.velocity.x).toBe(value);
    }

    state = stepController(state, act, grid, DT);
    expect(state.body.velocity.x).toBe(0);
  });

  it('cancels left and right held together, applying friction as if neither were held', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody({ velocity: { x: 120, y: 0 } }));

    state = stepController(state, actions({ left: true, right: true }), grid, DT);

    expect(state.body.velocity.x).toBe(100);
  });
});

describe('stepController - gravity and terminal velocity', () => {
  it('clamps free fall to terminal velocity at step 27 and holds', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody());
    const act = actions();

    for (let step = 1; step <= 26; step++) {
      state = stepController(state, act, grid, DT);
    }
    expect(state.body.velocity.y).toBe(390);

    state = stepController(state, act, grid, DT);
    expect(state.body.velocity.y).toBe(400);

    for (let step = 28; step <= 100; step++) {
      state = stepController(state, act, grid, DT);
    }
    expect(state.body.velocity.y).toBe(400);
  });
});

describe('stepController - grounding and coyote time', () => {
  it('sets grounded on landing and refills coyote steps', () => {
    const grid = parseGrid(['...', '...', '###']);
    let state = createControllerState(makeBody({ x: 0, y: 0 }));
    const act = actions();

    for (let i = 0; i < 20 && !state.body.grounded; i++) {
      state = stepController(state, act, grid, DT);
    }

    expect(state.body.grounded).toBe(true);
    expect(state.body.velocity.y).toBe(0);
    expect(state.coyoteSteps).toBe(COYOTE_STEPS);
  });

  it('fires a coyote jump on step T+6, where T is the last step that ended grounded', () => {
    const grid = parseGrid(['...', '###']);
    const walkRight = actions({ right: true });

    let state = walkOffLedge(grid);
    for (let i = 0; i < 4; i++) {
      state = stepController(state, walkRight, grid, DT);
    }

    const result = stepController(
      state,
      actions({ right: true, jumpPressed: true, jumpHeld: true }),
      grid,
      DT,
    );

    expect(result.body.velocity.y).toBe(JUMP_VEL);
  });

  it('refuses a coyote jump on step T+7, where T is the last step that ended grounded', () => {
    const grid = parseGrid(['...', '###']);
    const walkRight = actions({ right: true });

    let state = walkOffLedge(grid);
    for (let i = 0; i < 5; i++) {
      state = stepController(state, walkRight, grid, DT);
    }

    const result = stepController(
      state,
      actions({ right: true, jumpPressed: true, jumpHeld: true }),
      grid,
      DT,
    );

    // Seventh airborne step, 7 x 15 px/s of gravity; a fired jump would read -260.
    expect(result.body.velocity.y).toBe(105);
  });

  it('does not allow a second coyote jump to fire right after the first', () => {
    const grid = parseGrid(['.']);
    let state: ControllerState = {
      body: makeBody({ grounded: false }),
      coyoteSteps: COYOTE_STEPS,
      jumpBufferSteps: -1,
      jumpCutArmed: false,
    };

    state = stepController(state, actions({ jumpPressed: true, jumpHeld: true }), grid, DT);
    expect(state.body.velocity.y).toBe(JUMP_VEL);

    state = stepController(state, actions({ jumpPressed: true, jumpHeld: true }), grid, DT);
    // One step of gravity on the first impulse, not a re-fired impulse.
    expect(state.body.velocity.y).toBe(JUMP_VEL + 15);
  });
});

// Leads in these tests are measured to the landing step L, the first step
// whose resolve sets grounded. The buffered jump can never fire on L itself:
// coyote steps are written in phase 8 from L's own resolve, so the earliest
// firing step is L+1. A press with lead 6 (step L-6) reaches the firing step
// L+1 exactly JUMP_BUFFER_STEPS decrements later and fires; lead 7 is one
// decrement past and refuses. Measured to the firing step instead, this is
// the sub-plan's window [P, P+7]: lead 6 fires at P+7, the last step of the
// window, and lead 7 would need P+8.
describe('stepController - jump buffering', () => {
  it('fires a jump buffered 6 real steps before an actual landing', () => {
    const grid = parseGrid(['...', '...', '###']);
    const noJump = actions();
    const landingStep = stepsUntilGrounded(grid);

    let state = createControllerState(makeBody({ x: 0, y: 0 }));
    for (let step = 1; step <= landingStep; step++) {
      const act =
        step === landingStep - 6 ? actions({ jumpPressed: true, jumpHeld: true }) : noJump;
      state = stepController(state, act, grid, DT);
    }
    expect(state.body.grounded).toBe(true);
    expect(state.body.velocity.y).toBe(0);

    state = stepController(state, actions({ jumpHeld: true }), grid, DT);
    expect(state.body.velocity.y).toBe(JUMP_VEL);
  });

  it('refuses a jump buffered 7 real steps before an actual landing', () => {
    const grid = parseGrid(['...', '...', '###']);
    const noJump = actions();
    const landingStep = stepsUntilGrounded(grid);
    expect(landingStep).toBeGreaterThan(7);

    let state = createControllerState(makeBody({ x: 0, y: 0 }));
    for (let step = 1; step <= landingStep; step++) {
      const act =
        step === landingStep - 7 ? actions({ jumpPressed: true, jumpHeld: true }) : noJump;
      state = stepController(state, act, grid, DT);
    }
    expect(state.body.grounded).toBe(true);
    expect(state.body.velocity.y).toBe(0);

    state = stepController(state, actions({ jumpHeld: true }), grid, DT);
    // The resolve re-grounds the resting body and zeroes the post-gravity vy.
    expect(state.body.velocity.y).toBe(0);
  });

  it('fires a jump buffered a few steps before an actual landing, on the frame after landing', () => {
    const grid = parseGrid(['...', '...', '###']);
    const noJump = actions();

    const landingStep = stepsUntilGrounded(grid);
    expect(landingStep).toBeGreaterThan(3);

    let state = createControllerState(makeBody({ x: 0, y: 0 }));
    for (let step = 1; step <= landingStep; step++) {
      const act =
        step === landingStep - 3 ? actions({ jumpPressed: true, jumpHeld: true }) : noJump;
      state = stepController(state, act, grid, DT);
    }
    expect(state.body.grounded).toBe(true);
    expect(state.body.velocity.y).toBe(0);

    state = stepController(state, actions({ jumpHeld: true }), grid, DT);
    expect(state.body.velocity.y).toBe(JUMP_VEL);
  });
});

describe('stepController - variable jump height', () => {
  it('halves upward velocity exactly once on release', () => {
    const grid = parseGrid(['.']);
    let state: ControllerState = {
      body: makeBody({ grounded: false, velocity: { x: 0, y: JUMP_VEL } }),
      coyoteSteps: 0,
      jumpBufferSteps: -1,
      jumpCutArmed: true,
    };

    state = stepController(state, actions(), grid, DT);
    expect(state.body.velocity.y).toBe(-122.5);

    state = stepController(state, actions(), grid, DT);
    expect(state.body.velocity.y).toBe(-107.5);
  });

  it('does nothing when jump is released while already falling', () => {
    const grid = parseGrid(['.']);
    const state: ControllerState = {
      body: makeBody({ grounded: false, velocity: { x: 0, y: 50 } }),
      coyoteSteps: 0,
      jumpBufferSteps: -1,
      jumpCutArmed: false,
    };

    const result = stepController(state, actions(), grid, DT);

    expect(result.body.velocity.y).toBe(65);
  });

  it('reaches a full jump apex of 39.75 px when held, well past the 2.3 tile estimate', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody({ x: 0, y: 1000, grounded: true }));
    const startY = state.body.y;

    state = stepController(state, actions({ jumpPressed: true, jumpHeld: true }), grid, DT);
    expect(state.body.velocity.y).toBe(JUMP_VEL);

    for (let step = 0; step < 17; step++) {
      state = stepController(state, actions({ jumpHeld: true }), grid, DT);
    }

    const apex = startY - state.body.y;
    expect(apex).toBeCloseTo(39.75, 9);
    expect(apex / TILE_SIZE).toBeGreaterThan(2.3);
    expect(apex / TILE_SIZE).toBeLessThan(2.6);
  });

  it('reaches a tap-jump apex of about 13.708 px when released on the following step', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody({ x: 0, y: 1000, grounded: true }));
    const startY = state.body.y;

    state = stepController(state, actions({ jumpPressed: true, jumpHeld: true }), grid, DT);
    expect(state.body.velocity.y).toBe(JUMP_VEL);

    state = stepController(state, actions({ jumpHeld: false }), grid, DT);
    expect(state.body.velocity.y).toBe(-122.5);

    // Apex lands 9 steps after the jump step (0-indexed: jump = step 0), i.e.
    // 8 more calls after the release call above.
    for (let step = 0; step < 8; step++) {
      state = stepController(state, actions({ jumpHeld: false }), grid, DT);
    }

    const apex = startY - state.body.y;
    expect(apex).toBeCloseTo(329 / 24, 9);
  });

  it('does not allow a second jump to fire mid-ascent even when buffered', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody({ x: 0, y: 1000, grounded: true }));

    state = stepController(state, actions({ jumpPressed: true, jumpHeld: true }), grid, DT);
    expect(state.body.velocity.y).toBe(JUMP_VEL);

    state = stepController(state, actions({ jumpPressed: true, jumpHeld: true }), grid, DT);
    // Same derivation as above: one step of gravity on the first impulse, not a re-fired impulse.
    expect(state.body.velocity.y).toBe(JUMP_VEL + 15);
  });

  it('threads dynamic solids through to the move solver', () => {
    // A floor row wide enough to keep the body within the solid's vertical
    // span for the whole run; a bare 1-column floor lets the body fall off the
    // edge and coast past the solid once it drops below the solid's bottom.
    const grid = parseGrid(['...', '...', '###']);
    // A solid column two tiles to the right of the spawn blocks the run.
    const solid = { x: 32, y: 0, width: 16, height: 48 };
    let state = createControllerState(makeBody({ x: 0, y: 0, grounded: true }));

    for (let i = 0; i < 60; i++) {
      state = stepController(state, actions({ right: true }), grid, DT, [solid]);
    }

    expect(state.body.x + state.body.width).toBeLessThanOrEqual(solid.x);
  });
});

// ---------------------------------------------------------------------------
// Inverted gravity (gravityDir = -1)
// ---------------------------------------------------------------------------
//
// The controller owns the gravity sign, so every vertical behaviour is the
// exact mirror of the normal-gravity path: gravity pulls toward -y, the
// surface the body stands on is ABOVE it, the takeoff impulse points toward
// +y, and the release cut halves an ascent travelling against the pull. These
// tests pin that symmetry directly, rather than inferring it from the
// integration play-throughs.

const INVERTED = -1 as const;

// Mirror of walkOffLedge: a body resting under a ceiling walks right past the
// ceiling's edge and returns the state from the first step whose resolve left
// it airborne (falling toward -y, the inverted "down").
function walkOffCeiling(grid: TileGrid): ControllerState {
  const walkRight = actions({ right: true });
  let state = createControllerState(makeBody({ x: 0, y: 16, grounded: true }));

  for (let i = 0; i < 100; i++) {
    const wasGrounded = state.body.grounded;
    state = stepController(state, walkRight, grid, DT, [], INVERTED);
    if (wasGrounded && !state.body.grounded) {
      return state;
    }
  }

  throw new Error('body never walked off the ceiling');
}

// Mirror of stepsUntilGrounded: a body released under a ceiling falls toward
// -y and lands on the ceiling above; returns the landing step count.
function stepsUntilGroundedInverted(grid: TileGrid): number {
  let state = createControllerState(makeBody({ x: 0, y: 32 }));
  const noJump = actions();
  let steps = 0;

  while (!state.body.grounded) {
    state = stepController(state, noJump, grid, DT, [], INVERTED);
    steps++;
  }

  return steps;
}

describe('stepController - inverted gravity', () => {
  it('signs the takeoff impulse against gravity, flipping JUMP_VEL to +y', () => {
    // A body resting on the underside of a ceiling: the inverted ground is
    // above it, so a jump travels toward +y. JUMP_VEL (-260 against normal
    // gravity) therefore reads +260.
    const grid = parseGrid(['###', '...', '...']);
    const state = createControllerState(makeBody({ x: 16, y: 16, grounded: true }));

    const result = stepController(
      state,
      actions({ jumpPressed: true, jumpHeld: true }),
      grid,
      DT,
      [],
      INVERTED,
    );

    expect(result.body.velocity.y).toBe(260);
    expect(result.body.velocity.y).toBe(-JUMP_VEL);
  });

  it('lands on the ceiling above and sets grounded, refilling coyote steps', () => {
    const grid = parseGrid(['###', '...', '...', '...']);
    let state = createControllerState(makeBody({ x: 0, y: 32 }));
    const act = actions();

    for (let i = 0; i < 30 && !state.body.grounded; i++) {
      state = stepController(state, act, grid, DT, [], INVERTED);
    }

    expect(state.body.grounded).toBe(true);
    expect(state.body.y).toBe(16);
    expect(state.body.velocity.y).toBe(0);
    expect(state.coyoteSteps).toBe(COYOTE_STEPS);
  });

  it('clamps inverted free fall to -TERMINAL_VEL, the mirror of the normal clamp', () => {
    const grid = parseGrid(['.']);
    let state = createControllerState(makeBody());
    const act = actions();

    for (let step = 1; step <= 26; step++) {
      state = stepController(state, act, grid, DT, [], INVERTED);
    }
    expect(state.body.velocity.y).toBe(-390);

    state = stepController(state, act, grid, DT, [], INVERTED);
    expect(state.body.velocity.y).toBe(-400);

    for (let step = 28; step <= 60; step++) {
      state = stepController(state, act, grid, DT, [], INVERTED);
    }
    expect(state.body.velocity.y).toBe(-400);
  });

  it('fires an inverted coyote jump on step T+6 after leaving the ceiling', () => {
    const grid = parseGrid(['##.', '...', '...']);
    const walkRight = actions({ right: true });

    let state = walkOffCeiling(grid);
    for (let i = 0; i < 4; i++) {
      state = stepController(state, walkRight, grid, DT, [], INVERTED);
    }

    const result = stepController(
      state,
      actions({ right: true, jumpPressed: true, jumpHeld: true }),
      grid,
      DT,
      [],
      INVERTED,
    );

    expect(result.body.velocity.y).toBe(-JUMP_VEL);
  });

  it('refuses an inverted coyote jump on step T+7 after leaving the ceiling', () => {
    const grid = parseGrid(['##.', '...', '...']);
    const walkRight = actions({ right: true });

    let state = walkOffCeiling(grid);
    for (let i = 0; i < 5; i++) {
      state = stepController(state, walkRight, grid, DT, [], INVERTED);
    }

    const result = stepController(
      state,
      actions({ right: true, jumpPressed: true, jumpHeld: true }),
      grid,
      DT,
      [],
      INVERTED,
    );

    // Seventh airborne step, 7 x 15 px/s of downward gravity; a fired jump
    // would read +260.
    expect(result.body.velocity.y).toBe(-105);
  });

  it('fires a jump buffered 6 real steps before an inverted landing', () => {
    const grid = parseGrid(['###', '...', '...', '...']);
    const noJump = actions();
    const landingStep = stepsUntilGroundedInverted(grid);

    let state = createControllerState(makeBody({ x: 0, y: 32 }));
    for (let step = 1; step <= landingStep; step++) {
      const act =
        step === landingStep - 6 ? actions({ jumpPressed: true, jumpHeld: true }) : noJump;
      state = stepController(state, act, grid, DT, [], INVERTED);
    }
    expect(state.body.grounded).toBe(true);
    expect(state.body.velocity.y).toBe(0);

    state = stepController(state, actions({ jumpHeld: true }), grid, DT, [], INVERTED);
    expect(state.body.velocity.y).toBe(-JUMP_VEL);
  });

  it('halves the inverted ascent exactly once on release', () => {
    // Release-cut symmetry: travelling against the inverted pull (vy toward
    // +y) is "rising", so the same x0.5 cut applies.
    const grid = parseGrid(['.']);
    let state: ControllerState = {
      body: makeBody({ grounded: false, velocity: { x: 0, y: -JUMP_VEL } }),
      coyoteSteps: 0,
      jumpBufferSteps: -1,
      jumpCutArmed: true,
    };

    state = stepController(state, actions(), grid, DT, [], INVERTED);
    expect(state.body.velocity.y).toBe(122.5);

    state = stepController(state, actions(), grid, DT, [], INVERTED);
    expect(state.body.velocity.y).toBe(107.5);
  });
});
