import { describe, expect, it } from 'vitest';
import { moveAndCollide, Tile, tileAt, type Body, type SolidRect } from './physics';
import { parseGrid } from './testGrid';

const DT = 1 / 60;

function makeBody(overrides: Partial<Body> = {}): Body {
  return {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
    velocity: { x: 0, y: 0 },
    grounded: false,
    ...overrides,
  };
}

describe('tileAt', () => {
  it('treats out-of-bounds columns and rows as empty', () => {
    const grid = parseGrid(['.#.', '...']);

    expect(tileAt(grid, -1, 0)).toBe(Tile.Empty);
    expect(tileAt(grid, 3, 0)).toBe(Tile.Empty);
    expect(tileAt(grid, 0, -1)).toBe(Tile.Empty);
    expect(tileAt(grid, 0, 2)).toBe(Tile.Empty);
    expect(tileAt(grid, 1, 0)).toBe(Tile.Solid);
  });
});

describe('moveAndCollide - flush stops on each axis', () => {
  it('stops flush against a wall to the right, zeroing vx', () => {
    const grid = parseGrid(['...', '...', '..#']);
    const body = makeBody({ x: 15, y: 32, velocity: { x: 120, y: 0 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.x).toBe(16);
    expect(result.body.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('stops flush against a wall to the left, zeroing vx', () => {
    const grid = parseGrid(['...', '...', '#..']);
    const body = makeBody({ x: 17, y: 32, velocity: { x: -120, y: 0 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.x).toBe(16);
    expect(result.body.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('lands flush on a floor below, zeroing vy and setting grounded', () => {
    const grid = parseGrid(['...', '...', '###']);
    const body = makeBody({ x: 16, y: 15, velocity: { x: 0, y: 120 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.y).toBe(16);
    expect(result.body.velocity.y).toBe(0);
    expect(result.body.grounded).toBe(true);
    expect(result.hitCeiling).toBe(false);
  });

  it('stops flush against a ceiling above, zeroing vy', () => {
    const grid = parseGrid(['###', '...', '...']);
    const body = makeBody({ x: 16, y: 17, velocity: { x: 0, y: -120 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.y).toBe(16);
    expect(result.body.velocity.y).toBe(0);
    expect(result.hitCeiling).toBe(true);
    expect(result.body.grounded).toBe(false);
  });
});

describe('moveAndCollide - tile span at exact boundaries', () => {
  it('does not treat the floor row itself as a horizontal wall when resting exactly on it', () => {
    // The naive maxRow = floor((y + h) / 16) would over-report the body's own
    // row span by one whenever its bottom edge lands exactly on a tile boundary,
    // making a body resting on any floor unable to walk (every floor tile would
    // read as a wall in its own row-span check). ceil((y + h) / 16) - 1 avoids it.
    const grid = parseGrid(['....', '....', '####']);
    const body = makeBody({ x: 0, y: 16, velocity: { x: 120, y: 15 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.hitWall).toBe(false);
    expect(result.body.x).toBe(2);
    expect(result.body.y).toBe(16);
    expect(result.body.velocity.y).toBe(0);
    expect(result.body.grounded).toBe(true);
  });

  it('does not treat a flush wall column as a floor when falling alongside it', () => {
    // Naive maxCol = floor((x + w) / 16) would include the wall column in the
    // falling body's own column span and ground it on the wall.
    const grid = parseGrid(['..#', '..#', '..#']);
    const body = makeBody({ x: 16, y: 0, velocity: { x: 0, y: 120 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.grounded).toBe(false);
    expect(result.body.y).toBe(2);
    expect(result.body.velocity.y).toBe(120);
  });
});

describe('moveAndCollide - inside corner', () => {
  it('resolves both axes flush when diagonal motion clips a wall-and-floor corner', () => {
    const grid = parseGrid(['.....', '...#.', '...#.', '..###', '.....']);
    const body = makeBody({ x: 31, y: 31, velocity: { x: 120, y: 120 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.x).toBe(32);
    expect(result.body.y).toBe(32);
    expect(result.body.velocity.x).toBe(0);
    expect(result.body.velocity.y).toBe(0);
    expect(result.hitWall).toBe(true);
    expect(result.body.grounded).toBe(true);
  });
});

describe('moveAndCollide - one-way platforms', () => {
  it('is passable while rising through it', () => {
    const grid = parseGrid(['...', '-..', '...']);
    const body = makeBody({ x: 0, y: 20, velocity: { x: 0, y: -120 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.y).toBe(18);
    expect(result.body.velocity.y).toBe(-120);
    expect(result.hitCeiling).toBe(false);
  });

  it('lands flush from above and stays grounded across subsequent steps', () => {
    const grid = parseGrid(['...', '...', '-..']);
    const falling = makeBody({ x: 0, y: 15, velocity: { x: 0, y: 120 } });

    const landed = moveAndCollide(falling, grid, DT);
    expect(landed.body.y).toBe(16);
    expect(landed.body.velocity.y).toBe(0);
    expect(landed.body.grounded).toBe(true);

    const resting = moveAndCollide({ ...landed.body, velocity: { x: 0, y: 15 } }, grid, DT);
    expect(resting.body.y).toBe(16);
    expect(resting.body.velocity.y).toBe(0);
    expect(resting.body.grounded).toBe(true);
  });

  it('is ignored entirely on the X pass', () => {
    const grid = parseGrid(['...', '---', '...']);
    const body = makeBody({ x: 0, y: 16, velocity: { x: 120, y: 0 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.x).toBe(2);
    expect(result.hitWall).toBe(false);
  });
});

describe('moveAndCollide - out of bounds', () => {
  it('treats space outside the grid as empty, never as a phantom wall', () => {
    const grid = parseGrid(['...']);
    const body = makeBody({ x: 1, y: 0, velocity: { x: -120, y: 0 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.x).toBe(-1);
    expect(result.hitWall).toBe(false);
  });
});

describe('moveAndCollide - terminal-speed fall never tunnels', () => {
  it('lands flush on a floor even at vy = 400, never crossing it', () => {
    const grid = parseGrid(['...', '...', '###']);
    const body = makeBody({ x: 0, y: 10, velocity: { x: 0, y: 400 } });

    const result = moveAndCollide(body, grid, DT);

    expect(result.body.y).toBe(16);
    expect(result.body.velocity.y).toBe(0);
    expect(result.body.grounded).toBe(true);
    expect(result.hitCeiling).toBe(false);
  });
});

describe('moveAndCollide - dynamic solids', () => {
  // An empty tile grid so only the dynamic solids can affect the result.
  const emptyGrid = parseGrid(['...', '...', '...', '...']);

  it('blocks horizontal movement against a solid, zeroing vx', () => {
    const wall: SolidRect = { x: 48, y: 16, width: 16, height: 16 };
    const body = makeBody({ x: 32, y: 16, velocity: { x: 240, y: 0 } });

    const result = moveAndCollide(body, emptyGrid, DT, [wall]);

    expect(result.body.x).toBe(32);
    expect(result.body.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('blocks horizontal movement from the left side of a solid, zeroing vx', () => {
    const wall: SolidRect = { x: 16, y: 0, width: 16, height: 16 };
    const body = makeBody({ x: 33, y: 0, velocity: { x: -240, y: 0 } });

    const result = moveAndCollide(body, emptyGrid, DT, [wall]);

    expect(result.body.x).toBe(32);
    expect(result.body.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('lands on the top face of a solid, setting grounded', () => {
    const platform: SolidRect = { x: 0, y: 32, width: 32, height: 16 };
    const body = makeBody({ x: 0, y: 14, velocity: { x: 0, y: 240 } });

    const result = moveAndCollide(body, emptyGrid, DT, [platform]);

    expect(result.body.y).toBe(16);
    expect(result.body.velocity.y).toBe(0);
    expect(result.body.grounded).toBe(true);
    expect(result.hitCeiling).toBe(false);
  });

  it('bumps the head on the bottom face of a solid, zeroing vy', () => {
    const ceiling: SolidRect = { x: 0, y: 0, width: 32, height: 16 };
    const body = makeBody({ x: 0, y: 18, velocity: { x: 0, y: -240 } });

    const result = moveAndCollide(body, emptyGrid, DT, [ceiling]);

    expect(result.body.y).toBe(16);
    expect(result.body.velocity.y).toBe(0);
    expect(result.hitCeiling).toBe(true);
    expect(result.body.grounded).toBe(false);
  });

  it('does not block a body standing flush on top of a solid (strict inequalities)', () => {
    const platform: SolidRect = { x: 0, y: 32, width: 32, height: 16 };
    const body = makeBody({ x: 0, y: 16, velocity: { x: 120, y: 15 }, grounded: true });

    const result = moveAndCollide(body, emptyGrid, DT, [platform]);

    expect(result.hitWall).toBe(false);
    expect(result.body.grounded).toBe(true);
  });

  it('is equivalent to the no-solids path when passed an empty array', () => {
    const grid = parseGrid(['...', '...', '###']);
    const body = makeBody({ x: 4, y: 10, velocity: { x: 120, y: 400 } });

    const baseline = moveAndCollide(body, grid, DT);
    const withEmpty = moveAndCollide(body, grid, DT, []);

    expect(withEmpty).toEqual(baseline);
  });
});
