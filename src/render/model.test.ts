import { describe, expect, it } from 'vitest';
import atlasManifest from '../../assets/atlas.json';
import { loadAtlas, type BitmapLike } from './atlas-loader';
import {
  buildDynamicSolidRects,
  buildEffectsLayer,
  buildEntitySprites,
  buildHudLayer,
  buildRenderModel,
  buildTileLayer,
  interpolate,
  type DrawText,
  type EntitySnapshot,
  type RenderWorld,
} from './model';
import type { AtlasManifest } from './atlas';
import type { Vec2 } from '../engine/physics';
import type { TilePosition } from '../levels/types';
import type { HazardRect } from '../engine/levelAdapter';
import type { DynamicSolid } from '../traps/types';
import type { Particle } from '../effects/particles';

const MANIFEST = atlasManifest as unknown as AtlasManifest;
const BITMAP: BitmapLike = { width: 128, height: 40 };
const ATLAS = loadAtlas(MANIFEST, BITMAP);

/**
 * Builds a RenderWorld from string rows (chars = tile values) plus optional
 * hazards, dynamic solids, and exit position. Mirrors the old makeLevel
 * helper but produces a RenderWorld suitable for the new buildTileLayer /
 * buildRenderModel signatures.
 */
function makeWorld(
  rows: string[],
  opts?: {
    exit?: TilePosition;
    hazards?: HazardRect[];
    dynamicSolids?: DynamicSolid[];
  },
): RenderWorld {
  const tiles: number[] = [];
  for (const row of rows) {
    for (const ch of row) {
      tiles.push(Number(ch));
    }
  }
  return {
    cols: rows[0]!.length,
    rows: rows.length,
    tiles,
    exit: opts?.exit ?? { col: 0, row: 0 },
    hazards: opts?.hazards ?? [],
    dynamicSolids: opts?.dynamicSolids ?? [],
  };
}

describe('interpolate', () => {
  it('linearly interpolates between prev and curr', () => {
    const prev: Vec2 = { x: 0, y: 0 };
    const curr: Vec2 = { x: 10, y: 20 };
    expect(interpolate(prev, curr, 0)).toEqual({ x: 0, y: 0 });
    expect(interpolate(prev, curr, 0.5)).toEqual({ x: 5, y: 10 });
    expect(interpolate(prev, curr, 1)).toEqual({ x: 10, y: 20 });
  });

  it('does not mutate inputs', () => {
    const prev: Vec2 = { x: 1, y: 2 };
    const curr: Vec2 = { x: 5, y: 6 };
    interpolate(prev, curr, 0.5);
    expect(prev).toEqual({ x: 1, y: 2 });
    expect(curr).toEqual({ x: 5, y: 6 });
  });
});

describe('buildTileLayer', () => {
  it('maps Solid top-row to tile.solid.top and below-top to tile.solid.fill', () => {
    // Row 0 is ceiling solids, row 1 is below-ceiling solids.
    // Exit placed off-screen so it doesn't interfere with tile assertions.
    const world = makeWorld([
      '11',
      '11',
    ], { exit: { col: 100, row: 100 } });

    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });

    // Col 0, row 0: above is out-of-bounds (Empty) -> tile.solid.top
    // Col 0, row 1: above is Solid -> tile.solid.fill
    expect(sprites).toHaveLength(4);

    const topSprite = sprites.find(
      (s) => s.dstX === 0 && s.dstY === 0,
    );
    expect(topSprite).toBeDefined();
    expect(topSprite!.frame).toBe('tile.solid.top');

    const fillSprite = sprites.find(
      (s) => s.dstX === 0 && s.dstY === 16,
    );
    expect(fillSprite).toBeDefined();
    expect(fillSprite!.frame).toBe('tile.solid.fill');
  });

  it('maps OneWay to tile.oneway', () => {
    const world = makeWorld(['2'], { exit: { col: 100, row: 100 } });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });
    expect(sprites).toHaveLength(1);
    expect(sprites[0]!.frame).toBe('tile.oneway');
  });

  it('skips Empty cells', () => {
    const world = makeWorld(['0', '0'], { exit: { col: 100, row: 100 } });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });
    expect(sprites).toHaveLength(0);
  });

  it('computes screen coords relative to camera', () => {
    // Three-column level; camera at (16,0) so col 1 onward is visible.
    const world = makeWorld(['111'], { exit: { col: 100, row: 100 } });
    const { sprites } = buildTileLayer(world, { x: 16, y: 0 });
    // Visible range: startCol=floor(16/16)=1, so col 1 is the first visible.
    // Col 1, row 0: world (16,0), camera at (16,0), screen (0,0).
    expect(sprites).toHaveLength(2);
    expect(sprites[0]!.dstX).toBe(0);
    expect(sprites[0]!.dstY).toBe(0);
    expect(sprites[1]!.dstX).toBe(16);
  });

  it('does not mutate the world tiles', () => {
    const world = makeWorld(['11', '11'], { exit: { col: 100, row: 100 } });
    const tilesBefore = [...world.tiles];
    buildTileLayer(world, { x: 0, y: 0 });
    expect(world.tiles).toEqual(tilesBefore);
  });

  // --- New tests for exit door, hazards, dynamic solids ---

  it('emits exit.door sprite at the exit tile position', () => {
    const world = makeWorld(['00', '00'], {
      exit: { col: 1, row: 1 },
    });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });

    const exitSprite = sprites.find((s) => s.frame === 'exit.door');
    expect(exitSprite).toBeDefined();
    expect(exitSprite!.dstX).toBe(16); // 1 * 16 - 0
    expect(exitSprite!.dstY).toBe(16); // 1 * 16 - 0
    expect(exitSprite!.flipX).toBe(false);
  });

  it('culls exit door when off-screen', () => {
    // Exit at col 30 (480px) — way outside the 320-wide viewport with camera at 0.
    const world = makeWorld(['00'], {
      exit: { col: 30, row: 0 },
    });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });
    const exitSprite = sprites.find((s) => s.frame === 'exit.door');
    expect(exitSprite).toBeUndefined();
  });

  it('renders hazards from world.hazards as hazard.spikes sprites', () => {
    const world = makeWorld(['00', '00'], {
      hazards: [{ x: 16, y: 16, width: 16, height: 16 }],
    });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });

    const hazardSprites = sprites.filter((s) => s.frame === 'hazard.spikes');
    expect(hazardSprites).toHaveLength(1);
    expect(hazardSprites[0]!.dstX).toBe(16);
    expect(hazardSprites[0]!.dstY).toBe(16);
  });

  it('tiles hazard.spikes for larger hazard rects', () => {
    // 32x16 hazard should produce 2 hazard.spikes sprites
    const world = makeWorld(['000', '000'], {
      hazards: [{ x: 0, y: 0, width: 32, height: 16 }],
    });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });

    const hazardSprites = sprites.filter((s) => s.frame === 'hazard.spikes');
    expect(hazardSprites).toHaveLength(2);
    expect(hazardSprites[0]!.dstX).toBe(0);
    expect(hazardSprites[1]!.dstX).toBe(16);
  });

  it('culls off-screen hazards', () => {
    // Hazard at x=400 — outside the 320-wide viewport with camera at 0.
    const world = makeWorld(['00'], {
      hazards: [{ x: 400, y: 0, width: 16, height: 16 }],
    });
    const { sprites } = buildTileLayer(world, { x: 0, y: 0 });
    const hazardSprites = sprites.filter((s) => s.frame === 'hazard.spikes');
    expect(hazardSprites).toHaveLength(0);
  });

});

describe('buildDynamicSolidRects', () => {
  it('renders non-lethal dynamic solids as FillRect with edge color', () => {
    const ds: DynamicSolid = {
      id: 'ds1',
      x: 32,
      y: 32,
      width: 16,
      height: 16,
      velocityX: 0,
      velocityY: 0,
      solid: true,
      lethal: false,
    };
    const world = makeWorld(['00', '00'], { dynamicSolids: [ds] });
    const rects = buildDynamicSolidRects(world, { x: 0, y: 0 });

    expect(rects).toHaveLength(1);
    expect(rects[0]!.color).toBe('edge');
    expect(rects[0]!.x).toBe(32);
    expect(rects[0]!.y).toBe(32);
    expect(rects[0]!.w).toBe(16);
    expect(rects[0]!.h).toBe(16);
  });

  it('renders lethal dynamic solids as FillRect with lethal color', () => {
    const ds: DynamicSolid = {
      id: 'ds1',
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      velocityX: 0,
      velocityY: 0,
      solid: true,
      lethal: true,
    };
    const world = makeWorld(['00', '00'], { dynamicSolids: [ds] });
    const rects = buildDynamicSolidRects(world, { x: 0, y: 0 });

    expect(rects).toHaveLength(1);
    expect(rects[0]!.color).toBe('lethal');
  });

  it('skips non-solid dynamic solids', () => {
    const ds: DynamicSolid = {
      id: 'ds1',
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      velocityX: 0,
      velocityY: 0,
      solid: false,
      lethal: false,
    };
    const world = makeWorld(['00', '00'], { dynamicSolids: [ds] });
    const rects = buildDynamicSolidRects(world, { x: 0, y: 0 });
    expect(rects).toHaveLength(0);
  });

  it('culls off-screen dynamic solids', () => {
    const ds: DynamicSolid = {
      id: 'ds1',
      x: 400,
      y: 0,
      width: 16,
      height: 16,
      velocityX: 0,
      velocityY: 0,
      solid: true,
      lethal: false,
    };
    const world = makeWorld(['00', '00'], { dynamicSolids: [ds] });
    const rects = buildDynamicSolidRects(world, { x: 0, y: 0 });
    expect(rects).toHaveLength(0);
  });

  it('snaps fractional solid positions to whole pixels', () => {
    // Mechanic-published solids sit at fractional positions (rotating-arm
    // pivots derive x/y from cos/sin); every draw coordinate must be whole.
    const ds: DynamicSolid = {
      id: 'ds1',
      x: 94.6,
      y: 132.8,
      width: 16,
      height: 16,
      velocityX: 0,
      velocityY: 0,
      solid: true,
      lethal: false,
    };
    const world = makeWorld(['00', '00'], { dynamicSolids: [ds] });
    const rects = buildDynamicSolidRects(world, { x: 0, y: 0 });
    expect(rects).toHaveLength(1);
    expect(Number.isInteger(rects[0]!.x)).toBe(true);
    expect(Number.isInteger(rects[0]!.y)).toBe(true);
    expect(rects[0]).toMatchObject({ x: 95, y: 133, w: 16, h: 16 });
  });
});

describe('buildEntitySprites', () => {
  function makeSnap(
    x: number,
    y: number,
    frame: EntitySnapshot['frame'] = 'player.idle.0',
    flipX = false,
  ): EntitySnapshot {
    return { body: { x, y, width: 16, height: 24 }, frame, flipX };
  }

  it('uses interpolated position when prev exists', () => {
    const ents = [makeSnap(100, 50)];
    const prevs = [makeSnap(50, 10)];
    const sprites = buildEntitySprites(ents, prevs, 0.5, { x: 0, y: 0 }, ATLAS);

    expect(sprites).toHaveLength(1);
    // interpX = 50 + (100-50)*0.5 = 75
    // interpY = 10 + (50-10)*0.5 = 30
    // origin for player frames = {x:0, y:8}
    // dstX = 75 - 0 - 0 = 75
    // dstY = 30 - 8 - 0 = 22
    expect(sprites[0]!.dstX).toBe(75);
    expect(sprites[0]!.dstY).toBe(22);
  });

  it('falls back to current position when prev is missing', () => {
    const ents = [makeSnap(100, 50)];
    const sprites = buildEntitySprites(ents, [], 0.5, { x: 0, y: 0 }, ATLAS);

    expect(sprites).toHaveLength(1);
    expect(sprites[0]!.dstX).toBe(100);
    expect(sprites[0]!.dstY).toBe(42); // 50 - 8 (origin.y)
  });

  it('applies camera offset', () => {
    const ents = [makeSnap(200, 200)];
    const sprites = buildEntitySprites(
      ents,
      [makeSnap(200, 200)],
      0,
      { x: 50, y: 50 },
      ATLAS,
    );

    expect(sprites[0]!.dstX).toBe(150); // 200 - 0 - 50
    expect(sprites[0]!.dstY).toBe(142); // 200 - 8 - 50
  });

  it('preserves flipX from entity snapshot', () => {
    const ents = [makeSnap(0, 0, 'player.idle.0', true)];
    const sprites = buildEntitySprites(
      ents,
      [makeSnap(0, 0)],
      0,
      { x: 0, y: 0 },
      ATLAS,
    );
    expect(sprites[0]!.flipX).toBe(true);
  });

  it('does not mutate input arrays', () => {
    const ents = [makeSnap(100, 50)];
    const prevs = [makeSnap(50, 10)];
    const entsFrozen = [...ents];
    const prevsFrozen = [...prevs];
    buildEntitySprites(ents, prevs, 0.5, { x: 0, y: 0 }, ATLAS);
    expect(ents).toEqual(entsFrozen);
    expect(prevs).toEqual(prevsFrozen);
  });
});

describe('buildRenderModel', () => {
  it('produces layers in fixed order: world, dynamics, entities, effects, hud', () => {
    const world = makeWorld(['1'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      [],
    );

    expect(model.layers).toHaveLength(5);
    expect(model.layers.map((l) => l.kind)).toEqual([
      'world',
      'dynamics',
      'entities',
      'effects',
      'hud',
    ]);
  });

  it('clears with void palette token', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      [],
    );
    expect(model.clear).toBe('void');
  });

  it('populates world layer sprites from tiles', () => {
    const world = makeWorld(['1'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      [],
    );
    expect(model.layers[0]!.sprites.length).toBeGreaterThan(0);
  });

  it('populates entity layer sprites from entities', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const snap: EntitySnapshot = {
      body: { x: 0, y: 0, width: 16, height: 24 },
      frame: 'player.idle.0',
      flipX: false,
    };
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [snap],
      [snap],
      0,
      ATLAS,
      0,
      [],
    );
    expect(model.layers[2]!.sprites).toHaveLength(1);
  });

  it('effects layer is empty without particles', () => {
    const world = makeWorld(['1'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      [],
    );
    expect(model.layers[3]!.kind).toBe('effects');
    expect(model.layers[3]!.sprites).toHaveLength(0);
    expect(model.layers[3]!.rects).toHaveLength(0);
  });

  it('effects layer renders one fill-rect per particle', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const particles: Particle[] = [
      { x: 10.4, y: 20.6, vx: 0, vy: 0, life: 10, maxLife: 20, color: 'lethal', size: 2 },
      { x: 30, y: 40, vx: 0, vy: 0, life: 5, maxLife: 20, color: 'edge', size: 1 },
    ];
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      particles,
    );
    const fx = model.layers[3]!;
    expect(fx.kind).toBe('effects');
    expect(fx.rects).toHaveLength(2);
    expect(fx.rects[0]).toEqual({ x: 10, y: 21, w: 2, h: 2, color: 'lethal' });
    expect(fx.rects[1]).toEqual({ x: 30, y: 40, w: 1, h: 1, color: 'edge' });
  });

  it('buildEffectsLayer rounds fractional particle positions', () => {
    const layer = buildEffectsLayer([
      { x: 1.49, y: 2.5, vx: 0, vy: 0, life: 1, maxLife: 1, color: 'bone', size: 1 },
    ]);
    expect(layer.rects[0]!.x).toBe(1);
    expect(layer.rects[0]!.y).toBe(3);
  });

  it('routes dynamic solid rects to the dynamics layer, above tiles', () => {
    const ds: DynamicSolid = {
      id: 'ds1',
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      velocityX: 0,
      velocityY: 0,
      solid: true,
      lethal: false,
    };
    const world = makeWorld(['00', '00'], { dynamicSolids: [ds] });
    const model = buildRenderModel(world, { x: 0, y: 0 }, [], [], 0, ATLAS, 0, []);
    expect(model.layers[0]!.rects).toHaveLength(0);
    expect(model.layers[1]!.kind).toBe('dynamics');
    expect(model.layers[1]!.rects).toHaveLength(1);
  });

  it('rounds entity dst coords to whole pixels', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const curr: EntitySnapshot = {
      body: { x: 100, y: 50, width: 16, height: 24 },
      frame: 'player.idle.0',
      flipX: false,
    };
    const prev: EntitySnapshot = {
      body: { x: 50.4, y: 10.6, width: 16, height: 24 },
      frame: 'player.idle.0',
      flipX: false,
    };
    const model = buildRenderModel(
      world,
      { x: 0.2, y: 0.2 },
      [curr],
      [prev],
      0.5,
      ATLAS,
      0,
      [],
    );
    const sprite = model.layers[2]!.sprites[0];
    expect(sprite).toBeDefined();
    expect(Number.isInteger(sprite!.dstX)).toBe(true);
    expect(Number.isInteger(sprite!.dstY)).toBe(true);
  });

  it('includes hud layer as 5th layer with level text', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      [],
    );
    expect(model.layers).toHaveLength(5);
    expect(model.layers[4]!.kind).toBe('hud');
    expect(model.layers[4]!.texts).toHaveLength(1);
    expect(model.layers[4]!.texts[0]!.text).toBe('Level 1');
  });

  it('hud layer reflects levelIndex in text', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      44,
      [],
    );
    expect(model.layers[4]!.texts[0]!.text).toBe('Level 45');
  });

  it('hud layer texts use bone color', () => {
    const world = makeWorld(['0'], { exit: { col: 100, row: 100 } });
    const model = buildRenderModel(
      world,
      { x: 0, y: 0 },
      [],
      [],
      0,
      ATLAS,
      0,
      [],
    );
    expect(model.layers[4]!.texts[0]!.color).toBe('bone');
  });
});

describe('buildHudLayer', () => {
  it('produces "Level N" text at top-left for levelIndex 0', () => {
    const texts = buildHudLayer(0);
    expect(texts).toHaveLength(1);
    expect(texts[0]!).toEqual({
      text: 'Level 1',
      x: 2,
      y: 8,
      color: 'bone',
    } satisfies DrawText);
  });

  it('produces "Level 45" for levelIndex 44', () => {
    const texts = buildHudLayer(44);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('Level 45');
    expect(texts[0]!.x).toBe(2);
    expect(texts[0]!.y).toBe(8);
    expect(texts[0]!.color).toBe('bone');
  });
});
