import { describe, expect, it } from 'vitest';
import { validateReachability, validateSolvability } from './reachability';
import { loadLevel } from '../levels/load';
import { FIXTURE_SOURCES } from '../levels/fixtures';

describe('reachability validation (physics-calibrated)', () => {
  it('corridor is reachable', () => {
    const level = loadLevel(FIXTURE_SOURCES['corridor']);
    expect(validateReachability(level)).toBe(true);
  });

  it('jump-gap is reachable', () => {
    const level = loadLevel(FIXTURE_SOURCES['jump-gap']);
    expect(validateReachability(level)).toBe(true);
  });

  it('shaft (redesigned, overlapping ledges) is reachable', () => {
    const level = loadLevel(FIXTURE_SOURCES['shaft']);
    expect(validateReachability(level)).toBe(true);
  });

  it('walled-off exit is not reachable (standable spawn AND standable exit)', () => {
    // The original walled-off fixture spawned at (0,1) where tile '1' is
    // solid, so isStandable was false and the validator returned false
    // vacuously. The first rewrite fixed the spawn but sat the EXIT on a
    // Solid tile, so destination-standability rejected before any edge
    // was swept, which was equally vacuous w.r.t. obstruction checking (AC-2).
    //
    // This version makes BOTH endpoints standable and seals the exit
    // chamber with a wall column that runs the full interior height
    // (touching the ceiling above and the floor below), so no walk, jump,
    // or drop can cross it: every candidate edge toward the right chamber
    // is enumerated, swept, and rejected by the wall. Gutting the sweep
    // turns this test red (verified during the fix round), proving it
    // genuinely exercises obstruction checking.
    const veryBlocked = loadLevel({
      name: 'very-blocked',
      cols: 10, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '1000100001',
        '1000100001',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(veryBlocked)).toBe(false);
  });

  it('OLD shaft geometry (non-overlapping ledges, wide gap) is NOT reachable', () => {
    // Reproduce the original buggy shaft: left ledges cols 1-7, right
    // ledges cols 11-18. The 3-tile horizontal gap between alternating
    // tiers exceeds the kinematic jump envelope (a rise-2 jump allows at
    // most 3 tiles of lateral travel, and the tiers are offset both
    // horizontally and vertically), so the validator must reject it.
    //
    // The gap is 3 tiles (not the historical 2) because a 2-tile offset
    // is inside the calibrated envelope: rise 2 with lat 3 is flyable at
    // full run speed, so the old fixture was quietly reachable through
    // the one-way zigzag once the exit-stop rule matched the engine (the
    // engine completes on AABB overlap with the exit cell, and the old
    // fixture's floating exit masked the whole route).
    const oldShaft = loadLevel({
      name: 'old-shaft',
      cols: 20, rows: 24,
      spawn: { col: 2, row: 21 },
      exit: { col: 4, row: 1 },
      tiles: [
        '11111111111111111111',
        '10000000000000000001',
        '10000000000222222221',
        '10000000000000000001',
        '12222222000000000001',
        '10000000000000000001',
        '10000000000222222221',
        '10000000000000000001',
        '12222222000000000001',
        '10000000000000000001',
        '10000000000222222221',
        '10000000000000000001',
        '12222222000000000001',
        '10000000000000000001',
        '10000000000222222221',
        '10000000000000000001',
        '12222222000000000001',
        '10000000000000000001',
        '10000000000222222221',
        '10000000000000000001',
        '12222222000000000001',
        '10000000000000000001',
        '11111111111111111111',
        '11111111111111111111',
      ],
      traps: [],
    });
    expect(validateReachability(oldShaft)).toBe(false);
  });

  it('ledge too high (3-tile vertical gap) is NOT reachable', () => {
    // A single platform 3 tiles above the floor, with the exit on it.
    // The player can rise ~2 tiles, so 3 should be unreachable.
    const tooHigh = loadLevel({
      name: 'too-high',
      cols: 10, rows: 6,
      spawn: { col: 1, row: 4 },
      exit: { col: 1, row: 1 },
      tiles: [
        '1111111111',
        '1000000001',
        '1000000001',
        '1000000001',
        '1000000001',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(tooHigh)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mechanics-aware reachability tests (#129 checkpoint 7)
// ---------------------------------------------------------------------------

describe('reachability with springs', () => {
  it('spring allows reaching a ledge too high for a normal jump', () => {
    // A room with a high ledge 4 tiles above the floor. The spring is in a
    // different column from the exit so the spring's vertical path is clear
    // (the obstruction check scans the source column, not the destination).
    //
    //   Row 0: ceiling
    //   Row 1: exit area (exit at col 4, solid ledge below at row 2)
    //   Row 2: solid ledge under exit (cols 4-5 solid)
    //   Rows 3-5: open air
    //   Row 6: solid floor
    //   Row 7: solid floor
    //
    // Spawn at (1, 5): below row 6 = solid → standable.
    // Exit at (4, 1): below (4, 2) = solid → standable.
    // Spring at tile (1, 5) → pixel (16, 80). Same tile as spawn.
    //
    // Rise from spring (row 5) to exit (row 1) = 4 tiles.
    // Horizontal: spring col 1, exit col 4 → dc=3.
    // Envelope: 3/4 + 4/riseTiles ≈ 0.75 + 0.24 ≈ 0.99 ≤ 1 (riseTiles≈17).
    // Obstruction: source col 1, rows 4-2 all empty → clear. ✓
    //
    // Normal max rise = 2 → unreachable without spring.
    // Spring impulseY=-700 → rise ≈ 700²/(2×900)/16 ≈ 17 tiles >> 4.
    const level = loadLevel({
      name: 'spring-climb',
      cols: 6, rows: 8,
      spawn: { col: 1, row: 5 },
      exit: { col: 4, row: 1 },
      tiles: [
        '111111', // row 0: ceiling
        '100001', // row 1: exit area
        '100011', // row 2: solid ledge under exit (cols 4-5 solid)
        '100001', // row 3
        '100001', // row 4
        '100001', // row 5: spawn area, spring here
        '111111', // row 6: floor
        '111111', // row 7: floor
      ],
      traps: [],
      mechanics: [
        {
          id: 'spring1',
          type: 'spring',
          params: { x: 16, y: 80, impulseY: -700 },
        },
      ],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('same level WITHOUT spring is unreachable (high ledge)', () => {
    // Same geometry but no spring → the 4-tile rise is impossible.
    const level = loadLevel({
      name: 'no-spring',
      cols: 6, rows: 8,
      spawn: { col: 1, row: 5 },
      exit: { col: 4, row: 1 },
      tiles: [
        '111111',
        '100001',
        '100011',
        '100001',
        '100001',
        '100001',
        '111111',
        '111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('weak spring that cannot bridge the gap leaves level unreachable', () => {
    // Same geometry but with a weak spring whose rise envelope < 4 tiles.
    // impulseY = -300 → peak = 300²/(2×900)/16 ≈ 3.125 tiles.
    // Floor(3.125) = 3 tiles. Rise needed = 4 tiles (row 5 → row 1).
    // 3 < 4 → unreachable.
    const level = loadLevel({
      name: 'weak-spring',
      cols: 6, rows: 8,
      spawn: { col: 1, row: 5 },
      exit: { col: 4, row: 1 },
      tiles: [
        '111111',
        '100001',
        '100011',
        '100001',
        '100001',
        '100001',
        '111111',
        '111111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'spring1',
          type: 'spring',
          params: { x: 16, y: 80, impulseY: -300 },
        },
      ],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('level without mechanics validates identically (regression)', () => {
    // The optional mechanics field is absent. Behavior must match
    // the pre-extension validator exactly.
    const level = loadLevel({
      name: 'no-mechs',
      cols: 10, rows: 6,
      spawn: { col: 1, row: 4 },
      exit: { col: 8, row: 4 },
      tiles: [
        '1111111111',
        '1000000001',
        '1000000001',
        '1000000001',
        '1000000001',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(true);
  });
});

describe('reachability with teleporters', () => {
  it('one-way teleporter bridges a floor gap wider than jump range', () => {
    // Two platforms separated by a floor gap wider than MAX_FLAT_GAP.
    // The validator models flat jumps as ignoring walls (known approximation),
    // so we use a floor gap to prevent walking.
    //
    //   cols: 12, rows: 4
    //   Row 0: ceiling (all solid)
    //   Row 1: open passage
    //   Row 2: open passage (spawn and exit here)
    //   Row 3: floor with a 6-tile gap (cols 3-8 are empty)
    //
    // Spawn at (1, 2): below (1, 3) = solid → standable.
    // Exit at (10, 2): below (10, 3) = solid → standable.
    // Gap: cols 3-8 at row 3 are empty → no standable positions in between.
    // Distance from col 2 to col 9 = 7 tiles > MAX_FLAT_GAP (4).
    //
    // Teleporter at pixel (32, 32) = tile (2, 2) → pixel (160, 32) = tile (10, 2).
    const level = loadLevel({
      name: 'teleport-floor-gap',
      cols: 12, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 10, row: 2 },
      tiles: [
        '111111111111',
        '100000000001',
        '100000000001',
        '111000000111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'tp1',
          type: 'teleporter',
          params: { x: 32, y: 32, destX: 160, destY: 32, oneWay: true },
        },
      ],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('bidirectional teleporter adds reciprocal edge', () => {
    // Same floor-gap layout, but the teleporter is bidirectional.
    // Spawn is on the RIGHT side, exit on the LEFT. The reverse edge
    // (from dest back to source) makes it reachable.
    const level = loadLevel({
      name: 'bi-teleport',
      cols: 12, rows: 4,
      spawn: { col: 10, row: 2 },
      exit: { col: 1, row: 2 },
      tiles: [
        '111111111111',
        '100000000001',
        '100000000001',
        '111000000111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'tp1',
          type: 'teleporter',
          params: { x: 32, y: 32, destX: 160, destY: 32, oneWay: false },
        },
      ],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('teleporter to a non-standable destination does not help', () => {
    // Teleporter destination is in mid-air (no surface below) → not standable.
    // The edge is not added, and the floor gap prevents walking.
    const level = loadLevel({
      name: 'bad-tp-dest',
      cols: 12, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 10, row: 2 },
      tiles: [
        '111111111111',
        '100000000001',
        '100000000001',
        '111000000111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'tp1',
          type: 'teleporter',
          params: {
            // Dest at tile (10, 1) — row 1 is open, below row 2 is open → not standable.
            x: 32, y: 32, destX: 160, destY: 16, oneWay: true,
          },
        },
      ],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('floor gap without teleporter is unreachable', () => {
    const level = loadLevel({
      name: 'gap-no-tp',
      cols: 12, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 10, row: 2 },
      tiles: [
        '111111111111',
        '100000000001',
        '100000000001',
        '111000000111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });
});

describe('reachability with moving terrain', () => {
  it('moving platform bridges a floor gap wider than jump range', () => {
    // A wide gap in the floor (6 tiles) that exceeds the 4-tile jump gap.
    // A moving platform oscillates across the gap, making both endpoints
    // standable and adding ride edges between them.
    //
    //   cols: 12, rows: 4
    //   Row 0: ceiling
    //   Row 1: open
    //   Row 2: open (spawn and exit here)
    //   Row 3: floor with a 6-tile gap (cols 3-8 empty)
    //
    // Spawn at (1, 2), exit at (10, 2).
    // Gap: cols 3-8 at row 3 are empty → no standable positions.
    // Distance from col 2 to col 9 = 7 tiles > MAX_FLAT_GAP (4).
    //
    // Moving platform from tile (2, 2) to tile (9, 2), distance=112px=7 tiles.
    // Both (2, 2) and (9, 2) become standable. Ride edge connects them.
    // Path: (1,2)→walk→(2,2)*→ride→(9,2)*→walk→(10,2).
    const level = loadLevel({
      name: 'moving-platform-bridge',
      cols: 12, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 10, row: 2 },
      tiles: [
        '111111111111',
        '100000000001',
        '100000000001',
        '111000000111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'mp1',
          type: 'moving-platform',
          params: {
            startX: 32, startY: 32,   // tile (2, 2)
            width: 16, height: 16,
            dx: 1, dy: 0,
            speed: 60, distance: 112,  // 7 tiles → endpoint at tile (9, 2)
          },
        },
      ],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('same floor gap without moving platform is unreachable', () => {
    const level = loadLevel({
      name: 'gap-no-platform',
      cols: 12, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 10, row: 2 },
      tiles: [
        '111111111111',
        '100000000001',
        '100000000001',
        '111000000111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('moving platform enables crossing a vertical gap via ride edge', () => {
    // A platform that moves vertically. The lower endpoint is at floor level
    // (standable anyway), the upper endpoint is near a high ledge, connected
    // by a ride edge.
    //
    //   cols: 8, rows: 8
    //   Row 0: ceiling
    //   Row 1: high ledge (exit at col 4, solid at cols 4-6 row 2 for standing)
    //   Rows 2-5: open air
    //   Row 6: floor
    //   Row 7: floor
    //
    // Platform moves vertically from tile (2, 5) to tile (2, 2).
    // (2, 5) is standable (below = row 6 solid). (2, 2) is standable via
    // extraStandable. Ride edge connects (2, 5) ↔ (2, 2).
    // From (2, 2): jump to (4, 1). Rise=1, lat=2. Envelope: 2/4 + 1/2 = 1.0 ≤ 1. ✓
    // (4, 1): below (4, 2) = solid → standable ✓.
    const level = loadLevel({
      name: 'vert-platform',
      cols: 8, rows: 8,
      spawn: { col: 1, row: 5 },
      exit: { col: 4, row: 1 },
      tiles: [
        '11111111', // row 0: ceiling
        '10000001', // row 1: exit area
        '10001111', // row 2: solid under exit (cols 4-6 solid)
        '10000001', // row 3
        '10000001', // row 4
        '10000001', // row 5: spawn area, platform low point
        '11111111', // row 6: floor
        '11111111', // row 7: floor
      ],
      traps: [],
      mechanics: [
        {
          id: 'vp1',
          type: 'moving-platform',
          params: {
            startX: 32, startY: 80,  // tile (2, 5)
            width: 16, height: 16,
            dx: 0, dy: -1,           // moves upward
            speed: 60, distance: 48,  // 3 tiles up → endpoint at (2, 2)
          },
        },
      ],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('vertical gap without moving platform is unreachable', () => {
    // Same geometry but no platform. The 4-tile rise from row 5 to row 1
    // exceeds MAX_RISE (2).
    const level = loadLevel({
      name: 'vert-no-platform',
      cols: 8, rows: 8,
      spawn: { col: 1, row: 5 },
      exit: { col: 4, row: 1 },
      tiles: [
        '11111111',
        '10000001',
        '10001111',
        '10000001',
        '10000001',
        '10000001',
        '11111111',
        '11111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });
});

describe('gravity zones are not modelled (issue #174)', () => {
  // Gravity inversion is an engine no-op in the shipped build: the
  // gravity-zone adapter publishes {} and stepControllerWithGravity has
  // no consumer. The validator therefore models NORMAL gravity only and
  // must never certify a route that relies on inverted traversal. A
  // level declaring a gravity-zone mechanic that the normal-gravity BFS
  // cannot solve lands 'not-modelled' with 'gravity-zone' in `unmodeled`.

  it('former inversion fixture is NOT reachable in the normal-gravity model', () => {
    // Full-level gravity zone over a ceiling-walking layout. Under the
    // removed inversion model the player walked the one-way ceiling
    // tunnel; in normal gravity the spawn at (1, 1) has no floor beneath
    // it, so the level is vacuously unreachable no matter what the zone
    // promises.
    const level = loadLevel({
      name: 'gravity-invert',
      cols: 10, rows: 8,
      spawn: { col: 1, row: 1 },
      exit: { col: 8, row: 1 },
      tiles: [
        '1100000011',
        '1222222221',
        '1000000001',
        '1000000001',
        '1111111111',
        '1000000001',
        '1111111111',
        '1111111111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'gz1',
          type: 'gravity-zone',
          params: { x: 0, y: 0, width: 160, height: 128 },
        },
      ],
    });
    const result = validateSolvability(level);
    expect(result.reachable).toBe(false);
    // The declared gravity zone withholds the verdict instead of a
    // false certificate either way.
    expect(result.status).toBe('not-modelled');
    expect(result.unmodeled).toContain('gravity-zone');
  });

  it('same level WITHOUT gravity zone is unreachable', () => {
    // Without the zone there is no unmodelled mechanic, so the failed
    // flood-fill is a plain unsolvable verdict.
    const level = loadLevel({
      name: 'no-gravity-zone',
      cols: 10, rows: 8,
      spawn: { col: 1, row: 1 },
      exit: { col: 8, row: 1 },
      tiles: [
        '1100000011',
        '1222222221',
        '1000000001',
        '1000000001',
        '1111111111',
        '1000000001',
        '1111111111',
        '1111111111',
      ],
      traps: [],
    });
    const result = validateSolvability(level);
    expect(result.reachable).toBe(false);
    expect(result.status).toBe('unsolvable');
    expect(result.unmodeled).toEqual([]);
  });

  it('partial gravity zone grants no inverted traversal', () => {
    // Left half normal, right half zoned. The exit corridor hangs from
    // the ceiling and is only enterable upside-down; in normal gravity
    // the row-2 slab seals it (the hatch leads nowhere without upward
    // falls), so the BFS must fail and the verdict must be withheld
    // because of the declared zone.
    const level = loadLevel({
      name: 'partial-gravity',
      cols: 10, rows: 6,
      spawn: { col: 1, row: 3 },
      exit: { col: 8, row: 1 },
      tiles: [
        '1111111111',
        '1000000000',
        '1000010111',
        '1000000000',
        '1111100000',
        '1111111111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'gz1',
          type: 'gravity-zone',
          params: { x: 80, y: 0, width: 80, height: 80 },
        },
      ],
    });
    const result = validateSolvability(level);
    expect(result.reachable).toBe(false);
    expect(result.status).toBe('not-modelled');
    expect(result.unmodeled).toContain('gravity-zone');
  });

  it('partial gravity zone WITHOUT the zone is unreachable', () => {
    // Same hatched geometry but no gravity zone: no unmodelled mechanic,
    // so the failed flood-fill is a plain unsolvable verdict. The exit
    // at (8, 1) has no surface below in normal gravity (row 2 col 8 =
    // solid ABOVE it, not below), and nothing lifts the player to the
    // row-1 corridor: the right side has no floor (row 4 cols 5-9
    // empty), the row-1 cells sit under a solid ceiling, and every jump
    // envelope into row 1 clips the row-2 slab or the ceiling. Verified
    // unreachable.
    const level = loadLevel({
      name: 'partial-no-zone',
      cols: 10, rows: 6,
      spawn: { col: 1, row: 3 },
      exit: { col: 8, row: 1 },
      tiles: [
        '1111111111',
        '1000000000',
        '1000010111',
        '1000000000',
        '1111100000',
        '1111111111',
      ],
      traps: [],
    });
    const result = validateSolvability(level);
    expect(result.reachable).toBe(false);
    expect(result.status).toBe('unsolvable');
    expect(result.unmodeled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Swept-path obstruction regressions (issue #161 CP2)
//
// The pre-sweep validator only checked solids in the source column of
// upward jumps. These cases pin the classes of edge it waved through:
// lateral jumps through walls, drops through overhangs, walks through
// walls, plus positive controls proving the sweep still certifies
// ordinary arcs.
// ---------------------------------------------------------------------------

describe('swept-path obstruction regressions (#161)', () => {
  it('lateral jump through a full-height wall is NOT reachable', () => {
    // Two chambers separated by a full-height wall block (rows 0-1 solid,
    // wall column sealing row 2). Same floor row, so the exit is a flat
    // lateral jump away (well inside the envelope), but every arc from
    // row 2 rises into the solid ceiling and no walk crosses the wall.
    // The pre-sweep validator accepted the flat jump and called this
    // reachable.
    const level = loadLevel({
      name: 'wall-between',
      cols: 10, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '1111111111',
        '1000000101',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('drop onto a ledge THROUGH a solid overhang is NOT reachable', () => {
    // The exit sits on a ledge sheltered by a solid overhang (row 3,
    // cols 4-9). From the spawn plateau (row 2, cols 0-3) the only
    // envelope route down is a drop with lateral drift, and every such
    // fall clips the overhang. The pre-sweep validator never checked
    // drops for solids and called this reachable.
    //
    //   Row 0: ceiling
    //   Row 1: open; spawn (1,1) stands on the plateau
    //   Row 2: plateau cols 0-3 solid; overhang top cols 4-8 standable
    //   Row 3: OVERHANG cols 4-9 solid
    //   Row 4: open under the overhang; exit (7,4)
    //   Row 5: ledge cols 4-9 solid
    //   Row 6: floor
    const level = loadLevel({
      name: 'overhang-drop',
      cols: 10, rows: 7,
      spawn: { col: 1, row: 1 },
      exit: { col: 7, row: 4 },
      tiles: [
        '1111111111',
        '1000000001',
        '1111000001',
        '0000111111',
        '0000000000',
        '0000111111',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('walk-off drift across an unfloored chasm is NOT reachable (composite soundness)', () => {
    // Regression for the Motion-3 soundness hole (#161 fix round): the
    // walk-off composite drifted horizontally at the landing altitude with
    // no footing requirement beneath the drift row, and its bounding-box
    // precheck accepted any merely solid-free region. Counterexample:
    // 14x9, flush ceiling (row 0 solid) killing every jump arc, spawn
    // ledge cols 0-3 (top at row 2), a 3-tile moat (cols 4-6, 5 deep),
    // and a 5-tile-tall pedestal (cols 7-10) with the exit on top at (8,3).
    //
    // The only envelope edge toward the exit is the 1-row walk-off drop
    // from (3,2) to the pedestal top (7,3): ballistic drift on a 1-row
    // fall is bounded by MAX_RUN * t_fall (~23 px), roughly 40 px short
    // of the pedestal, so the real player lands in the moat instead. The
    // moat walls and the pedestal are a 5-tile rise, beyond the 2.35-tile
    // jump apex, so there is no second chance. Physically unsolvable; the
    // composite must not certify the drift across the unfloored moat.
    const level = loadLevel({
      name: 'chasm-drift',
      cols: 14, rows: 9,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 3 },
      tiles: [
        '11111111111111', // row 0: flush ceiling, kills every jump arc
        '10000000000001', // row 1
        '10000000000001', // row 2: spawn ledge top (cols 0-3 standable)
        '11110000000001', // row 3: ledge block, moat mouth, pedestal air
        '11110001111001', // row 4: pedestal cols 7-10 (top surface)
        '11110001111001', // row 5
        '11110001111001', // row 6
        '11110001111001', // row 7: moat bottom (stands on row 8)
        '11111111111111', // row 8: floor
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('walk blocked by a 1-tile wall is NOT reachable', () => {
    // Flat corridor whose open row is exactly one tile high: a waist-high
    // solid at col 4 blocks walking, and the sealed headroom (rows 0-1
    // solid) leaves no room to arc over it. The pre-sweep validator leapt
    // the wall with an unchecked flat jump and called this reachable.
    const level = loadLevel({
      name: 'waist-wall',
      cols: 10, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '1111111111',
        '1000100001',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(false);
  });

  it('positive control: arc over a 1-tile obstacle succeeds', () => {
    // Same corridor as the waist-wall case but with headroom: the ceiling
    // is two rows above the floor, leaving space to arc over the single
    // obstacle tile. The sweep must certify this hop.
    const level = loadLevel({
      name: 'hop-over',
      cols: 10, rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '1000000001',
        '1000100001',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('positive control: plain flat jump across a gap succeeds', () => {
    // A 3-tile gap in the floor at the same row: squarely inside the
    // 4-tile envelope, no obstructions. Must stay reachable.
    const level = loadLevel({
      name: 'plain-gap',
      cols: 10, rows: 4,
      spawn: { col: 2, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '1000000001',
        '1001110001',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(true);
  });

  it('positive control: drop down a clear shaft with drift succeeds', () => {
    // Spawn on an upper ledge, exit on the floor below and 3 columns
    // across, with open air the whole way. The walked-off composite must
    // certify it.
    const level = loadLevel({
      name: 'clear-drop',
      cols: 10, rows: 7,
      spawn: { col: 1, row: 1 },
      exit: { col: 5, row: 5 },
      tiles: [
        '1111111111',
        '1000000000',
        '1111100000',
        '1000000000',
        '1000000000',
        '1000000000',
        '1111111111',
      ],
      traps: [],
    });
    expect(validateReachability(level)).toBe(true);
  });
});
