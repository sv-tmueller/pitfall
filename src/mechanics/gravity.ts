// Gravity inversion: flips the up-vector for the controller and collision.
//
// Inversion is now FIRST-CLASS in the controller (`stepController` takes a
// signed `gravityDir`), so this module is a thin compatibility wrapper plus
// the small transition-timer state the old adapter used. The previous
// implementation stepped the controller in normal gravity and then negated
// the resolved vy, which is physically wrong (it dropped the resolve of the
// inverted motion entirely and left the body resolving against the wrong
// surfaces). It now delegates to the signed controller.

import {
  stepController,
  type ControllerActions,
  type ControllerState,
  type GravityDirection,
} from '../engine/controller';
import type { SolidRect, TileGrid } from '../engine/physics';

export type { GravityDirection };

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
  // The controller owns the sign now; there is no separate inverted path.
  return stepController(state, actions, grid, dt, solids, gravityDir);
}
