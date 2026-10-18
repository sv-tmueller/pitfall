// Application shell: the composition root's state machine. It sits between
// main.ts and the existing game modules and owns screen routing, pause and
// focus policy, input consumption, and save persistence. The game is observed
// imperatively: the shell polls scene counters and listens to the existing
// SceneCallbacks. Nothing in src/game/scene.ts or src/game/integration.ts is
// modified.

import type { InputSnapshot, KeyboardInput } from '../engine/input';
import { createLoop, type Ticker } from '../engine/loop';
import type { LoadedAtlas } from '../render/atlas-loader';
import { flushModel, type BlitContext } from '../render/batcher';
import { PALETTE } from '../render/palette';
import type { FillRect, RenderModel } from '../render/model';
import {
  buildTitleModel,
  createTitleState,
  getTitleTransition,
  stepTitle,
  type TitleState,
} from '../screens/title';
import { buildEndModel, createEndState, getEndTransition, stepEnd, type EndState } from '../screens/end';
import { createGame, renderGame, stepGame, type GameState } from './integration';
import type { SceneCallbacks } from './scene';
import type { LevelSource } from './sequence';
import {
  completeLevel,
  getCurrentPosition,
  getDefaultSettings,
  loadSave,
  recordDeath,
  saveSave,
  setCurrentPosition,
} from '../save/repository';
import { SAVE_SCHEMA_VERSION, type SavePayload } from '../save/schema';
import type { SaveStorage } from '../save/storage';

export type AppScreen = 'boot-error' | 'title' | 'playing' | 'end';

/**
 * The shell's view of the game layer. Defaults to the real integration
 * functions; tests substitute a structural fake so scene counters and
 * callbacks can be driven deterministically.
 *
 * `step` takes only the state because the shell feeds the game a primed input
 * whose single `sample()` call returns the snapshot the shell already took
 * this step. That keeps exactly one real key-poll per simulation step.
 */
export interface GameAdapter {
  create(
    opts: { readonly sources: readonly LevelSource[]; readonly atlas: LoadedAtlas },
    input: KeyboardInput,
    callbacks?: SceneCallbacks,
  ): GameState;
  step(state: GameState, dt: number): GameState;
  render(state: GameState, ctx: BlitContext, alpha: number): void;
}

export const defaultGameAdapter: GameAdapter = {
  create: (opts, input, callbacks) => createGame(opts, input, callbacks),
  step: (state, dt) => stepGame(state, dt),
  render: (state, ctx, alpha) => renderGame(state, ctx, alpha),
};

/** KeyboardInput whose first sample() returns a snapshot supplied by the shell. */
export interface ShellInput extends KeyboardInput {
  prime(snapshot: InputSnapshot): void;
}

export function createShellInput(inner: KeyboardInput): ShellInput {
  let pending: InputSnapshot | null = null;
  return {
    keyDown: (code) => inner.keyDown(code),
    keyUp: (code) => inner.keyUp(code),
    blur: () => inner.blur(),
    isBound: (code) => inner.isBound(code),
    prime: (snapshot) => {
      pending = snapshot;
    },
    sample: () => {
      if (pending !== null) {
        const snapshot = pending;
        pending = null;
        return snapshot;
      }
      return inner.sample();
    },
  };
}

export interface AppOptions {
  readonly sources: readonly LevelSource[];
  readonly atlas: LoadedAtlas;
  readonly input: KeyboardInput;
  readonly storage: SaveStorage;
  readonly blit: BlitContext;
  readonly ticker: Ticker;
  readonly adapter?: GameAdapter;
  readonly onScreenChange?: (screen: AppScreen) => void;
  /** Presentation hook: called after each render so the host can blit. */
  readonly present?: () => void;
}

export interface App {
  readonly screen: AppScreen;
  readonly paused: boolean;
  readonly save: SavePayload;
  readonly title: TitleState;
  readonly end: EndState | null;
  readonly totalDeaths: number;
  readonly bootMessage: string | null;
  start(): void;
  stop(): void;
  step(dt: number): void;
  render(alpha: number): void;
  handleBlur(): void;
  handleVisibilityChange(hidden: boolean): void;
  fail(error: unknown): void;
}

/** Sum of every level's deathCount in the payload. */
export function sumDeaths(payload: SavePayload): number {
  let total = 0;
  for (const level of Object.values(payload.levels)) {
    total += level.deathCount;
  }
  return total;
}

/** True when the player has anything worth continuing from. */
export function hasProgress(payload: SavePayload): boolean {
  return getCurrentPosition(payload) > 0 || Object.keys(payload.levels).length > 0;
}

/** Readable one-line boot failure message for the DOM fallback. */
export function formatBootError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Pitfall could not start. ${detail}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  const floored = Math.floor(index);
  if (!Number.isFinite(floored)) return 0;
  return Math.min(Math.max(floored, 0), length - 1);
}

/** Stable save key for a level, derived from its absolute sequence index. */
export function levelKey(absoluteIndex: number): string {
  return `level-${absoluteIndex}`;
}

/** Fresh, empty payload. New game clears progress to exactly this. */
export function clearSave(storage: SaveStorage): SavePayload {
  const fresh: SavePayload = {
    version: SAVE_SCHEMA_VERSION,
    levels: {},
    settings: getDefaultSettings(),
    currentPosition: 0,
  };
  saveSave(storage, fresh);
  return fresh;
}

/** Full-screen overlay drawn on top of the frozen game frame while paused. */
export function buildPauseOverlay(): RenderModel {
  const rects: FillRect[] = [
    { x: 96, y: 76, w: 128, h: 28, color: 'night' },
  ];
  return {
    clear: 'void',
    layers: [
      { kind: 'hud', sprites: [], rects, texts: [
        { text: 'PAUSED', x: 128, y: 88, color: 'bone' },
      ] },
    ],
  };
}

/** Render model for the boot-error screen. */
export function buildBootErrorModel(message: string): RenderModel {
  return {
    clear: 'void',
    layers: [
      { kind: 'hud', sprites: [], rects: [], texts: [
        { text: 'BOOT ERROR', x: 8, y: 60, color: 'lethal' },
        { text: message, x: 8, y: 76, color: 'bone' },
      ] },
    ],
  };
}

/** Blit a model on top of the current frame without clearing it first. */
function blitOverlay(ctx: BlitContext, model: RenderModel): void {
  for (const layer of model.layers) {
    for (const rect of layer.rects) {
      ctx.fillStyle = PALETTE[rect.color];
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    for (const text of layer.texts) {
      ctx.fillStyle = PALETTE[text.color];
      ctx.fillText(text.text, text.x, text.y);
    }
  }
}

export function createApp(options: AppOptions): App {
  const { sources, atlas, input, storage, blit, ticker } = options;
  const adapter = options.adapter ?? defaultGameAdapter;
  const onScreenChange = options.onScreenChange;
  const present = options.present;

  let save = loadSave(storage);
  let screen: AppScreen = 'title';
  let paused = false;
  let titleState = createTitleState({ hasProgress: hasProgress(save) });
  let endState: EndState | null = null;
  let game: GameState | null = null;
  let shellInput: ShellInput | null = null;
  let offset = clampIndex(getCurrentPosition(save), sources.length);
  let lastDeathsThisLevel = 0;
  let lastAbsIndex = offset;
  let bootMessage: string | null = null;

  if (sources.length === 0) {
    bootMessage = formatBootError(new Error('no levels available'));
    screen = 'boot-error';
  }

  function setScreen(next: AppScreen): void {
    if (next === screen) return;
    screen = next;
    onScreenChange?.(next);
  }

  function fail(error: unknown): void {
    bootMessage = formatBootError(error);
    paused = false;
    setScreen('boot-error');
  }

  function persist(): void {
    saveSave(storage, save);
  }

  function startCampaign(mode: 'continue' | 'new'): void {
    try {
      if (mode === 'new') {
        save = clearSave(storage);
        offset = 0;
      } else {
        offset = clampIndex(getCurrentPosition(save), sources.length);
      }
      const resumeSources = sources.slice(offset);
      shellInput = createShellInput(input);
      game = adapter.create({ sources: resumeSources, atlas }, shellInput, {
        onLevelComplete: (relativeIndex) => handleLevelComplete(relativeIndex),
        onSequenceComplete: () => handleSequenceComplete(),
      });
      lastDeathsThisLevel = 0;
      lastAbsIndex = offset;
      paused = false;
      setScreen('playing');
    } catch (error) {
      fail(error);
    }
  }

  function handleLevelComplete(relativeIndex: number): void {
    const absoluteIndex = offset + relativeIndex;
    const nextAbsolute = absoluteIndex + 1;
    const nextId = nextAbsolute < sources.length ? levelKey(nextAbsolute) : undefined;
    save = completeLevel(save, levelKey(absoluteIndex), nextId);
    save = setCurrentPosition(save, clampIndex(nextAbsolute, sources.length));
    persist();
  }

  function handleSequenceComplete(): void {
    endState = createEndState(sumDeaths(save));
    paused = false;
    setScreen('end');
  }

  function syncProgress(): void {
    if (game === null) return;
    const scene = game.scene;
    const absoluteIndex = offset + scene.sequence.index;

    if (absoluteIndex !== lastAbsIndex) {
      lastAbsIndex = absoluteIndex;
      lastDeathsThisLevel = 0;
    }

    if (scene.deathsThisLevel > lastDeathsThisLevel) {
      const delta = scene.deathsThisLevel - lastDeathsThisLevel;
      lastDeathsThisLevel = scene.deathsThisLevel;
      const body = scene.controller.body;
      for (let i = 0; i < delta; i++) {
        save = recordDeath(save, levelKey(absoluteIndex), { x: body.x, y: body.y });
      }
      persist();
    }
  }

  function step(dt: number): void {
    if (screen === 'boot-error') return;
    const snapshot = input.sample();

    if (screen === 'title') {
      titleState = stepTitle(titleState, snapshot, dt);
      const transition = getTitleTransition(titleState, snapshot);
      if (transition === null || transition === 'how-to-play') return;
      // A screen transition drains the triggering step: the confirm jump must
      // not also reach the game on the frame play begins.
      startCampaign(transition === 'continue' ? 'continue' : 'new');
      return;
    }

    if (screen === 'end') {
      if (endState !== null) endState = stepEnd(endState, snapshot, dt);
      if (endState !== null && getEndTransition(endState, snapshot) === 'replay') {
        startCampaign('new');
      }
      return;
    }

    // playing
    if (snapshot.pressed.pause) {
      paused = !paused;
      // Drain this step so the unpause keypress cannot also act in the game.
      return;
    }
    if (paused || game === null || shellInput === null) return;

    shellInput.prime(snapshot);
    game = adapter.step(game, dt);
    syncProgress();
  }

  function render(alpha: number): void {
    if (screen === 'title') {
      flushModel(blit, buildTitleModel(titleState), atlas);
    } else if (screen === 'end') {
      flushModel(blit, buildEndModel(endState ?? createEndState(0)), atlas);
    } else if (screen === 'playing') {
      if (game !== null) adapter.render(game, blit, alpha);
      if (paused) blitOverlay(blit, buildPauseOverlay());
    } else {
      flushModel(blit, buildBootErrorModel(bootMessage ?? ''), atlas);
    }
    present?.();
  }

  const loop = createLoop(
    { step: (dt) => step(dt), render: (alpha) => render(alpha) },
    ticker,
  );

  function pauseForFocusLoss(): void {
    if (screen === 'playing') {
      paused = true;
    }
  }

  return {
    get screen() {
      return screen;
    },
    get paused() {
      return paused;
    },
    get save() {
      return save;
    },
    get title() {
      return titleState;
    },
    get end() {
      return endState;
    },
    get totalDeaths() {
      return sumDeaths(save);
    },
    get bootMessage() {
      return bootMessage;
    },
    start: () => loop.start(),
    stop: () => loop.stop(),
    step,
    render,
    handleBlur: () => {
      input.blur();
      pauseForFocusLoss();
    },
    handleVisibilityChange: (hidden: boolean) => {
      if (!hidden) return;
      input.blur();
      pauseForFocusLoss();
    },
    fail,
  };
}
