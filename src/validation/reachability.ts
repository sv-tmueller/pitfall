// Level validation harness: reachability and solvability checks (#44, #161).
// BFS flood-fill from spawn through the tile grid using movement constraints
// derived from the real controller physics, with every edge swept for solid
// obstruction.
//
// Jump envelope (calibrated to the shipped controller tunables in
// src/engine/controller.ts: maxRun 120, accel 800, jumpVel -260, gravity 900):
//   - Max flat horizontal gap: 4 tiles (64 px), measured by simulation.
//   - Max vertical rise: ~2.35 tiles; we conservatively allow 2 tiles.
//   - Combined jumps trade horizontal range against vertical gain: a jump
//     that rises 2 tiles cannot also cover 4 tiles sideways. We model this
//     as |dc| / MAX_FLAT_GAP + rise / MAX_RISE <= 1.
//   - Drops are unconstrained (gravity assists); lateral drift during a
//     drop is bounded by the same horizontal term.
//   - One-way tiles (id 2) are standable from above and passable from below
//     or the sides. A one-way tile is a valid standing position; the BFS may
//     occupy it. Solids (id 1) block passage. Hazards (id 3) are traversable
//     for reachability purposes (the validator checks geometry, not survival).
//
// Mechanics extensions (#129 checkpoint 7):
//   - Springs expand the jump envelope from the spring's tile based on the
//     impulse magnitude.
//   - Teleporters create guaranteed edges between teleporter and destination
//     tiles. Bidirectional pairs add reciprocal edges.
//   - Moving platforms make both endpoint positions standable in the BFS grid.
//
// Gravity zones ARE modelled (issue #174 restores the #129 model; #173 had
// stripped it while the engine treated inversion as a no-op): a gravity-zone
// mechanic inverts the gravity sign inside its rectangle. Inside a zone the
// standable surface is ABOVE (with a world-ceiling guard), the jump/drop
// envelope is mirrored (drop dr signs), and every swept edge flies the
// mirrored parabola. The BFS is therefore sound under inversion again and
// gravity-zone leaves `unmodeled` (TRAVERSAL_UNMODELED_TYPES).

import { levelToGrid } from '../engine/levelAdapter';
import type { JsonValue, LevelData, MechanicEntry } from '../levels/types';
import { Tile } from '../levels/types';

/**
 * Structured solvability verdict (issue #161 CP3).
 *
 *  - 'solvable': the BFS reached the exit through physically swept edges.
 *  - 'unsolvable': the BFS failed and the level contains no unmodeled
 *    traversal-relevant mechanics; the geometry alone cannot connect
 *    spawn to exit.
 *  - 'not-modelled': the BFS failed but the level declares mechanics or
 *    traps the validator does not model and that can plausibly change
 *    traversal (listed in `unmodeled`). The verdict is withheld rather
 *    than guessed.
 */
export interface SolvabilityResult {
  readonly reachable: boolean;
  readonly status: 'solvable' | 'unsolvable' | 'not-modelled';
  readonly unmodeled: readonly string[];
}

/**
 * Mechanic and trap types the validator does not model that can plausibly
 * change traversal. Pure-hazard traps (spikes, emerging/retracting spikes,
 * crushers, fake-ui, camera-troll, control-inversion) are deliberately
 * absent: they alter survival, not geometry, and never buy a
 * 'not-modelled' excuse.
 *
 * 'gravity-zone' is deliberately absent (issue #174): the restored
 * inversion model (see isInvertedRegion / isStandable / sweepEdge) certifies
 * inverted traversal, so a gravity-zone level that fails the flood-fill is
 * genuinely unsolvable geometry, not a withheld verdict.
 */
const TRAVERSAL_UNMODELED_TYPES: ReadonlySet<string> = new Set([
  'jetpack',
  'fake-exit',
  'lever',
  'shifting-wall',
  'vanishing-floor',
]);

// ---------------------------------------------------------------------------
// Physics constants (mirror src/engine/controller.ts)
// ---------------------------------------------------------------------------

const TILE_SIZE = 16;

// Maximum horizontal gap (in tiles) the player can clear with a running
// jump at the same elevation. Calibrated by simulating the real controller;
// see docs/level-format.md "Why the jump-gap is 48 px".
const MAX_FLAT_GAP = 4;

// Maximum vertical rise (in tiles) from a standing jump. The controller
// achieves ~2.35 tiles (jumpVel -260, gravity 900); we round down to 2 to
// keep the validator conservative so it never certifies a level the real
// physics cannot solve.
const MAX_RISE = 2;

// Controller tunables mirrored from src/engine/controller.ts. Kept as locals
// so the validator stays independent of the engine module's export graph.
const CONTROLLER_GRAVITY = 900;

// |JUMP_VEL| from src/engine/controller.ts; the swept arc launches with
// this vertical speed (springs override it with their impulse).
const NORMAL_JUMP_VEL_ABS = 260;

// MAX_RUN from src/engine/controller.ts: the fastest horizontal speed the
// controller can sustain. Arcs demanding more are physically unflyable.
const CONTROLLER_MAX_RUN = 120;

// ACCEL from src/engine/controller.ts: ground/air horizontal acceleration.
const CONTROLLER_ACCEL = 800;

// ---------------------------------------------------------------------------
// Grid wrapper with optional standable overrides (moving platforms) and
// gravity-zone awareness.
// ---------------------------------------------------------------------------

/**
 * Internal grid representation that augments the base tile grid with:
 *  - extraStandable: cells made standable by moving platforms (both endpoints)
 *  - gravityZones: rectangles where the gravity sign is inverted, so the
 *    standable surface is above and jump/drop directions are mirrored
 */
interface ValidatorGrid {
  cols: number;
  rows: number;
  tiles: readonly Tile[];
  extraStandable: Set<string>;
  gravityZones: GravityZone[];
}

/** Inclusive top-left / exclusive bottom-right rectangle, in tile coords. */
interface GravityZone {
  colMin: number;
  rowMin: number;
  colMax: number; // exclusive
  rowMax: number; // exclusive
}

function gridKey(col: number, row: number): string {
  return `${col},${row}`;
}

/**
 * Determines whether a tile is passable for BFS traversal: the player body
 * can occupy or transit this cell. Empty, OneWay and Hazard cells are
 * passable; Solid cells are not.
 */
function isPassable(tile: Tile | undefined): boolean {
  return tile !== Tile.Solid;
}

/**
 * A position (col, row) is "standable" if the tile there is passable (the
 * body can occupy it) AND the tile directly beneath (col, row+1) is Solid
 * or OneWay (the body has a surface to stand on). The player can only
 * initiate a jump or walk from a standable position, and every jump/drop
 * destination must also be standable --- the player must land on something.
 * This prevents the BFS from chaining jumps through mid-air tiles.
 *
 * If the cell is in the `extraStandable` set (placed by a moving platform),
 * it is considered standable regardless of the underlying tile.
 *
 * Inside a gravity zone (issue #174) the surface is ABOVE instead of below:
 * the tile at (col, row-1) must be Solid or OneWay, guarded by the world
 * ceiling (row-1 < 0 is not standable, mirroring the floor guard).
 */
function isStandable(
  grid: ValidatorGrid,
  col: number,
  row: number,
): boolean {
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return false;

  // Moving-platform overrides: the platform makes this cell standable.
  if (grid.extraStandable.has(gridKey(col, row))) return true;

  const here = grid.tiles[row * grid.cols + col];
  if (!isPassable(here)) return false;

  if (isInvertedRegion(grid, col, row)) {
    // Inverted gravity: surface must be above.
    if (row - 1 < 0) return false; // ceiling of the world
    const above = grid.tiles[(row - 1) * grid.cols + col];
    return above === Tile.Solid || above === Tile.OneWay;
  }

  // Normal gravity: surface must be below.
  if (row + 1 >= grid.rows) return false; // floor of the world
  const below = grid.tiles[(row + 1) * grid.cols + col];
  return below === Tile.Solid || below === Tile.OneWay;
}

/**
 * Returns true when (col, row) falls inside any gravity zone on the grid.
 */
function isInvertedRegion(grid: ValidatorGrid, col: number, row: number): boolean {
  for (const zone of grid.gravityZones) {
    if (
      col >= zone.colMin && col < zone.colMax &&
      row >= zone.rowMin && row < zone.rowMax
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Generates reachable neighbor offsets given the physics jump envelope.
 *
 * Movement primitives:
 *  - Walk: 1 tile horizontally at the same row.
 *  - Running jump (flat): up to MAX_FLAT_GAP tiles horizontally at the same
 *    row, decaying as vertical rise increases.
 *  - Vertical jump: up to MAX_RISE tiles straight up (dc=0).
 *  - Drop: any number of rows downward (gravity-assisted), with up to
 *    MAX_FLAT_GAP tiles of lateral drift scaled by the drop's horizontal
 *    allowance.
 *
 * Rising-jump lateral allowances are KINEMATIC (issue #161): a jump that
 * rises R tiles lands after t = (v + sqrt(v^2 - 2 g R')) / g seconds
 * (descending root, v = 260, g = 900, R' = 16R px), during which the
 * controller can cover MAX_RUN * t pixels horizontally:
 *   rise 0: t = 0.578 s -> 4.3 tiles -> lat 4
 *   rise 1: t = 0.508 s -> 3.8 tiles -> lat 3
 *   rise 2: t = 0.400 s -> 3.0 tiles -> lat 3
 * The old heuristic (|dc| / MAX_FLAT_GAP + rise / MAX_RISE <= 1) forbade
 * ANY lateral travel on a 2-tile rise, which real physics disproves: the
 * swept arc family plus the MAX_RUN cap now guards soundness, so the
 * envelope only enumerates candidates.
 */
export function jumpNeighbors(): Array<{ dc: number; dr: number }> {
  const neighbors: Array<{ dc: number; dr: number }> = [];

  // Walking: 1 tile left/right at the same row.
  neighbors.push({ dc: -1, dr: 0 });
  neighbors.push({ dc: 1, dr: 0 });

  // Upward and level jumps: kinematic lateral allowance per rise.
  const RISING_LAT: ReadonlyArray<number> = [MAX_FLAT_GAP, 3, 3];
  for (let rise = 0; rise <= MAX_RISE; rise++) {
    const maxLat = RISING_LAT[rise] ?? 0;
    for (let lat = -maxLat; lat <= maxLat; lat++) {
      if (lat === 0 && rise === 0) continue; // already covered by walking
      neighbors.push({ dc: lat, dr: -rise });
    }
  }

  // Downward drops: any depth, lateral drift up to MAX_FLAT_GAP tiles.
  // Gravity accelerates the fall so deep drops still allow some lateral
  // travel; we cap lateral at MAX_FLAT_GAP for conservatism.
  for (let drop = 1; drop <= 24; drop++) {
    for (let lat = -MAX_FLAT_GAP; lat <= MAX_FLAT_GAP; lat++) {
      neighbors.push({ dc: lat, dr: drop });
    }
  }

  return neighbors;
}

/**
 * Like {@link jumpNeighbors} but with an expanded vertical rise for springs.
 * Produces neighbor offsets for a spring launch: lateral range scales with
 * the expanded envelope, and the rise can go much higher than MAX_RISE.
 *
 * The spring's effective max rise (in tiles) replaces MAX_RISE in the
 * envelope formula:
 *   |dc| / MAX_FLAT_GAP + rise / springRise <= 1
 *
 * Since springs overwrite vy (not additive), the player effectively gets a
 * fresh jump from the spring tile with the spring's impulse as the takeoff
 * velocity. We compute the peak height from |impulseY| the same way the
 * controller computes the normal jump peak.
 */
function springLaunchNeighbors(springRiseTiles: number): Array<{ dc: number; dr: number }> {
  const neighbors: Array<{ dc: number; dr: number }> = [];
  const maxRise = Math.max(1, Math.floor(springRiseTiles));

  for (let rise = 0; rise <= maxRise; rise++) {
    const fraction = maxRise > 0 ? rise / maxRise : 0;
    const maxLat = Math.floor(MAX_FLAT_GAP * (1 - fraction));
    for (let lat = -maxLat; lat <= maxLat; lat++) {
      if (lat === 0 && rise === 0) continue; // trivial
      neighbors.push({ dc: lat, dr: -rise });
    }
  }

  // Springs also allow drops (player can walk off after landing on the spring tile).
  for (let drop = 1; drop <= 24; drop++) {
    for (let lat = -MAX_FLAT_GAP; lat <= MAX_FLAT_GAP; lat++) {
      neighbors.push({ dc: lat, dr: drop });
    }
  }

  return neighbors;
}

// ---------------------------------------------------------------------------
// Swept-path obstruction (issue #161 CP1)
//
// The old validator only tested solids in the SOURCE COLUMN of upward jumps;
// lateral jumps, walks, and drops crossed full-height walls unchecked. The
// replacement sweeps EVERY edge through pixel space:
//
//   - Every jump-envelope edge is swept as the arc the real controller flies:
//     takeoff with vertical velocity JUMP_VEL (-260; springs use their
//     impulse), gravity 900, horizontal velocity solved so the body lands
//     centered on the destination cell. The apex is
//     260^2 / (2 * 900) = 37.6 px above the launch point. Sampled at a fixed
//     quarter-step (240 samples/sec); each sample is the player AABB
//     (16x16, cell-aligned, so half-extents of 8 px).
//   - Downward edges (drops) additionally accept a walk-off composite:
//     slide one cell toward the drift direction, free-fall the source
//     column's neighbor, land, then walk the drift row (footing required
//     beneath every drifted column). This models stepping off a ledge
//     without jumping; a one-way shelf the body descends onto blocks the
//     fall via the came-from-above rule (see below).
//   - Walks are swept as a sliding 16x16 box translated one cell.
//
// Any sample intersecting a Solid rejects that motion. OneWay tiles block a
// DESCENDING body only when it originated at or above the tile top (the
// engine's resolveY came-from-above rule, physics.ts); ascending and lateral
// motions pass through them. Hazard tiles never obstruct (geometrically
// traversable). Pure arithmetic, fixed steps, no RNG (CLAUDE.md determinism).
// ---------------------------------------------------------------------------

const PLAYER_HALF_EXTENT = 8;
const HALF_TILE = 8;
/** Quarter of the fixed physics step: 240 sweep samples per second. */
const SWEEP_DT = 1 / 240;
/** Cap so pathological spring flights stay bounded. */
const MAX_SWEEP_SAMPLES = 4000;

/**
 * True if the player-sized box centered at (cx, cy) overlaps any Solid
 * tile. Out-of-bounds areas do not obstruct (edges are bounds-checked
 * before the sweep runs).
 */
function sampleHitsSolid(
  grid: ValidatorGrid,
  cx: number,
  cy: number,
): boolean {
  const minX = Math.floor((cx - PLAYER_HALF_EXTENT) / TILE_SIZE);
  const maxX = Math.floor((cx + PLAYER_HALF_EXTENT - 1) / TILE_SIZE);
  const minY = Math.floor((cy - PLAYER_HALF_EXTENT) / TILE_SIZE);
  const maxY = Math.floor((cy + PLAYER_HALF_EXTENT - 1) / TILE_SIZE);
  for (let r = minY; r <= maxY; r++) {
    if (r < 0 || r >= grid.rows) continue;
    for (let c = minX; c <= maxX; c++) {
      if (c < 0 || c >= grid.cols) continue;
      if (grid.tiles[r * grid.cols + c] === Tile.Solid) return true;
    }
  }
  return false;
}

/**
 * True if the player-sized box centered at (cx, cy) obstructs a DESCENDING
 * body that began this step with its bottom edge at `prevBottom` (the
 * previous sample's bottom edge).
 *
 * Mirrors the engine's per-transition one-way rule (physics.ts resolveY):
 *   - a Solid tile blocks whenever the box overlaps it (the established,
 *     conservative sampler behaviour);
 *   - a OneWay tile blocks only when the body's bottom edge crossed the
 *     tile's top face downward this step (prevBottom <= tileTop < bottom),
 *     i.e. the body descended onto the shelf from above. A body rising from
 *     below or drifting laterally never satisfies the crossing, so it passes.
 *
 * The crossing test is expressed as a row/column scan rather than a box
 * overlap so it is robust to the sweep's sample phase: a monotone descent
 * always has exactly one sample whose bottom edge straddles the tile top,
 * whereas a box-overlap test can miss the shelf by a sub-tile margin when
 * the phase lands unfavourably.
 *
 * Issue #175: the sweep previously treated every OneWay as never
 * obstructing, so it certified descents through one-way shelves the engine
 * would land on. Out-of-bounds areas do not obstruct (edges are
 * bounds-checked before the sweep runs).
 */
function sampleBlocksBody(
  grid: ValidatorGrid,
  cx: number,
  cy: number,
  prevBottom: number,
): boolean {
  // Conservative Solid coverage: identical to sampleHitsSolid, so adding the
  // one-way rule never weakens solid detection for descending motions.
  if (sampleHitsSolid(grid, cx, cy)) return true;

  const bottom = cy + PLAYER_HALF_EXTENT;
  if (prevBottom >= bottom) return false; // not descending: no one-way crossing

  // Rows whose top face the bottom edge crossed downward this step, i.e.
  // tileTop in [prevBottom, bottom). The strict upper bound excludes the
  // supporting tile a landing body comes to rest on top of.
  const rLo = Math.ceil(prevBottom / TILE_SIZE);
  const rHi = Math.ceil(bottom / TILE_SIZE) - 1;
  // Body column span, matching the engine's spanStart/spanEnd convention.
  const cLo = Math.floor((cx - PLAYER_HALF_EXTENT) / TILE_SIZE);
  const cHi = Math.ceil((cx + PLAYER_HALF_EXTENT) / TILE_SIZE) - 1;
  for (let r = rLo; r <= rHi; r++) {
    if (r < 0 || r >= grid.rows) continue;
    for (let c = cLo; c <= cHi; c++) {
      if (c < 0 || c >= grid.cols) continue;
      if (grid.tiles[r * grid.cols + c] === Tile.OneWay) return true;
    }
  }
  return false;
}

/**
 * Cheap bounding-box precheck: if no Solid tile intersects the inflated
 * rectangle covering the whole swept path, the path is trivially clear.
 *
 * `includeOneWay` extends the test to OneWay tiles (issue #175): for a
 * descending motion a one-way shelf inside the region can block the path, so
 * its mere presence must defeat the shortcut and force the full sampled
 * sweep. Direction of error stays conservative either way: over-inclusion
 * only costs sampling, under-inclusion would certify a blocked descent.
 */
function regionHasSolid(
  grid: ValidatorGrid,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  includeOneWay = false,
): boolean {
  const c0 = Math.floor(minX / TILE_SIZE);
  const c1 = Math.floor(maxX / TILE_SIZE);
  const r0 = Math.floor(minY / TILE_SIZE);
  const r1 = Math.floor(maxY / TILE_SIZE);
  for (let r = r0; r <= r1; r++) {
    if (r < 0 || r >= grid.rows) continue;
    for (let c = c0; c <= c1; c++) {
      if (c < 0 || c >= grid.cols) continue;
      const tile = grid.tiles[r * grid.cols + c];
      if (tile === Tile.Solid) return true;
      if (includeOneWay && tile === Tile.OneWay) return true;
    }
  }
  return false;
}

/**
 * Sweeps one jump-envelope edge from (col,row) to (nc,nr).
 *
 * `jumpVelAbs` is the takeoff vertical speed (260 for a normal jump, the
 * spring impulse on a spring tile). Returns true when at least one legal
 * motion connects the two cells without clipping a Solid.
 *
 * Exported for direct unit testing of the sweep geometry.
 */
export function sweepEdge(
  grid: ValidatorGrid,
  col: number,
  row: number,
  nc: number,
  nr: number,
  jumpVelAbs: number,
  inverted = false,
): boolean {
  const sx = col * TILE_SIZE + HALF_TILE;
  const sy = row * TILE_SIZE + HALF_TILE;
  const ex = nc * TILE_SIZE + HALF_TILE;
  const ey = nr * TILE_SIZE + HALF_TILE;

  // Solidity test.
  const hits = (x: number, y: number): boolean =>
    sampleHitsSolid(grid, x, y);

  // ---- Motion 1: the jumped arc family ------------------------------------
  //
  // y(t) = sy - v0 t + g/2 t^2 with takeoff speed v0. The landing time for
  // y(t) = ey is the positive root of (g/2) t^2 - v0 t + (sy - ey) = 0:
  //   t = (v0 + sqrt(v0^2 - 2 g (sy - ey))) / g
  // which exists iff v0 >= v_min = sqrt(2 g (sy - ey)), the minimal arc
  // that reaches the destination (apex exactly at the higher endpoint).
  //
  // The engine supports a RANGE of jump heights: holding jump flies the
  // full impulse; tapping cuts it (release cut x0.5). We therefore sweep a
  // small deterministic family of arcs and accept the edge when ANY of
  // them flies clean:
  //   v_min (grazing arc), 0.5x, 0.75x, and the full impulse.
  // Low arcs certify tight-headroom hops; the full arc certifies hops over
  // mid-path obstacles; a wall blocks every member of the family.
  // Gravity sign: +1 normal (pulls toward +y, so the player launches toward
  // -y and lands on the cell below); -1 inverted (the exact y-mirror: pulls
  // toward -y, launches toward +y, lands on the cell above). Every vertical
  // term below carries `gSign`, so one code path flies both parabolas.
  const gSign = inverted ? -1 : 1;
  const dy = sy - ey;
  // Minimum launch speed whose apex exactly reaches the destination. The
  // "against gravity" displacement is gSign * dy (positive when the target
  // lies opposite the pull).
  const vMin = Math.sqrt(2 * CONTROLLER_GRAVITY * Math.max(gSign * dy, 0));

  const candidates: number[] = [];
  for (const f of [1, 0.75, 0.5]) {
    const v = jumpVelAbs * f;
    if (v >= vMin - 1e-9) candidates.push(v);
  }
  if (gSign * dy > 0) candidates.push(vMin);

  for (const v0 of candidates) {
    const disc = v0 * v0 - 2 * CONTROLLER_GRAVITY * gSign * dy;
    if (disc < 0) continue;
    const tLand = (v0 + Math.sqrt(disc)) / CONTROLLER_GRAVITY;
    const vx = (ex - sx) / tLand;
    // Physical feasibility: the controller cannot sustain more than
    // MAX_RUN of horizontal speed in EITHER direction, and vx is signed
    // (leftward arcs are negative), so the cap must test the magnitude.
    // The unsigned comparison let leftward arcs bypass it entirely.
    if (Math.abs(vx) > CONTROLLER_MAX_RUN) continue;
    const apexY = sy - gSign * (v0 * v0) / (2 * CONTROLLER_GRAVITY);

    // Bounding box precheck over the full arc. A descending arc can be
    // stopped by a one-way shelf, so OneWay presence in the region defeats
    // the shortcut (issue #175); over-inclusion only costs sampling.
    if (
      !regionHasSolid(
        grid,
        Math.min(sx, ex) - PLAYER_HALF_EXTENT,
        Math.min(apexY, sy, ey) - PLAYER_HALF_EXTENT,
        Math.max(sx, ex) + PLAYER_HALF_EXTENT,
        Math.max(sy, ey) + PLAYER_HALF_EXTENT,
        true,
      )
    ) {
      return true;
    }

    const samples = Math.min(
      MAX_SWEEP_SAMPLES,
      Math.max(8, Math.ceil(tLand / SWEEP_DT)),
    );
    let arcOk = true;
    // One-way semantics (issue #175): carry the previous sample's bottom
    // edge. A sample that overlaps a one-way shelf the body originated above
    // is rejected, mirroring the engine's resolveY; the ascent half of every
    // arc carries a prevBottom below the shelf top and passes, matching the
    // engine's pass-through from below.
    let prevBottom = sy + PLAYER_HALF_EXTENT;
    for (let i = 0; i <= samples; i++) {
      const t = (tLand * i) / samples;
      const x = sx + vx * t;
      const y = sy - gSign * v0 * t + gSign * (CONTROLLER_GRAVITY / 2) * t * t;
      if (sampleBlocksBody(grid, x, y, prevBottom)) {
        arcOk = false;
        break;
      }
      prevBottom = y + PLAYER_HALF_EXTENT;
    }
    if (arcOk) return true;
  }

  // ---- Motion 2 (effective-rising edges): the apex-drift detour ------------
  // The engine supports rising with a ceiling bonk (vy arrests, horizontal
  // velocity is preserved and the player slides) and drifting at apex
  // altitude. Model both as: rise straight up the source column to the
  // destination altitude, then traverse horizontally at that altitude.
  // Available only when the rise is within the takeoff impulse's apex
  // (v0^2 / 2g); a wall blocks the traverse, a low ceiling blocks the
  // rise, and the plain arc family already covers unobstructed jumps.
  //
  // Deliberately NOT extended with the one-way rule (issue #175): this
  // motion RISES then moves horizontally, and the engine's resolveY one-way
  // blocking only applies to a falling body (resolveX ignores one-way tiles
  // entirely). The rise leg comes from below, so a one-way shelf is passed,
  // and the apex traverse is lateral, so a one-way at the destination
  // altitude is not a landing. Only descending motions need the rule.
  //
  // The traverse is bounded by the time the jump spends at or above the
  // destination altitude: the interval between crossing that altitude
  // upward and dropping back below it. Only the distance coverable in
  // that window (accelerating from rest to MAX_RUN) qualifies; beyond
  // that the detour would glide, which jump dynamics cannot sustain.
  // Direction of travel relative to the pull: "rising" means moving against
  // gravity (gSign * (row - nr) > 0), "falling" means moving with it.
  const rising = gSign * (row - nr) > 0;
  const falling = gSign * (nr - row) > 0;
  if (rising && Math.abs(row - nr) * TILE_SIZE <= (jumpVelAbs * jumpVelAbs) / (2 * CONTROLLER_GRAVITY)) {
    const risePx = Math.abs(row - nr) * TILE_SIZE;
    // Time from the destination altitude to the apex and back down to it.
    const vAtAlt = Math.sqrt(jumpVelAbs * jumpVelAbs - 2 * CONTROLLER_GRAVITY * risePx);
    const tAbove = (2 * vAtAlt) / CONTROLLER_GRAVITY;
    // Deliberately conservative: accelerating from rest understates a
    // running jump's reach (the player arrives at this altitude already
    // carrying horizontal speed). The shortfall only risks false-blocking,
    // never false-certification, which is the safe direction.
    // Generous horizontal reach while at/above the altitude: accelerate
    // from rest to MAX_RUN for the whole window.
    const tToMax = CONTROLLER_MAX_RUN / CONTROLLER_ACCEL;
    const reach =
      tAbove <= tToMax
        ? 0.5 * CONTROLLER_ACCEL * tAbove * tAbove
        : 0.5 * CONTROLLER_ACCEL * tToMax * tToMax +
          CONTROLLER_MAX_RUN * (tAbove - tToMax);
    if (Math.abs(ex - sx) <= reach) {
      // Leg A: vertical rise in the source column. The launch sample is
      // skipped: the standing box legitimately overlaps its own support tile.
      const riseSpan = sy - ey;
      const riseSamples = Math.max(2, Math.ceil(riseSpan / 2));
      let riseOk = true;
      for (let i = 1; i <= riseSamples; i++) {
        const y = sy - riseSpan * (i / riseSamples);
        if (hits(sx, y)) {
          riseOk = false;
          break;
        }
      }
      // Leg B: horizontal traverse at the destination altitude.
      if (riseOk) {
        if (ex !== sx) {
          const travSamples = Math.max(2, Math.abs(nc - col) * 8);
          for (let i = 0; i <= travSamples; i++) {
            const x = sx + (ex - sx) * (i / travSamples);
            if (hits(x, ey)) {
              riseOk = false;
              break;
            }
          }
        }
      }
      if (riseOk) return true;
    }
  }

  // ---- Motion 3 (downward edges only): the walk-off composite -------------
  // Slide one cell toward the drift direction, free-fall that column, LAND,
  // then walk the drift row to the destination column. Models stepping off
  // a ledge without jumping. The free-fall leg carries the came-from-above
  // one-way rule (issue #175): a shelf the body originated above blocks the
  // fall, so a chamber sealed by a full-width one-way shelf is no longer
  // certified. Landing ON TOP of a one-way still certifies (the landing
  // sample sits above its support tile, so no one-way overlaps it).
  //
  // Soundness (#161 fix round): the post-fall drift is a GROUNDED walk, so
  // every column of the drift row, from the fall column through the
  // destination, must provide standable footing beneath it. The previous
  // formulation drifted at the landing altitude with no footing requirement
  // and short-circuited through a composite bounding-box precheck that
  // accepted any merely solid-free region, certifying unbounded mid-air
  // glides across chasms the real controller cannot cross (ballistic drift
  // on a shallow fall is bounded by MAX_RUN times the fall time, far short
  // of what the old drift allowed).
  if (falling) {
    const dir = Math.sign(nc - col);
    const fallCol = dir === 0 ? col : col + dir;
    const fcx = fallCol * TILE_SIZE + HALF_TILE;

    // Local verdict flag, matching the Motions 1-2 style: a failed phase
    // rejects THIS composite, not the whole edge evaluation. (An early
    // return here would be accidentally equivalent only because Motion 3
    // is the last motion tried.)
    let compositeOk = true;

    // Phase 0: footing along the drift row. The fall must land on a
    // surface in the fall column, and the drift to the destination is a
    // walk, so every intervening column needs a floor too. isStandable
    // handles one-way surfaces and moving-platform overrides; a missing
    // floor anywhere in the span rejects the edge.
    const driftLo = Math.min(fallCol, nc);
    const driftHi = Math.max(fallCol, nc);
    for (let cc = driftLo; cc <= driftHi && compositeOk; cc++) {
      if (!isStandable(grid, cc, nr)) compositeOk = false;
    }

    // Phase A: slide one cell at the source height.
    if (compositeOk) {
      const slideSamples = 8;
      for (let i = 0; i <= slideSamples && compositeOk; i++) {
        const x = sx + (fcx - sx) * (i / slideSamples);
        if (hits(x, sy)) compositeOk = false;
      }
    }

    // Phase B: free fall down the fall column. One-way semantics
    // (issue #175): carry the previous sample's bottom edge so a shelf the
    // body descended onto from above blocks the fall, matching the engine's
    // resolveY. The landing sample sits above its support tile, so arriving
    // on top of a one-way still certifies.
    if (compositeOk) {
      const fallSpan = ey - sy;
      const fallSamples = Math.max(2, Math.ceil(fallSpan / 1.6));
      let prevBottom = sy + PLAYER_HALF_EXTENT;
      for (let i = 0; i <= fallSamples && compositeOk; i++) {
        const y = sy + fallSpan * (i / fallSamples);
        if (sampleBlocksBody(grid, fcx, y, prevBottom)) compositeOk = false;
        prevBottom = y + PLAYER_HALF_EXTENT;
      }
    }

    // Phase C: drift at the landing height to the destination column.
    if (compositeOk && fcx !== ex) {
      const driftSamples = Math.abs(nc - fallCol) * 8;
      for (let i = 0; i <= driftSamples && compositeOk; i++) {
        const x = fcx + (ex - fcx) * (i / driftSamples);
        if (hits(x, ey)) compositeOk = false;
      }
    }
    if (compositeOk) return true;
  }

  return false;
}

/**
 * Sweeps a one-cell walk from (col,row) to (nc,row) as a sliding 16x16 box.
 * Walking is a horizontal translation at ground level.
 */
function walkPathClear(
  grid: ValidatorGrid,
  col: number,
  row: number,
  nc: number,
): boolean {
  const y = row * TILE_SIZE + HALF_TILE;
  if (
    !regionHasSolid(
      grid,
      Math.min(col, nc) * TILE_SIZE,
      y - PLAYER_HALF_EXTENT,
      Math.max(col, nc) * TILE_SIZE + TILE_SIZE,
      y + PLAYER_HALF_EXTENT,
    )
  ) {
    return true;
  }
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = col * TILE_SIZE + HALF_TILE + (nc - col) * TILE_SIZE * t;
    if (sampleHitsSolid(grid, x, y)) return false;
  }
  return true;
}

const NEIGHBORS = jumpNeighbors();

// ---------------------------------------------------------------------------
// Mechanic parsing helpers
// ---------------------------------------------------------------------------

function numParam(params: Readonly<Record<string, JsonValue>>, key: string): number | undefined {
  const v = params[key];
  return typeof v === 'number' ? v : undefined;
}

function boolParam(
  params: Readonly<Record<string, JsonValue>>,
  key: string,
  defaultValue: boolean,
): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : defaultValue;
}

/** Converts a pixel-space coordinate to a tile coordinate (floor division). */
function pxToTile(px: number): number {
  return Math.floor(px / TILE_SIZE);
}

// ---------------------------------------------------------------------------
// Mechanic extraction structures
// ---------------------------------------------------------------------------

interface SpringInfo {
  /** Tile coordinates of the spring. */
  col: number;
  row: number;
  /** Effective rise in tiles computed from |impulseY|. */
  riseTiles: number;
  /** Raw |impulseY| for the swept arc. */
  impulseAbs: number;
}

interface TeleporterInfo {
  /** Source tile coordinates. */
  srcCol: number;
  srcRow: number;
  /** Destination tile coordinates. */
  destCol: number;
  destRow: number;
  oneWay: boolean;
}

interface MovingTerrainInfo {
  /** Endpoint A tile coordinates. */
  aCol: number;
  aRow: number;
  /** Endpoint B tile coordinates. */
  bCol: number;
  bRow: number;
}

interface GravityZoneInfo {
  colMin: number;
  rowMin: number;
  colMax: number; // exclusive
  rowMax: number; // exclusive
}

interface ExtractedMechanics {
  springs: SpringInfo[];
  teleporters: TeleporterInfo[];
  movingTerrain: MovingTerrainInfo[];
  gravityZones: GravityZoneInfo[];
}

/**
 * Computes the peak rise (in tiles) from a vertical impulse.
 *
 * The controller's normal jump reaches peak when vy = 0:
 *   steps_to_apex = |impulseY| / gravity
 *   peak_height_px = |impulseY| * steps_to_apex / 2  (kinematic: v²/(2g))
 *   peak_tiles = peak_height_px / TILE_SIZE
 *
 * This is the same relationship that calibrates MAX_RISE from JUMP_VEL=-260,
 * GRAVITY=900: 260² / (2 * 900) = 37.6 px ≈ 2.35 tiles.
 */
function computeSpringRiseTiles(impulseY: number): number {
  const absImpulse = Math.abs(impulseY);
  const peakPx = (absImpulse * absImpulse) / (2 * CONTROLLER_GRAVITY);
  return peakPx / TILE_SIZE;
}

/**
 * Extracts mechanics info from the level's optional `mechanics` array.
 * Unknown mechanic types are silently skipped: the validator only models
 * mechanics that affect pathfinding geometry. Gravity zones ARE extracted
 * (issue #174): the inversion model consumes them to mirror standability
 * and the jump/drop envelope inside their rectangles.
 */
function extractMechanics(level: LevelData): ExtractedMechanics {
  const result: ExtractedMechanics = {
    springs: [],
    teleporters: [],
    movingTerrain: [],
    gravityZones: [],
  };

  const mechanics = level.mechanics;
  if (!mechanics || mechanics.length === 0) return result;

  for (const entry of mechanics) {
    switch (entry.type) {
      case 'spring':
        extractSpring(entry, result);
        break;
      case 'teleporter':
        extractTeleporter(entry, result);
        break;
      case 'moving-platform':
        extractMovingPlatform(entry, result);
        break;
      case 'gravity-zone':
        extractGravityZone(entry, result);
        break;
      default:
        // Unrecognized mechanic type: not pathfinding-relevant.
        break;
    }
  }

  return result;
}

function extractSpring(entry: MechanicEntry, result: ExtractedMechanics): void {
  const x = numParam(entry.params, 'x');
  const y = numParam(entry.params, 'y');
  const impulseY = numParam(entry.params, 'impulseY');
  if (x === undefined || y === undefined || impulseY === undefined) return;

  result.springs.push({
    col: pxToTile(x),
    row: pxToTile(y),
    riseTiles: computeSpringRiseTiles(impulseY),
    impulseAbs: Math.abs(impulseY),
  });
}

function extractTeleporter(entry: MechanicEntry, result: ExtractedMechanics): void {
  const x = numParam(entry.params, 'x');
  const y = numParam(entry.params, 'y');
  const destX = numParam(entry.params, 'destX');
  const destY = numParam(entry.params, 'destY');
  if (x === undefined || y === undefined ||
      destX === undefined || destY === undefined) return;

  const oneWay = boolParam(entry.params, 'oneWay', false);

  result.teleporters.push({
    srcCol: pxToTile(x),
    srcRow: pxToTile(y),
    destCol: pxToTile(destX),
    destRow: pxToTile(destY),
    oneWay,
  });
}

function extractMovingPlatform(entry: MechanicEntry, result: ExtractedMechanics): void {
  const startX = numParam(entry.params, 'startX');
  const startY = numParam(entry.params, 'startY');
  const dx = numParam(entry.params, 'dx');
  const dy = numParam(entry.params, 'dy');
  const distance = numParam(entry.params, 'distance');
  if (startX === undefined || startY === undefined ||
      dx === undefined || dy === undefined ||
      distance === undefined) return;

  // Normalize the direction vector.
  const len = Math.hypot(dx, dy) || 1;
  const ndx = dx / len;
  const ndy = dy / len;

  // Endpoint A: the start position.
  const aCol = pxToTile(startX);
  const aRow = pxToTile(startY);

  // Endpoint B: start + normalized_dir * distance.
  const endX = startX + ndx * distance;
  const endY = startY + ndy * distance;
  const bCol = pxToTile(endX);
  const bRow = pxToTile(endY);

  result.movingTerrain.push({ aCol, aRow, bCol, bRow });
}

/**
 * Extracts a gravity zone's tile rectangle. The zone inverts gravity for any
 * body overlapping it, so the validator mirrors standability and the jump/
 * drop envelope inside these bounds. Params are pixel-space x/y (top-left)
 * plus width/height (issue #174).
 */
function extractGravityZone(entry: MechanicEntry, result: ExtractedMechanics): void {
  const x = numParam(entry.params, 'x');
  const y = numParam(entry.params, 'y');
  const width = numParam(entry.params, 'width');
  const height = numParam(entry.params, 'height');
  if (x === undefined || y === undefined ||
      width === undefined || height === undefined) return;

  const colMin = pxToTile(x);
  const rowMin = pxToTile(y);
  const colMax = pxToTile(x + width);
  const rowMax = pxToTile(y + height);
  // Degenerate rects invert nothing.
  if (colMax <= colMin || rowMax <= rowMin) return;

  result.gravityZones.push({ colMin, rowMin, colMax, rowMax });
}

// ---------------------------------------------------------------------------
// Core BFS
// ---------------------------------------------------------------------------

export function validateSolvability(level: LevelData): SolvabilityResult {
  // Physics-calibrated BFS: can the player walk/jump/drop from spawn to exit
  // using the real controller's jump envelope? One-way platforms are standable;
  // solids block; hazards are geometrically passable.
  //
  // Key constraint: the player can only jump or walk from a standable position
  // (a passable tile with a solid/one-way surface beneath it), and every jump
  // or drop destination must also be standable. This prevents the BFS from
  // chaining jumps through mid-air tiles --- the player must land on something
  // before jumping again.
  //
  // Mechanics (#129 cp7): springs, teleporters, and moving platforms
  // augment the BFS graph. See extractMechanics for details. Gravity
  // zones ARE modelled (issue #174): inside a zone the gravity sign flips,
  // so standability and the jump/drop envelope are mirrored.
  //
  // Every edge is swept for solid obstruction (#161); see sweepEdge.

  const reachable = bfsReachable(level);

  if (reachable) {
    return { reachable: true, status: 'solvable', unmodeled: [] };
  }

  // BFS failed: withhold the verdict when the level declares traversal-
  // relevant mechanics the validator does not model.
  const unmodeled: string[] = [];
  for (const trap of level.traps) {
    if (TRAVERSAL_UNMODELED_TYPES.has(trap.type)) unmodeled.push(trap.type);
  }
  for (const mech of level.mechanics ?? []) {
    if (TRAVERSAL_UNMODELED_TYPES.has(mech.type)) unmodeled.push(mech.type);
  }

  if (unmodeled.length > 0) {
    return { reachable: false, status: 'not-modelled', unmodeled };
  }
  return { reachable: false, status: 'unsolvable', unmodeled: [] };
}

/**
 * Boolean thin-wrapper over {@link validateSolvability}.
 */
export function validateReachability(level: LevelData): boolean {
  return validateSolvability(level).reachable;
}

/**
 * The raw BFS flood-fill from spawn to exit. Returns true when the exit is
 * reached through swept, physically feasible edges.
 */
export function bfsReachable(level: LevelData): boolean {
  const baseGrid = levelToGrid(level);
  const mech = extractMechanics(level);

  // Build the validator grid with moving-platform standable overrides.
  const extraStandable = new Set<string>();
  for (const mt of mech.movingTerrain) {
    extraStandable.add(gridKey(mt.aCol, mt.aRow));
    extraStandable.add(gridKey(mt.bCol, mt.bRow));
  }

  const grid: ValidatorGrid = {
    cols: baseGrid.cols,
    rows: baseGrid.rows,
    tiles: baseGrid.tiles,
    extraStandable,
    gravityZones: mech.gravityZones,
  };

  // Pre-compute spring launch neighbor sets keyed by spring tile.
  const springCache = new Map<
    string,
    { neighbors: Array<{ dc: number; dr: number }>; impulseAbs: number }
  >();
  for (const sp of mech.springs) {
    const k = gridKey(sp.col, sp.row);
    if (!springCache.has(k)) {
      springCache.set(k, {
        neighbors: springLaunchNeighbors(sp.riseTiles),
        impulseAbs: sp.impulseAbs,
      });
    }
  }

  // Pre-build teleporter adjacency: for each teleporter tile, a list of
  // destination tiles. Reciprocal edges are added for bidirectional pairs.
  const teleportEdges = new Map<string, Array<{ col: number; row: number }>>();
  for (const tp of mech.teleporters) {
    const srcKey = gridKey(tp.srcCol, tp.srcRow);
    const dest = { col: tp.destCol, row: tp.destRow };
    const list = teleportEdges.get(srcKey) ?? [];
    list.push(dest);
    teleportEdges.set(srcKey, list);

    // Bidirectional: if not oneWay, also add reverse edge.
    if (!tp.oneWay) {
      const destKey = gridKey(tp.destCol, tp.destRow);
      const revList = teleportEdges.get(destKey) ?? [];
      revList.push({ col: tp.srcCol, row: tp.srcRow });
      teleportEdges.set(destKey, revList);
    }
  }

  // Pre-build moving-platform ride edges: the player can ride a platform
  // between its two endpoint positions. This connects the two standable
  // cells that the platform creates.
  const platformEdges = new Map<string, Array<{ col: number; row: number }>>();
  for (const mt of mech.movingTerrain) {
    const aKey = gridKey(mt.aCol, mt.aRow);
    const bKey = gridKey(mt.bCol, mt.bRow);
    if (aKey === bKey) continue; // degenerate platform (zero distance)

    const aList = platformEdges.get(aKey) ?? [];
    aList.push({ col: mt.bCol, row: mt.bRow });
    platformEdges.set(aKey, aList);

    const bList = platformEdges.get(bKey) ?? [];
    bList.push({ col: mt.aCol, row: mt.aRow });
    platformEdges.set(bKey, bList);
  }

  const visited = new Set<string>();

  // Seed: the spawn position. If the spawn isn't standable (floating in open
  // space with no floor beneath), the level is vacuously unreachable.
  if (!isStandable(grid, level.spawn.col, level.spawn.row)) return false;

  const queue: Array<{ col: number; row: number }> = [
    { col: level.spawn.col, row: level.spawn.row },
  ];
  visited.add(gridKey(level.spawn.col, level.spawn.row));

  while (queue.length > 0) {
    const { col, row } = queue.shift()!;
    if (col === level.exit.col && row === level.exit.row) return true;

    const posKey = gridKey(col, row);
    // Gravity sign at the source cell (issue #174): inside a zone the pull
    // is inverted, so the jump/drop envelope mirrors about the player.
    const inverted = isInvertedRegion(grid, col, row);

    // Determine which neighbor set applies at this position.
    // Springs override the normal jump envelope if the player is on the
    // spring tile. Otherwise use the standard physics neighbors.
    let neighbors: Array<{ dc: number; dr: number }>;
    let jumpVelAbs = NORMAL_JUMP_VEL_ABS;

    // Choose neighbor set: spring takes precedence if present. Springs inside
    // a gravity zone are exempt: the engine's spring impulse overwrites vy in
    // absolute terms, independent of the gravity sign (applySpringImpulse),
    // so the modelled rise, which assumes the launch fights normal gravity,
    // does not describe flight once the pull is inverted. Falling back to the
    // zone-mirrored jump envelope under-certifies reach rather than certifying
    // a launch the engine cannot actually make.
    const springAt = inverted ? undefined : springCache.get(posKey);
    if (springAt) {
      neighbors = springAt.neighbors;
      jumpVelAbs = springAt.impulseAbs;
    } else {
      neighbors = NEIGHBORS;
    }

    // In an inverted region, mirror every vertical offset: a "jump against
    // gravity" moves toward +y (the zone's floor is above the player), and a
    // "drop with gravity" moves toward -y. The envelope is symmetric, so the
    // mirrored neighbor set covers the same local reach.
    if (inverted) {
      neighbors = neighbors.map(({ dc, dr }) => ({ dc, dr: -dr }));
    }

    for (const { dc, dr } of neighbors) {
      const nc = col + dc;
      const nr = row + dr;
      const nKey = gridKey(nc, nr);
      if (visited.has(nKey)) continue;
      if (nc < 0 || nc >= grid.cols || nr < 0 || nr >= grid.rows) continue;

      // Destination validity. Ordinary destinations must be standable:
      // the player has to land on a surface before moving again. The
      // EXIT cell is the exception: the engine completes the level the
      // moment the player AABB overlaps the exit cell (scene.ts exit
      // check), so a merely-passable exit reached by a swept edge
      // suffices --- no footing beneath it is required. This matters for
      // levels like w2/ceiling-walk whose exit hangs in the air in
      // normal gravity and is touched mid-arc.
      const isExitCell =
        nc === level.exit.col && nr === level.exit.row;
      const destinationValid =
        (isExitCell && isPassable(grid.tiles[nr * grid.cols + nc])) ||
        isStandable(grid, nc, nr);
      if (!destinationValid) continue;

      // Swept-path obstruction (issue #161): every edge must be physically
      // flyable. Walks translate a player-sized box; jumps and drops sweep
      // the controller's parabola (plus the walk-off composite for drops).
      // `inverted` tells the sweep which way gravity pulls at the source.
      if (dr === 0 && Math.abs(dc) === 1) {
        if (!walkPathClear(grid, col, row, nc)) continue;
      } else if (!sweepEdge(grid, col, row, nc, nr, jumpVelAbs, inverted)) {
        continue;
      }

      visited.add(nKey);
      queue.push({ col: nc, row: nr });
    }

    // Teleporter edges: guaranteed transitions from the teleporter tile to
    // the destination tile (if standable). These are independent of the
    // physical jump/drop neighbors.
    const tpDestinations = teleportEdges.get(posKey);
    if (tpDestinations) {
      for (const dest of tpDestinations) {
        const dKey = gridKey(dest.col, dest.row);
        if (visited.has(dKey)) continue;
        if (dest.col < 0 || dest.col >= grid.cols ||
            dest.row < 0 || dest.row >= grid.rows) continue;
        if (!isStandable(grid, dest.col, dest.row)) continue;
        visited.add(dKey);
        queue.push({ col: dest.col, row: dest.row });
      }
    }

    // Moving-platform ride edges: the player can ride the platform from one
    // endpoint to the other. Both endpoints are standable (via the
    // extraStandable set), so the ride is a guaranteed edge.
    const platDests = platformEdges.get(posKey);
    if (platDests) {
      for (const dest of platDests) {
        const dKey = gridKey(dest.col, dest.row);
        if (visited.has(dKey)) continue;
        if (dest.col < 0 || dest.col >= grid.cols ||
            dest.row < 0 || dest.row >= grid.rows) continue;
        if (!isStandable(grid, dest.col, dest.row)) continue;
        visited.add(dKey);
        queue.push({ col: dest.col, row: dest.row });
      }
    }
  }

  return false;
}

