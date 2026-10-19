// Runtime engine-parity harness for the one-way sweep predicate (issue #183).
//
// The sweep predicate in reachability.ts (#175) models the engine's one-way
// platforms in closed form: a descent is blocked when it crosses a OneWay
// tile's top face, and a body already inside the shelf row is never blocked
// laterally. Nothing checked that model against the engine's actual stepper,
// so a drift between the two stays invisible until a generated level traps a
// player at runtime. This harness drives the REAL stepper (moveAndCollide with
// the controller's gravity schedule) and asserts, transition by transition,
// that the predicate's verdict matches the engine's observable behavior:
// resolveY refusing the integrated position, or a grounded flip.
//
// Domain. The sweep samples poses of a descending body along an arc, up to and
// including the flush landing pose; the six probes below stay inside that
// domain. Both views of every fixture are parsed from one digit matrix, so the
// engine grid (testGrid.parseGrid) and the validator grid cannot drift apart.
// Five probes run with vx = 0, which makes resolveX a provable no-op (its
// vx === 0 branch returns body.x + 0 * dt); the sixth drives a real lateral
// drift against a lone shelf tile.
//
// Non-vacuity. Agreement alone cannot pass here: each of the six probes also
// asserts the known verdict direction per transition, and three intentional,
// test-local mutants (marked INTENTIONAL MUTANT, never shipped) must produce
// the exact disagreement fingerprint they are built to produce. The real
// engine and the real predicate are never modified.
import { describe, expect, it } from 'vitest';
import { GRAVITY, JUMP_VEL, MAX_RUN, TERMINAL_VEL } from '../engine/controller';
import { DT } from '../engine/loop';
import {
  TILE_SIZE,
  Tile as EngineTile,
  moveAndCollide,
  tileAt,
  type Body,
  type TileGrid,
} from '../engine/physics';
import { parseGrid } from '../engine/testGrid';
import { Tile } from '../levels/types';
import { sampleBlocksBody } from './reachability';

const PLAYER_SIZE = 16;
const HALF = PLAYER_SIZE / 2;

// Digit code to engine testGrid char: '.' Empty, '#' Solid, '-' OneWay.
const ENGINE_CHAR: Record<string, string> = { '0': '.', '1': '#', '2': '-' };

/**
 * The validator grid shape. ValidatorGrid is not exported, so structural
 * typing supplies it, the same pattern sweep-geometry.test.ts uses.
 */
interface ViewGrid {
  cols: number;
  rows: number;
  tiles: Tile[];
  extraStandable: Set<string>;
  gravityZones: Array<{ colMin: number; rowMin: number; colMax: number; rowMax: number }>;
}

/** Validator view of a digit matrix: the digits are the Tile enum values. */
function viewGridFrom(rowsOfDigits: readonly string[]): ViewGrid {
  const rows = rowsOfDigits.length;
  const cols = rowsOfDigits[0]?.length ?? 0;
  const tiles: Tile[] = [];
  for (const row of rowsOfDigits) {
    for (const digit of row) {
      tiles.push(Number(digit) as Tile);
    }
  }
  return { cols, rows, tiles, extraStandable: new Set<string>(), gravityZones: [] };
}

/** Engine view of the same digit matrix, via the engine's own test parser. */
function engineGridFrom(rowsOfDigits: readonly string[]): TileGrid {
  return parseGrid(
    rowsOfDigits.map((row) =>
      row
        .split('')
        .map((digit) => ENGINE_CHAR[digit] ?? '.')
        .join(''),
    ),
  );
}

/** One engine step, recorded with everything the predicate call needs. */
interface ProbeStep {
  /** 1-based step index. */
  readonly step: number;
  /** Vertical speed after the gravity age, the speed this step moved with. */
  readonly vy: number;
  readonly vx: number;
  /** Body top edge at the start of the step (the previous step's resolved y). */
  readonly preY: number;
  /** preY + PLAYER_SIZE, the bottom edge the predicate chains from. */
  readonly prevBottom: number;
  /** Post-integration position, what the engine handed to its resolve pass. */
  readonly integratedX: number;
  readonly integratedY: number;
  readonly resolvedY: number;
  readonly wasGrounded: boolean;
  readonly grounded: boolean;
  readonly hitWall: boolean;
  /** resolveY refused the integrated position, or the grounded flag flipped. */
  readonly engineBlocked: boolean;
}

interface Probe {
  readonly name: string;
  readonly engine: TileGrid;
  readonly validator: ViewGrid;
  readonly steps: readonly ProbeStep[];
}

interface ProbeStart {
  readonly x: number;
  readonly y: number;
  readonly vx?: number;
  readonly vy?: number;
}

/**
 * Drives the real stepper for a fixed number of steps.
 *
 * The vertical speed is aged exactly as controller.ts does before a move
 * (vy + GRAVITY * dt, capped at TERMINAL_VEL), then moveAndCollide runs with
 * the fixed DT. The engine returns body.y + vy * dt verbatim when it does not
 * arrest, so resolvedY !== integratedY is bit-exact evidence of an arrest.
 */
function driveProbe(
  name: string,
  rowsOfDigits: readonly string[],
  start: ProbeStart,
  stepCount: number,
): Probe {
  const engine = engineGridFrom(rowsOfDigits);
  const validator = viewGridFrom(rowsOfDigits);
  const steps: ProbeStep[] = [];
  let body: Body = {
    x: start.x,
    y: start.y,
    width: PLAYER_SIZE,
    height: PLAYER_SIZE,
    velocity: { x: start.vx ?? 0, y: start.vy ?? 0 },
    grounded: false,
  };
  for (let n = 1; n <= stepCount; n++) {
    const vy = Math.min(body.velocity.y + GRAVITY * DT, TERMINAL_VEL);
    const vx = body.velocity.x;
    const integratedX = body.x + vx * DT;
    const integratedY = body.y + vy * DT;
    const moved: Body = { ...body, velocity: { x: vx, y: vy } };
    const result = moveAndCollide(moved, engine, DT);
    steps.push({
      step: n,
      vy,
      vx,
      preY: body.y,
      prevBottom: body.y + PLAYER_SIZE,
      integratedX,
      integratedY,
      resolvedY: result.body.y,
      wasGrounded: body.grounded,
      grounded: result.body.grounded,
      hitWall: result.hitWall,
      engineBlocked:
        (result.body.grounded && !body.grounded) || result.body.y !== integratedY,
    });
    body = result.body;
  }
  return { name, engine, validator, steps };
}

/** Inclusive integer range, for readable expected step lists. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

function stepAt(probe: Probe, step: number): ProbeStep {
  const found = probe.steps.find((s) => s.step === step);
  if (found === undefined) throw new Error(`${probe.name}: no step ${step}`);
  return found;
}

function lastStep(probe: Probe): ProbeStep {
  const found = probe.steps[probe.steps.length - 1];
  if (found === undefined) throw new Error(`${probe.name}: no steps`);
  return found;
}

/** Steps where the engine refused the integrated position. */
function engineBlockedSteps(probe: Probe): number[] {
  return probe.steps.filter((s) => s.engineBlocked).map((s) => s.step);
}

type BlockVerdict = (probe: Probe, step: ProbeStep) => boolean;

/** The predicate under test, called the way the sweep calls it. */
const sweepPredicate: BlockVerdict = (probe, step) =>
  sampleBlocksBody(
    probe.validator,
    step.integratedX + HALF,
    step.integratedY + HALF,
    step.prevBottom,
  );

function verdictSteps(probe: Probe, verdict: BlockVerdict): number[] {
  return probe.steps.filter((s) => verdict(probe, s)).map((s) => s.step);
}

/** Steps where a verdict and the engine observable disagree. */
function disagreeingSteps(probe: Probe, verdict: BlockVerdict): number[] {
  return probe.steps
    .filter((s) => verdict(probe, s) !== s.engineBlocked)
    .map((s) => s.step);
}

/** Tile tops the bottom edge strictly crossed this step (tileTop in (prevBottom, bottom)). */
function crossedTileTops(step: ProbeStep): number[] {
  const bottom = step.integratedY + PLAYER_SIZE;
  const tops: number[] = [];
  for (let r = Math.ceil(step.prevBottom / TILE_SIZE); r * TILE_SIZE < bottom; r++) {
    tops.push(r * TILE_SIZE);
  }
  return tops;
}

/** Tile tops the bottom edge crossed or reached this step (tileTop in (prevBottom, bottom]). */
function touchedTileTops(step: ProbeStep): number[] {
  const bottom = step.integratedY + PLAYER_SIZE;
  const tops: number[] = [];
  // Half-open interval: a top counts when the step crosses it, so the
  // lower bound is strict (a body already sitting on a top did not just
  // cross it, and a resting body crosses nothing).
  for (let r = Math.floor(step.prevBottom / TILE_SIZE) + 1; r * TILE_SIZE <= bottom; r++) {
    tops.push(r * TILE_SIZE);
  }
  return tops;
}

/** Validator-view tile read with the out-of-bounds sentinel the sweep uses. */
function viewTileAt(grid: ViewGrid, col: number, row: number): Tile {
  if (row < 0 || row >= grid.rows || col < 0 || col >= grid.cols) return Tile.Empty;
  return grid.tiles[row * grid.cols + col] ?? Tile.Empty;
}

// ---------------------------------------------------------------------------
// INTENTIONAL MUTANTS, test-local only. The real engine and the real predicate
// are never modified; these fork the RULES so the parity check has to catch
// them. Each one is expected to disagree with the engine on exactly one probe
// direction, which is asserted below.
// ---------------------------------------------------------------------------

/**
 * INTENTIONAL MUTANT (predicate side): reachability.ts sampleBlocksBody with
 * the entire OneWay clause deleted, the pre-#175 behavior in which a one-way
 * shelf never obstructs a descent. This is sampleHitsSolid's box scan, which
 * is all that remains of the predicate once the OneWay clause is gone.
 */
function mutantPredicateNeverBlocksOneWay(probe: Probe, step: ProbeStep): boolean {
  const minX = Math.floor(step.integratedX / TILE_SIZE);
  const maxX = Math.floor((step.integratedX + PLAYER_SIZE - 1) / TILE_SIZE);
  const minY = Math.floor(step.integratedY / TILE_SIZE);
  const maxY = Math.floor((step.integratedY + PLAYER_SIZE - 1) / TILE_SIZE);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (viewTileAt(probe.validator, x, y) === Tile.Solid) return true;
    }
  }
  return false;
}

/**
 * INTENTIONAL MUTANT (engine-oracle side): the landing branch of resolveY in
 * physics.ts, tile === Tile.Solid || tile === Tile.OneWay, with the
 * came-from-above clause dropped, so a OneWay tile under the bottom edge reads
 * as solid no matter where the body came from. The real engine passes a body
 * rising from below; this mutant cannot. spanEnd is re-derived locally because
 * it is module-private.
 */
function mutantEngineOneWayAlwaysBlocks(probe: Probe, step: ProbeStep): boolean {
  const bottomRow = Math.ceil((step.integratedY + PLAYER_SIZE) / TILE_SIZE) - 1;
  const minCol = Math.floor(step.integratedX / TILE_SIZE);
  const maxCol = Math.ceil((step.integratedX + PLAYER_SIZE) / TILE_SIZE) - 1;
  for (let col = minCol; col <= maxCol; col++) {
    const tile = tileAt(probe.engine, col, bottomRow);
    if (tile === EngineTile.Solid || tile === EngineTile.OneWay) return true;
  }
  return false;
}

/**
 * INTENTIONAL MUTANT (predicate side): the same box scan plus descent scan as
 * the real predicate, with the strict upper bound relaxed. The real predicate
 * uses ceil(bottom / TILE_SIZE) - 1, which excludes the tile whose top face is
 * exactly at the bottom edge; this mutant uses floor(bottom / TILE_SIZE),
 * which includes it. The two forms are identical except at an exact tile
 * boundary, so this mutant isolates the flush-landing boundary.
 */
function mutantPredicateInclusiveUpperBound(probe: Probe, step: ProbeStep): boolean {
  if (mutantPredicateNeverBlocksOneWay(probe, step)) return true;
  const bottom = step.integratedY + PLAYER_SIZE;
  if (step.prevBottom >= bottom) return false;
  const rLo = Math.ceil(step.prevBottom / TILE_SIZE);
  const rHi = Math.floor(bottom / TILE_SIZE);
  const cLo = Math.floor(step.integratedX / TILE_SIZE);
  const cHi = Math.ceil((step.integratedX + PLAYER_SIZE) / TILE_SIZE) - 1;
  for (let r = rLo; r <= rHi; r++) {
    for (let c = cLo; c <= cHi; c++) {
      if (viewTileAt(probe.validator, c, r) === Tile.OneWay) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixtures. 8 columns, digits: 0 Empty, 1 Solid, 2 OneWay.
// ---------------------------------------------------------------------------

// Row 6 is a full-width one-way shelf: every descent column crosses it.
const FULL_WIDTH_SHELF: readonly string[] = [
  '00000000', '00000000', '00000000', // rows 0..2
  '00000000', '00000000', '00000000', // rows 3..5
  '22222222', // row 6
  '00000000', '00000000', '00000000', '00000000', '00000000', // rows 7..11
];

// Shelf at columns 2..4 only, solid floor far below. The falling body runs in
// column 6, outside the shelf's span.
const NARROW_SHELF_SIDE_COLUMN: readonly string[] = [
  '00000000', '00000000', '00000000', // rows 0..2
  '00000000', '00000000', '00000000', // rows 3..5
  '00222000', // row 6: shelf at columns 2..4
  '00000000', '00000000', '00000000', '00000000', // rows 7..10
  '11111111', // row 11: solid floor, never reached inside the probe window
];

// Shelf at row 6, columns 2..5, solid floor at row 11. The body lands on the
// shelf at exactly 80 px of fall, five tiles.
const SHELF_UNDER_DESCENT: readonly string[] = [
  '00000000', '00000000', '00000000', // rows 0..2
  '00000000', '00000000', '00000000', // rows 3..5
  '00222200', // row 6: shelf at columns 2..5
  '00000000', '00000000', '00000000', '00000000', // rows 7..10
  '11111111', // row 11
];

// Shelf at row 8, columns 2..5, solid floor at row 11.
const SHELF_AT_ROW_EIGHT: readonly string[] = [
  '00000000', '00000000', '00000000', '00000000', // rows 0..3
  '00000000', '00000000', '00000000', '00000000', // rows 4..7
  '00222200', // row 8: shelf at columns 2..5
  '00000000', '00000000', // rows 9..10
  '11111111', // row 11
];

// Shelf at row 6, columns 2..5. Ten rows is enough for a rise from below.
const SHELF_ABOVE_RISE: readonly string[] = [
  '00000000', '00000000', '00000000', // rows 0..2
  '00000000', '00000000', '00000000', // rows 3..5
  '00222200', // row 6: shelf at columns 2..5
  '00000000', '00000000', '00000000', // rows 7..9
];

// A single shelf tile at row 6, column 3, at the drifting body's own altitude.
const LONE_SHELF_TILE: readonly string[] = [
  '00000000', '00000000', '00000000', // rows 0..2
  '00000000', '00000000', '00000000', // rows 3..5
  '00020000', // row 6: one shelf tile at column 3
  '00000000', '00000000', '00000000', '00000000', '00000000', // rows 7..11
];

// ---------------------------------------------------------------------------
// Probe 1: full-width shelf descent. A rest-start fall onto a shelf that spans
// every column blocks exactly at the crossing step and stays arrested.
// ---------------------------------------------------------------------------
const P1_FULL_WIDTH_DESCENT = driveProbe(
  'full-width-shelf-descent',
  FULL_WIDTH_SHELF,
  { x: 48, y: 32 },
  26,
);

describe('one-way parity: full-width shelf descent', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P1_FULL_WIDTH_DESCENT, sweepPredicate)).toEqual([]);
  });

  it('blocks the landing and the resting transitions on both sides', () => {
    expect(engineBlockedSteps(P1_FULL_WIDTH_DESCENT)).toEqual(range(20, 26));
    expect(verdictSteps(P1_FULL_WIDTH_DESCENT, sweepPredicate)).toEqual(range(20, 26));
  });

  it('arrests the body on the shelf top, never below it', () => {
    const landing = stepAt(P1_FULL_WIDTH_DESCENT, 20);
    // 48 px of rest-start fall plus 5 px on the crossing step: bottom 95.5 to
    // 100.5 crosses the shelf top at 96, so the engine lands it flush.
    expect(landing.prevBottom).toBe(95.5);
    expect(landing.integratedY + PLAYER_SIZE).toBe(100.5);
    expect(landing.resolvedY).toBe(80);
    expect(landing.grounded).toBe(true);
    // Every earlier step is a free fall above the shelf.
    for (const step of P1_FULL_WIDTH_DESCENT.steps) {
      if (step.step < 20) expect(step.engineBlocked).toBe(false);
    }
  });

  it('feeds the resting samples a prevBottom exactly on the support top face', () => {
    // The support-tile boundary is live in the predicate: prevBottom is exactly
    // 96 (the shelf's top face) while the bottom edge sits 0.25 px inside.
    for (const step of P1_FULL_WIDTH_DESCENT.steps) {
      if (step.step >= 21) expect(step.prevBottom).toBe(96);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe 2: lateral outside span. A fall in a column the shelf does not cover
// passes the shelf altitude with no block on either side.
// ---------------------------------------------------------------------------
const P2_LATERAL_OUTSIDE_SPAN = driveProbe(
  'lateral-outside-span',
  NARROW_SHELF_SIDE_COLUMN,
  { x: 96, y: 32 },
  27,
);

describe('one-way parity: lateral outside span', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P2_LATERAL_OUTSIDE_SPAN, sweepPredicate)).toEqual([]);
  });

  it('passes every transition on both sides', () => {
    expect(engineBlockedSteps(P2_LATERAL_OUTSIDE_SPAN)).toEqual([]);
    expect(verdictSteps(P2_LATERAL_OUTSIDE_SPAN, sweepPredicate)).toEqual([]);
  });

  it('does cross the shelf altitude, so the pass is not vacuous', () => {
    // The box must reach the shelf's row (bottom edge through 96 and into the
    // row 6 band) while never sharing a column with the shelf tiles.
    const entered = P2_LATERAL_OUTSIDE_SPAN.steps.filter(
      (s) => s.prevBottom <= 96 && s.integratedY + PLAYER_SIZE > 96,
    );
    expect(entered).toHaveLength(1);
    expect(entered[0]?.step).toBe(20);
    for (const step of P2_LATERAL_OUTSIDE_SPAN.steps) {
      expect(Math.floor(step.integratedX / TILE_SIZE)).toBe(6);
      expect(Math.ceil((step.integratedX + PLAYER_SIZE) / TILE_SIZE) - 1).toBe(6);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe 3: flush landing. The bottom edge reaches the shelf's top face exactly
// on a step boundary, so the transition neither crosses the tile top (the
// engine's spanEnd check excludes row 6) nor enters the predicate's crossing
// range. The next step crosses it and both sides block.
//
// Accuracy: the probe opens at terminal velocity, the long-fall plateau the
// controller reaches after 27 gravity steps, from a tile-aligned position.
// Twelve steps at 400 px/s is exactly 80 px in IEEE doubles from this base, so
// step 12's bottom is exactly 96, the shelf top. This is asserted below; if the
// accumulator ever stops landing exactly, the probe is not on the boundary.
// ---------------------------------------------------------------------------
const P3_FLUSH_LANDING = driveProbe(
  'flush-landing',
  SHELF_UNDER_DESCENT,
  { x: 48, y: 0, vy: TERMINAL_VEL },
  20,
);

describe('one-way parity: flush landing', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P3_FLUSH_LANDING, sweepPredicate)).toEqual([]);
  });

  it('passes the flush step and blocks the crossing and rest steps, both sides', () => {
    expect(engineBlockedSteps(P3_FLUSH_LANDING)).toEqual(range(13, 20));
    expect(verdictSteps(P3_FLUSH_LANDING, sweepPredicate)).toEqual(range(13, 20));
    expect(stepAt(P3_FLUSH_LANDING, 12).engineBlocked).toBe(false);
  });

  it('reaches the shelf top exactly at step 12', () => {
    const flush = stepAt(P3_FLUSH_LANDING, 12);
    expect(flush.integratedY).toBe(80);
    expect(flush.integratedY + PLAYER_SIZE).toBe(96);
    expect((flush.integratedY + PLAYER_SIZE) % TILE_SIZE).toBe(0);
    const exactTileTopSteps = P3_FLUSH_LANDING.steps
      .filter((s) => (s.integratedY + PLAYER_SIZE) % TILE_SIZE === 0)
      .map((s) => s.step);
    expect(exactTileTopSteps).toEqual([12]);
    // Reached, not crossed: 96 is in (prevBottom, bottom] but not in the
    // strict crossing interval the predicate's upper bound works with.
    expect(touchedTileTops(flush)).toEqual([96]);
    expect(crossedTileTops(flush)).toEqual([]);
  });

  it('crosses the tile tops of rows 2..5 and reaches row 6, nothing else', () => {
    const table = P3_FLUSH_LANDING.steps
      .filter((s) => touchedTileTops(s).length > 0)
      .map((s) => [s.step, touchedTileTops(s)]);
    expect(table).toEqual([
      [3, [32]],
      [5, [48]],
      [8, [64]],
      [10, [80]],
      [12, [96]],
    ]);
  });

  it('arrests the body flush on the shelf top from step 13 on', () => {
    const crossing = stepAt(P3_FLUSH_LANDING, 13);
    expect(crossing.prevBottom).toBe(96);
    expect(crossing.resolvedY).toBe(80);
    expect(crossing.grounded).toBe(true);
    for (const step of P3_FLUSH_LANDING.steps) {
      if (step.step >= 14) expect(step.resolvedY).toBe(80);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe 4: land on a shelf and rest. A rest-start fall onto a partial shelf
// lands, then stays arrested on top of it for the rest of the probe.
// ---------------------------------------------------------------------------
const P4_LAND_AND_REST = driveProbe(
  'land-on-shelf-and-rest',
  SHELF_AT_ROW_EIGHT,
  { x: 48, y: 0 },
  40,
);

describe('one-way parity: land on shelf and rest', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P4_LAND_AND_REST, sweepPredicate)).toEqual([]);
  });

  it('blocks the landing and every resting transition, both sides', () => {
    expect(engineBlockedSteps(P4_LAND_AND_REST)).toEqual(range(30, 40));
    expect(verdictSteps(P4_LAND_AND_REST, sweepPredicate)).toEqual(range(30, 40));
  });

  it('is airborne before the landing and grounded flush on the shelf after', () => {
    for (const step of P4_LAND_AND_REST.steps) {
      if (step.step < 30) {
        expect(step.grounded).toBe(false);
        expect(step.engineBlocked).toBe(false);
      } else {
        expect(step.grounded).toBe(true);
        expect(step.resolvedY).toBe(112);
      }
    }
    expect(stepAt(P4_LAND_AND_REST, 30).integratedY + PLAYER_SIZE).toBeGreaterThan(128);
  });

  it('feeds the resting samples a prevBottom exactly on the support top face', () => {
    for (const step of P4_LAND_AND_REST.steps) {
      if (step.step >= 31) expect(step.prevBottom).toBe(128);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe 5: ascend through. A body rising at the takeoff speed passes the shelf
// from below. The engine's landing branch never runs (vy < 0), and the
// predicate's crossing range is empty (not descending), so every transition
// passes on both sides.
// ---------------------------------------------------------------------------
const P5_ASCEND_THROUGH = driveProbe(
  'ascend-through',
  SHELF_ABOVE_RISE,
  { x: 48, y: 112, vy: JUMP_VEL },
  17,
);

describe('one-way parity: ascend through', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P5_ASCEND_THROUGH, sweepPredicate)).toEqual([]);
  });

  it('passes every transition on both sides', () => {
    expect(engineBlockedSteps(P5_ASCEND_THROUGH)).toEqual([]);
    expect(verdictSteps(P5_ASCEND_THROUGH, sweepPredicate)).toEqual([]);
    for (const step of P5_ASCEND_THROUGH.steps) {
      expect(step.vy).toBeLessThan(0);
      expect(step.grounded).toBe(false);
    }
  });

  it('fully crosses the shelf row while rising, so the pass is not vacuous', () => {
    // Box top starts in row 7, below the shelf; by the end the box sits
    // entirely above the shelf's top face at 96.
    expect(P5_ASCEND_THROUGH.steps[0]?.preY).toBe(112);
    expect(lastStep(P5_ASCEND_THROUGH).integratedY + PLAYER_SIZE).toBeLessThan(96);
    const insideShelfRow = P5_ASCEND_THROUGH.steps.filter(
      (s) => s.integratedY < 112 && s.integratedY + PLAYER_SIZE > 96,
    );
    expect(insideShelfRow.length).toBeGreaterThan(0);
    for (const step of insideShelfRow) {
      expect(step.vy).toBeLessThan(0);
      expect(tileAt(P5_ASCEND_THROUGH.engine, 3, 6)).toBe(EngineTile.OneWay);
    }
  });
});

// ---------------------------------------------------------------------------
// Probe 6: drift past a lone shelf tile. A body drifting at maximum run speed
// along the shelf's own row passes straight through the tile's column: the
// engine's resolveX ignores OneWay, and the predicate's crossing range holds no
// tile top, so both sides pass.
// ---------------------------------------------------------------------------
const P6_DRIFT_PAST_LONE_SHELF = driveProbe(
  'drift-past-lone-shelf',
  LONE_SHELF_TILE,
  { x: 16, y: 96, vx: MAX_RUN },
  30,
);

describe('one-way parity: drift past lone shelf tile', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P6_DRIFT_PAST_LONE_SHELF, sweepPredicate)).toEqual([]);
  });

  it('passes every transition, with resolveX never arresting on the shelf', () => {
    expect(engineBlockedSteps(P6_DRIFT_PAST_LONE_SHELF)).toEqual([]);
    expect(verdictSteps(P6_DRIFT_PAST_LONE_SHELF, sweepPredicate)).toEqual([]);
    for (const step of P6_DRIFT_PAST_LONE_SHELF.steps) {
      expect(step.hitWall).toBe(false);
    }
  });

  it('drifts across the shelf tile at its own altitude, so the pass is not vacuous', () => {
    const overShelf = P6_DRIFT_PAST_LONE_SHELF.steps.filter((s) => {
      const minCol = Math.floor(s.integratedX / TILE_SIZE);
      const maxCol = Math.ceil((s.integratedX + PLAYER_SIZE) / TILE_SIZE) - 1;
      return minCol <= 3 && maxCol >= 3;
    });
    expect(overShelf.length).toBeGreaterThan(0);
    const insideShelfRow = P6_DRIFT_PAST_LONE_SHELF.steps.filter(
      (s) => s.integratedY < 112 && s.integratedY + PLAYER_SIZE > 96,
    );
    expect(insideShelfRow.length).toBeGreaterThan(0);
    expect(lastStep(P6_DRIFT_PAST_LONE_SHELF).integratedX).toBe(76);
  });
});

// ---------------------------------------------------------------------------
// Probe 7: overlap descent. The body OPENS with its bottom edge already
// inside the shelf row (bottom 98 vs the shelf top 96), still descending.
// The engine's came-from-above conjunct is false on the first transition
// (originalBottom 98 > tileTop 96), so the OneWay does not block; the
// predicate's crossing range starts strictly below prevBottom, so it also
// passes. This is the one pose where the conjunct's FALSE branch governs
// both sides, pinning the rule the six #179 probes never reach: dropping
// the conjunct from the engine (OneWay always blocks) arrests the body on
// step 1 while the predicate still passes. Verified empirically against a
// mutated engine in a throwaway worktree: the two assertions below are the
// ones that go red.
// ---------------------------------------------------------------------------
const P7_OVERLAP_DESCENT = driveProbe(
  'overlap-descent',
  SHELF_ABOVE_RISE,
  { x: 48, y: 82, vy: TERMINAL_VEL },
  12,
);

describe('one-way parity: overlap descent', () => {
  it('agrees with the engine on every transition', () => {
    expect(disagreeingSteps(P7_OVERLAP_DESCENT, sweepPredicate)).toEqual([]);
  });

  it('opens with the bottom edge inside the shelf row, descending', () => {
    // Bottom starts at 98, two pixels past the shelf top at 96.
    expect(P7_OVERLAP_DESCENT.steps[0]!.preY + PLAYER_SIZE).toBe(98);
    expect(P7_OVERLAP_DESCENT.steps[0]!.vy).toBe(TERMINAL_VEL);
  });

  it('lets the body sink through the overlapped shelf, both sides', () => {
    // The engine's landing loop skips the OneWay (originalBottom > tileTop),
    // and the predicate's crossing range holds no tile top below prevBottom.
    expect(engineBlockedSteps(P7_OVERLAP_DESCENT)).toEqual([]);
    expect(verdictSteps(P7_OVERLAP_DESCENT, sweepPredicate)).toEqual([]);
    // The body ends strictly below the shelf row: the pass is not vacuous.
    expect(lastStep(P7_OVERLAP_DESCENT).integratedY).toBeGreaterThan(112);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity mutants. Each mutant must produce the exact disagreement
// fingerprint it is built for, and must stay in agreement everywhere else.
// ---------------------------------------------------------------------------

describe('non-vacuity: predicate mutant, OneWay clause deleted', () => {
  it('disagrees on the full-width descent, where the shelf is the only blocker', () => {
    expect(disagreeingSteps(P1_FULL_WIDTH_DESCENT, mutantPredicateNeverBlocksOneWay)).toEqual(
      range(20, 26),
    );
  });

  it('disagrees on the partial-shelf landing and rest too', () => {
    expect(disagreeingSteps(P3_FLUSH_LANDING, mutantPredicateNeverBlocksOneWay)).toEqual(
      range(13, 20),
    );
    expect(disagreeingSteps(P4_LAND_AND_REST, mutantPredicateNeverBlocksOneWay)).toEqual(
      range(30, 40),
    );
  });

  it('still agrees on the ascend-through and the lateral probes, which have no shelf block', () => {
    expect(disagreeingSteps(P5_ASCEND_THROUGH, mutantPredicateNeverBlocksOneWay)).toEqual([]);
    expect(disagreeingSteps(P6_DRIFT_PAST_LONE_SHELF, mutantPredicateNeverBlocksOneWay)).toEqual(
      [],
    );
    expect(
      disagreeingSteps(P2_LATERAL_OUTSIDE_SPAN, mutantPredicateNeverBlocksOneWay),
    ).toEqual([]);
  });
});

describe('non-vacuity: engine-oracle mutant, came-from-above clause dropped', () => {
  it('disagrees on the ascend-through, where the real engine passes a rising body', () => {
    expect(disagreeingSteps(P5_ASCEND_THROUGH, mutantEngineOneWayAlwaysBlocks)).toEqual(
      range(5, 11),
    );
  });

  it('still agrees on the descents, where a body under the shelf must block anyway', () => {
    expect(disagreeingSteps(P1_FULL_WIDTH_DESCENT, mutantEngineOneWayAlwaysBlocks)).toEqual([]);
    expect(disagreeingSteps(P3_FLUSH_LANDING, mutantEngineOneWayAlwaysBlocks)).toEqual([]);
    expect(disagreeingSteps(P4_LAND_AND_REST, mutantEngineOneWayAlwaysBlocks)).toEqual([]);
  });
});

describe('non-vacuity: predicate mutant, upper descent bound relaxed', () => {
  it('is caught exactly at the flush-landing boundary', () => {
    expect(disagreeingSteps(P3_FLUSH_LANDING, mutantPredicateInclusiveUpperBound)).toEqual([12]);
  });

  it('agrees on every other probe, the relaxed bound only bites on an exact tile top', () => {
    for (const probe of [
      P1_FULL_WIDTH_DESCENT,
      P2_LATERAL_OUTSIDE_SPAN,
      P4_LAND_AND_REST,
      P5_ASCEND_THROUGH,
      P6_DRIFT_PAST_LONE_SHELF,
    ]) {
      expect(disagreeingSteps(probe, mutantPredicateInclusiveUpperBound)).toEqual([]);
    }
  });
});
