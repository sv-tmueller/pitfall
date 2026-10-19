import { describe, expect, it } from 'vitest';
import atlasManifest from '../../assets/atlas.json';
import { loadAtlas, type BitmapLike } from './atlas-loader';
import { flushModel, type BlitContext } from './batcher';
import type { RenderModel } from './model';
import type { AtlasManifest } from './atlas';

const MANIFEST = atlasManifest as unknown as AtlasManifest;
const BITMAP: BitmapLike = { width: 128, height: 40 };
const ATLAS = loadAtlas(MANIFEST, BITMAP);

/**
 * Minimal tracking mock: records every method call with its arguments.
 * Does NOT implement a pixel framebuffer -- just call recording.
 */
interface RecordedCall {
  method: string;
  args: unknown[];
}

function createMockCtx(): BlitContext & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const proxy: BlitContext & { calls: RecordedCall[] } = {
    calls,
    fillStyle: '',
    font: '',
    imageSmoothingEnabled: true,
    drawImage: (...args: unknown[]) => calls.push({ method: 'drawImage', args }),
    fillRect: (...args: unknown[]) => calls.push({ method: 'fillRect', args }),
    fillText: (...args: unknown[]) => calls.push({ method: 'fillText', args }),
    save: () => calls.push({ method: 'save', args: [] }),
    restore: () => calls.push({ method: 'restore', args: [] }),
    translate: (...args: unknown[]) =>
      calls.push({ method: 'translate', args }),
    scale: (...args: unknown[]) => calls.push({ method: 'scale', args }),
  };

  return proxy;
}

function findCalls(ctx: { calls: RecordedCall[] }, method: string): RecordedCall[] {
  return ctx.calls.filter((c) => c.method === method);
}

describe('flushModel', () => {
  it('disables image smoothing on the blit context', () => {
    const ctx = createMockCtx();
    const model: RenderModel = {
      clear: 'void',
      layers: [],
    };

    flushModel(ctx, model, ATLAS);

    expect(ctx.imageSmoothingEnabled).toBe(false);
  });

  it('clears the backbuffer first with the clear color', () => {
    const ctx = createMockCtx();
    const model: RenderModel = {
      clear: 'void',
      layers: [{ kind: 'world', sprites: [], rects: [], texts: [] }],
    };

    flushModel(ctx, model, ATLAS);

    // First meaningful call should be a fillRect for the clear.
    const fillRects = findCalls(ctx, 'fillRect');
    expect(fillRects.length).toBeGreaterThanOrEqual(1);
    const clearCall = fillRects[0]!;
    expect(clearCall.args).toEqual([0, 0, 320, 180]);

    // fillStyle should have been set to the void palette color before the clear.
    // We check the sequence: fillStyle assignment precedes fillRect.
    // Since fillStyle is a property setter on our mock, we check the value
    // was set. Our mock stores it, so:
    expect((ctx as unknown as Record<string, unknown>).fillStyle).toBe(
      '#05050a',
    );
  });

  it('blits a sprite via drawImage with correct source and dest rects', () => {
    const ctx = createMockCtx();
    const model: RenderModel = {
      clear: 'void',
      layers: [
        {
          kind: 'world',
          sprites: [
            {
              frame: 'tile.solid.top',
              dstX: 10,
              dstY: 20,
              flipX: false,
            },
          ],
          rects: [],
          texts: [],
        },
      ],
    };

    flushModel(ctx, model, ATLAS);

    const draws = findCalls(ctx, 'drawImage');
    expect(draws).toHaveLength(1);

    // drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)
    const args = draws[0]!.args;
    // Source rect: tile.solid.top is at x=0, y=24, w=16, h=16
    expect(args[1]).toBe(0); // sx
    expect(args[2]).toBe(24); // sy
    expect(args[3]).toBe(16); // sw
    expect(args[4]).toBe(16); // sh
    // Dest rect: dstX=10, dstY=20, dw=16, dh=16
    expect(args[5]).toBe(10); // dx
    expect(args[6]).toBe(20); // dy
    expect(args[7]).toBe(16); // dw
    expect(args[8]).toBe(16); // dh
  });

  it('flips sprites via save/translate/scale(-1,1)/restore bracket', () => {
    const ctx = createMockCtx();
    const model: RenderModel = {
      clear: 'void',
      layers: [
        {
          kind: 'entities',
          sprites: [
            {
              frame: 'player.idle.0',
              dstX: 100,
              dstY: 50,
              flipX: true,
            },
          ],
          rects: [],
          texts: [],
        },
      ],
    };

    flushModel(ctx, model, ATLAS);

    const saves = findCalls(ctx, 'save');
    const restores = findCalls(ctx, 'restore');
    const scales = findCalls(ctx, 'scale');
    const translates = findCalls(ctx, 'translate');

    expect(saves).toHaveLength(1);
    expect(restores).toHaveLength(1);
    expect(scales).toHaveLength(1);
    expect(translates).toHaveLength(1);

    // translate(dstX + frameW, dstY) = (100 + 16, 50) = (116, 50)
    expect(translates[0]!.args).toEqual([116, 50]);
    // scale(-1, 1)
    expect(scales[0]!.args).toEqual([-1, 1]);

    // drawImage inside the transform: dest is (0, 0) since translated.
    const draws = findCalls(ctx, 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0]!.args[5]).toBe(0); // dx
    expect(draws[0]!.args[6]).toBe(0); // dy
  });

  it('fills rects before sprites within a layer', () => {
    const ctx = createMockCtx();
    const model: RenderModel = {
      clear: 'void',
      layers: [
        {
          kind: 'world',
          sprites: [
            {
              frame: 'tile.solid.top',
              dstX: 0,
              dstY: 0,
              flipX: false,
            },
          ],
          rects: [{ x: 0, y: 0, w: 320, h: 180, color: 'night' }],
          texts: [],
        },
      ],
    };

    flushModel(ctx, model, ATLAS);

    // Order: fillRect(clear), fillRect(rect), drawImage(sprite)
    const fillRects = findCalls(ctx, 'fillRect');
    const draws = findCalls(ctx, 'drawImage');

    expect(fillRects).toHaveLength(2); // clear + layer rect
    expect(draws).toHaveLength(1);

    // The layer rect fill should come before the drawImage.
    const rectIdx = ctx.calls.indexOf(fillRects[1]!);
    const drawIdx = ctx.calls.indexOf(draws[0]!);
    expect(rectIdx).toBeLessThan(drawIdx);
  });

  it('flushes layers in order: world, entities, effects', () => {
    const ctx = createMockCtx();
    const model: RenderModel = {
      clear: 'void',
      layers: [
        {
          kind: 'world',
          sprites: [
            { frame: 'tile.solid.top', dstX: 0, dstY: 0, flipX: false },
          ],
          rects: [],
          texts: [],
        },
        {
          kind: 'entities',
          sprites: [
            { frame: 'player.idle.0', dstX: 0, dstY: 0, flipX: false },
          ],
          rects: [],
          texts: [],
        },
        {
          kind: 'effects',
          sprites: [
            { frame: 'hazard.spikes', dstX: 0, dstY: 0, flipX: false },
          ],
          rects: [],
          texts: [],
        },
      ],
    };

    flushModel(ctx, model, ATLAS);

    const draws = findCalls(ctx, 'drawImage');
    expect(draws).toHaveLength(3);

    // World sprite drawn first, entities second, effects third.
    // Check the source x-coords: tile.solid.top sx=0, player.idle.0 sx=0,
    // hazard.spikes sx=48. But since two share sx=0, check sy:
    // tile.solid.top sy=24, player.idle.0 sy=0, hazard.spikes sy=24.
    // Better: check the bitmap arg (same) and the sy to distinguish.
    expect(draws[0]!.args[2]).toBe(24); // tile.solid.top sy=24
    expect(draws[1]!.args[2]).toBe(0); // player.idle.0 sy=0
    expect(draws[2]!.args[1]).toBe(48); // hazard.spikes sx=48
  });
});
