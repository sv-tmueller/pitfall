// Direct sweep-geometry unit tests (issue #161 review round).
//
// jumpNeighbors, sweepEdge, and bfsReachable are exported specifically for
// direct unit testing of the sweep's geometry; these tests make good on
// that promise and host the leftward-overspeed regression: the arc solver
// derives vx = (ex - sx) / tLand, which is SIGNED, so the MAX_RUN
// feasibility cap must test Math.abs(vx). The former unsigned comparison
// let leftward arcs demanding more than 120 px/s slip through and
// certified physically unflyable trajectories.
import { describe, expect, it } from 'vitest';
import { bfsReachable, jumpNeighbors, sweepEdge, validateSolvability } from './reachability';
import { loadLevel } from '../levels/load';
import { Tile } from '../levels/types';

/**
 * Builds a ValidatorGrid-shaped argument from digit-string rows. Structural
 * typing supplies the ValidatorGrid interface without importing it.
 */
function gridFrom(
  rowsOfDigits: string[],
): {
  cols: number;
  rows: number;
  tiles: Tile[];
  extraStandable: Set<string>;
  gravityZones: Array<{ colMin: number; rowMin: number; colMax: number; rowMax: number }>;
} {
  const rows = rowsOfDigits.length;
  const cols = rowsOfDigits[0]?.length ?? 0;
  const tiles: Tile[] = [];
  for (const r of rowsOfDigits) {
    for (const ch of r) {
      tiles.push(Number(ch) as Tile);
    }
  }
  return { cols, rows, tiles, extraStandable: new Set<string>(), gravityZones: [] };
}

// ---------------------------------------------------------------------------
// jumpNeighbors: envelope enumeration
// ---------------------------------------------------------------------------

describe('jumpNeighbors (direct unit)', () => {
  const ns = jumpNeighbors();
  const keys = new Set(ns.map(({ dc, dr }) => `${dc},${dr}`));

  it('contains the walk offsets, and its only repeats are the 1-tile flats', () => {
    expect(keys.has('-1,0')).toBe(true);
    expect(keys.has('1,0')).toBe(true);

    // The rise-0 block emits the 1-4 tile flat jumps, so (±1,0) is listed
    // twice (once as a walk, once as a flat jump). Harmless redundancy in
    // the BFS (dedup via the visited set), but worth pinning so a future
    // envelope change does not silently introduce worse waste.
    const counts = new Map<string, number>();
    for (const { dc, dr } of ns) {
      const k = `${dc},${dr}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const dupes = [...counts.entries()].filter(([, n]) => n > 1);
    expect(dupes, `unexpected duplicate offsets: ${JSON.stringify(dupes)}`).toEqual([
      ['-1,0', 2],
      ['1,0', 2],
    ]);
  });

  it('is symmetric: every offset has a left/right mirror twin', () => {
    // Directional symmetry of the ENUMERATION is what makes a directional
    // asymmetry in the sweep (like the unsigned MAX_RUN cap was) detectable
    // as a validator bug rather than an envelope gap.
    for (const { dc, dr } of ns) {
      expect(keys.has(`${-dc},${dr}`), `missing mirror of (${dc},${dr})`).toBe(true);
    }
  });

  it('enumerates only physically bounded offsets', () => {
    for (const { dc, dr } of ns) {
      if (dr < 0) expect(-dr, `rise ${-dr} exceeds MAX_RISE`).toBeLessThanOrEqual(2);
      if (dr > 0) expect(dr, `drop ${dr} exceeds the depth cap`).toBeLessThanOrEqual(24);
      expect(Math.abs(dc), `lateral ${dc} exceeds MAX_FLAT_GAP`).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// sweepEdge: arc-family geometry and the MAX_RUN cap
// ---------------------------------------------------------------------------

describe('sweepEdge (direct unit)', () => {
  // Low-ceiling corridor: solid ceiling at row 1 (underside y=32), standing
  // row 3 (centre y=56, feet on the row-4 floor). The full and 0.75x arcs
  // clip the ceiling (box tops 10.4 and 26.9 px); only the 0.5x tap clears
  // it (box top 38.6 px), and that arc lands after t = 2*130/900 = 0.289 s.
  const lowCeiling = gridFrom([
    '1111111111',
    '1111111111',
    '0000000000',
    '0000000000',
    '1111111111',
    '1111111111',
  ]);

  it('LEFTWARD low-ceiling hop whose only clean arc demands 221 px/s is rejected', () => {
    // (9,3) -> (5,3): 64 px in 0.289 s = 221 px/s, well over MAX_RUN (120).
    // The pre-fix unsigned cap (vx > MAX_RUN) never fired on the NEGATIVE
    // vx of this arc, so the sweep certified it; this is the regression.
    expect(sweepEdge(lowCeiling, 9, 3, 5, 3, 260)).toBe(false);
  });

  it('RIGHTWARD mirror of the same hop is also rejected (direction parity)', () => {
    // Identical geometry flown east: vx = +221 px/s. The pre-fix cap DID
    // reject this one, which is exactly the asymmetry the fix removes.
    expect(sweepEdge(lowCeiling, 0, 3, 4, 3, 260)).toBe(false);
  });

  it('leftward low-ceiling hop inside the speed cap still certifies', () => {
    // (9,3) -> (7,3): 32 px in 0.289 s = 111 px/s, under MAX_RUN. Guards
    // against the fix over-blocking legitimate leftward hops.
    expect(sweepEdge(lowCeiling, 9, 3, 7, 3, 260)).toBe(true);
  });

  // Open-sky corridor: no ceiling, standing row 2 on the row-3 floor.
  const openSky = gridFrom([
    '000000000000',
    '000000000000',
    '000000000000',
    '111111111111',
    '111111111111',
  ]);

  it('open-sky 4-tile leftward hop (111 px/s) certifies', () => {
    // Full-impulse flat arc: t = 2*260/900 = 0.578 s, 64 px -> 111 px/s.
    expect(sweepEdge(openSky, 10, 2, 6, 2, 260)).toBe(true);
  });

  it('open-sky 6-tile leftward hop (166 px/s) is rejected', () => {
    // Beyond the BFS envelope's enumeration (lat <= 4) but still a direct
    // pin of the cap: 96 px in 0.578 s = 166 px/s is unflyable, and the
    // pre-fix code certified it because vx was negative.
    expect(sweepEdge(openSky, 11, 2, 5, 2, 260)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bfsReachable: the leftward-overspeed regression at flood-fill level
// ---------------------------------------------------------------------------

describe('bfsReachable (direct unit)', () => {
  it('plain corridor floods from spawn to exit', () => {
    const level = loadLevel({
      name: 'unit-corridor',
      cols: 10, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '1000000001',
        '1000000001',
        '1111111111',
      ],
      traps: [],
    });
    expect(bfsReachable(level)).toBe(true);
  });

  it('level whose ONLY route is a leftward 221 px/s hop under a low ceiling is unsolvable', () => {
    // Integration form of the leftward-overspeed regression. The 3-wide
    // spiked moat (cols 6-8; hazard floor provides no footing) bars
    // walking, the solid ceiling bars every rising arc, and the sole edge
    // to the exit plateau is the flat 4-tile leftward hop (9,3)->(5,3),
    // whose only ceiling-clearing arc (the 0.5x tap) demands 221 px/s.
    // Pre-fix the BFS certified this level; post-fix it must not.
    const level = loadLevel({
      name: 'low-ceiling-left-gap',
      cols: 12, rows: 6,
      spawn: { col: 9, row: 3 },
      exit: { col: 5, row: 3 },
      tiles: [
        '111111111111', // row 0: mass above the ceiling
        '111111111111', // row 1: low ceiling (underside y = 32)
        '000000000000', // row 2: flight headroom
        '000000000000', // row 3: standing row
        '111111000111', // row 4: floor, 3-wide moat mouth at cols 6-8
        '111111333111', // row 5: moat floor is hazard (no footing)
      ],
      traps: [],
    });
    expect(bfsReachable(level)).toBe(false);
    expect(validateSolvability(level).status).toBe('unsolvable');
  });

  it('rightward mirror of the same level is unsolvable (pre-fix parity)', () => {
    // Identical geometry reflected: the sole edge is the EASTERN 4-tile
    // hop (2,3)->(6,3) at +221 px/s. The pre-fix cap already rejected
    // this, so both before and after the fix the verdict is unsolvable;
    // the pin guarantees left/right verdict parity.
    const level = loadLevel({
      name: 'low-ceiling-right-gap',
      cols: 12, rows: 6,
      spawn: { col: 2, row: 3 },
      exit: { col: 6, row: 3 },
      tiles: [
        '111111111111',
        '111111111111',
        '000000000000',
        '000000000000',
        '111000111111', // moat mouth at cols 3-5
        '111333111111', // hazard moat floor
      ],
      traps: [],
    });
    expect(bfsReachable(level)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sweepEdge: one-way came-from-above semantics (issue #175)
//
// The engine's resolveY blocks a falling body on a OneWay tile only when the
// body's bottom edge began at or above the tile's top face this step; a body
// rising through or drifting past a one-way passes. These direct pins hold
// the sweep to the same rule: descending through a shelf is rejected,
// ascending through it and landing on top of it are certified.
// ---------------------------------------------------------------------------

describe('sweepEdge one-way semantics (issue #175)', () => {
  // A one-way shelf spans cols 1-4 at row 2 (top face y = 32); open sky
  // above (rows 0-1) and the row-3 standing row on the row-4 floor.
  const oneWayShelf = gridFrom([
    '00000000',
    '00000000',
    '02222000',
    '00000000',
    '11111111',
  ]);

  it('descending through a one-way shelf is rejected (came from above)', () => {
    // (2,0) -> (2,3): the body starts above the shelf and the arc/free-fall
    // descends through row 2, where the engine strands it on the shelf.
    expect(sweepEdge(oneWayShelf, 2, 0, 2, 3, 260)).toBe(false);
  });

  it('ascending through a one-way shelf still certifies (pass from below)', () => {
    // (2,3) -> (2,0): the identical geometry flown upward. The body
    // originates below the shelf top, so the engine lets it pass; the sweep
    // must not over-block the ascent.
    expect(sweepEdge(oneWayShelf, 2, 3, 2, 0, 260)).toBe(true);
  });

  it('landing on top of a one-way shelf certifies (destination standability unchanged)', () => {
    // (2,0) -> (2,1): the body descends and comes to rest on the shelf's top
    // face (destination row 1, support at row 2). The landing sample sits
    // above the support tile, so the descending predicate does not fire.
    expect(sweepEdge(oneWayShelf, 2, 0, 2, 1, 260)).toBe(true);
  });
});
