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

describe('moveAndCollide - rising-platform tunneling (issue #168)', () => {
  // A tall empty grid so only the dynamic solid can affect the result; the
  // platform rises without bound over the simulation.
  const emptyGrid = parseGrid(Array.from({ length: 60 }, () => '....'));

  const GRAVITY = 900;
  const TERMINAL = 400;
  const RISE = -60 * DT; // one pixel per step, rising

  /**
   * Drops a body from ~32 px of clearance onto a platform rising one pixel per
   * step, stepped to convergence. Each step the platform's top advances from
   * its start-of-step position (startY) to its end-of-step position (y), the
   * same shape collectActiveSolids feeds the solver. Returns the settled body
   * and the platform's final top edge.
   */
  function settleOnRisingPlatform(width: number): { body: Body; platformTop: number } {
    let platformTop = 200;
    let body = makeBody({ x: 0, y: platformTop - 32 - 16, velocity: { x: 0, y: 0 } });

    for (let i = 0; i < 400; i++) {
      body = {
        ...body,
        velocity: { x: 0, y: Math.min(body.velocity.y + GRAVITY * DT, TERMINAL) },
      };
      const startY = platformTop;
      const endY = platformTop + RISE;
      const platform: SolidRect = { x: 0, y: endY, width, height: 16, startY };
      body = moveAndCollide(body, emptyGrid, DT, [platform]).body;
      platformTop = endY;
    }

    return { body, platformTop };
  }

  it.each([16, 32, 200])(
    'catches a body falling onto a rising platform (width %i), never tunneling through',
    (width) => {
      const { body, platformTop } = settleOnRisingPlatform(width);

      expect(body.grounded).toBe(true);
      expect(body.velocity.y).toBe(0);
      // Resting flush on the platform top, not fallen through below it.
      expect(Math.abs(body.y + body.height - platformTop)).toBeLessThanOrEqual(1);
    },
  );

  it('still catches when the body starts at or above the platform top (clearance >= dy)', () => {
    // Start-of-step top is 40; the body's bottom begins 1 px above it (a
    // clearance of exactly dy), so the pre-existing guard already fires.
    const startY = 40;
    const endY = startY + RISE;
    const platform: SolidRect = { x: 0, y: endY, width: 32, height: 16, startY };
    const body = makeBody({ x: 0, y: startY - 16 - 1, velocity: { x: 0, y: 240 } });

    const result = moveAndCollide(body, emptyGrid, DT, [platform]);

    expect(result.body.grounded).toBe(true);
    expect(result.body.velocity.y).toBe(0);
    expect(result.body.y).toBe(endY - 16);
  });

  it('does not eject a body already inside a stationary solid (anti-pull-out invariant)', () => {
    // The body overlaps the solid well below its top face. With no startY the
    // landing guard reads the same end-of-step top as before, so the body is
    // never pulled out to sit on top.
    const platform: SolidRect = { x: 0, y: 32, width: 32, height: 16 };
    const body = makeBody({ x: 0, y: 30, velocity: { x: 0, y: 240 } });

    const result = moveAndCollide(body, emptyGrid, DT, [platform]);

    expect(result.body.grounded).toBe(false);
    expect(result.body.y).toBeCloseTo(30 + 240 * DT);
  });

  it('does not eject a body already inside a solid that did not rise this step', () => {
    // startY === y pins the invariant for a dynamic solid whose displacement
    // this step is zero: the widened guard must not fire deeper than before.
    const platform: SolidRect = { x: 0, y: 32, width: 32, height: 16, startY: 32 };
    const body = makeBody({ x: 0, y: 30, velocity: { x: 0, y: 240 } });

    const result = moveAndCollide(body, emptyGrid, DT, [platform]);

    expect(result.body.grounded).toBe(false);
    expect(result.body.y).toBeCloseTo(30 + 240 * DT);
  });
});
