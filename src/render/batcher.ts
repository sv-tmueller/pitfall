// Thin blitter: the ONLY module that touches a canvas context.
// Takes a pure RenderModel and flushes it to the canvas. Tested with a
// minimal tracking mock that records method calls.
//
// BlitContext is a structural subset of CanvasRenderingContext2D so this
// module compiles under tsconfig.tools.json (which omits the DOM lib).
// A real CanvasRenderingContext2D satisfies it structally.

import type { AtlasFrame } from './atlas';
import type { LoadedAtlas } from './atlas-loader';
import type { RenderModel } from './model';
import { PALETTE } from './palette';
import { BASE_HEIGHT, BASE_WIDTH } from '../scale';

/** Structural subset of CanvasRenderingContext2D used by the blitter. */
export interface BlitContext {
  fillStyle: string;
  font: string;
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
}

export function flushModel(
  ctx: BlitContext,
  model: RenderModel,
  atlas: LoadedAtlas,
): void {
  // Nearest-neighbor sampling: fractional dest coords must not blur pixels.
  ctx.imageSmoothingEnabled = false;

  // Clear first, filling the entire backbuffer with the clear color.
  ctx.fillStyle = PALETTE[model.clear];
  ctx.fillRect(0, 0, BASE_WIDTH, BASE_HEIGHT);

  for (const layer of model.layers) {
    // Fill rects first, then blit sprites, within each layer.
    for (const rect of layer.rects) {
      ctx.fillStyle = PALETTE[rect.color];
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }

    for (const sprite of layer.sprites) {
      const frame: AtlasFrame | undefined = atlas.frame[sprite.frame];
      if (frame === undefined) continue;

      if (sprite.flipX) {
        ctx.save();
        ctx.translate(sprite.dstX + frame.w, sprite.dstY);
        ctx.scale(-1, 1);
        ctx.drawImage(
          atlas.bitmap,
          frame.x,
          frame.y,
          frame.w,
          frame.h,
          0,
          0,
          frame.w,
          frame.h,
        );
        ctx.restore();
      } else {
        ctx.drawImage(
          atlas.bitmap,
          frame.x,
          frame.y,
          frame.w,
          frame.h,
          sprite.dstX,
          sprite.dstY,
          frame.w,
          frame.h,
        );
      }
    }

    // Flush text elements (HUD layer).
    for (const txt of layer.texts) {
      ctx.font = '8px monospace';
      ctx.fillStyle = PALETTE[txt.color];
      ctx.fillText(txt.text, txt.x, txt.y);
    }
  }
}
