// Core types for the mechanic system. No logic lives here; this module is the
// vocabulary the registry, runtime, and concrete mechanic adapters speak.
//
// Unlike traps (which evaluate→fire→apply once per arm cycle), mechanics are
// CONTINUOUS: they step every frame and optionally emit effects that the
// runtime collects and applies in a deterministic order.
//
// Dependency direction: src/mechanics/ sits above src/engine/ and src/levels/
// and may import from both. Neither engine nor levels may import from mechanics.

import type { Body } from '../engine/physics';
import type { ControllerActions } from '../engine/controller';
import type { HazardRect } from '../engine/levelAdapter';
import type { DynamicSolid } from '../traps/types';

// ---------------------------------------------------------------------------
// Context passed to every mechanic each step
// ---------------------------------------------------------------------------

/**
 * Snapshot of player body + input state available to every mechanic each
 * step. The runtime constructs this before calling `.step()`.
 */
export interface MechanicContext {
  readonly body: Body;
  readonly actions: ControllerActions;
  readonly step: number;
}

// ---------------------------------------------------------------------------
// Result emitted by a mechanic each step
// ---------------------------------------------------------------------------

/**
 * What a mechanic wants the runtime to apply after stepping. All fields are
 * optional—a mechanic that has no effect this frame returns `{}`.
 *
 * Merge semantics (handled by the runtime):
 *  - `bodyOverride`: last writer wins (teleporter overrides spring).
 *  - `velocityMod`: accumulated additively across mechanics.
 *  - `actionsOverride`: last writer wins (typically only one input modifier).
 *  - `dynamicSolids` / `hazardsToAdd`: concatenated into the published arrays.
 *  - `cosmeticState`: stored for the renderer; does not affect physics.
 */
export interface MechanicStepResult {
  readonly bodyOverride?: Body;
  readonly velocityMod?: { x?: number; y?: number };
  readonly actionsOverride?: ControllerActions;
  readonly dynamicSolids?: DynamicSolid[];
  readonly hazardsToAdd?: HazardRect[];
  readonly cosmeticState?: CosmeticEffect;
}

// ---------------------------------------------------------------------------
// Published overrides (merged by the runtime each step)
// ---------------------------------------------------------------------------

/**
 * Additive velocity modification published by the runtime. `x` and `y` are
 * summed across every mechanic that emitted a `velocityMod` this step, so two
 * thrust sources stack. Zero means "no modification".
 */
export interface VelocityMod {
  readonly x: number;
  readonly y: number;
}

/**
 * Small, non-additive overrides merged from every mechanic step result and
 * published on the runtime each step (cleared like the other buffers).
 *
 * Merge semantics:
 *  - `bodyOverride`: last writer wins in declaration order.
 *  - `velocityMod`: accumulated additively across mechanics.
 *  - `actionsOverride`: last writer wins (typically only one input modifier).
 */
export interface PublishedOverrides {
  readonly bodyOverride?: Body;
  readonly velocityMod: VelocityMod;
  readonly actionsOverride?: ControllerActions;
}

// ---------------------------------------------------------------------------
// Contact hooks (post-resolve, runtime-owned)
// ---------------------------------------------------------------------------

/**
 * Result of a mechanic's post-resolve contact check. `halts` means the contact
 * pass stops after applying this body (a relocation happened); springs leave
 * it false so a later spring in declaration order may still fire.
 */
export interface MechanicContact {
  readonly body: Body;
  readonly halts: boolean;
}

/**
 * Pairing token for relocation mechanics (teleporters). The runtime links an
 * instance whose `dest` token equals another instance's `origin` token and
 * whose own `origin` token equals that instance's `dest`, so a relocation can
 * cool its twin. `origin`/`dest` are stable coordinate strings.
 */
export interface MechanicPairKey {
  readonly origin: string;
  readonly dest: string;
}

// ---------------------------------------------------------------------------
// Cosmetic effects (stored for renderer, no physics impact)
// ---------------------------------------------------------------------------

export interface CosmeticEffect {
  readonly cameraTrolls?: CameraTrollSnapshot[];
  readonly fakeUiStates?: FakeUiSnapshot[];
}

export interface CameraTrollSnapshot {
  readonly kind: string;
  readonly active: boolean;
  readonly zoom: number;
  readonly flipped: boolean;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly lagFrames: number;
}

export interface FakeUiSnapshot {
  readonly kind: string;
  readonly active: boolean;
  readonly timer: number;
}

// ---------------------------------------------------------------------------
// Mechanic instance and factory
// ---------------------------------------------------------------------------

/**
 * A mechanic instance: created from a {@link MechanicEntry} by a registered
 * factory. The runtime calls `step()` EVERY frame (unlike traps which
 * evaluate triggers). `reset()` restores initial state for respawn.
 *
 * Implementations MUST be deterministic: no Math.random, no Date.now, no
 * wall-clock dependencies. Same context + same step => same result.
 */
export interface MechanicInstance {
  readonly id: string;
  readonly type: string;
  step(ctx: MechanicContext): MechanicStepResult;
  /**
   * Optional post-resolve contact hook. The runtime calls it with the RESOLVED
   * post-move body after the controller step, in declaration order. A returned
   * body replaces the current one; the pass stops early when `halts` is true.
   * Persistent cooldowns live in the instance, not in rebuilt params.
   */
  contact?(body: Body): MechanicContact | null;
  /**
   * Optional pairing token. The runtime links two instances whose origin/dest
   * tokens mirror each other at construction (deterministic, declaration
   * order). Pairing is a runtime concern; adapters just declare the geometry.
   */
  readonly pairKey?: MechanicPairKey;
  /** Optional: receive the paired twin instance. Called once at construction. */
  linkTwin?(twin: MechanicInstance): void;
  /** Optional: apply an external cooldown (a paired twin relocated). */
  cool?(steps: number): void;
  reset(): void;
}

/**
 * Factory: creates a {@link MechanicInstance} from a {@link MechanicEntry}.
 * Registered with the global registry by concrete mechanic adapter packages.
 */
export type MechanicFactory = (
  entry: import('../levels/types').MechanicEntry,
) => MechanicInstance;
