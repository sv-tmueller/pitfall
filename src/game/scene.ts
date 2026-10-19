import { aabbOverlap, type AABB, type Body, type SolidRect, Tile, type TileGrid } from '../engine/physics';
import {
  createControllerState,
  stepController,
  type ControllerActions,
  type ControllerState,
} from '../engine/controller';
import { overlapsHazard } from '../engine/levelAdapter';
import type { LevelData, TilePosition } from '../levels/types';
import {
  DEATH_FREEZE_STEPS,
  EXIT_BEAT_STEPS,
  PLAYER_HEIGHT,
  spawnToBody,
} from './constants';
import {
  advance,
  createSequence,
  currentLevel,
  hasNext,
  type LevelSequence,
  type LevelSource,
} from './sequence';
import { createRuntime, resetTraps, stepTraps, type TrapRuntime } from '../traps/runtime';
import { registerAllTrapTypes } from '../traps/implementations';
import type { DynamicSolid } from '../traps/types';
import {
  applyMechanicContacts,
  createMechanicsRuntime,
  resetMechanics,
  stepMechanics,
  type MechanicsRuntime,
} from '../mechanics/runtime';
import { registerAllMechanicTypes } from '../mechanics/register';

// Register every concrete trap and mechanic factory once at module load so
// createRuntime / createMechanicsRuntime can resolve any type a level declares.
registerAllTrapTypes();
registerAllMechanicTypes();

export type PlayPhase = 'playing' | 'dying' | 'entering' | 'complete';

export interface SceneActions {
  readonly left: boolean;
  readonly right: boolean;
  readonly jumpPressed: boolean;
  readonly jumpHeld: boolean;
  /** Rising-edge: true only on the step the R key was first pressed. */
  readonly restart: boolean;
}

export interface SceneState {
  readonly phase: PlayPhase;
  readonly controller: ControllerState;
  readonly level: LevelData;
  /**
   * The trap runtime owns the mutable tile grid and hazard list that the
   * controller and hazard check read from each step. Traps mutate this in
   * place (vanishing floors clear tiles, emerging spikes add hazards); the
   * scene carries the same runtime reference across steps so mutations
   * persist. Reset on respawn and rebuilt on level advance.
   */
  readonly runtime: TrapRuntime;
  /**
   * The mechanics runtime owns the continuous mechanic instances (springs,
   * teleporters, moving platforms, etc.) and published effect buffers
   * (dynamic solids, hazards, merged overrides, cosmetic effects). Stepped
   * once per frame before the controller to collect input/body overrides and
   * to publish solids/hazards; the runtime's contact pass then runs after the
   * controller resolves the new position, so spring and teleporter cooldowns
   * live in the instances rather than in the scene. Reset on respawn and
   * rebuilt on level advance.
   */
  readonly mechanicsRuntime: MechanicsRuntime;
  /** Monotonically increasing sim step counter, fed to stepTraps. */
  readonly step: number;
  readonly sequence: LevelSequence;
  /** Countdown steps for the dying or entering phases. */
  readonly timer: number;
  readonly deathsThisLevel: number;
  readonly deathsTotal: number;
}

export interface SceneCallbacks {
  onLevelComplete?(levelIndex: number): void;
  onSequenceComplete?(): void;
}

// Callbacks are kept out of SceneState so the state stays serializable.
// They ride alongside in a WeakMap keyed by the state object identity.
const callbacksByState = new WeakMap<object, SceneCallbacks>();

function exitAABB(exit: TilePosition): AABB {
  return { x: exit.col * 16, y: exit.row * 16, width: 16, height: 16 };
}

/**
 * Loads the current level from the sequence and builds a fresh trap runtime
 * and mechanics runtime for it. The trap runtime owns the mutable tile grid
 * and hazard list; the mechanics runtime owns continuous mechanic instances.
 */
function loadSeqLevel(seq: LevelSequence, body: Body): {
  level: LevelData;
  runtime: TrapRuntime;
  mechanicsRuntime: MechanicsRuntime;
} {
  const level = currentLevel(seq);
  const runtime = createRuntime(level, body);
  const mechanicsRuntime = createMechanicsRuntime(level, body);
  return { level, runtime, mechanicsRuntime };
}

function freshController(level: LevelData): ControllerState {
  return createControllerState(spawnToBody(level.spawn, PLAYER_HEIGHT));
}

export function createScene(
  sources: readonly LevelSource[],
  callbacks?: SceneCallbacks,
): SceneState {
  const sequence = createSequence(sources);
  const controller = freshController(currentLevel(sequence));
  const { level, runtime, mechanicsRuntime } = loadSeqLevel(sequence, controller.body);

  const state: SceneState = {
    phase: 'playing',
    controller,
    level,
    runtime,
    mechanicsRuntime,
    step: 0,
    sequence,
    timer: 0,
    deathsThisLevel: 0,
    deathsTotal: 0,
  };

  if (callbacks !== undefined) {
    callbacksByState.set(state, callbacks);
  }
  return state;
}

export function stepScene(
  state: SceneState,
  actions: SceneActions,
  dt: number,
): SceneState {
  switch (state.phase) {
    case 'playing':
      return stepPlaying(state, actions, dt);
    case 'dying':
      return stepDying(state);
    case 'entering':
      return stepEntering(state);
    case 'complete':
      return state;
  }
}

/** Flush-edge tolerance for treating a body as resting on a platform top. */
const CARRY_EPSILON = 0.5;

/**
 * Builds the dynamic-solid list the collide solve sees this step. Trap-owned
 * solids contribute their positions from the end of the previous step; a
 * stepTraps advance later in the frame is what the crush check reacts to, and
 * holding the pre-advance position here keeps trap trigger semantics intact.
 *
 * Mechanic-published platforms store their start-of-step position together
 * with the displacement they are about to make, so each is advanced to its
 * end-of-step position. That lines the blocking top up with a body carried by
 * the same displacement, and the strict flush-edge convention then reads a
 * rider standing on top as no side contact at all.
 */
function collectActiveSolids(state: SceneState, dt: number): SolidRect[] {
  const solids: SolidRect[] = [];
  for (const solid of state.runtime.world.dynamicSolids) {
    if (solid.solid) {
      solids.push(solid);
    }
  }
  for (const solid of state.mechanicsRuntime.publishedSolids) {
    if (!solid.solid) continue;
    solids.push({
      x: solid.x + solid.velocityX * dt,
      y: solid.y + solid.velocityY * dt,
      width: solid.width,
      height: solid.height,
      // The published position is the start-of-step top; the advance above is
      // the end-of-step top. Handing both to the solver lets its landing guard
      // test against where the top began, which is what catches a body a
      // rising platform would otherwise route past (issue #168). Trap-owned
      // solids pushed above stay static this step and omit startY.
      startY: solid.y,
    });
  }
  return solids;
}

/**
 * Moves a body that was resting on a published platform last step by that
 * platform's per-step displacement (velocity is px/s, so displacement is
 * velocity * dt). Rise, descent, and turnaround all fall out of the published
 * velocity sign, so no special casing is needed. Only a grounded body flush
 * with a platform top and horizontally overlapping it is carried.
 */
function carryRiders(
  body: Body,
  publishedSolids: readonly DynamicSolid[],
  dt: number,
): Body {
  if (!body.grounded) {
    return body;
  }

  let carried = body;
  for (const solid of publishedSolids) {
    if (!solid.solid) continue;
    const flush = Math.abs(carried.y + carried.height - solid.y) <= CARRY_EPSILON;
    const horizontal =
      carried.x < solid.x + solid.width && carried.x + carried.width > solid.x;
    if (!flush || !horizontal) continue;
    carried = {
      ...carried,
      x: carried.x + solid.velocityX * dt,
      y: carried.y + solid.velocityY * dt,
    };
  }
  return carried;
}

/**
 * True when the player is being crushed: overlapping a solid that advanced
 * this step (position differs from the pre-stepTraps snapshot), or overlapping
 * any solid flagged lethal. Stationary non-lethal solids merely block, which
 * the collide solve already enforced.
 *
 * The moved-kill arm is trap-solids-only BY DESIGN. `before` is the trap-owned
 * snapshot taken just before stepTraps advances them, so a mechanic-published
 * solid never has a prior entry and can never trip this arm; mechanic solids
 * kill exclusively through the lethal flag. Extending the moved arm to
 * mechanics would mean snapshotting published solids across the buffer-clearing
 * stepMechanics cycle for a case no shipped level exercises, which batch #164
 * explicitly rejected. Left as-is and pinned by the issue #168 regressions.
 */
function isCrushed(
  body: Body,
  solids: readonly DynamicSolid[],
  before: readonly { id: string; x: number; y: number }[],
): boolean {
  for (const solid of solids) {
    if (!solid.solid) continue;
    if (!aabbOverlap(body, solid)) continue;
    if (solid.lethal) return true;
    const prev = before.find((entry) => entry.id === solid.id);
    if (prev !== undefined && (prev.x !== solid.x || prev.y !== solid.y)) {
      return true;
    }
  }
  return false;
}

function stepPlaying(
  state: SceneState,
  actions: SceneActions,
  dt: number,
): SceneState {
  // 1. R-key manual restart: same dying path, no counter increment.
  if (actions.restart) {
    const next: SceneState = { ...state, phase: 'dying', timer: DEATH_FREEZE_STEPS };
    transferCallbacks(state, next);
    return next;
  }

  // 2. PRE-CONTROLLER PHASE: Step mechanics with the current body and input
  //    state. This collects the merged overrides (actionsOverride for control
  //    inversion, velocityMod for the jetpack, bodyOverride) and advances
  //    continuous mechanic state (platforms, buzzsaws, fuses, cosmetic
  //    timers). Published solids/hazards are buffered for the collide solve.
  const rawActions: ControllerActions = {
    left: actions.left,
    right: actions.right,
    jumpPressed: actions.jumpPressed,
    jumpHeld: actions.jumpHeld,
  };
  const step = state.step + 1;
  const prevGrounded = state.controller.body.grounded;

  stepMechanics(state.mechanicsRuntime, state.controller.body, rawActions, step);
  const overrides = state.mechanicsRuntime.publishedOverrides;

  // 2b. Snapshot trap-owned solid positions before stepTraps advances them, so
  //     the crush check below can tell which solids moved into the player.
  const trapSolidBefore = state.runtime.world.dynamicSolids.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
  }));

  // 3. STEP CONTROLLER: Use the runtime's mutable tile grid so trap-induced
  //    tile changes (vanishing floors, shifting walls) are felt by the physics
  //    solver immediately. Only traps modify tiles; mechanics contribute
  //    through the dynamic-solid list collected here, which is what stops a
  //    crusher, blocks a shifting wall, and lets a platform carry the player.
  //
  //    The controller receives the merged actions: a mechanic that transforms
  //    input (control inversion) publishes actionsOverride, which replaces the
  //    raw input when present. Mechanic velocity modifications are applied to
  //    the resolved body just below, not threaded through the solve.
  const grid: TileGrid = {
    cols: state.runtime.world.cols,
    rows: state.runtime.world.rows,
    tiles: state.runtime.world.tiles as unknown as readonly Tile[],
  };
  const activeSolids = collectActiveSolids(state, dt);
  const carriedBody = carryRiders(
    state.controller.body,
    state.mechanicsRuntime.publishedSolids,
    dt,
  );
  const effectiveActions = overrides.actionsOverride ?? rawActions;
  let controller = stepController(
    { ...state.controller, body: carriedBody },
    effectiveActions,
    grid,
    dt,
    activeSolids,
  );

  // 3b. Apply the merged velocity modification (jetpack thrust) additively to
  //     the resolved body's velocity. Acting on the post-controller velocity
  //     makes the modification effective from the next integration step.
  const vmod = overrides.velocityMod;
  if (vmod.x !== 0 || vmod.y !== 0) {
    controller = {
      ...controller,
      body: {
        ...controller.body,
        velocity: {
          x: controller.body.velocity.x + vmod.x,
          y: controller.body.velocity.y + vmod.y,
        },
      },
    };
  }

  // 4. POST-CONTROLLER CONTACT PASS: the mechanics runtime owns spring and
  //    teleporter contact. It checks the RESOLVED post-move body in
  //    declaration order, applies any relocation, and then skips any further
  //    relocation in the same step (a second portal cannot chain off the
  //    first). Cooldowns and contact arming live in the instances, so a spring
  //    fires once per contact and a teleporter pair cannot bounce the player
  //    back while its cooldown runs or until the body leaves the arrival tile.
  //    A merged bodyOverride then replaces the resolved body.
  let body = applyMechanicContacts(state.mechanicsRuntime, controller.body);
  if (overrides.bodyOverride !== undefined) {
    body = overrides.bodyOverride;
  }
  controller = { ...controller, body };

  // 5. ADVANCE THE TRAP SYSTEM: Feed it the post-move (and post-contact) body
  //    so triggers (on-enter, on-approach, on-land) evaluate against the new
  //    position. Traps mutate the runtime's world in place.
  stepTraps(
    state.runtime,
    controller.body,
    prevGrounded,
    false,
    step,
  );

  // 6. MERGE MECHANICS WORLD STATE: Splice mechanic-published dynamic solids
  //    and hazards into the trap runtime's world so the crush check, the
  //    hazard check, and the renderer all see the full picture for this step.
  //    The copies are trimmed back below; they are replaced on the next
  //    stepMechanics call (which clears the published buffers at the start).
  const mechWorld = state.mechanicsRuntime;
  const savedSolidsLen = state.runtime.world.dynamicSolids.length;
  const savedHazardsLen = state.runtime.world.hazards.length;
  state.runtime.world.dynamicSolids.push(...mechWorld.publishedSolids);
  state.runtime.world.hazards.push(...mechWorld.publishedHazards);

  // 7. CRUSH CHECK: a solid that advanced into the player this step, or any
  //    solid flagged lethal, kills. A stationary non-lethal solid only blocks,
  //    which the collide solve above already handled.
  if (isCrushed(controller.body, state.runtime.world.dynamicSolids, trapSolidBefore)) {
    state.runtime.world.dynamicSolids.length = savedSolidsLen;
    state.runtime.world.hazards.length = savedHazardsLen;
    const next: SceneState = {
      ...state,
      controller,
      step,
      phase: 'dying',
      timer: DEATH_FREEZE_STEPS,
      deathsThisLevel: state.deathsThisLevel + 1,
      deathsTotal: state.deathsTotal + 1,
    };
    transferCallbacks(state, next);
    return next;
  }

  // 8. Hazard check (death wins over exit if both occur in the same step).
  //    Uses the runtime's hazard list, which now includes mechanic-added
  //    hazards (buzzsaws, rotating arms, bomb blasts).
  if (overlapsHazard(controller.body, state.runtime.world.hazards)) {
    // Restore world arrays before transitioning (so respawn starts clean).
    state.runtime.world.dynamicSolids.length = savedSolidsLen;
    state.runtime.world.hazards.length = savedHazardsLen;
    const next: SceneState = {
      ...state,
      controller,
      step,
      phase: 'dying',
      timer: DEATH_FREEZE_STEPS,
      deathsThisLevel: state.deathsThisLevel + 1,
      deathsTotal: state.deathsTotal + 1,
    };
    transferCallbacks(state, next);
    return next;
  }

  // 9. Exit check. Reads the WORLD's mutable exitPos: the fake-exit trap
  //    slides the door away, and only the moved tile may open the door.
  if (aabbOverlap(controller.body, exitAABB(state.runtime.world.exitPos))) {
    // Restore world arrays before transitioning.
    state.runtime.world.dynamicSolids.length = savedSolidsLen;
    state.runtime.world.hazards.length = savedHazardsLen;
    fireOnLevelComplete(state);
    const next: SceneState = {
      ...state,
      controller,
      step,
      phase: 'entering',
      timer: EXIT_BEAT_STEPS,
    };
    transferCallbacks(state, next);
    return next;
  }

  // 10. Normal stepped state. Leave the merged solids/hazards in the world for
  //    rendering this frame; they'll be replaced on the next stepMechanics call.
  //    However, we must trim them back so they don't permanently accumulate
  //    across steps (stepMechanics clears its own buffers, but the spliced
  //    copies in the trap world would grow indefinitely). Trim to the saved
  //    lengths so the trap world only retains its own state between steps.
  state.runtime.world.dynamicSolids.length = savedSolidsLen;
  state.runtime.world.hazards.length = savedHazardsLen;

  const next: SceneState = { ...state, controller, step };
  transferCallbacks(state, next);
  return next;
}

function stepDying(state: SceneState): SceneState {
  if (state.timer > 0) {
    const next: SceneState = { ...state, timer: state.timer - 1 };
    transferCallbacks(state, next);
    return next;
  }

  // Timer reached 0: respawn with a factory-fresh controller and re-armed
  // traps and mechanics. resetTraps rebuilds the world (tiles, hazards,
  // dynamic solids) from the original level data. resetMechanics restores
  // every mechanic to its initial state.
  const controller = freshController(state.level);
  resetTraps(state.runtime, controller.body);
  resetMechanics(state.mechanicsRuntime, controller.body);
  const next: SceneState = {
    ...state,
    controller,
    step: 0,
    phase: 'playing',
    timer: 0,
  };
  transferCallbacks(state, next);
  return next;
}

function stepEntering(state: SceneState): SceneState {
  if (state.timer > 0) {
    const next: SceneState = { ...state, timer: state.timer - 1 };
    transferCallbacks(state, next);
    return next;
  }

  // Timer reached 0: advance or complete.
  if (hasNext(state.sequence)) {
    const nextSeq = advance(state.sequence);
    const controller = freshController(currentLevel(nextSeq));
    const { level, runtime, mechanicsRuntime } = loadSeqLevel(nextSeq, controller.body);
    const next: SceneState = {
      ...state,
      controller,
      level,
      runtime,
      mechanicsRuntime,
      step: 0,
      sequence: nextSeq,
      phase: 'playing',
      timer: 0,
      deathsThisLevel: 0,
    };
    transferCallbacks(state, next);
    return next;
  }

  fireOnSequenceComplete(state);
  const next: SceneState = { ...state, phase: 'complete', timer: 0 };
  transferCallbacks(state, next);
  return next;
}

function transferCallbacks(from: object, to: object): void {
  const cb = callbacksByState.get(from);
  if (cb !== undefined) {
    callbacksByState.set(to, cb);
  }
}

function fireOnLevelComplete(state: SceneState): void {
  const cb = callbacksByState.get(state);
  cb?.onLevelComplete?.(state.sequence.index);
}

function fireOnSequenceComplete(state: SceneState): void {
  const cb = callbacksByState.get(state);
  cb?.onSequenceComplete?.();
}
