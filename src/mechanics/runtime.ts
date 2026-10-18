// Mechanics runtime: owns the array of active MechanicInstances and the
// published effect buffers consumed by the scene each step. Unlike the trap
// runtime (which evaluates triggers and fires once per arm cycle), mechanics
// are CONTINUOUS: every mechanic is stepped every frame and optionally emits
// a MechanicStepResult. The runtime collects all emitted results and merges
// them in a deterministic order.
//
// Determinism contract: given identical (body, actions, step) inputs,
// stepMechanics produces identical published state. No Math.random, no
// Date.now, no wall-clock dependencies anywhere in this module or in
// mechanic implementations.
//
// Merge semantics (per MechanicStepResult):
//   - bodyOverride: last writer wins (teleporter overrides spring).
//   - velocityMod: accumulated additively across mechanics.
//   - actionsOverride: last writer wins (typically only one input modifier).
//   - dynamicSolids / hazardsToAdd: concatenated into the published arrays.
//   - cosmeticState: aggregated into cosmeticEffects for the renderer.

import type { Body } from '../engine/physics';
import type { ControllerActions } from '../engine/controller';
import type { HazardRect } from '../engine/levelAdapter';
import type { LevelData } from '../levels/types';
import type { DynamicSolid } from '../traps/types';
import { createMechanic } from './registry';
import type {
  CosmeticEffect,
  MechanicContext,
  MechanicInstance,
  MechanicStepResult,
  PublishedOverrides,
  VelocityMod,
} from './types';

export interface MechanicsRuntime {
  readonly level: LevelData;
  mechanics: MechanicInstance[];
  /** Dynamic solids published this step (consumed by scene, cleared each step). */
  publishedSolids: DynamicSolid[];
  /** Hazards published this step (consumed by scene, cleared each step). */
  publishedHazards: HazardRect[];
  /**
   * Overrides merged from every mechanic step result this step (consumed by
   * scene, cleared each step). Body and action overrides are last-writer-wins;
   * the velocity modification is additive.
   */
  publishedOverrides: PublishedOverrides;
  /** Aggregated cosmetic effects published this step (for renderer). */
  cosmeticEffects: CosmeticEffect;
}

function emptyOverrides(): PublishedOverrides {
  return { velocityMod: { x: 0, y: 0 } };
}

/**
 * Links paired relocation mechanics at construction. Two instances pair when
 * one's `pairKey.dest` equals the other's `pairKey.origin` and vice versa.
 * The first instance to claim an origin token wins, so the pairing is
 * deterministic under declaration order.
 */
function linkTwinPairs(mechanics: readonly MechanicInstance[]): void {
  const byOrigin = new Map<string, MechanicInstance>();
  for (const mech of mechanics) {
    const key = mech.pairKey;
    if (key === undefined) continue;
    if (!byOrigin.has(key.origin)) byOrigin.set(key.origin, mech);
  }
  for (const mech of mechanics) {
    const key = mech.pairKey;
    if (key === undefined) continue;
    const twin = byOrigin.get(key.dest);
    if (twin === undefined || twin === mech) continue;
    const twinKey = twin.pairKey;
    if (twinKey === undefined || twinKey.dest !== key.origin) continue;
    mech.linkTwin?.(twin);
  }
}

/**
 * Constructs the mechanics runtime from a level: instantiates every mechanic
 * declared in `level.mechanics` via the registry. Levels without a mechanics
 * field produce an empty (inert) runtime — no behavioural change.
 *
 * Call `registerAllMechanicTypes()` at module load (done in scene.ts) so the
 * registry can resolve every mechanic type a level declares.
 */
export function createMechanicsRuntime(
  level: LevelData,
  _initialBody: Body,
): MechanicsRuntime {
  const entries = level.mechanics ?? [];
  const mechanics = entries.map(createMechanic);
  linkTwinPairs(mechanics);

  return {
    level,
    mechanics,
    publishedSolids: [],
    publishedHazards: [],
    publishedOverrides: emptyOverrides(),
    cosmeticEffects: { cameraTrolls: [], fakeUiStates: [] },
  };
}

/**
 * Advances the mechanics system one step. Calls `.step(ctx)` on every
 * mechanic in DECLARATION ORDER (fixed = deterministic), collects all
 * MechanicStepResults, and merges them into the published buffers.
 *
 * Clear-before-step semantics: publishedSolids, publishedHazards, and
 * cosmeticEffects are replaced wholesale each step (they represent the
 * current frame's state, not an accumulation across frames).
 *
 * The runtime mutates the runtime object in place and returns the same
 * reference for convenience (mirrors stepTraps).
 */
export function stepMechanics(
  runtime: MechanicsRuntime,
  body: Body,
  actions: ControllerActions,
  step: number,
): MechanicsRuntime {
  // Clear published buffers for this frame.
  runtime.publishedSolids = [];
  runtime.publishedHazards = [];

  const cameraTrolls = [];
  const fakeUiStates = [];

  const ctx: MechanicContext = { body, actions, step };

  // Override merge accumulators (see merge semantics above).
  let bodyOverride: Body | undefined;
  let actionsOverride: ControllerActions | undefined;
  const velocityMod: { x: number; y: number } = { x: 0, y: 0 };

  for (const mech of runtime.mechanics) {
    const result: MechanicStepResult = mech.step(ctx);

    // Concatenate dynamic solids.
    if (result.dynamicSolids !== undefined && result.dynamicSolids.length > 0) {
      runtime.publishedSolids.push(...result.dynamicSolids);
    }

    // Concatenate hazards.
    if (result.hazardsToAdd !== undefined && result.hazardsToAdd.length > 0) {
      runtime.publishedHazards.push(...result.hazardsToAdd);
    }

    // Merge overrides: body/actions last writer wins, velocity additive.
    if (result.bodyOverride !== undefined) {
      bodyOverride = result.bodyOverride;
    }
    if (result.actionsOverride !== undefined) {
      actionsOverride = result.actionsOverride;
    }
    if (result.velocityMod !== undefined) {
      velocityMod.x += result.velocityMod.x ?? 0;
      velocityMod.y += result.velocityMod.y ?? 0;
    }

    // Aggregate cosmetic snapshots.
    if (result.cosmeticState !== undefined) {
      if (result.cosmeticState.cameraTrolls !== undefined) {
        cameraTrolls.push(...result.cosmeticState.cameraTrolls);
      }
      if (result.cosmeticState.fakeUiStates !== undefined) {
        fakeUiStates.push(...result.cosmeticState.fakeUiStates);
      }
    }
  }

  runtime.cosmeticEffects = { cameraTrolls, fakeUiStates };
  runtime.publishedOverrides = buildOverrides(bodyOverride, actionsOverride, velocityMod);

  return runtime;
}

function buildOverrides(
  bodyOverride: Body | undefined,
  actionsOverride: ControllerActions | undefined,
  velocityMod: { x: number; y: number },
): PublishedOverrides {
  const mod: VelocityMod = { x: velocityMod.x, y: velocityMod.y };
  return {
    velocityMod: mod,
    ...(bodyOverride !== undefined ? { bodyOverride } : {}),
    ...(actionsOverride !== undefined ? { actionsOverride } : {}),
  };
}

/**
 * Post-resolve contact pass owned by the runtime. Runs each mechanic's
 * optional `contact()` hook against the RESOLVED post-move body, in
 * declaration order (deterministic), returning the merged body. A hook flagged
 * `halts` (a relocation) skips any REMAINING hook sharing its
 * `contactCategory` for the rest of the step, so a second teleporter cannot
 * chain off the first while an unrelated spring still fires on the relocated
 * body. Persistent cooldowns and contact arming live in the instances, so the
 * pass itself is stateless here.
 */
export function applyMechanicContacts(
  runtime: MechanicsRuntime,
  body: Body,
): Body {
  let current = body;
  // Categories whose halting hook has already run this step.
  const haltedCategories = new Set<string>();
  for (const mech of runtime.mechanics) {
    const hook = mech.contact;
    if (hook === undefined) continue;
    const category = mech.contactCategory ?? '';
    if (haltedCategories.has(category)) continue;
    const contact = hook.call(mech, current);
    if (contact === null) continue;
    current = contact.body;
    if (contact.halts) haltedCategories.add(category);
  }
  return current;
}

/**
 * Resets every mechanic to its initial state for respawn. Does NOT rebuild
 * the mechanic list (same instances, freshly reset). Published buffers are
 * cleared.
 */
export function resetMechanics(
  runtime: MechanicsRuntime,
  _body: Body,
): MechanicsRuntime {
  for (const mech of runtime.mechanics) {
    mech.reset();
  }
  runtime.publishedSolids = [];
  runtime.publishedHazards = [];
  runtime.publishedOverrides = emptyOverrides();
  runtime.cosmeticEffects = { cameraTrolls: [], fakeUiStates: [] };
  return runtime;
}
