// Solvability gate over every shipped level (issue #161 CP5).
//
// Iterates the three world sequences (45 levels total) and asserts the
// sound validator's verdict against an explicit ALLOWLIST. The assertion
// is the CONTRAPOSITIVE of the acceptance criterion "every shipped level
// is reachable or allowlisted with a reason":
//
//   reachable  <=>  NOT allowlisted
//
// so a level that fails validation MUST be allowlisted (forcing a
// documented reason) and an allowlisted level that starts validating
// FAILS the gate (forcing the stale entry out — the anti-stale rule).
//
// Allowlisted entries are reviewed reasons, not silences: each records
// why the gate cannot certify the level today. When the underlying
// blocker is fixed, the contrapositive evicts the entry automatically.
import { describe, expect, it } from 'vitest';
import { validateSolvability } from './reachability';
import { loadLevel } from '../levels/load';
import { MVP_LEVELS, MVP_SEQUENCE } from '../levels/mvp/index';
import { WORLD2_LEVELS, WORLD2_SEQUENCE } from '../levels/world2/index';
import { WORLD3_LEVELS, WORLD3_SEQUENCE } from '../levels/world3/index';

/**
 * Reviewed exceptions: level id -> reason the gate cannot certify it.
 * Every entry must reference a concrete, current blocker; the gate's
 * contrapositive assertion evicts entries that stop being true.
 *
 * Note on world-3-finale: issue #171's impossibility is a crusher
 * SURVIVAL race at the teleporter destination, not a geometry failure.
 * The swept BFS certifies a legal static route to the exit door, and the
 * sub-plan's own ruling excludes pure-hazard traps from reachability,
 * so the level is NOT allowlisted here. Practical completability stays
 * tracked by the it.todo in src/game/fake-exit-completion.test.ts and by
 * issue #171.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'lift-off':
    'jetpack mechanic is not modelled; the BFS cannot certify the route without it',
  'mechanism':
    'shifting-wall trap rearranges geometry at runtime; the static sweep sees the wall closed and cannot certify the level',
};

/** The 45 shipped levels in sequence order. */
function composeCatalog(): Array<{ world: string; id: string; source: unknown }> {
  const out: Array<{ world: string; id: string; source: unknown }> = [];
  for (const id of MVP_SEQUENCE) {
    out.push({ world: 'mvp', id, source: MVP_LEVELS[id] });
  }
  for (const id of WORLD2_SEQUENCE) {
    out.push({ world: 'world2', id, source: WORLD2_LEVELS[id] });
  }
  for (const id of WORLD3_SEQUENCE) {
    out.push({ world: 'world3', id, source: WORLD3_LEVELS[id] });
  }
  return out;
}

describe('solvability gate over all shipped levels (#161)', () => {
  it('covers exactly the 45 shipped levels', () => {
    expect(composeCatalog()).toHaveLength(45);
  });

  it.each(composeCatalog())('$world/$id: reachable iff not allowlisted', ({ id, source }) => {
    const level = loadLevel(source);
    const result = validateSolvability(level);

    const reason = ALLOWLIST[id];
    if (reason !== undefined) {
      // Allowlisted: the gate must STILL fail to certify it, otherwise the
      // entry is stale and must be removed.
      expect(
        result.status === 'solvable',
        `"${id}" validates reachable; remove the stale allowlist entry "${reason}"`,
      ).toBe(false);
      return;
    }

    // Not allowlisted: the gate must certify it solvable.
    expect(result.status, `"${id}" failed the gate: ${JSON.stringify(result)}`).toBe('solvable');
  });
});

// ---------------------------------------------------------------------------
// Gate self-verification (issue #161 CP6)
// ---------------------------------------------------------------------------

describe('gate self-verification (#161)', () => {
  it('detects a sealed exit: negative verification of the gate itself', () => {
    // Take a shipping level the gate certifies solvable (spike-room: only
    // an emerging-spikes trap, so no not-modelled excuse), seal its exit
    // cell shut in a scratch copy, and require the gate to notice and
    // declare the copy unsolvable.
    const baseline = loadLevel(MVP_LEVELS['spike-room']);
    expect(validateSolvability(baseline).status).toBe('solvable');

    const { col, row } = baseline.exit;
    const tiles = [...baseline.tiles];
    const ringOffsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ] as const;
    for (const [dc, dr] of ringOffsets) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || c >= baseline.cols || r < 0 || r >= baseline.rows) continue;
      tiles[r * baseline.cols + c] = 1;
    }
    const sealedLevel: typeof baseline = { ...baseline, tiles };
    const verdict = validateSolvability(sealedLevel);
    expect(verdict.reachable).toBe(false);
    expect(verdict.status).toBe('unsolvable');
  });

  it('cross-check: every level the completion tests prove completable validates solvable', () => {
    // The five simulated completions in src/game/fake-exit-completion.test.ts
    // (four hopBot levels plus the mvp/15 finale) must all be certified by
    // the gate, either solvable or (per the advisor ruling) allowlisted.
    // A contradiction here would be a validator soundness bug, not a test
    // casualty.
    const completionProven: ReadonlyArray<[string, unknown]> = [
      ['fake-door', MVP_LEVELS['fake-door']],
      ['maze-of-doors', MVP_LEVELS['maze-of-doors']],
      ['world-2-finale', WORLD2_LEVELS['world-2-finale']],
      ['glitch', WORLD3_LEVELS['glitch']],
      ['finale', MVP_LEVELS.finale],
    ];

    for (const [id, source] of completionProven) {
      const result = validateSolvability(loadLevel(source));
      const allowlisted = ALLOWLIST[id] !== undefined;
      expect(
        result.status === 'solvable' || allowlisted,
        `"${id}" is proven completable by simulation but the gate neither certifies nor allowlists it (${JSON.stringify(result)})`,
      ).toBe(true);
    }
  });
});
