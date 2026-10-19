// Vanishing floor trap (#14): floor tiles that look ordinary and disappear
// on a trigger.
//
// Lifecycle (deterministic, per arm cycle):
//   fuse  -> vanished -> done (terminal)
//
// Timing. For an on-timer trigger the authored delaySteps is consumed by the
// trigger threshold in evaluate(), so apply() vanishes the tiles on its first
// call: the floor disappears at exactly the authored delay measured from
// level start. For on-land / on-approach triggers, whose evaluate() ignores
// delaySteps, the authored delay is applied as a post-trigger fuse here: the
// floor disappears at exactly the authored delay measured from the trigger.
//
// Restoration. Each target tile's original Tile value is recorded at vanish
// time and replayed on restore, so OneWay, Empty (pit) and Hazard tiles
// return as authored rather than being forced to Solid. A body parked over a
// tile defers that tile's restore until the body clears it, so the player is
// never embedded in a freshly restored solid. Restoration happens at most
// once; afterwards the trap is terminal and apply() no-ops.

import type { TilePosition } from '../../levels/types';
import { Tile } from '../../engine/physics';
import { aabbOverlap } from '../../engine/physics';
import type { AABB, Body } from '../../engine/physics';
import type { TrapEntry } from '../../levels/types';
import type { TrapInstance, WorldState } from '../types';
import { registerTrapType } from '../registry';
import {
  buildTriggerContext,
  reqNumber,
  reqTileArray,
  optBoolean,
  optNumber,
} from './helpers';

const TILE_SIZE = 16;

type Phase = 'fuse' | 'vanished' | 'done';

interface VanishingFloorState {
  tiles: TilePosition[];
  fuseSteps: number;         // 0 for on-timer (delay spent by the threshold)
  returns: boolean;
  returnDelaySteps: number;
  phase: Phase;
  fuseCount: number;         // apply() calls since the trigger fired, minus one
  waitCount: number;         // apply() calls since the tiles vanished
  originals: number[];       // Tile value recorded per target tile at vanish
  restoredFlags: boolean[];  // per target tile: already put back
}

/**
 * Computes the bounding AABB covering all target tiles.
 */
function tilesBounds(tiles: readonly TilePosition[]): AABB {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    const x = t.col * TILE_SIZE;
    const y = t.row * TILE_SIZE;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + TILE_SIZE);
    maxY = Math.max(maxY, y + TILE_SIZE);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Euclidean-ish distance from the player body to the nearest edge of an AABB.
 * Returns 0 if overlapping.
 */
function bodyDistance(body: Body, aabb: AABB): number {
  const dx = Math.max(aabb.x - (body.x + body.width), body.x - (aabb.x + aabb.width), 0);
  const dy = Math.max(aabb.y - (body.y + body.height), body.y - (aabb.y + aabb.height), 0);
  return Math.sqrt(dx * dx + dy * dy);
}

function tileRect(t: TilePosition): AABB {
  return { x: t.col * TILE_SIZE, y: t.row * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE };
}

export function createVanishingFloor(entry: TrapEntry): TrapInstance {
  const trigger = buildTriggerContext(entry.trigger, entry.params);
  const tiles = reqTileArray(entry.params, 'tiles');
  const delaySteps = reqNumber(entry.params, 'delaySteps');
  const returns = optBoolean(entry.params, 'returns', false);
  const returnDelaySteps = optNumber(entry.params, 'returnDelaySteps') ?? 0;

  const bounds = tilesBounds(tiles);

  const state: VanishingFloorState = {
    tiles,
    // An on-timer trigger already waits delaySteps before evaluate() returns
    // true; any further fuse would double the authored delay.
    fuseSteps: trigger.kind === 'on-timer' ? 0 : delaySteps,
    returns,
    returnDelaySteps,
    phase: 'fuse',
    fuseCount: 0,
    waitCount: 0,
    originals: [],
    restoredFlags: [],
  };

  function evaluateImpl(this: TrapInstance, world: WorldState, _step: number): boolean {
    void _step;
    switch (this.trigger.kind) {
      case 'on-land':
        // Player just transitioned from airborne to grounded within the tile region.
        if (!world.playerBody.grounded || world.playerPrevGrounded) return false;
        return aabbOverlap(world.playerBody, bounds);

      case 'on-approach': {
        const dist = this.trigger.distance ?? 0;
        return bodyDistance(world.playerBody, bounds) < dist;
      }

      case 'on-timer': {
        const threshold = this.trigger.delaySteps ?? 0;
        return this.stepsSinceArm >= threshold;
      }

      default:
        return false;
    }
  }

  /** Records the authored tile values, then empties every target tile. */
  function vanish(world: WorldState): void {
    state.originals = [];
    state.restoredFlags = [];
    state.tiles.forEach((t) => {
      const idx = t.row * world.cols + t.col;
      const inRange = idx >= 0 && idx < world.tiles.length;
      state.originals.push(inRange ? (world.tiles[idx] ?? Tile.Solid) : Tile.Solid);
      state.restoredFlags.push(false);
      if (inRange) {
        world.tiles[idx] = Tile.Empty;
      }
    });
  }

  /**
   * Replays the recorded originals, skipping any tile whose rect currently
   * overlaps the player. Returns true once every tile is back.
   */
  function restore(world: WorldState): boolean {
    let allRestored = true;
    state.tiles.forEach((t, k) => {
      if (state.restoredFlags[k]) return;
      const idx = t.row * world.cols + t.col;
      if (idx < 0 || idx >= world.tiles.length) {
        state.restoredFlags[k] = true;
        return;
      }
      if (aabbOverlap(world.playerBody, tileRect(t))) {
        // Never restore a solid into the player's body; retry next step.
        allRestored = false;
        return;
      }
      world.tiles[idx] = state.originals[k] ?? Tile.Solid;
      state.restoredFlags[k] = true;
    });
    return allRestored;
  }

  function applyImpl(this: TrapInstance, world: WorldState): void {
    void this;

    if (state.phase === 'done') {
      // Terminal: the runtime's animation pass keeps calling apply() safely.
      return;
    }

    if (state.phase === 'fuse') {
      if (state.fuseCount < state.fuseSteps) {
        state.fuseCount++;
        return;
      }
      vanish(world);
      state.waitCount = 0;
      // A floor that never returns is finished the moment it vanishes.
      state.phase = state.returns ? 'vanished' : 'done';
      return;
    }

    // phase === 'vanished'
    state.waitCount++;
    if (state.waitCount >= state.returnDelaySteps) {
      if (restore(world)) {
        state.phase = 'done';
      }
    }
  }

  function resetImpl(this: TrapInstance): void {
    this.armed = true;
    this.fired = false;
    this.stepsSinceArm = 0;
    state.phase = 'fuse';
    state.fuseCount = 0;
    state.waitCount = 0;
    state.originals = [];
    state.restoredFlags = [];
  }

  return {
    id: entry.id,
    type: entry.type,
    trigger,
    armed: true,
    fired: false,
    stepsSinceArm: 0,
    evaluate: evaluateImpl,
    apply: applyImpl,
    reset: resetImpl,
  };
}

export function registerVanishingFloor(): void {
  registerTrapType('vanishing-floor', createVanishingFloor);
}
