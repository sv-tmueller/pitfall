// Adapter wrappers: thin layers that convert the existing functional mechanic
// APIs (create/step/reset) into MechanicInstance factories.
//
// Each adapter:
//  1. Parses required params from the MechanicEntry's params object.
//  2. Owns the mechanic's internal state (created from params at construction).
//  3. step() advances the internal state and emits a MechanicStepResult.
//  4. reset() restores the initial state for respawn.
//
// Param extraction helpers (reqNumber/optNumber/etc.) are duplicated locally
// rather than imported from src/traps/implementations/helpers.ts to keep the
// mechanics subsystem independent of the traps subsystem's internals.

import type { JsonValue, MechanicEntry } from '../levels/types';
import type { Body } from '../engine/physics';
import type { MechanicInstance } from './types';

// ---------------------------------------------------------------------------
// Param extraction helpers (local copies to avoid coupling to traps/)
// ---------------------------------------------------------------------------

function reqNumber(params: Readonly<Record<string, JsonValue>>, key: string): number {
  const val = params[key];
  if (typeof val !== 'number') {
    throw new Error(`param "${key}" must be a number`);
  }
  return val;
}

function optNumber(
  params: Readonly<Record<string, JsonValue>>,
  key: string,
): number | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') return undefined;
  return val;
}

function optBoolean(
  params: Readonly<Record<string, JsonValue>>,
  key: string,
  defaultValue: boolean,
): boolean {
  const val = params[key];
  if (typeof val === 'boolean') return val;
  return defaultValue;
}

function reqString(params: Readonly<Record<string, JsonValue>>, key: string): string {
  const val = params[key];
  if (typeof val !== 'string') {
    throw new Error(`param "${key}" must be a string`);
  }
  return val;
}

function reqPointArray(
  params: Readonly<Record<string, JsonValue>>,
  key: string,
): Array<{ x: number; y: number }> {
  const val = params[key];
  if (!Array.isArray(val)) {
    throw new Error(`param "${key}" must be an array`);
  }
  return val.map((item, idx) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`param "${key}[${idx}]" must be an object`);
    }
    const obj = item as { readonly [k: string]: JsonValue };
    const x = obj['x'];
    const y = obj['y'];
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new Error(`param "${key}[${idx}]" must have numeric x and y`);
    }
    return { x, y };
  });
}

// ---------------------------------------------------------------------------
// Spring adapter
// ---------------------------------------------------------------------------

import {
  applySpringImpulse,
  createSpring,
  resetSpring,
  springOverlaps,
  stepSpring,
  triggerSpring,
  type Spring,
} from './spring';

export function createSpringMechanic(entry: MechanicEntry): MechanicInstance {
  const x = reqNumber(entry.params, 'x');
  const y = reqNumber(entry.params, 'y');
  const impulseX = optNumber(entry.params, 'impulseX') ?? 0;
  const impulseY = reqNumber(entry.params, 'impulseY');

  let spring: Spring = createSpring(x, y, impulseX, impulseY);
  // Contact-state arming: a spring fires on the rising edge of overlap. It is
  // disarmed once it fires and only re-arms after the body has left the volume,
  // so sustained overlap never re-triggers even after the cooldown expires.
  let armed = true;

  return {
    id: entry.id,
    type: entry.type,
    contactCategory: 'impulse',
    step(_ctx) {
      spring = stepSpring(spring, 1);
      return {};
    },
    // Post-resolve contact: fires against the resolved body once per contact,
    // combining rising-edge arming with the instance's persistent cooldown.
    contact(body: Body) {
      if (!springOverlaps(spring, body)) {
        armed = true;
        return null;
      }
      if (!armed) return null;
      if (spring.currentCooldown > 0) return null;
      spring = triggerSpring(spring);
      armed = false;
      return { body: applySpringImpulse(spring, body), halts: false };
    },
    reset() {
      spring = resetSpring(spring);
      armed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Teleporter adapter
// ---------------------------------------------------------------------------

import {
  applyTeleport,
  createTeleporter,
  resetTeleporter,
  stepTeleporter,
  teleporterOverlaps,
  triggerCooldown,
  type Teleporter,
} from './teleporter';

export function createTeleporterMechanic(entry: MechanicEntry): MechanicInstance {
  const x = reqNumber(entry.params, 'x');
  const y = reqNumber(entry.params, 'y');
  const destX = reqNumber(entry.params, 'destX');
  const destY = reqNumber(entry.params, 'destY');
  const oneWay = optBoolean(entry.params, 'oneWay', false);
  const preserveMomentum = optBoolean(entry.params, 'preserveMomentum', false);

  let teleporter: Teleporter = createTeleporter(x, y, destX, destY, oneWay, preserveMomentum);
  let twin: MechanicInstance | undefined;
  // Contact-state arming: a portal relocates on the rising edge of overlap and
  // re-arms only after the body has LEFT the trigger volume. Without this, the
  // cooldown alone would re-fire the moment it expired while the body still sat
  // on the arrival tile, ping-ponging a walking player between the pair.
  let armed = true;

  return {
    id: entry.id,
    type: entry.type,
    contactCategory: 'relocation',
    // Two-way teleporters publish a pairing token; the runtime links mirrored
    // pairs by geometry. One-way teleporters have no twin (self cooldown only).
    ...(oneWay
      ? {}
      : { pairKey: { origin: `${x},${y}`, dest: `${destX},${destY}` } }),
    step(_ctx) {
      teleporter = stepTeleporter(teleporter, 1);
      return {};
    },
    // Post-resolve contact: relocates against the resolved body and halts
    // further relocations this step. Firing cools this teleporter and disarms
    // its paired twin, so the arrival tile cannot bounce the player straight
    // back and stays disarmed until the player leaves the tile.
    contact(body: Body) {
      if (!teleporterOverlaps(teleporter, body)) {
        armed = true;
        return null;
      }
      if (!armed) return null;
      if (teleporter.currentCooldown > 0) return null;
      teleporter = triggerCooldown(teleporter);
      armed = false;
      twin?.cool?.(teleporter.cooldown);
      return { body: applyTeleport(teleporter, body), halts: true };
    },
    linkTwin(t: MechanicInstance) {
      twin = t;
    },
    cool(steps: number) {
      teleporter = { ...teleporter, currentCooldown: steps };
      // A twin teleported INTO this portal: hold it disarmed until the body
      // leaves the arrival tile, not merely until the cooldown decays.
      armed = false;
    },
    reset() {
      teleporter = resetTeleporter(teleporter);
      armed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Gravity zone adapter
// ---------------------------------------------------------------------------

import {
  createGravity,
  invertGravity,
  stepGravity,
  type GravityState,
} from './gravity';

export function createGravityZoneMechanic(entry: MechanicEntry): MechanicInstance {
  let gravState: GravityState = createGravity();
  let initialized = false;

  return {
    id: entry.id,
    type: entry.type,
    step(ctx) {
      if (!initialized) {
        // Activate gravity inversion on first step (zone is always-on)
        gravState = invertGravity(gravState);
        initialized = true;
      }
      gravState = stepGravity(gravState, 1);
      void ctx;
      return {};
    },
    reset() {
      gravState = createGravity();
      initialized = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Moving platform adapter
// ---------------------------------------------------------------------------

import {
  createMovingPlatform,
  resetMovingPlatform,
  stepMovingPlatform,
  type MovingPlatform,
} from './moving-terrain';
import type { DynamicSolid } from '../traps/types';
// The sim runs at a fixed 60 Hz (loop.ts owns the DT contract), so the
// per-step displacement is velocity * DT without threading dt through
// MechanicContext.
import { DT } from '../engine/loop';

export function createMovingPlatformMechanic(entry: MechanicEntry): MechanicInstance {
  const startX = reqNumber(entry.params, 'startX');
  const startY = reqNumber(entry.params, 'startY');
  const width = reqNumber(entry.params, 'width');
  const height = reqNumber(entry.params, 'height');
  const dx = reqNumber(entry.params, 'dx');
  const dy = reqNumber(entry.params, 'dy');
  const speed = reqNumber(entry.params, 'speed');
  const distance = reqNumber(entry.params, 'distance');

  let platform: MovingPlatform = createMovingPlatform(startX, startY, width, height, dx, dy, speed, distance);

  return {
    id: entry.id,
    type: entry.type,
    step(_ctx) {
      // Emit current position as a dynamic solid, then advance for next step.
      const solid: DynamicSolid = {
        id: entry.id,
        x: platform.x,
        y: platform.y,
        width: platform.width,
        height: platform.height,
        velocityX: platform.dx * platform.speed * platform.direction,
        velocityY: platform.dy * platform.speed * platform.direction,
        solid: true,
        lethal: false,
      };
      platform = stepMovingPlatform(platform, DT);
      return { dynamicSolids: [solid] };
    },
    reset() {
      platform = resetMovingPlatform(platform);
    },
  };
}

// ---------------------------------------------------------------------------
// Jetpack adapter
// ---------------------------------------------------------------------------

import {
  createJetpack,
  equipJetpack,
  getJetpackVelocityMod,
  stepJetpack,
  type JetpackState,
} from './jetpack';

export function createJetpackMechanic(entry: MechanicEntry): MechanicInstance {
  const maxFuel = reqNumber(entry.params, 'maxFuel');
  const thrustPower = reqNumber(entry.params, 'thrustPower');

  let jetpack: JetpackState = equipJetpack(createJetpack(maxFuel, thrustPower));

  return {
    id: entry.id,
    type: entry.type,
    step(ctx) {
      const thrusting = ctx.actions.jumpHeld;
      jetpack = stepJetpack(jetpack, thrusting, 1);
      if (thrusting) {
        const mod = getJetpackVelocityMod(jetpack, 1);
        if (mod !== 0) {
          return { velocityMod: { y: mod } };
        }
      }
      return {};
    },
    reset() {
      jetpack = equipJetpack(createJetpack(maxFuel, thrustPower));
    },
  };
}

// ---------------------------------------------------------------------------
// Lever adapter
// ---------------------------------------------------------------------------

import {
  createLever,
  stepLevers,
  type Lever,
} from './lever';

export function createLeverMechanic(entry: MechanicEntry): MechanicInstance {
  const x = reqNumber(entry.params, 'x');
  const y = reqNumber(entry.params, 'y');
  const toggleOnContact = optBoolean(entry.params, 'toggleOnContact', false);

  let lever: Lever = createLever(x, y, toggleOnContact);

  return {
    id: entry.id,
    type: entry.type,
    step(ctx) {
      lever = stepLevers([lever], ctx.body, ctx.actions.jumpPressed)[0]!;
      return {};
    },
    reset() {
      lever = createLever(x, y, toggleOnContact);
    },
  };
}

// ---------------------------------------------------------------------------
// Control inversion adapter
// ---------------------------------------------------------------------------

import {
  activateInversion,
  createControlInversion,
  invertActions,
  stepControlInversion,
  type ControlInversionState,
} from './control-inversion';

export function createControlInversionMechanic(entry: MechanicEntry): MechanicInstance {
  const duration = optNumber(entry.params, 'duration') ?? -1;

  let ciState: ControlInversionState = createControlInversion(duration);
  let activated = false;

  return {
    id: entry.id,
    type: entry.type,
    step(ctx) {
      if (!activated) {
        ciState = activateInversion(ciState);
        activated = true;
      }
      ciState = stepControlInversion(ciState, 1);
      return { actionsOverride: invertActions(ctx.actions, ciState.inverted) };
    },
    reset() {
      ciState = createControlInversion(duration);
      activated = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Camera troll adapter
// ---------------------------------------------------------------------------

import {
  createCameraTroll,
  stepCameraTroll,
  triggerCameraTroll,
  type CameraTrollState,
} from './camera-troll';

export function createCameraTrollMechanic(entry: MechanicEntry): MechanicInstance {
  const kind = reqString(entry.params, 'kind') as 'zoom' | 'flip' | 'offset' | 'lag';
  const intensity = reqNumber(entry.params, 'intensity');
  const durationSteps = optNumber(entry.params, 'durationSteps') ?? 60;

  let state: CameraTrollState = createCameraTroll(kind, intensity);
  let triggered = false;

  return {
    id: entry.id,
    type: entry.type,
    step(_ctx) {
      if (!triggered) {
        state = triggerCameraTroll(state, durationSteps);
        triggered = true;
      }
      state = stepCameraTroll(state, 1);
      return {
        cosmeticState: {
          cameraTrolls: [{
            kind: state.kind,
            active: state.active,
            zoom: state.zoom,
            flipped: state.flipped,
            offsetX: state.offsetX,
            offsetY: state.offsetY,
            lagFrames: state.lagFrames,
          }],
          fakeUiStates: [],
        },
      };
    },
    reset() {
      state = createCameraTroll(kind, intensity);
      triggered = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake UI adapter
// ---------------------------------------------------------------------------

import {
  createFakeUi,
  stepFakeUi,
  triggerFakeUi,
  type FakeUiState,
  type FakeUiKind,
} from './fake-ui';

export function createFakeUiMechanic(entry: MechanicEntry): MechanicInstance {
  const seed = optNumber(entry.params, 'seed') ?? 42;
  const kind = (reqString(entry.params, 'kind')) as FakeUiKind;
  const durationSteps = optNumber(entry.params, 'durationSteps') ?? 120;

  let state: FakeUiState = createFakeUi(seed);
  let triggered = false;

  return {
    id: entry.id,
    type: entry.type,
    step(_ctx) {
      if (!triggered) {
        state = triggerFakeUi(state, kind, durationSteps);
        triggered = true;
      }
      state = stepFakeUi(state, 1);
      return {
        cosmeticState: {
          cameraTrolls: [],
          fakeUiStates: [{
            kind: state.kind,
            active: state.active,
            timer: state.timer,
          }],
        },
      };
    },
    reset() {
      state = createFakeUi(seed);
      triggered = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Buzzsaw adapter
// ---------------------------------------------------------------------------

import {
  createBuzzsaw,
  resetBuzzsaw,
  stepBuzzsaw,
  type Buzzsaw,
  type PatrolPath,
} from './buzzsaw';

export function createBuzzsawMechanic(entry: MechanicEntry): MechanicInstance {
  const radius = reqNumber(entry.params, 'radius');
  const waypoints = reqPointArray(entry.params, 'waypoints');
  const speed = reqNumber(entry.params, 'speed');
  const pingpong = optBoolean(entry.params, 'pingpong', false);

  const path: PatrolPath = { waypoints, speed, pingpong };
  let saw: Buzzsaw = createBuzzsaw(radius, path);

  return {
    id: entry.id,
    type: entry.type,
    step(_ctx) {
      saw = stepBuzzsaw(saw, 1);
      return {
        hazardsToAdd: [{
          x: saw.x - saw.radius,
          y: saw.y - saw.radius,
          width: saw.radius * 2,
          height: saw.radius * 2,
        }],
      };
    },
    reset() {
      saw = resetBuzzsaw(saw);
    },
  };
}

// ---------------------------------------------------------------------------
// Rotating arm adapter
// ---------------------------------------------------------------------------

import {
  createRotatingArm,
  getBladeAABB,
  resetRotatingArm,
  stepRotatingArm,
  type RotatingArm,
} from './rotating-arm';

export function createRotatingArmMechanic(entry: MechanicEntry): MechanicInstance {
  const pivotX = reqNumber(entry.params, 'pivotX');
  const pivotY = reqNumber(entry.params, 'pivotY');
  const length = reqNumber(entry.params, 'length');
  const angularSpeed = reqNumber(entry.params, 'angularSpeed');
  const initialAngle = optNumber(entry.params, 'initialAngle') ?? 0;

  let arm: RotatingArm = createRotatingArm(pivotX, pivotY, length, angularSpeed, initialAngle);

  return {
    id: entry.id,
    type: entry.type,
    step(_ctx) {
      arm = stepRotatingArm(arm, 1);
      const blade = getBladeAABB(arm);
      return {
        hazardsToAdd: [{
          x: blade.x,
          y: blade.y,
          width: blade.width,
          height: blade.height,
        }],
      };
    },
    reset() {
      arm = resetRotatingArm(arm, initialAngle);
    },
  };
}

// ---------------------------------------------------------------------------
// Bomb adapter
// ---------------------------------------------------------------------------

import {
  createBomb,
  getBlastArea,
  stepBomb,
  type Bomb,
} from './bomb';

export function createBombMechanic(entry: MechanicEntry): MechanicInstance {
  const x = reqNumber(entry.params, 'x');
  const y = reqNumber(entry.params, 'y');
  const fuseSteps = reqNumber(entry.params, 'fuseSteps');
  const blastRadius = reqNumber(entry.params, 'blastRadius');
  const destroyTerrain = optBoolean(entry.params, 'destroyTerrain', false);

  let bomb: Bomb = createBomb(x, y, fuseSteps, blastRadius, destroyTerrain);

  return {
    id: entry.id,
    type: entry.type,
    step(_ctx) {
      bomb = stepBomb(bomb, 1);
      if (bomb.exploded) {
        const blast = getBlastArea(bomb);
        return {
          hazardsToAdd: [{
            x: blast.x,
            y: blast.y,
            width: blast.width,
            height: blast.height,
          }],
        };
      }
      return {};
    },
    reset() {
      bomb = createBomb(x, y, fuseSteps, blastRadius, destroyTerrain);
    },
  };
}

// ---------------------------------------------------------------------------
// Token adapter
// ---------------------------------------------------------------------------

import {
  createTokens,
  resetTokens,
  stepTokens,
  type TokenCollectionState,
} from './token';

export function createTokenMechanic(entry: MechanicEntry): MechanicInstance {
  const positions = reqPointArray(entry.params, 'positions');

  let tokens: TokenCollectionState = createTokens(positions);

  return {
    id: entry.id,
    type: entry.type,
    step(ctx) {
      tokens = stepTokens(tokens, ctx.body);
      return {};
    },
    reset() {
      tokens = resetTokens(tokens);
    },
  };
}
