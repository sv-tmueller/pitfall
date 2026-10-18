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
  readonly created: { sources: readonly LevelSource[] }[] = [];
  readonly stepped: InputSnapshot[] = [];
  readonly rendered: number[] = [];
  callbacks: SceneCallbacks | null = null;
  deathsToAdd = 0;

  create(
    opts: { readonly sources: readonly LevelSource[]; readonly atlas: LoadedAtlas },
    input: Parameters<GameAdapter['create']>[1],
    callbacks?: SceneCallbacks,
  ): GameState {
    this.created.push({ sources: opts.sources });
    this.callbacks = callbacks ?? null;
    return createGame({ sources: opts.sources, atlas: opts.atlas }, input, callbacks);
  }

  step(state: GameState, dt: number): GameState {
    void dt;
    this.stepped.push(state.input.sample());
    if (this.deathsToAdd > 0) {
      const add = this.deathsToAdd;
      this.deathsToAdd = 0;
      const scene = state.scene;
      return {
        ...state,
        scene: {
          ...scene,
          deathsThisLevel: scene.deathsThisLevel + add,
          deathsTotal: scene.deathsTotal + add,
        },
      };
    }
    return state;
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

  it('renders the title model with the title sprite (AC-1)', () => {
    const { app, ctx } = makeApp();
    app.render(0);
    expect(ctx.calls.some((c) => c.method === 'drawImage')).toBe(true);
    expect(textOf(ctx)).toContain('START');
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
