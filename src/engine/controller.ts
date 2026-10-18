import { moveAndCollide, type Body, type SolidRect, type TileGrid } from './physics';

export const MAX_RUN = 120;
export const ACCEL = 800;
export const FRICTION = 1200;
export const GRAVITY = 900;
export const JUMP_VEL = -260;
export const TERMINAL_VEL = 400;
export const RELEASE_CUT = 0.5;

// 6 x 1/60 s = 100 ms exactly.
export const COYOTE_STEPS = 6;
// 120 ms / (1000/60 ms) = 7.2; floored to whole steps, so this reads as
// 116.67 ms rather than the nominal 120 ms. The extra 13.3 ms of an 8-step
// buffer would exceed the contract, so the floor is the correct rounding.
export const JUMP_BUFFER_STEPS = 7;

export interface ControllerActions {
  readonly left: boolean;
  readonly right: boolean;
  // Rising edge: true for exactly one step per press.
  readonly jumpPressed: boolean;
  readonly jumpHeld: boolean;
}

export interface ControllerState {
  body: Body;
  coyoteSteps: number;
  jumpBufferSteps: number;
  jumpCutArmed: boolean;
}

export function createControllerState(body: Body): ControllerState {
  return {
    body,
    coyoteSteps: body.grounded ? COYOTE_STEPS : 0,
    jumpBufferSteps: -1,
    jumpCutArmed: false,
  };
}

export function stepController(
  state: ControllerState,
  actions: ControllerActions,
  grid: TileGrid,
  dt: number,
  solids: readonly SolidRect[] = [],
): ControllerState {
  const body = state.body;

  // Phase 1: age the buffer by one step. Floored at -1, not 0, so a press
  // that just expired reads as clearly stale rather than indistinguishable
  // from "never pressed".
  let jumpBufferSteps = Math.max(state.jumpBufferSteps - 1, -1);
  // Phase 2: arm on a fresh press. Written and read within the same step,
  // hence the >= 0 (not > 0) eligibility check below.
  if (actions.jumpPressed) {
    jumpBufferSteps = JUMP_BUFFER_STEPS;
  }

  // Phase 3: horizontal accel/friction, air control equal to ground control.
  const direction = (actions.right ? 1 : 0) - (actions.left ? 1 : 0);
  let vx = body.velocity.x;
  if (direction !== 0) {
    vx = clamp(vx + direction * ACCEL * dt, -MAX_RUN, MAX_RUN);
  } else if (vx > 0) {
    vx = Math.max(0, vx - FRICTION * dt);
  } else if (vx < 0) {
    vx = Math.min(0, vx + FRICTION * dt);
  }

  // Phase 4: gravity before the jump impulse, so JUMP_VEL is the literal
  // takeoff velocity rather than JUMP_VEL + one step of gravity.
  let vy = Math.min(body.velocity.y + GRAVITY * dt, TERMINAL_VEL);

  // Phase 5: jump. Coyote is written only at the end of the step (phase 8)
  // from the previous step's grounded result, hence the > 0 (not >= 0)
  // eligibility check: it is read before this step's own resolve exists.
  let jumpCutArmed = state.jumpCutArmed;
  let coyoteSteps = state.coyoteSteps;
  if (jumpBufferSteps >= 0 && coyoteSteps > 0) {
    vy = JUMP_VEL;
    jumpBufferSteps = -1;
    coyoteSteps = 0;
    jumpCutArmed = true;
  }

  // Phase 6: release cut, at most once per jump, never applied to a fall.
  if (jumpCutArmed && !actions.jumpHeld && vy < 0) {
    vy *= RELEASE_CUT;
    jumpCutArmed = false;
  }
  if (vy >= 0) {
    jumpCutArmed = false;
  }

  // Phase 7: integrate and resolve.
  const bodyToMove: Body = { ...body, velocity: { x: vx, y: vy } };
  const result = moveAndCollide(bodyToMove, grid, dt, solids);

  // Phase 8: coyote bookkeeping from the resolved grounded flag.
  coyoteSteps = result.body.grounded ? COYOTE_STEPS : Math.max(coyoteSteps - 1, 0);

  return {
    body: result.body,
    coyoteSteps,
    jumpBufferSteps,
    jumpCutArmed,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
