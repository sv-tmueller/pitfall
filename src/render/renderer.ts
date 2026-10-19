// Top-level render entry point: composes the render model from a
// RenderContext + alpha, then delegates to flushModel. This is the only
// function a game loop needs to call each frame.

import type { LoadedAtlas } from './atlas-loader';
import { flushModel, type BlitContext } from './batcher';
import type { Camera } from './camera';
import { buildRenderModel, type EntitySnapshot, type RenderWorld } from './model';
import type { Particle } from '../effects/particles';

export type { EntitySnapshot, RenderWorld };

export interface RenderContext {
  readonly atlas: LoadedAtlas;
  readonly world: RenderWorld;
  readonly camera: Camera;
  readonly entities: readonly EntitySnapshot[];
  readonly prevEntities: readonly EntitySnapshot[];
  readonly levelIndex: number;
  /** Living particles, drawn as fill-rects in the effects layer. */
  readonly particles: readonly Particle[];
  /**
   * Screen-shake offset in whole pixels, added AFTER computeCamera has
   * clamped and rounded so shaking never reveals out-of-bounds area beyond
   * the intended jolt.
   */
  readonly shakeOffset: Readonly<{ x: number; y: number }>;
}

export function renderFrame(
  ctx: BlitContext,
  rc: RenderContext,
  alpha: number,
): void {
  const camera: Camera = {
    x: rc.camera.x + rc.shakeOffset.x,
    y: rc.camera.y + rc.shakeOffset.y,
  };
  const model = buildRenderModel(
    rc.world,
    camera,
    rc.entities,
    rc.prevEntities,
    alpha,
    rc.atlas,
    rc.levelIndex,
    rc.particles,
  );
  flushModel(ctx, model, rc.atlas);
}
