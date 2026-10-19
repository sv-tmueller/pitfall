import { describe, expect, it } from 'vitest';
import atlasManifest from '../../assets/atlas.json';
import type { AtlasManifest } from '../render/atlas';
import type { BitmapLike } from '../render/atlas-loader';
import { loadAtlas } from '../render/atlas-loader';
import type { BlitContext } from '../render/batcher';
import type { KeyboardInput, InputSnapshot } from '../engine/input';
import { FIXTURE_SOURCES } from '../levels/fixtures';
import {
  createGame,
  inputSnapshotToActions,
  inputSnapshotToSceneActions,
  stepGame,
  renderGame,
  type GameState,
} from './integration';

const DT = 1 / 60;

const MANIFEST = atlasManifest as unknown as AtlasManifest;
const BITMAP: BitmapLike = { width: 128, height: 40 };
const ATLAS = loadAtlas(MANIFEST, BITMAP);

/**
 * Fake KeyboardInput that wraps a real createKeyboardInput instance but
 * allows tests to simulate key presses without a DOM.
 */
function createFakeInput(): KeyboardInput {
  // Inline a minimal implementation matching KeyboardInput, avoiding DOM.
  const held: Record<string, boolean> = {};
  const pressedEdges: Record<string, boolean> = {};

  const ACTION_KEYS = [
    'left',
    'right',
    'jump',
    'restart',
    'pause',
  ] as const;

  // Reverse-map codes to actions matching DEFAULT_BINDINGS.
  const CODE_TO_ACTION: Record<string, (typeof ACTION_KEYS)[number]> = {
    ArrowLeft: 'left',
    KeyA: 'left',
    ArrowRight: 'right',
    KeyD: 'right',
    Space: 'jump',
    ArrowUp: 'jump',
    KeyR: 'restart',
    KeyP: 'pause',
    Escape: 'pause',
  };

  function emptyRecord(): Record<(typeof ACTION_KEYS)[number], boolean> {
    const rec = {} as Record<(typeof ACTION_KEYS)[number], boolean>;
    for (const a of ACTION_KEYS) rec[a] = false;
    return rec;
  }

  return {
    keyDown(code: string): void {
      if (held[code]) return;
      held[code] = true;
      const action = CODE_TO_ACTION[code];
      if (action !== undefined) pressedEdges[action] = true;
    },
    keyUp(code: string): void {
      delete held[code];
    },
    blur(): void {
      for (const k of Object.keys(held)) delete held[k];
    },
    isBound(code: string): boolean {
      return code in CODE_TO_ACTION;
    },
    sample(): InputSnapshot {
      const heldRec = emptyRecord();
      const pressedRec = emptyRecord();
      const releasedRec = emptyRecord();

      for (const [code, action] of Object.entries(CODE_TO_ACTION)) {
        if (held[code]) {
          heldRec[action] = true;
        }
      }
      for (const action of ACTION_KEYS) {
        if (pressedEdges[action]) {
          pressedRec[action] = true;
          pressedEdges[action] = false;
        }
      }

      return Object.freeze({
        held: Object.freeze({ ...heldRec }),
        pressed: Object.freeze({ ...pressedRec }),
        released: Object.freeze({ ...releasedRec }),
      });
    },
  };
}

function mockBlitContext(): BlitContext & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
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
}

describe('inputSnapshotToActions', () => {
  it('maps held left/right and jump edges to ControllerActions', () => {
    const snap: InputSnapshot = {
      held: Object.freeze({
        left: true,
        right: false,
        jump: true,
        restart: false,
        pause: false,
      }),
      pressed: Object.freeze({
        left: false,
        right: false,
        jump: true,
        restart: false,
        pause: false,
      }),
      released: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: false,
        pause: false,
      }),
    };

    const actions = inputSnapshotToActions(snap);
    expect(actions.left).toBe(true);
    expect(actions.right).toBe(false);
    expect(actions.jumpPressed).toBe(true);
    expect(actions.jumpHeld).toBe(true);
  });
});

describe('inputSnapshotToSceneActions', () => {
  it('adds restart from pressed edges', () => {
    const snap: InputSnapshot = {
      held: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: false,
        pause: false,
      }),
      pressed: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: true,
        pause: false,
      }),
      released: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: false,
        pause: false,
      }),
    };

    const actions = inputSnapshotToSceneActions(snap);
    expect(actions.restart).toBe(true);
    expect(actions.left).toBe(false);
    expect(actions.right).toBe(false);
    expect(actions.jumpPressed).toBe(false);
    expect(actions.jumpHeld).toBe(false);
  });
});

describe('createGame', () => {
  it('initializes with scene, atlas, input, animTrack, and prevBody', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    expect(game.scene).toBeDefined();
    expect(game.atlas).toBe(ATLAS);
    expect(game.input).toBe(input);
    expect(game.animTrack.state).toBe('idle');
    expect(game.animTrack.frameIndex).toBe(0);
    expect(game.animTrack.facing).toBe(1);
    expect(game.prevBody).toBeDefined();
  });

  it('stores prevBody equal to the initial controller body', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );
    expect(game.prevBody).toEqual(game.scene.controller.body);
  });
});

describe('walk right on corridor', () => {
  it('moves the player body rightward over 60 steps', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    const startX = game.scene.controller.body.x;

    input.keyDown('ArrowRight');

    let state: GameState = game;
    let grounded = false;
    for (let i = 0; i < 60; i++) {
      state = stepGame(state, DT);
      if (state.scene.controller.body.grounded) grounded = true;
    }

    expect(state.scene.controller.body.x).toBeGreaterThan(startX);
    expect(grounded).toBe(true);
  });
});

describe('jump', () => {
  it('produces upward velocity when jump is pressed', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    // Let the player settle on the ground first.
    let state: GameState = game;
    for (let i = 0; i < 10; i++) {
      state = stepGame(state, DT);
    }

    // Press jump for one step.
    input.keyDown('Space');
    state = stepGame(state, DT);

    expect(state.scene.controller.body.velocity.y).toBeLessThan(0);

    // Release.
    input.keyUp('Space');
  });
});

describe('animation state changes', () => {
  it('transitions to run when walking right', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    input.keyDown('ArrowRight');

    let state: GameState = game;
    for (let i = 0; i < 30; i++) {
      state = stepGame(state, DT);
    }

    expect(state.animTrack.state).toBe('run');
  });

  it('stays idle when standing still', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    let state: GameState = game;
    for (let i = 0; i < 10; i++) {
      state = stepGame(state, DT);
    }

    expect(state.animTrack.state).toBe('idle');
  });
});

describe('renderGame', () => {
  it('does not throw and produces drawImage calls with a mock BlitContext', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    // Step a few times so the player settles.
    let state: GameState = game;
    for (let i = 0; i < 10; i++) {
      state = stepGame(state, DT);
    }

    const ctx = mockBlitContext();

    expect(() => renderGame(state, ctx, 0.5)).not.toThrow();

    const draws = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(draws.length).toBeGreaterThan(0);
  });

  it('captures prevBody before stepping for interpolation', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    const bodyBeforeStep = game.scene.controller.body;
    input.keyDown('ArrowRight');

    const state = stepGame(game, DT);

    // prevBody should be the body from BEFORE the step.
    expect(state.prevBody).toEqual(bodyBeforeStep);
    // And the current body should have moved.
    expect(state.scene.controller.body).not.toEqual(state.prevBody);
  });
});
