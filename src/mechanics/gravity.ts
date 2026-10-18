// Gravity inversion: flips the up-vector for the controller and collision.
// Wrapper around stepController that negates gravity and jump when inverted.

import { stepController, type ControllerActions, type ControllerState } from '../engine/controller';
import type { SolidRect, TileGrid } from '../engine/physics';

export type GravityDirection = 1 | -1;

export interface GravityState {
  direction: GravityDirection;
  transitionTimer: number;
}

export function createGravity(): GravityState {
  return { direction: 1, transitionTimer: 0 };
}

export function invertGravity(state: GravityState): GravityState {
  return {
    direction: (state.direction === 1 ? -1 : 1) as GravityDirection,
    transitionTimer: 12,
  };
}

export function stepGravity(state: GravityState, dt: number): GravityState {
  void dt;
  if (state.transitionTimer <= 0) return state;
  return { ...state, transitionTimer: state.transitionTimer - 1 };
}

export function stepControllerWithGravity(
  state: ControllerState,
  actions: ControllerActions,
  grid: TileGrid,
  dt: number,
  gravityDir: GravityDirection,
  solids: readonly SolidRect[] = [],
): ControllerState {
  if (gravityDir === 1) {
    return stepController(state, actions, grid, dt, solids);
  }
  // Inverted: negate jump press (jump goes DOWN), swap up/down semantics
  const invertedActions: ControllerActions = {
    ...actions,
    jumpPressed: actions.jumpPressed,
    jumpHeld: actions.jumpHeld,
  };
  // Step normally, then flip the vertical velocity and position
  const result = stepController(state, invertedActions, grid, dt, solids);
  // Negate vy to simulate inverted gravity (the controller applied +gravity, we want -gravity)
  return {
    ...result,
    body: {
      ...result.body,
      velocity: { ...result.body.velocity, y: -result.body.velocity.y },
    },
  };
}
