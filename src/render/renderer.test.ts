import { describe, expect, it } from 'vitest';
import atlasManifest from '../../assets/atlas.json';
import { loadAtlas, type BitmapLike } from './atlas-loader';
import { renderFrame, type EntitySnapshot, type RenderContext } from './renderer';
import { computeCamera } from './camera';
import { loadLevel } from '../levels/load';
import { FIXTURE_SOURCES } from '../levels/fixtures';
import type { AtlasManifest } from './atlas';
import type { BlitContext } from './batcher';
import type { RenderWorld } from './model';

const MANIFEST = atlasManifest as unknown as AtlasManifest;
const BITMAP: BitmapLike = { width: 128, height: 40 };
const ATLAS = loadAtlas(MANIFEST, BITMAP);

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

const LEVEL = loadLevel(FIXTURE_SOURCES['corridor']);

/**
 * Builds a RenderWorld from a loaded LevelData, converting the static tile
 * grid into the physics-grid format the renderer expects (Hazard→Empty is
 * handled implicitly since corridor has no hazards).
 */
function worldFromLevel(level: typeof LEVEL): RenderWorld {
  return {
    cols: level.cols,
    rows: level.rows,
    tiles: level.tiles,
    exit: level.exit,
    hazards: [],
    dynamicSolids: [],
  };
}

describe('renderFrame', () => {
  it('renders a fixture level tile layer producing expected drawImage calls', () => {
    const ctx = createMockCtx();
    const camera = computeCamera(160, 90, LEVEL.cols * 16, LEVEL.rows * 16);

    const rc: RenderContext = {
      atlas: ATLAS,
      world: worldFromLevel(LEVEL),
      camera,
      entities: [],
      prevEntities: [],
      levelIndex: 0,
      particles: [],
      shakeOffset: { x: 0, y: 0 },
    };

    renderFrame(ctx, rc, 0);

    // Should have at least one fillRect (clear) and some drawImage calls
    // for the corridor's solid tiles.
    const fillRects = ctx.calls.filter((c) => c.method === 'fillRect');
    const draws = ctx.calls.filter((c) => c.method === 'drawImage');

    expect(fillRects.length).toBeGreaterThanOrEqual(1);
    expect(draws.length).toBeGreaterThan(0);
  });

  it('clears the backbuffer first', () => {
    const ctx = createMockCtx();
    const rc: RenderContext = {
      atlas: ATLAS,
      world: worldFromLevel(LEVEL),
      camera: { x: 0, y: 0 },
      entities: [],
      prevEntities: [],
      levelIndex: 0,
      particles: [],
      shakeOffset: { x: 0, y: 0 },
    };

    renderFrame(ctx, rc, 0);

    // First call should be a fillRect (the clear).
    expect(ctx.calls[0]!.method).toBe('fillRect');
    expect(ctx.calls[0]!.args).toEqual([0, 0, 320, 180]);
  });

  it('renders entity sprites with interpolated position at alpha=0.5', () => {
    const ctx = createMockCtx();
    const camera = { x: 0, y: 0 };

    const prevEnt: EntitySnapshot = {
      body: { x: 0, y: 0, width: 16, height: 24 },
      frame: 'player.idle.0',
      flipX: false,
    };
    const currEnt: EntitySnapshot = {
      body: { x: 100, y: 0, width: 16, height: 24 },
      frame: 'player.idle.0',
      flipX: false,
    };

    const rc: RenderContext = {
      atlas: ATLAS,
      world: worldFromLevel(LEVEL),
      camera,
      entities: [currEnt],
      prevEntities: [prevEnt],
      levelIndex: 0,
      particles: [],
      shakeOffset: { x: 0, y: 0 },
    };

    renderFrame(ctx, rc, 0.5);

    const draws = ctx.calls.filter((c) => c.method === 'drawImage');

    // Find the entity draw call (sy=0 distinguishes player from tiles).
    const entityDraws = draws.filter((c) => c.args[2] === 0);
    expect(entityDraws.length).toBeGreaterThan(0);

    // interpX = 0 + (100 - 0) * 0.5 = 50
    // origin.x = 0, camera.x = 0
    // dstX = 50 - 0 - 0 = 50
    const entDraw = entityDraws[entityDraws.length - 1]!;
    expect(entDraw.args[5]).toBe(50);
  });

  it('does not mutate the render context', () => {
    const ctx = createMockCtx();
    const camera = { x: 0, y: 0 };
    const entities: EntitySnapshot[] = [
      {
        body: { x: 50, y: 50, width: 16, height: 24 },
        frame: 'player.idle.0',
        flipX: false,
      },
    ];
    const prevEntities: EntitySnapshot[] = [
      {
        body: { x: 40, y: 50, width: 16, height: 24 },
        frame: 'player.idle.0',
        flipX: false,
      },
    ];

    const rc: RenderContext = {
      atlas: ATLAS,
      world: worldFromLevel(LEVEL),
      camera,
      entities,
      prevEntities,
      levelIndex: 0,
      particles: [],
      shakeOffset: { x: 0, y: 0 },
    };

    // Deep freeze-ish: record originals.
    const origCamX = rc.camera.x;
    const origCamY = rc.camera.y;
    const origEntX = rc.entities[0]!.body.x;
    const origPrevX = rc.prevEntities[0]!.body.x;

    renderFrame(ctx, rc, 0.5);

    expect(rc.camera.x).toBe(origCamX);
    expect(rc.camera.y).toBe(origCamY);
    expect(rc.entities[0]!.body.x).toBe(origEntX);
    expect(rc.prevEntities[0]!.body.x).toBe(origPrevX);
  });

  it('camera clamps at level edges', () => {
    // Corridor is 320x192. Requesting a center far right should clamp.
    const cam = computeCamera(9999, 90, LEVEL.cols * 16, LEVEL.rows * 16);
    // maxX = max(0, 320 - 320) = 0, so x = 0 regardless.
    // Actually corridor is 20 cols * 16 = 320 wide, so maxX = 0.
    expect(cam.x).toBe(0);

    // Shaft is 20 cols * 16 = 320 wide, 24 rows * 16 = 384 tall.
    const shaftLevel = loadLevel(FIXTURE_SOURCES['shaft']);
    const cam2 = computeCamera(9999, 9999, shaftLevel.cols * 16, shaftLevel.rows * 16);
    // maxX = max(0, 320 - 320) = 0
    // maxY = max(0, 384 - 180) = 204
    expect(cam2.x).toBe(0);
    expect(cam2.y).toBe(204);
  });

  it('displaces every draw by the nonzero shake offset', () => {
    // Guards the renderer's shakeOffset composition (renderer.ts composes
    // it after computeCamera); a regression zeroing that compose would pass
    // every other test, which all feed {x:0, y:0}.
    const steady = createMockCtx();
    const shaken = createMockCtx();
    const base: Omit<RenderContext, 'shakeOffset'> = {
      atlas: ATLAS,
      world: worldFromLevel(LEVEL),
      camera: { x: 0, y: 0 },
      entities: [],
      prevEntities: [],
      levelIndex: 0,
      particles: [],
    };
    renderFrame(steady, { ...base, shakeOffset: { x: 0, y: 0 } }, 0);
    renderFrame(shaken, { ...base, shakeOffset: { x: 3, y: -2 } }, 0);

    const steadyDraws = steady.calls.filter((c) => c.method === 'drawImage');
    const shakenDraws = shaken.calls.filter((c) => c.method === 'drawImage');
    expect(shakenDraws.length).toBe(steadyDraws.length);
    expect(shakenDraws.length).toBeGreaterThan(0);
    for (let i = 0; i < shakenDraws.length; i += 1) {
      const s = steadyDraws[i]!.args as number[];
      const k = shakenDraws[i]!.args as number[];
      // drawImage destination pair shifts by the NEGATED shake offset
      // (renderer composes camera + shake as pos - offset).
      expect(k[5]).toBe(s[5]! - 3);
      expect(k[6]).toBe(s[6]! + 2);
      expect(k[0]).toBe(s[0]);
      expect(k[1]).toBe(s[1]);
      expect(k[7]).toBe(s[7]);
      expect(k[8]).toBe(s[8]);
    }
  });
});
