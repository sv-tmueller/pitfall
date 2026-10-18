import { describe, expect, it, vi } from 'vitest';
import { TILE_SIZE } from '../engine/physics';
import type { LevelData, Tile as LvlTile } from '../levels/types';
import {
  createScene,
  stepScene,
  type SceneActions,
  type SceneState,
} from './scene';
import {
  DEATH_FREEZE_STEPS,
  EXIT_BEAT_STEPS,
  PLAYER_HEIGHT,
  spawnToBody,
} from './constants';
import { createControllerState } from '../engine/controller';
import { WORLD3_LEVELS } from '../levels/world3/index';

const DT = 1 / 60;

function idle(overrides: Partial<SceneActions> = {}): SceneActions {
  return {
    left: false,
    right: false,
    jumpPressed: false,
    jumpHeld: false,
    restart: false,
    ...overrides,
  };
}

/**
 * Minimal 3-row level: ceiling, open middle, floor. Spawn and exit are
 * configurable. Middle-row tiles accept '0' (empty), '1' (solid), '3' (hazard).
 */
function makeMiniLevel(opts: {
  spawn: { col: number; row: number };
  exit: { col: number; row: number };
  middleTiles?: string;
}): LevelData {
  const cols = opts.middleTiles?.length ?? 6;
  const middle = opts.middleTiles ?? ''.padEnd(cols, '0');

  const tiles: LvlTile[] = [];
  for (let c = 0; c < cols; c++) tiles.push(1);
  for (const ch of middle) {
    if (ch === '1') tiles.push(1);
    else if (ch === '3') tiles.push(3);
    else tiles.push(0);
  }
  for (let c = 0; c < cols; c++) tiles.push(1);

  return {
    name: 'mini',
    cols,
    rows: 3,
    spawn: opts.spawn,
    exit: opts.exit,
    tiles,
    traps: [],
  };
}

/** Converts a LevelData into the raw JSON-source shape loadLevel expects. */
function asSource(level: LevelData): unknown {
  // Validator expects tiles as an array of row strings, each of length cols.
  const rowStrings: string[] = [];
  for (let r = 0; r < level.rows; r++) {
    let rowStr = '';
    for (let c = 0; c < level.cols; c++) {
      rowStr += String(level.tiles[r * level.cols + c]);
    }
    rowStrings.push(rowStr);
  }

  return {
    name: level.name,
    cols: level.cols,
    rows: level.rows,
    spawn: level.spawn,
    exit: level.exit,
    tiles: rowStrings,
    traps: level.traps,
  };
}

const SAFE_LEVEL = makeMiniLevel({
  spawn: { col: 1, row: 1 },
  exit: { col: 4, row: 1 },
  middleTiles: '000000',
});

const HAZARD_AT_SPAWN = makeMiniLevel({
  spawn: { col: 1, row: 1 },
  exit: { col: 4, row: 1 },
  middleTiles: '030000',
});

// ===========================================================================
// Death on hazard overlap
// ===========================================================================

describe('scene - death on hazard overlap', () => {
  it('transitions to dying and increments counters when body touches hazard', () => {
    const scene = createScene([asSource(HAZARD_AT_SPAWN)]);
    const next = stepScene(scene, idle(), DT);
    expect(next.phase).toBe('dying');
    expect(next.deathsThisLevel).toBe(1);
    expect(next.deathsTotal).toBe(1);
    expect(next.timer).toBe(DEATH_FREEZE_STEPS);
  });
});

// ===========================================================================
// Freeze countdown
// ===========================================================================

describe('scene - death freeze countdown', () => {
  it('stays in dying for DEATH_FREEZE_STeps then respawns at spawn', () => {
    const scene = createScene([asSource(HAZARD_AT_SPAWN)]);

    let s = stepScene(scene, idle(), DT);
    expect(s.phase).toBe('dying');

    for (let i = 0; i < DEATH_FREEZE_STEPS; i++) {
      s = stepScene(s, idle(), DT);
    }
    expect(s.phase).toBe('dying');
    expect(s.timer).toBe(0);

    // One more step respawns
    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('playing');
    expect(s.controller.body.x).toBe(1 * TILE_SIZE);
    expect(s.controller.body.y).toBe((1 + 1) * TILE_SIZE - PLAYER_HEIGHT);
    expect(s.controller.body.velocity.x).toBe(0);
    expect(s.controller.body.velocity.y).toBe(0);
  });
});

// ===========================================================================
// Clean reset
// ===========================================================================

describe('scene - clean reset on respawn', () => {
  it('rebuilds controller state from scratch after death', () => {
    const scene = createScene([asSource(HAZARD_AT_SPAWN)]);

    // Pollute the controller state before death
    const base = createControllerState(spawnToBody(HAZARD_AT_SPAWN.spawn, PLAYER_HEIGHT));
    const dirty: SceneState = {
      ...scene,
      controller: {
        body: {
          ...base.body,
          velocity: { x: 100, y: 200 },
          grounded: true,
        },
        coyoteSteps: 5,
        jumpBufferSteps: 3,
        jumpCutArmed: true,
      },
    };

    let s = stepScene(dirty, idle(), DT);
    expect(s.phase).toBe('dying');

    for (let i = 0; i < DEATH_FREEZE_STEPS + 1; i++) {
      s = stepScene(s, idle(), DT);
    }

    expect(s.phase).toBe('playing');
    expect(s.controller.body.velocity.x).toBe(0);
    expect(s.controller.body.velocity.y).toBe(0);
    expect(s.controller.coyoteSteps).toBe(0);
    expect(s.controller.jumpBufferSteps).toBe(-1);
    expect(s.controller.jumpCutArmed).toBe(false);
  });
});

// ===========================================================================
// R-key restart
// ===========================================================================

describe('scene - R-key restart', () => {
  it('triggers dying phase WITHOUT incrementing counters', () => {
    const scene = createScene([asSource(SAFE_LEVEL)]);
    const prevDeaths = scene.deathsThisLevel;
    const prevTotal = scene.deathsTotal;

    const s = stepScene(scene, idle({ restart: true }), DT);

    expect(s.phase).toBe('dying');
    expect(s.timer).toBe(DEATH_FREEZE_STEPS);
    expect(s.deathsThisLevel).toBe(prevDeaths);
    expect(s.deathsTotal).toBe(prevTotal);
  });

  it('R-key during dying is a no-op (just decrements timer)', () => {
    const scene = createScene([asSource(SAFE_LEVEL)]);

    let s = stepScene(scene, idle({ restart: true }), DT);
    expect(s.phase).toBe('dying');
    const timerAfterRestart = s.timer;

    s = stepScene(s, idle({ restart: true }), DT);
    expect(s.phase).toBe('dying');
    expect(s.timer).toBe(timerAfterRestart - 1);
  });
});

// ===========================================================================
// Multiple deaths accumulate
// ===========================================================================

describe('scene - cumulative deaths', () => {
  it('accumulates deathsThisLevel and deathsTotal across multiple deaths', () => {
    const scene = createScene([asSource(HAZARD_AT_SPAWN)]);

    let s = stepScene(scene, idle(), DT);
    expect(s.deathsThisLevel).toBe(1);
    expect(s.deathsTotal).toBe(1);

    for (let i = 0; i < DEATH_FREEZE_STEPS + 1; i++) {
      s = stepScene(s, idle(), DT);
    }
    expect(s.phase).toBe('playing');

    s = stepScene(s, idle(), DT);
    expect(s.deathsThisLevel).toBe(2);
    expect(s.deathsTotal).toBe(2);
  });
});

// ===========================================================================
// Exit overlap
// ===========================================================================

describe('scene - exit overlap', () => {
  it('transitions to entering when body overlaps exit', () => {
    const EXIT_AT_SPAWN = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });
    const scene = createScene([asSource(EXIT_AT_SPAWN)]);

    const s = stepScene(scene, idle(), DT);
    expect(s.phase).toBe('entering');
    expect(s.timer).toBe(EXIT_BEAT_STEPS);
  });
});

// ===========================================================================
// Entering -> level advance
// ===========================================================================

describe('scene - entering countdown and level advance', () => {
  it('advances to the next level after EXIT_BEAT_STEPS and spawns at new spawn', () => {
    const level1 = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });
    const level2 = makeMiniLevel({
      spawn: { col: 2, row: 1 },
      exit: { col: 5, row: 1 },
      middleTiles: '000000',
    });

    const scene = createScene([asSource(level1), asSource(level2)]);

    let s = stepScene(scene, idle(), DT);
    expect(s.phase).toBe('entering');

    for (let i = 0; i < EXIT_BEAT_STEPS; i++) {
      s = stepScene(s, idle(), DT);
    }
    expect(s.phase).toBe('entering');
    expect(s.timer).toBe(0);

    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('playing');
    expect(s.sequence.index).toBe(1);
    expect(s.controller.body.x).toBe(2 * TILE_SIZE);
    expect(s.controller.body.y).toBe((1 + 1) * TILE_SIZE - PLAYER_HEIGHT);
  });

  it('resets deathsThisLevel to 0 on advance but preserves deathsTotal', () => {
    // Two levels. Level 1 has exit at spawn so the player enters immediately.
    // We inject a fake death count before triggering the advance.
    const level1 = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });
    const level2 = makeMiniLevel({
      spawn: { col: 2, row: 1 },
      exit: { col: 5, row: 1 },
      middleTiles: '000000',
    });

    const scene = createScene([asSource(level1), asSource(level2)]);

    // Simulate having died twice on level 1 before reaching the exit.
    let s: SceneState = {
      ...scene,
      deathsThisLevel: 2,
      deathsTotal: 3,
    };

    // Trigger entering (exit at spawn)
    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('entering');
    expect(s.deathsThisLevel).toBe(2); // not reset yet
    expect(s.deathsTotal).toBe(3);

    // Exhaust the beat
    for (let i = 0; i < EXIT_BEAT_STEPS; i++) {
      s = stepScene(s, idle(), DT);
    }

    // Advance to level 2
    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('playing');
    expect(s.sequence.index).toBe(1);
    expect(s.deathsThisLevel).toBe(0); // reset
    expect(s.deathsTotal).toBe(3); // preserved
  });

  it('last level entering transitions to complete', () => {
    const level1 = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });

    const scene = createScene([asSource(level1)]);

    let s = stepScene(scene, idle(), DT);
    expect(s.phase).toBe('entering');

    for (let i = 0; i < EXIT_BEAT_STEPS; i++) {
      s = stepScene(s, idle(), DT);
    }

    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('complete');
  });
});

// ===========================================================================
// Complete phase is a no-op
// ===========================================================================

describe('scene - complete phase', () => {
  it('stepping while complete returns the same state', () => {
    const level1 = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });

    let s = createScene([asSource(level1)]);

    s = stepScene(s, idle(), DT);
    for (let i = 0; i < EXIT_BEAT_STEPS; i++) {
      s = stepScene(s, idle(), DT);
    }
    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('complete');

    const after = stepScene(s, idle(), DT);
    expect(after).toBe(s);
  });
});

// ===========================================================================
// Callbacks
// ===========================================================================

describe('scene - callbacks', () => {
  it('fires onLevelComplete with the level index when entering begins', () => {
    const onLevelComplete = vi.fn();
    const level1 = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });

    const scene = createScene([asSource(level1)], { onLevelComplete });
    stepScene(scene, idle(), DT);

    expect(onLevelComplete).toHaveBeenCalledOnce();
    expect(onLevelComplete).toHaveBeenCalledWith(0);
  });

  it('fires onSequenceComplete when the last level finishes entering', () => {
    const onSequenceComplete = vi.fn();
    const level1 = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '000000',
    });

    const scene = createScene([asSource(level1)], { onSequenceComplete });

    let s = stepScene(scene, idle(), DT);
    for (let i = 0; i < EXIT_BEAT_STEPS; i++) {
      s = stepScene(s, idle(), DT);
    }
    s = stepScene(s, idle(), DT);

    expect(onSequenceComplete).toHaveBeenCalledOnce();
    expect(s.phase).toBe('complete');
  });
});

// ===========================================================================
// Hazard vs exit priority
// ===========================================================================

describe('scene - hazard takes priority over exit', () => {
  it('when body overlaps both hazard and exit in the same step, death wins', () => {
    const CONTESTED = makeMiniLevel({
      spawn: { col: 1, row: 1 },
      exit: { col: 1, row: 1 },
      middleTiles: '030000',
    });

    const scene = createScene([asSource(CONTESTED)]);
    const s = stepScene(scene, idle(), DT);

    expect(s.phase).toBe('dying');
    expect(s.deathsThisLevel).toBe(1);
  });
});

// ===========================================================================
// Mechanics integration (springs, teleporters)
// ===========================================================================

describe('scene - mechanics integration', () => {
  it('scene state includes mechanicsRuntime', () => {
    const scene = createScene([asSource(SAFE_LEVEL)]);
    expect(scene.mechanicsRuntime).toBeDefined();
    expect(scene.mechanicsRuntime.mechanics).toHaveLength(0);
  });

  it('levels with mechanics create mechanic instances', () => {
    // Use asSource but add mechanics to the source.
    const source = asSource(SAFE_LEVEL) as Record<string, unknown>;
    source['mechanics'] = [
      { id: 'sp1', type: 'spring', params: { x: 16, y: 16, impulseY: -400 } },
    ];
    const scene = createScene([source]);
    expect(scene.mechanicsRuntime.mechanics).toHaveLength(1);
    expect(scene.mechanicsRuntime.mechanics[0]!.id).toBe('sp1');
  });

  it('spring launches player upward on contact', () => {
    // Build a level where the player stands on a spring at spawn.
    // The spring imparts a strong upward velocity, lifting the player off
    // the ground. We verify the body's y-velocity becomes strongly negative.
    const source: unknown = {
      name: 'spring-test',
      cols: 6,
      rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 5, row: 2 },
      tiles: [
        '111111',
        '000000',
        '000000',
        '111111',
      ],
      traps: [],
      mechanics: [
        // Spring placed exactly at spawn tile (col=1, row=2 => x=16, y=32).
        // Player body occupies (16, 32) to (32, 48) initially.
        { id: 'sp1', type: 'spring', params: { x: 16, y: 32, impulseY: -500 } },
      ],
    };

    const scene = createScene([source]);

    // Step once: player should contact the spring and get launched.
    const s = stepScene(scene, idle(), DT);

    // The spring overrides vy to -500. Even after one controller step
    // (which applies gravity), the velocity should be strongly negative.
    expect(s.controller.body.velocity.y).toBeLessThan(-400);
  });

  it('teleporter relocates player to destination on contact', () => {
    // Build a level where the player spawns on top of a teleporter that
    // sends them to a distant location.
    const source: unknown = {
      name: 'teleport-test',
      cols: 10,
      rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 8, row: 2 },
      tiles: [
        '1111111111',
        '0000000000',
        '0000000000',
        '1111111111',
      ],
      traps: [],
      mechanics: [
        // Teleporter at spawn (col=1, row=2 => x=16, y=32).
        // Destination at col=7 (x=112, y=32).
        { id: 'tp1', type: 'teleporter', params: { x: 16, y: 32, destX: 112, destY: 32 } },
      ],
    };

    const scene = createScene([source]);

    // Step once: player should be teleported.
    const s = stepScene(scene, idle(), DT);

    // The player's x should have jumped significantly toward destX.
    expect(s.controller.body.x).toBeGreaterThan(100);
  });

  it('levels without mechanics field behave identically (backward compat)', () => {
    // Same SAFE_LEVEL but without mechanics in the source.
    const source = asSource(SAFE_LEVEL);
    const scene = createScene([source]);

    // Step a few times—should not crash or produce unexpected state.
    let s = stepScene(scene, idle(), DT);
    s = stepScene(s, idle(), DT);
    s = stepScene(s, idle(), DT);

    expect(s.phase).toBe('playing');
    expect(s.mechanicsRuntime.mechanics).toHaveLength(0);
  });

  it('mechanics runtime resets on respawn', () => {
    // Level with a moving platform that advances over time.
    const source: unknown = {
      name: 'respawn-test',
      cols: 6,
      rows: 4,
      spawn: { col: 1, row: 2 },
      exit: { col: 5, row: 2 },
      tiles: [
        '111111',
        '000000',
        '000000',
        '111111',
      ],
      traps: [],
      mechanics: [
        { id: 'mp1', type: 'moving-platform', params: {
          startX: 16, startY: 16, width: 16, height: 16,
          dx: 1, dy: 0, speed: 16, distance: 48,
        }},
      ],
    };

    const scene = createScene([source]);

    // Step a few times to move the platform.
    let s = stepScene(scene, idle(), DT);
    s = stepScene(s, idle(), DT);
    s = stepScene(s, idle(), DT);

    // The mechanics runtime should have published solids.
    expect(s.mechanicsRuntime.publishedSolids.length).toBeGreaterThan(0);
    const movedX = s.mechanicsRuntime.publishedSolids[0]!.x;
    expect(movedX).toBeGreaterThan(0);

    // Die and respawn: the platform should reset to its start position.
    // Force death by injecting a hazardous state.
    s = stepScene(s, idle({ restart: true }), DT);
    expect(s.phase).toBe('dying');

    // Exhaust death timer.
    for (let i = 0; i < DEATH_FREEZE_STEPS + 1; i++) {
      s = stepScene(s, idle(), DT);
    }
    expect(s.phase).toBe('playing');

    // After respawn, the platform should be back at startX.
    s = stepScene(s, idle(), DT);
    expect(s.mechanicsRuntime.publishedSolids[0]!.x).toBe(16);
  });
});

// ===========================================================================
// Dynamic solids: colliding, crushing, and carrying (issue #158)
// ===========================================================================

/**
 * Six-row open shaft: ceiling, four open rows, floor. Spawn and exit are
 * tile positions; traps and mechanics are passed through verbatim so a test
 * can drop in a crusher, a shifting wall, or a moving platform.
 */
function makeShaftLevel(opts: {
  spawn: { col: number; row: number };
  exit: { col: number; row: number };
  cols?: number;
  traps?: unknown[];
  mechanics?: unknown[];
}): Record<string, unknown> {
  const cols = opts.cols ?? 10;
  const rows = 6;
  const tiles: string[] = ['1'.repeat(cols)];
  for (let r = 1; r < rows - 1; r++) tiles.push('0'.repeat(cols));
  tiles.push('1'.repeat(cols));

  return {
    name: 'shaft',
    cols,
    rows,
    spawn: opts.spawn,
    exit: opts.exit,
    tiles,
    traps: opts.traps ?? [],
    mechanics: opts.mechanics ?? [],
  };
}

describe('scene - dynamic solids (issue #158)', () => {
  it('a crusher dropping onto the player kills (AC1)', () => {
    // Player stands on the floor at row 4. The crusher hangs two tiles above
    // the floor (row 1, two tiles tall) so its danger zone already wraps the
    // player, firing on-enter. It then descends onto the standing player.
    const source = makeShaftLevel({
      spawn: { col: 1, row: 4 },
      exit: { col: 9, row: 1 },
      traps: [
        {
          id: 'ceiling-crusher',
          type: 'crusher',
          trigger: 'on-enter',
          params: { col: 1, row: 1, width: 2, height: 2, dropDistance: 48, dropSpeed: 4 },
        },
      ],
    });

    let s = createScene([source]);
    let died = false;
    for (let i = 0; i < 40 && !died; i++) {
      s = stepScene(s, idle(), DT);
      if (s.phase === 'dying') died = true;
    }

    expect(died).toBe(true);
    expect(s.deathsThisLevel).toBe(1);
  });

  it('a shifting wall slides in and blocks horizontal movement (AC2)', () => {
    // The wall spawns at col 3 and slides right by 32 px (two tiles), parking
    // its left face at x = 80. The player walks right from x = 16 and must be
    // stopped with its right edge against that face (player x = 64).
    const source = makeShaftLevel({
      spawn: { col: 1, row: 4 },
      exit: { col: 9, row: 1 },
      traps: [
        {
          id: 'seal-wall',
          type: 'shifting-wall',
          trigger: 'on-timer',
          params: {
            col: 3,
            row: 4,
            direction: 'right',
            distance: 32,
            speed: 8,
            delaySteps: 0,
          },
        },
      ],
    });

    let s = createScene([source]);
    for (let i = 0; i < 200; i++) {
      s = stepScene(s, idle({ right: true }), DT);
    }

    expect(s.phase).toBe('playing');
    // Blocked by the wall face: the player never crosses x = 64.
    expect(s.controller.body.x).toBeLessThanOrEqual(65);
    // But it did travel right toward the wall rather than stalling at spawn.
    expect(s.controller.body.x).toBeGreaterThan(45);
  });

  it('a rider is carried through a turnaround without falling (AC3)', () => {
    // Platform starts at x = 48 and ping-pongs over a 48 px band. The player
    // spawns flush on its top (bottom edge at y = 48), one tile above the
    // floor, so a carry failure shows up as a fall to y = 64.
    const source = makeShaftLevel({
      cols: 12,
      spawn: { col: 4, row: 2 },
      exit: { col: 11, row: 1 },
      mechanics: [
        {
          id: 'ride',
          type: 'moving-platform',
          params: {
            startX: 48,
            startY: 48,
            width: 32,
            height: 16,
            dx: 1,
            dy: 0,
            speed: 60,
            distance: 48,
          },
        },
      ],
    });

    let s = createScene([source]);
    let sawTurnaround = false;

    for (let i = 0; i < 200; i++) {
      s = stepScene(s, idle(), DT);
      const platform = s.mechanicsRuntime.publishedSolids[0]!;
      const body = s.controller.body;

      if (platform.velocityX < 0) sawTurnaround = true;

      // Still resting on the platform top (y = 48), never dropped to the floor.
      expect(Math.abs(body.y + body.height - 48)).toBeLessThanOrEqual(1);
      // Still horizontally over the platform.
      expect(body.x + body.width).toBeGreaterThan(platform.x);
      expect(body.x).toBeLessThan(platform.x + platform.width);
    }

    expect(sawTurnaround).toBe(true);
    expect(s.controller.body.grounded).toBe(true);
  });
});

describe('scene - runtime-owned mechanics (issue #159)', () => {
  it('a jetpack lifts the player while jump is held (AC)', () => {
    const source = makeShaftLevel({
      spawn: { col: 1, row: 4 },
      exit: { col: 9, row: 1 },
      mechanics: [{ id: 'jp', type: 'jetpack', params: { maxFuel: 300, thrustPower: 600 } }],
    });

    let s = createScene([source]);
    const startY = s.controller.body.y;
    let minY = startY;
    for (let i = 0; i < 40; i++) {
      s = stepScene(s, idle({ jumpHeld: true }), DT);
      minY = Math.min(minY, s.controller.body.y);
    }

    expect(s.phase).toBe('playing');
    expect(minY).toBeLessThan(startY - 20);
    expect(s.controller.body.y).toBeLessThan(startY);
  });

  it('without held jump the jetpack does not lift the player', () => {
    const source = makeShaftLevel({
      spawn: { col: 1, row: 4 },
      exit: { col: 9, row: 1 },
      mechanics: [{ id: 'jp', type: 'jetpack', params: { maxFuel: 300, thrustPower: 600 } }],
    });

    let s = createScene([source]);
    const startY = s.controller.body.y;
    let minY = startY;
    for (let i = 0; i < 40; i++) {
      s = stepScene(s, idle(), DT);
      minY = Math.min(minY, s.controller.body.y);
    }

    expect(minY).toBeGreaterThanOrEqual(startY - 1);
  });

  it('control inversion makes left input move the player right (AC)', () => {
    const source = makeShaftLevel({
      spawn: { col: 1, row: 4 },
      exit: { col: 9, row: 1 },
      mechanics: [{ id: 'ci', type: 'control-inversion', params: { duration: -1 } }],
    });

    let s = createScene([source]);
    const startX = s.controller.body.x;
    for (let i = 0; i < 30; i++) {
      s = stepScene(s, idle({ left: true }), DT);
    }

    expect(s.controller.body.x).toBeGreaterThan(startX + 20);
  });

  it('a spring penned under a ceiling fires once per contact, not every frame (AC)', () => {
    // Three rows: the player exactly fills the open row between ceiling and
    // floor, so it can never leave the spring's overlap box. The launch must
    // therefore apply exactly once across the whole sustained overlap, even
    // long past the 10-step cooldown, because the body never breaks contact.
    const source = {
      name: 'spring-pen',
      cols: 6,
      rows: 3,
      spawn: { col: 1, row: 1 },
      exit: { col: 5, row: 1 },
      tiles: ['111111', '000000', '111111'],
      traps: [],
      mechanics: [{ id: 'sp', type: 'spring', params: { x: 16, y: 16, impulseY: -500 } }],
    };

    let s = createScene([source]);
    let launches = 0;
    // 40 frames spans several cooldown windows (cooldown is 10 steps): a single
    // sustained contact must still yield exactly one launch.
    for (let i = 0; i < 40; i++) {
      s = stepScene(s, idle(), DT);
      if (s.controller.body.velocity.y <= -400) launches++;
      // Penned: the body never rises off the spring or falls to the floor.
      expect(s.controller.body.y).toBeCloseTo(16, 5);
    }

    expect(launches).toBe(1);
  });

  it('teleporter arrives and stays on the real level-43 pair (AC)', () => {
    // Level 43's tp-glitch-a sits at (80, 144) and relocates the player to
    // (240, 80), which overlaps tp-glitch-b. Before the twin cooldown the pair
    // ping-ponged: every frame bounced the player straight back.
    const source = WORLD3_LEVELS['glitch'] as Record<string, unknown>;
    const scene = createScene([source]);

    let s: SceneState = {
      ...scene,
      controller: {
        ...scene.controller,
        body: {
          ...scene.controller.body,
          x: 80,
          y: 144,
          velocity: { x: 0, y: 0 },
          grounded: false,
        },
      },
    };

    // Frame 1: contact fires and the body lands on the paired arrival tile.
    s = stepScene(s, idle(), DT);
    expect(s.phase).toBe('playing');
    expect(s.controller.body.x).toBe(240);
    expect(s.controller.body.y).toBe(80);

    // Following frames: the arrival tile is still overlapping, yet the twin
    // cooldown must hold the player there instead of bouncing it back.
    for (let i = 0; i < 9; i++) {
      s = stepScene(s, idle(), DT);
      expect(s.controller.body.x).toBeGreaterThan(200);
    }

    // The 10-step cooldown elapses, but the player never left the arrival tile,
    // so the portal stays disarmed: no involuntary bounce back to the origin.
    // (Overlap-release arming is what keeps this stable indefinitely.)
    for (let i = 0; i < 40; i++) {
      s = stepScene(s, idle(), DT);
      expect(s.controller.body.x).toBeGreaterThan(200);
    }
  });

  it('a walking player escapes the level-43 teleporter pair instead of ping-ponging', () => {
    // Regression for the soft-lock: posed on tp-glitch-a and holding right, the
    // player used to bounce A->B->A every 10 frames forever, never clearing
    // either portal's 16 px trigger box (x >= 96 at A, x >= 256 at B). With
    // overlap-release arming the arrival portal stays disarmed until the player
    // walks clear, then re-arms only after the box is empty.
    const source = WORLD3_LEVELS['glitch'] as Record<string, unknown>;
    const scene = createScene([source]);
    let s: SceneState = {
      ...scene,
      controller: {
        ...scene.controller,
        body: {
          ...scene.controller.body,
          x: 80,
          y: 144,
          velocity: { x: 0, y: 0 },
          grounded: false,
        },
      },
    };
    const holding = idle({ right: true });

    // Frame 1: the origin portal fires and drops the player on tp-glitch-b.
    s = stepScene(s, holding, DT);
    expect(s.controller.body.x).toBe(240);

    // Hold right for the tester's full 6000-frame horizon. The player must
    // walk clear of tp-glitch-b's box (x 240..256, so x reaches 256) and must
    // never be dragged involuntarily back into tp-glitch-a's box (x 80..96).
    let clearedB = false;
    let reentriesToA = 0;
    let prevX = s.controller.body.x;
    for (let i = 0; i < 6000; i++) {
      s = stepScene(s, holding, DT);
      const x = s.controller.body.x;
      if (x >= 256) clearedB = true;
      if (x < 96 && prevX >= 96) reentriesToA++;
      prevX = x;
    }
    expect(clearedB).toBe(true);
    expect(reentriesToA).toBe(0);
  });
});
