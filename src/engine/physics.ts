export const TILE_SIZE = 16;

export interface Vec2 {
  x: number;
  y: number;
}

// x,y = top-left.
export interface AABB {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Body extends AABB {
  velocity: Vec2;
  grounded: boolean;
}

/**
 * Engine-local structural rectangle for a dynamic solid (crusher, shifting
 * wall, moving platform). Structurally compatible with the trap/mechanic
 * DynamicSolid so callers can pass those directly, keeping the dependency
 * direction intact: the engine never imports src/traps or src/mechanics.
 */
export interface SolidRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * Optional start-of-step top edge for a solid that advanced this step. When
   * present the landing guard tests the body's original bottom against where
   * the top BEGAN rather than where it ended, closing the rising-platform
   * tunneling window (issue #168). The body still lands on the end-of-step
   * top. Callers that omit it (trap solids, static solids) keep the previous
   * behavior exactly.
   */
  readonly startY?: number;
}

// const-object stand-in for a const enum: isolatedModules rules const enum out.
export const Tile = { Empty: 0, Solid: 1, OneWay: 2 } as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export interface TileGrid {
  readonly cols: number;
  readonly rows: number;
  readonly tiles: readonly Tile[];
}

export interface CollisionResult {
  body: Body;
  hitWall: boolean;
  hitCeiling: boolean;
}

// Levels are expected to wall themselves; out-of-bounds reads as Empty rather
// than aliasing into a neighboring row, so col and row are bounds-checked
// separately before the flat-index lookup.
export function tileAt(grid: TileGrid, col: number, row: number): Tile {
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) {
    return Tile.Empty;
  }
  return grid.tiles[row * grid.cols + col] ?? Tile.Empty;
}

// Inclusive first tile of the span.
function spanStart(pos: number): number {
  return Math.floor(pos / TILE_SIZE);
}

// Inclusive last tile of a span [pos, pos + size). Using
// ceil(end / TILE_SIZE) - 1 (rather than the naive floor(end / TILE_SIZE))
// keeps a box whose far edge lands exactly on a tile boundary from being
// counted as occupying the next tile over.
function spanEnd(pos: number, size: number): number {
  return Math.ceil((pos + size) / TILE_SIZE) - 1;
}

// Strict-inequality interval overlap, matching aabbOverlap's convention: a
// flush edge (equality) reads as no overlap. Used to decide whether a body
// shares a row span / column span with a dynamic solid before the solid's
// face is treated as a blocking plane.
function verticalRangesOverlap(body: AABB, solid: SolidRect): boolean {
  return body.y < solid.y + solid.height && body.y + body.height > solid.y;
}

function horizontalRangesOverlap(body: AABB, solid: SolidRect): boolean {
  return body.x < solid.x + solid.width && body.x + body.width > solid.x;
}

function resolveX(
  body: Body,
  grid: TileGrid,
  dt: number,
  solids: readonly SolidRect[],
): { x: number; vx: number; hitWall: boolean } {
  const vx = body.velocity.x;
  let x = body.x + vx * dt;
  let hitWall = false;

  if (vx !== 0) {
    const minRow = spanStart(body.y);
    const maxRow = spanEnd(body.y, body.height);

    if (vx > 0) {
      const col = spanEnd(x, body.width);
      for (let row = minRow; row <= maxRow; row++) {
        if (tileAt(grid, col, row) === Tile.Solid) {
          x = col * TILE_SIZE - body.width;
          hitWall = true;
          break;
        }
      }
      // Dynamic solids: a leading left face blocks like a wall. The body
      // must have started flush with or left of that face, so a body already
      // inside the solid is never pushed out (no depenetration here).
      for (const solid of solids) {
        if (!verticalRangesOverlap(body, solid)) continue;
        const stop = solid.x - body.width;
        if (x + body.width > solid.x && body.x + body.width <= solid.x && stop < x) {
          x = stop;
          hitWall = true;
        }
      }
    } else {
      const col = spanStart(x);
      for (let row = minRow; row <= maxRow; row++) {
        if (tileAt(grid, col, row) === Tile.Solid) {
          x = (col + 1) * TILE_SIZE;
          hitWall = true;
          break;
        }
      }
      // Dynamic solids: a trailing right face blocks like a wall, again only
      // for a body that started flush with or right of that face.
      for (const solid of solids) {
        if (!verticalRangesOverlap(body, solid)) continue;
        const stop = solid.x + solid.width;
        if (x < stop && body.x >= stop && stop > x) {
          x = stop;
          hitWall = true;
        }
      }
    }
  }

  return { x, vx: hitWall ? 0 : vx, hitWall };
}

function resolveY(
  body: Body,
  grid: TileGrid,
  dt: number,
  solids: readonly SolidRect[],
): { y: number; vy: number; hitCeiling: boolean; grounded: boolean } {
  const vy = body.velocity.y;
  const originalBottom = body.y + body.height;
  let y = body.y + vy * dt;
  let hitCeiling = false;
  let grounded = false;
  let resolvedVy = vy;

  const minCol = spanStart(body.x);
  const maxCol = spanEnd(body.x, body.width);

  if (vy >= 0) {
    const row = spanEnd(y, body.height);
    for (let col = minCol; col <= maxCol; col++) {
      const tile = tileAt(grid, col, row);
      const tileTop = row * TILE_SIZE;
      // One-way tiles are solid only from above: the body's bottom edge must
      // have started at or above the tile's top face this step.
      const isBlocking = tile === Tile.Solid || (tile === Tile.OneWay && originalBottom <= tileTop);
      if (isBlocking) {
        y = tileTop - body.height;
        resolvedVy = 0;
        grounded = true;
        break;
      }
    }
    // Dynamic solids: land on the top face. The body must have started at or
    // above where the top BEGAN (startY) rather than where it ended (y): a
    // rising platform cannot legitimately have passed a body whose bottom was
    // already at or above its start-of-step top, so this closes the window
    // where a body ending a step just inside the solid fell through next step.
    // A body genuinely inside the solid (its bottom began below startY) is
    // still excluded, preserving the no-pull-out invariant. The body lands on
    // the end-of-step top, keeping flush-edge alignment for riders.
    for (const solid of solids) {
      if (!horizontalRangesOverlap(body, solid)) continue;
      const stop = solid.y - body.height;
      const landTop = solid.startY ?? solid.y;
      if (originalBottom <= landTop && y + body.height > solid.y && stop < y) {
        y = stop;
        resolvedVy = 0;
        grounded = true;
      }
    }
  } else {
    const row = spanStart(y);
    for (let col = minCol; col <= maxCol; col++) {
      if (tileAt(grid, col, row) === Tile.Solid) {
        y = (row + 1) * TILE_SIZE;
        resolvedVy = 0;
        hitCeiling = true;
        break;
      }
    }
    // Dynamic solids: bump the head on the bottom face, only for a body that
    // started at or below that face.
    for (const solid of solids) {
      if (!horizontalRangesOverlap(body, solid)) continue;
      const stop = solid.y + solid.height;
      if (body.y >= stop && y < stop && stop > y) {
        y = stop;
        resolvedVy = 0;
        hitCeiling = true;
      }
    }
  }

  return { y, vy: resolvedVy, hitCeiling, grounded };
}

/**
 * Standard AABB intersection with STRICT inequalities: flush edges (equality)
 * read as NO overlap. Consistent with overlapsHazard in levelAdapter.ts and
 * the physics solver's spanEnd convention (ceil(end / TILE_SIZE) - 1) which
 * excludes the far-edge-aligned tile, so bodies standing exactly adjacent do
 * not register a spurious contact.
 */
export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// With velocity.y === 0 the downward probe row is the body's own bottom row,
// so a resting body reports grounded: false; callers must apply gravity
// first (stepController guarantees vy >= 15).
//
// The optional solids list adds dynamic-solid blocking on top of the tile
// grid: solid rectangles stop horizontal motion at their faces and act as
// landable tops / head-bumpable undersides. The default empty array keeps
// the tile-grid-only behavior for every existing caller.
export function moveAndCollide(
  body: Body,
  grid: TileGrid,
  dt: number,
  solids: readonly SolidRect[] = [],
): CollisionResult {
  const xResult = resolveX(body, grid, dt, solids);
  const bodyAfterX: Body = {
    ...body,
    x: xResult.x,
    velocity: { x: xResult.vx, y: body.velocity.y },
  };

  const yResult = resolveY(bodyAfterX, grid, dt, solids);
  const resolvedBody: Body = {
    ...bodyAfterX,
    y: yResult.y,
    velocity: { x: xResult.vx, y: yResult.vy },
    grounded: yResult.grounded,
  };

  return { body: resolvedBody, hitWall: xResult.hitWall, hitCeiling: yResult.hitCeiling };
}
