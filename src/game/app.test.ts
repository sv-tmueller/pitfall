import { describe, expect, it } from 'vitest';
import atlasManifest from '../../assets/atlas.json';
import type { AtlasManifest } from '../render/atlas';
import { loadAtlas, type BitmapLike, type LoadedAtlas } from '../render/atlas-loader';
import type { BlitContext } from '../render/batcher';
import { createKeyboardInput, type InputSnapshot } from '../engine/input';
import type { Ticker } from '../engine/loop';
import { FIXTURE_SOURCES } from '../levels/fixtures';
import { createMemoryStorage, type SaveStorage } from '../save/storage';
import { getCurrentPosition, loadSave, saveSave } from '../save/repository';
import { SAVE_SCHEMA_VERSION, type SavePayload } from '../save/schema';
import { createGame, type GameState } from './integration';
import { getAllStats } from '../stats/stats';
import type { SceneCallbacks } from './scene';
import type { LevelSource } from './sequence';
import {
  createApp,
  formatBootError,
  levelKey,
  sumDeaths,
  type App,
  type GameAdapter,
} from './app';

const MANIFEST = atlasManifest as unknown as AtlasManifest;
const BITMAP: BitmapLike = { width: 128, height: 40 };
const ATLAS: LoadedAtlas = loadAtlas(MANIFEST, BITMAP);

const SOURCES: readonly LevelSource[] = [
  FIXTURE_SOURCES['corridor'],
  FIXTURE_SOURCES['shaft'],
];

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Structural fakes
// ---------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  args: unknown[];
}

type MockCtx = BlitContext & { calls: RecordedCall[] };

function createMockCtx(): MockCtx {
  const calls: RecordedCall[] = [];
  const ctx: MockCtx = {
    calls,
    fillStyle: '',
    font: '',
    imageSmoothingEnabled: true,
    drawImage: (...args: unknown[]) => calls.push({ method: 'drawImage', args }),
    fillRect: (...args: unknown[]) => calls.push({ method: 'fillRect', args }),
    fillText: (...args: unknown[]) => calls.push({ method: 'fillText', args }),
    save: () => calls.push({ method: 'save', args: [] }),
    restore: () => calls.push({ method: 'restore', args: [] }),
    translate: (...args: unknown[]) => calls.push({ method: 'translate', args }),
    scale: (...args: unknown[]) => calls.push({ method: 'scale', args }),
  };
  return ctx;
}

function manualTicker(): { ticker: Ticker; frame: (nowMs: number) => void; stopped: () => boolean } {
  let onFrame: ((nowMs: number) => void) | null = null;
  let isStopped = false;
  return {
    ticker: {
      start(cb) {
        onFrame = cb;
      },
      stop() {
        isStopped = true;
      },
    },
    frame(nowMs) {
      if (isStopped || onFrame === null) return;
      onFrame(nowMs);
    },
    stopped: () => isStopped,
  };
}

class FakeAdapter implements GameAdapter {
  readonly created: {
    sources: readonly LevelSource[];
    effectsIntensity: number | undefined;
  }[] = [];
  readonly stepped: InputSnapshot[] = [];
  readonly rendered: number[] = [];
  callbacks: SceneCallbacks | null = null;
  deathsToAdd = 0;
  /**
   * Absolute-in-level knob: the next step returns a state whose
   * scene.sequence.index is set to this value. onLevelComplete alone does not
   * move the index the shell polls, so advance tests need this.
   */
  advanceToIndex: number | null = null;

  create(
    opts: Parameters<GameAdapter['create']>[0],
    input: Parameters<GameAdapter['create']>[1],
    callbacks?: SceneCallbacks,
  ): GameState {
    this.created.push({
      sources: opts.sources,
      effectsIntensity: opts.effectsIntensity,
    });
    this.callbacks = callbacks ?? null;
    return createGame(
      { sources: opts.sources, atlas: opts.atlas, effectsIntensity: opts.effectsIntensity },
      input,
      callbacks,
    );
  }

  step(state: GameState, dt: number): GameState {
    void dt;
    this.stepped.push(state.input.sample());
    const advance = this.advanceToIndex;
    const deaths = this.deathsToAdd;
    if (advance === null && deaths === 0) return state;
    this.advanceToIndex = null;
    this.deathsToAdd = 0;
    const scene = state.scene;
    return {
      ...state,
      scene: {
        ...scene,
        sequence: advance === null ? scene.sequence : { ...scene.sequence, index: advance },
        deathsThisLevel: scene.deathsThisLevel + deaths,
        deathsTotal: scene.deathsTotal + deaths,
      },
    };
  }

  render(): void {
    this.rendered.push(1);
  }
}

function makeApp(
  overrides: Partial<Parameters<typeof createApp>[0]> = {},
): { app: App; input: ReturnType<typeof createKeyboardInput>; ctx: MockCtx; adapter: FakeAdapter; storage: SaveStorage } {
  const input = createKeyboardInput();
  const ctx = createMockCtx();
  const adapter = new FakeAdapter();
  const storage = overrides.storage ?? createMemoryStorage();
  const { ticker } = manualTicker();
  const app = createApp({
    sources: SOURCES,
    atlas: ATLAS,
    input,
    storage,
    blit: ctx,
    ticker,
    ...overrides,
    adapter,
  });
  return { app, input, ctx, adapter, storage };
}

/** Jump once from the title screen so the shell enters play. */
function startPlaying(app: App, input: ReturnType<typeof createKeyboardInput>): void {
  input.keyDown('Space');
  app.step(DT);
  input.keyUp('Space');
}

function textOf(ctx: MockCtx): string[] {
  return ctx.calls
    .filter((c) => c.method === 'fillText')
    .map((c) => String(c.args[0]));
}

function prepopulatedStorage(currentPosition: number): SaveStorage {
  const storage = createMemoryStorage();
  const payload: SavePayload = {
    version: SAVE_SCHEMA_VERSION,
    levels: {
      [levelKey(0)]: {
        attemptCount: 1,
        deathCount: 4,
        deathPositions: [],
        completed: true,
        unlocked: true,
      },
    },
    settings: { muted: false, reducedMotion: false },
    currentPosition,
  };
  saveSave(storage, payload);
  return storage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('app shell', () => {
  it('opens on the title screen', () => {
    const { app } = makeApp();
    expect(app.screen).toBe('title');
    expect(app.title.hasProgress).toBe(false);
  });

  it('starts the game when the title confirm fires (AC-1)', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    expect(app.screen).toBe('playing');
    expect(adapter.created).toHaveLength(1);
    expect(adapter.created[0]!.sources).toHaveLength(SOURCES.length);
  });

  it('does not leak the confirm jump into the first gameplay step', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    app.step(DT);
    expect(adapter.stepped).toHaveLength(1);
    expect(adapter.stepped[0]!.pressed.jump).toBe(false);
  });

  it('starts the game when Enter confirms the title selection (AC-1)', () => {
    const { app, input, adapter } = makeApp();
    input.keyDown('Enter');
    app.step(DT);
    input.keyUp('Enter');

    expect(app.screen).toBe('playing');
    expect(adapter.created).toHaveLength(1);
  });

  it('does not leak the confirm keypress into the first gameplay step (AC-1)', () => {
    const { app, input, adapter } = makeApp();
    input.keyDown('Enter');
    app.step(DT);
    input.keyUp('Enter');
    app.step(DT);

    expect(adapter.stepped).toHaveLength(1);
    expect(adapter.stepped[0]!.pressed.confirm).toBe(false);
    expect(adapter.stepped[0]!.pressed.jump).toBe(false);
  });

  it('selects how-to-play with Enter without starting the game (AC-1)', () => {
    const { app, input, adapter } = makeApp();
    input.keyDown('ArrowRight');
    app.step(DT);
    input.keyUp('ArrowRight');
    input.keyDown('Enter');
    app.step(DT);
    input.keyUp('Enter');

    expect(app.screen).toBe('title');
    expect(app.title.showInstructions).toBe(true);
    expect(adapter.created).toHaveLength(0);
  });

  it('offers continue and resumes at the saved position (AC-4)', () => {
    const storage = prepopulatedStorage(1);
    const { app, input, adapter } = makeApp({ storage });
    expect(app.title.hasProgress).toBe(true);
    // Option 0 is continue.
    input.keyDown('Space');
    app.step(DT);
    input.keyUp('Space');
    expect(app.screen).toBe('playing');
    expect(adapter.created[0]!.sources).toHaveLength(SOURCES.length - 1);
  });

  it('clears progress when new game is chosen (AC-4)', () => {
    const storage = prepopulatedStorage(1);
    const { app, input } = makeApp({ storage });
    input.keyDown('ArrowRight');
    app.step(DT);
    input.keyUp('ArrowRight');
    input.keyDown('Space');
    app.step(DT);
    input.keyUp('Space');
    expect(app.screen).toBe('playing');
    expect(app.save.levels).toEqual({});
    expect(getCurrentPosition(loadSave(storage))).toBe(0);
  });

  it('records level completion and advances the saved position (AC-4)', () => {
    const storage = createMemoryStorage();
    const { app, input, adapter } = makeApp({ storage });
    startPlaying(app, input);
    adapter.callbacks?.onLevelComplete?.(0);
    app.step(DT);
    expect(getCurrentPosition(loadSave(storage))).toBe(1);
  });

  it('resumes a fresh app at the next level after a reload (AC-4)', () => {
    const storage = createMemoryStorage();
    const first = makeApp({ storage });
    startPlaying(first.app, first.input);
    first.adapter.callbacks?.onLevelComplete?.(0);
    first.app.step(DT);

    const second = makeApp({ storage });
    expect(second.app.title.hasProgress).toBe(true);
    startPlaying(second.app, second.input);
    expect(second.adapter.created[0]!.sources).toHaveLength(SOURCES.length - 1);
  });

  it('records per-level deaths from the polled counters (AC-4)', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    adapter.deathsToAdd = 2;
    app.step(DT);
    adapter.deathsToAdd = 1;
    app.step(DT);
    expect(app.save.levels[levelKey(0)]?.deathCount).toBe(3);
  });

  it('does not flicker pause while the pause key is held (AC-3)', () => {
    const { app, input } = makeApp();
    startPlaying(app, input);
    input.keyDown('KeyP');
    app.step(DT);
    expect(app.paused).toBe(true);
    // Key-repeat fires keydown repeatedly with no keyup in between.
    input.keyDown('KeyP');
    input.keyDown('KeyP');
    app.step(DT);
    app.step(DT);
    expect(app.paused).toBe(true);
    input.keyUp('KeyP');
    input.keyDown('KeyP');
    app.step(DT);
    expect(app.paused).toBe(false);
  });

  it('does not step the game on the same frame pause toggles (AC-3)', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    expect(adapter.stepped).toHaveLength(0);
    input.keyDown('KeyP');
    app.step(DT);
    expect(adapter.stepped).toHaveLength(0);
  });

  it('pauses on window blur (AC-3)', () => {
    const { app, input } = makeApp();
    startPlaying(app, input);
    app.handleBlur();
    expect(app.paused).toBe(true);
  });

  it('pauses on tab switch (AC-3)', () => {
    const { app, input } = makeApp();
    startPlaying(app, input);
    app.handleVisibilityChange(true);
    expect(app.paused).toBe(true);
  });

  it('does not resume on becoming visible again (AC-3)', () => {
    const { app, input } = makeApp();
    startPlaying(app, input);
    app.handleVisibilityChange(true);
    app.handleVisibilityChange(false);
    expect(app.paused).toBe(true);
  });

  it('does not fire a buffered jump on resume (AC-3)', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);

    input.keyDown('KeyP');
    app.step(DT);
    input.keyUp('KeyP');
    expect(app.paused).toBe(true);

    // Jump pressed while paused must not survive the resume.
    input.keyDown('Space');
    app.step(DT);
    input.keyUp('Space');

    input.keyDown('KeyP');
    app.step(DT);
    input.keyUp('KeyP');
    expect(app.paused).toBe(false);

    for (let i = 0; i < 10; i++) app.step(DT);

    expect(adapter.stepped.every((s) => !s.pressed.jump)).toBe(true);
    expect(adapter.created).toHaveLength(1);
  });

  it('shows the end screen with summed deaths and replays (AC-2)', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    adapter.deathsToAdd = 3;
    app.step(DT);

    adapter.callbacks?.onSequenceComplete?.();
    app.step(DT);
    expect(app.screen).toBe('end');
    expect(app.end?.totalDeaths).toBe(3);

    input.keyDown('Space');
    app.step(DT);
    input.keyUp('Space');
    expect(app.screen).toBe('playing');
    expect(app.save.levels).toEqual({});
    expect(adapter.created).toHaveLength(2);
  });

  it('replays from the end screen on an Enter confirm (AC-2)', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    adapter.callbacks?.onSequenceComplete?.();
    app.step(DT);
    expect(app.screen).toBe('end');

    input.keyDown('Enter');
    app.step(DT);
    input.keyUp('Enter');
    expect(app.screen).toBe('playing');
    expect(adapter.created).toHaveLength(2);
  });

  it('renders the title model with the title sprite (AC-1)', () => {
    const { app, ctx } = makeApp();
    app.render(0);
    expect(ctx.calls.some((c) => c.method === 'drawImage')).toBe(true);
    expect(textOf(ctx)).toContain('START');
    expect(textOf(ctx)).toContain('PRESS SPACE OR ENTER - OR CLICK');
  });

  it('renders the end model with the summed death count (AC-2)', () => {
    const { app, input, ctx, adapter } = makeApp();
    startPlaying(app, input);
    adapter.deathsToAdd = 4;
    app.step(DT);
    adapter.callbacks?.onSequenceComplete?.();
    app.step(DT);
    app.render(0);
    expect(textOf(ctx)).toContain('TOTAL DEATHS 4');
  });

  it('renders a pause overlay without clearing the frozen frame', () => {
    const { app, input, ctx, adapter } = makeApp();
    startPlaying(app, input);
    input.keyDown('KeyP');
    app.step(DT);
    const drawnBefore = adapter.rendered.length;
    app.render(0);
    expect(adapter.rendered.length).toBeGreaterThan(drawnBefore);
    expect(textOf(ctx)).toContain('PAUSED');
  });

  it('produces a readable boot error (AC-5)', () => {
    const { app, ctx } = makeApp();
    app.fail(new Error('atlas request failed with status 500'));
    expect(app.screen).toBe('boot-error');
    expect(app.bootMessage).toContain('500');
    app.render(0);
    expect(textOf(ctx)).toContain('BOOT ERROR');
    expect(textOf(ctx).some((t) => t.includes('500'))).toBe(true);
  });

  it('reports an empty campaign as a boot error (AC-5)', () => {
    const { app } = makeApp({ sources: [] });
    expect(app.screen).toBe('boot-error');
    expect(app.bootMessage).toContain('no levels available');
  });

  it('forwards effectsIntensity to the adapter create options', () => {
    const { app, input, adapter } = makeApp({ effectsIntensity: 0 });
    startPlaying(app, input);
    expect(adapter.created).toHaveLength(1);
    expect(adapter.created[0]!.effectsIntensity).toBe(0);
  });

  it('defaults effectsIntensity to undefined when unset', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    expect(adapter.created[0]!.effectsIntensity).toBeUndefined();
  });

  it('drives the loop through the injected ticker', () => {
    const manual = manualTicker();
    const input = createKeyboardInput();
    const adapter = new FakeAdapter();
    const app = createApp({
      sources: SOURCES,
      atlas: ATLAS,
      input,
      storage: createMemoryStorage(),
      blit: createMockCtx(),
      ticker: manual.ticker,
      adapter,
    });
    startPlaying(app, input);
    const before = adapter.stepped.length;

    app.start();
    manual.frame(0); // seed frame
    manual.frame(16.7);
    manual.frame(33.4);
    expect(adapter.stepped.length).toBeGreaterThan(before);

    app.stop();
    expect(manual.stopped()).toBe(true);
  });
});

describe('app shell attempt stats', () => {
  it('records one attempt when play begins at the first level', () => {
    const { app, input } = makeApp();
    startPlaying(app, input);
    app.step(DT);
    expect(app.save.levels[levelKey(0)]?.attemptCount).toBe(1);
  });

  it('records one attempt per level entry, not per step or respawn', () => {
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    app.step(DT);
    app.step(DT);
    app.step(DT);
    expect(app.save.levels[levelKey(0)]?.attemptCount).toBe(1);

    // A new absolute level index is a new entry and counts once.
    adapter.advanceToIndex = 1;
    app.step(DT);
    expect(app.save.levels[levelKey(1)]?.attemptCount).toBe(1);
    expect(app.save.levels[levelKey(0)]?.attemptCount).toBe(1);

    // Revisiting the same index across steps must not double-record.
    app.step(DT);
    app.step(DT);
    expect(app.save.levels[levelKey(1)]?.attemptCount).toBe(1);
  });

  it('persists attempts and feeds them into the aggregate stats', () => {
    const storage = createMemoryStorage();
    const { app, input, adapter } = makeApp({ storage });
    startPlaying(app, input);
    app.step(DT);
    adapter.advanceToIndex = 1;
    app.step(DT);

    expect(loadSave(storage).levels[levelKey(0)]?.attemptCount).toBe(1);
    expect(getAllStats(loadSave(storage)).totalAttempts).toBe(2);
  });

  it('resets the attempt ledger when a replay starts at the same index', () => {
    // Pins the lastAttemptedIndex reset in startCampaign: the end-screen
    // replay path calls startCampaign('new') on the SAME app instance, and
    // the replayed campaign starts at the same absolute index (0) the
    // finished one last attempted. Without the reset the ledger still holds
    // 0 from the previous campaign and the replay's first entry is skipped.
    const { app, input, adapter } = makeApp();
    startPlaying(app, input);
    app.step(DT);
    expect(app.save.levels[levelKey(0)]?.attemptCount).toBe(1);

    // Finish the campaign: the shell lands on the end screen.
    adapter.callbacks?.onLevelComplete?.(0);
    app.step(DT);
    adapter.callbacks?.onSequenceComplete?.();
    app.step(DT);
    expect(app.screen).toBe('end');

    // Replay from the end screen: same instance, same start index. The
    // transition step is drained (like the title transition), and the
    // replay clears the save (mode new), so the ledger restarts and the
    // first entry records a fresh 1 - not a skipped undefined.
    input.keyDown('Enter');
    app.step(DT);
    input.keyUp('Enter');
    expect(app.screen).toBe('playing');
    app.step(DT);
    expect(app.save.levels[levelKey(0)]?.attemptCount).toBe(1);
  });
});

describe('app shell finished campaign', () => {
  /** Play the two-fixture campaign to completion through the adapter callbacks. */
  function playToEnd(app: App, input: ReturnType<typeof createKeyboardInput>, adapter: FakeAdapter): void {
    startPlaying(app, input);
    adapter.deathsToAdd = 3;
    app.step(DT);
    for (let index = 0; index < SOURCES.length; index++) {
      adapter.callbacks?.onLevelComplete?.(index);
      app.step(DT);
    }
    adapter.callbacks?.onSequenceComplete?.();
    app.step(DT);
  }

  it('shows the end screen once every level is complete', () => {
    const { app, input, adapter } = makeApp();
    playToEnd(app, input, adapter);
    expect(app.screen).toBe('end');
    expect(app.end?.totalDeaths).toBe(3);
  });

  it('routes CONTINUE to the end screen when the final level is complete', () => {
    const storage = createMemoryStorage();
    const first = makeApp({ storage });
    playToEnd(first.app, first.input, first.adapter);
    expect(first.app.screen).toBe('end');

    const second = makeApp({ storage });
    expect(second.app.title.hasProgress).toBe(true);
    startPlaying(second.app, second.input);

    expect(second.app.screen).toBe('end');
    expect(second.app.end?.totalDeaths).toBe(sumDeaths(loadSave(storage)));
    expect(second.app.end?.totalDeaths).toBe(3);
    // No new game was created: CONTINUE went straight to the end screen.
    expect(second.adapter.created).toHaveLength(0);
  });

  it('still replays from the finished end screen with a new campaign', () => {
    const storage = createMemoryStorage();
    const first = makeApp({ storage });
    playToEnd(first.app, first.input, first.adapter);

    const second = makeApp({ storage });
    startPlaying(second.app, second.input);
    expect(second.app.screen).toBe('end');

    second.input.keyDown('Space');
    second.app.step(DT);
    second.input.keyUp('Space');
    expect(second.app.screen).toBe('playing');
    expect(second.app.save.levels).toEqual({});
    expect(second.adapter.created).toHaveLength(1);
  });
});

describe('app shell helpers', () => {
  it('sums deaths across every level', () => {
    const payload: SavePayload = {
      version: SAVE_SCHEMA_VERSION,
      levels: {
        [levelKey(0)]: {
          attemptCount: 1,
          deathCount: 2,
          deathPositions: [],
          completed: true,
          unlocked: true,
        },
        [levelKey(1)]: {
          attemptCount: 1,
          deathCount: 5,
          deathPositions: [],
          completed: false,
          unlocked: true,
        },
      },
      settings: { muted: false, reducedMotion: false },
      currentPosition: 1,
    };
    expect(sumDeaths(payload)).toBe(7);
  });

  it('formats a boot error from a non-Error value', () => {
    expect(formatBootError('disk on fire')).toBe('Pitfall could not start. disk on fire');
  });
});
