// Emerging spikes trap (#15): spikes that rise from surfaces on a trigger,
// becoming lethal only once extended. Over extendSteps steps a HazardRect
// grows from 0 to full 16px. If repeats=true, retracts over retractSteps
// then re-arms.
//
// Visual identity rule: the lethal accent appears only as the spike
// extends. A retracted spike is invisible as a threat.

import { Tile } from '../../engine/physics';
import { aabbOverlap } from '../../engine/physics';
import type { AABB, Body } from '../../engine/physics';
import type { TrapEntry } from '../../levels/types';
import type { TrapInstance, WorldState } from '../types';
import type { HazardRect } from '../../engine/levelAdapter';
import { registerTrapType } from '../registry';
import {
  buildTriggerContext,
  reqNumber,
  reqString,
  optBoolean,
  optNumber,
} from './helpers';

type Surface = 'floor' | 'wall' | 'ceiling';

const SURFACES: readonly Surface[] = ['floor', 'wall', 'ceiling'];

interface SpikesState {
  surface: Surface;
  col: number;
  row: number;
  extendSteps: number;
  retractSteps: number;
  repeats: boolean;
  // Lifecycle: 'idle' -> 'extending' -> 'extended' -> 'retracting' -> 'idle'
  phase: 'idle' | 'extending' | 'extended' | 'retracting';
  progress: number; // steps in current phase
  // Held reference to our own managed hazard rect, null when retracted.
  // Identity-based tracking: a sibling spike's splice shifts indices but
  // never invalidates this reference (index-based tracking orphaned rects).
  hazard: HazardRect | null;
}

const FULL_EXTENT = 16;

function tileAABB(col: number, row: number): AABB {
  return { x: col * 16, y: row * 16, width: 16, height: 16 };
}

function bodyDistance(body: Body, aabb: AABB): number {
  const dx = Math.max(aabb.x - (body.x + body.width), body.x - (aabb.x + aabb.width), 0);
  const dy = Math.max(aabb.y - (body.y + body.height), body.y - (aabb.y + aabb.height), 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Computes the hazard rect for a spike at a given extension fraction (0..1).
 * Growth direction depends on the surface:
 * - floor: grows upward from the bottom edge of the tile
 * - ceiling: grows downward from the top edge of the tile
 * - wall: grows rightward from the left edge of the tile
 */
function computeHazardRect(state: SpikesState, fraction: number): AABB {
  const tx = state.col * 16;
  const ty = state.row * 16;
  const extent = Math.round(FULL_EXTENT * fraction);

  switch (state.surface) {
    case 'floor':
      // Base at bottom (y + 16), grows up.
      return { x: tx, y: ty + 16 - extent, width: 16, height: extent };
    case 'ceiling':
      // Base at top (y), grows down.
      return { x: tx, y: ty, width: 16, height: extent };
    case 'wall':
      // Base at left (x), grows right.
      return { x: tx, y: ty, width: extent, height: 16 };
  }
}

export function createEmergingSpikes(entry: TrapEntry): TrapInstance {
  const trigger = buildTriggerContext(entry.trigger, entry.params);
  const surfaceStr = reqString(entry.params, 'surface');
  if (!SURFACES.includes(surfaceStr as Surface)) {
    throw new Error(`param "surface" must be floor, wall, or ceiling`);
  }
  const surface = surfaceStr as Surface;
  const col = reqNumber(entry.params, 'col');
  const row = reqNumber(entry.params, 'row');
  const extendSteps = reqNumber(entry.params, 'extendSteps');
  const repeats = optBoolean(entry.params, 'repeats', false);
  const retractSteps = optNumber(entry.params, 'retractSteps') ?? extendSteps;

  const spikeAABB = tileAABB(col, row);

  const state: SpikesState = {
    surface,
    col,
    row,
    extendSteps,
    retractSteps,
    repeats,
    phase: 'idle',
    progress: 0,
    hazard: null,
  };

  function evaluateImpl(this: TrapInstance, world: WorldState, _step: number): boolean {
    void _step;
    switch (this.trigger.kind) {
      case 'on-enter':
        return aabbOverlap(world.playerBody, spikeAABB);

      case 'on-approach': {
        const dist = this.trigger.distance ?? 0;
        return bodyDistance(world.playerBody, spikeAABB) < dist;
      }

      case 'on-timer': {
        const threshold = this.trigger.delaySteps ?? 0;
        return this.stepsSinceArm >= threshold;
      }

      default:
        return false;
    }
  }

  /**
   * Inserts or replaces this trap's managed hazard rect, tracking it by
   * object identity. Sibling spikes splicing their own rects out of the
   * shared world.hazards array cannot orphan it.
   */
  function upsertHazard(world: WorldState, rect: AABB): void {
    if (state.hazard !== null) {
      const idx = world.hazards.indexOf(state.hazard);
      if (idx >= 0) {
        world.hazards[idx] = rect;
        state.hazard = rect;
        return;
      }
    }
    world.hazards.push(rect);
    state.hazard = rect;
  }

  /** Removes this trap's managed hazard rect by identity, if present. */
  function removeHazard(world: WorldState): void {
    if (state.hazard !== null) {
      const idx = world.hazards.indexOf(state.hazard);
      if (idx >= 0) {
        world.hazards.splice(idx, 1);
      }
      state.hazard = null;
    }
  }

  function applyImpl(this: TrapInstance, world: WorldState): void {
    // Advance the lifecycle.
    if (state.phase === 'idle') {
      state.phase = 'extending';
      state.progress = 0;
    }

    if (state.phase === 'extending') {
      state.progress++;

      if (state.extendSteps <= 0) {
        state.progress = state.extendSteps;
      }

      const fraction = Math.min(state.progress / state.extendSteps, 1);
      const rect = computeHazardRect(state, fraction);

      if (fraction > 0) {
        upsertHazard(world, rect);
      }

      if (state.progress >= state.extendSteps) {
        state.phase = 'extended';
        state.progress = 0;
      }
      return;
    }

    if (state.phase === 'extended') {
      if (state.repeats) {
        state.phase = 'retracting';
        state.progress = 0;
        // Fall through to retracting logic for this step.
      } else {
        // Non-repeating: stays fully extended. Nothing to do.
        return;
      }
    }

    if (state.phase === 'retracting') {
      state.progress++;

      const fraction = Math.max(1 - state.progress / state.retractSteps, 0);
      const rect = computeHazardRect(state, fraction);

      if (fraction > 0) {
        upsertHazard(world, rect);
      } else {
        // Fully retracted: remove the hazard.
        removeHazard(world);
        state.phase = 'idle';
        state.progress = 0;
      }
    }
  }

  function resetImpl(this: TrapInstance): void {
    this.armed = true;
    this.fired = false;
    this.stepsSinceArm = 0;
    state.phase = 'idle';
    state.progress = 0;
    state.hazard = null;
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

export function registerEmergingSpikes(): void {
  registerTrapType('emerging-spikes', createEmergingSpikes);
}

// Reference Tile to satisfy potential future use; kept for consistency.
void Tile;
