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
    'confirm',
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
    Enter: 'confirm',
    NumpadEnter: 'confirm',
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
        confirm: false,
      }),
      pressed: Object.freeze({
        left: false,
        right: false,
        jump: true,
        restart: false,
        pause: false,
        confirm: false,
      }),
      released: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: false,
        pause: false,
        confirm: false,
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
        confirm: false,
      }),
      pressed: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: true,
        pause: false,
        confirm: false,
      }),
      released: Object.freeze({
        left: false,
        right: false,
        jump: false,
        restart: false,
        pause: false,
        confirm: false,
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

describe('interpolation snap on discontinuous relocations', () => {
  it('snaps prevBody on respawn after death', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    // Walk away from spawn first so the respawn is a real relocation.
    input.keyDown('ArrowRight');
    let walked: GameState = game;
    for (let i = 0; i < 60; i++) {
      walked = stepGame(walked, DT);
    }
    input.keyUp('ArrowRight');
    expect(walked.scene.controller.body.x).toBeGreaterThan(
      game.scene.controller.body.x + 32,
    );

    // Kill via R-restart (drives playing -> dying), then run out the freeze.
    input.keyDown('KeyR');
    let state: GameState = stepGame(walked, DT);
    input.keyUp('KeyR');
    expect(state.scene.phase).toBe('dying');

    while (state.scene.phase === 'dying') {
      state = stepGame(state, DT);
    }

    // Respawn relocated the body back to spawn; prevBody must coincide
    // with the new body (no stale cross-map interpolation).
    expect(state.scene.phase).toBe('playing');
    expect(state.prevBody.x).toBe(state.scene.controller.body.x);
    expect(state.prevBody.y).toBe(state.scene.controller.body.y);
  });

  it('snaps prevBody on level advance', () => {
    const input = createFakeInput();

    // Second level spawns the player elsewhere so the advance is a jump.
    const levelB: Record<string, unknown> = JSON.parse(
      JSON.stringify(FIXTURE_SOURCES['corridor']),
    ) as Record<string, unknown>;
    (levelB as { spawn: { col: number; row: number } }).spawn = {
      col: 10,
      row: 3,
    };

    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor'], levelB], atlas: ATLAS },
      input,
    );

    // Walk to the exit at col 17 and run out the enter beat.
    input.keyDown('ArrowRight');
    let state: GameState = game;
    for (let i = 0; i < 600 && state.scene.phase === 'playing'; i++) {
      state = stepGame(state, DT);
    }
    input.keyUp('ArrowRight');
    expect(state.scene.phase).toBe('entering');

    while (state.scene.phase === 'entering') {
      state = stepGame(state, DT);
    }

    // Advance relocated the body to level B's spawn; prevBody snapped.
    expect(state.scene.sequence.index).toBe(1);
    expect(state.prevBody.x).toBe(state.scene.controller.body.x);
    expect(state.prevBody.y).toBe(state.scene.controller.body.y);
  });

  it('snaps prevBody on teleporter relocation', () => {
    const input = createFakeInput();

    // Tiny level with a teleporter pair: pad at (80,144) warps to (240,80).
    const teleLevel = {
      name: 'tele-snap',
      cols: 20,
      rows: 12,
      spawn: { col: 2, row: 9 },
      exit: { col: 18, row: 9 },
      tiles: [
        '11111111111111111111',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '10000000000000000001',
        '11111111111111111111',
        '11111111111111111111',
      ],
      traps: [],
      mechanics: [
        {
          id: 'tp-a',
          type: 'teleporter',
          params: {
            x: 80,
            y: 144,
            destX: 240,
            destY: 80,
            oneWay: false,
            preserveMomentum: false,
          },
        },
        {
          id: 'tp-b',
          type: 'teleporter',
          params: {
            x: 240,
            y: 80,
            destX: 80,
            destY: 144,
            oneWay: false,
            preserveMomentum: false,
          },
        },
      ],
    };

    const game = createGame({ sources: [teleLevel], atlas: ATLAS }, input);

    // Walk right until the body jumps to the destination column.
    input.keyDown('ArrowRight');
    let state: GameState = game;
    let warped = false;
    for (let i = 0; i < 600 && !warped; i++) {
      state = stepGame(state, DT);
      warped = state.scene.controller.body.x >= 240;
    }
    input.keyUp('ArrowRight');

    expect(warped).toBe(true);
    // The warp exceeded SNAP_DISTANCE in one step; prevBody must equal the
    // post-teleport body, not the pre-teleport position.
    expect(state.prevBody.x).toBe(state.scene.controller.body.x);
    expect(state.prevBody.y).toBe(state.scene.controller.body.y);
  });

  it('keeps prevBody for ordinary sub-SNAP_DISTANCE movement', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    const bodyBefore = game.scene.controller.body;
    input.keyDown('ArrowRight');
    const state = stepGame(game, DT);
    input.keyUp('ArrowRight');

    // Continuous movement: prevBody preserved (equals the pre-step body).
    expect(state.prevBody.x).toBe(bodyBefore.x);
    expect(state.prevBody.y).toBe(bodyBefore.y);
    expect(state.scene.controller.body.x).toBeGreaterThan(bodyBefore.x);
  });
});

describe('renderGame camera from interpolated body', () => {
  it('feeds the interpolated center to the camera (sprite and camera agree)', () => {
    const input = createFakeInput();

    // Wide level (40 cols) so the camera pans and rounding is observable.
    const wideRows = Array.from({ length: 12 }, (_, r) =>
      r === 0 || r >= 10 ? '1'.repeat(40) : `1${'0'.repeat(38)}1`,
    );
    const wideLevel = {
      name: 'wide-cam',
      cols: 40,
      rows: 12,
      spawn: { col: 2, row: 9 },
      exit: { col: 38, row: 9 },
      tiles: wideRows,
      traps: [],
    };

    const game = createGame({ sources: [wideLevel], atlas: ATLAS }, input);

    // Walk right for a stretch so the camera is off the clamp and prev !=
    // curr on the final step.
    input.keyDown('ArrowRight');
    let state: GameState = game;
    for (let i = 0; i < 120; i++) {
      state = stepGame(state, DT);
    }
    input.keyUp('ArrowRight');

    const body = state.scene.controller.body;
    const prev = state.prevBody;
    expect(prev.x).toBeLessThan(body.x);

    const ctx = mockBlitContext();
    renderGame(state, ctx, 0.5);

    // Expected camera x from the INTERPOLATED center (alpha = 0.5),
    // rounded. Width 16 -> center = pos.x + 8.
    const interpX = prev.x + (body.x - prev.x) * 0.5;
    const expectedCamX = Math.round(Math.max(0, interpX + 8 - 160));

    // Leftmost visible tile sprite: startCol = floor(camX / 16), so its
    // screen x is startCol * 16 - camX.
    const draws = ctx.calls.filter((c) => c.method === 'drawImage');
    expect(draws.length).toBeGreaterThan(0);
    const minX = Math.min(...draws.map((d) => d.args[5] as number));
    const startCol = Math.floor(expectedCamX / 16);
    expect(minX).toBe(startCol * 16 - expectedCamX);
  });
});

describe('effects wiring', () => {
  it('fires death effects on any transition into dying (R-restart included)', () => {
    const input = createFakeInput();
    const game = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    input.keyDown('KeyR');
    const state = stepGame(game, DT);
    input.keyUp('KeyR');

    expect(state.scene.phase).toBe('dying');
    expect(state.effects.particles.particles.length).toBeGreaterThan(0);
    expect(state.effects.shake.magnitude).toBeGreaterThan(0);
    expect(state.effects.hitStop.active).toBe(true);
  });

  it('freezes the sim during hit-stop and unfreezes after it expires', () => {
    const input = createFakeInput();
    let state: GameState = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    input.keyDown('KeyR');
    state = stepGame(state, DT);
    input.keyUp('KeyR');
    expect(state.effects.hitStop.active).toBe(true);

    // Frozen steps: the scene must not advance (timer, phase, body frozen).
    const frozenScene = state.scene;
    let frozenSteps = 0;
    while (state.effects.hitStop.active) {
      state = stepGame(state, DT);
      frozenSteps++;
      expect(state.scene.timer).toBe(frozenScene.timer);
      expect(state.scene.step).toBe(frozenScene.step);
      expect(state.scene.controller.body.x).toBe(frozenScene.controller.body.x);
    }
    // triggerHitStop(3) at intensity 1, but the arming death step already
    // ran stepEffects (3 -> 2), so exactly 2 fully-frozen steps remain.
    expect(frozenSteps).toBe(2);

    // Freeze expired: the next step advances the scene normally. The body
    // is mid-death-freeze, so the observable advance is the dying-phase
    // timer ticking down again.
    state = stepGame(state, DT);
    expect(state.scene.timer).toBe(frozenScene.timer - 1);
  });

  it('consumes the primed input snapshot during a hit-stop freeze', () => {
    const input = createFakeInput();
    let state: GameState = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    // Die once to arm the freeze.
    input.keyDown('KeyR');
    state = stepGame(state, DT);
    input.keyUp('KeyR');
    expect(state.effects.hitStop.active).toBe(true);

    // A jump pressed during the freeze is sampled (and thereby drained) by
    // the frozen step even though no scene step runs: dropping the primed
    // snapshot for that step is correct for a freeze.
    input.keyDown('Space');
    state = stepGame(state, DT);
    expect(state.effects.hitStop.active).toBe(true);
    expect(input.sample().pressed.jump).toBe(false);
    input.keyUp('Space');
  });

  it('fires landing effects when the body transitions airborne to grounded', () => {
    const input = createFakeInput();
    let state: GameState = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    // Settle on the ground and let the initial spawn-drop dust die out.
    // (The spawn fall is itself an airborne -> grounded transition and
    // legitimately fires one landing burst.)
    for (let i = 0; i < 60; i++) state = stepGame(state, DT);
    expect(state.scene.controller.body.grounded).toBe(true);
    expect(state.effects.particles.particles).toHaveLength(0);

    // Jump, then fall back to the ground.
    input.keyDown('Space');
    state = stepGame(state, DT);
    input.keyUp('Space');
    expect(state.scene.controller.body.grounded).toBe(false);

    let landed = false;
    for (let i = 0; i < 60 && !landed; i++) {
      state = stepGame(state, DT);
      landed = state.scene.controller.body.grounded;
    }
    expect(landed).toBe(true);
    // onLand spawned dust particles at the feet.
    expect(state.effects.particles.particles.length).toBeGreaterThan(0);
  });

  it('reduced-motion intensity (0) produces zero-length effects everywhere', () => {
    const input = createFakeInput();
    let state: GameState = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS, effectsIntensity: 0 },
      input,
    );

    input.keyDown('KeyR');
    state = stepGame(state, DT);
    input.keyUp('KeyR');

    expect(state.scene.phase).toBe('dying');
    expect(state.effects.particles.particles).toHaveLength(0);
    expect(state.effects.shake.magnitude).toBe(0);
    expect(state.effects.shake.offsetX).toBe(0);
    expect(state.effects.shake.offsetY).toBe(0);
    expect(state.effects.hitStop.active).toBe(false);

    // Rendering with zero effects: the effects layer stays empty and the
    // shake offset leaves the camera untouched.
    const ctx = mockBlitContext();
    expect(() => renderGame(state, ctx, 0.5)).not.toThrow();
    expect(state.effects.particles.particles).toHaveLength(0);
  });

  it('passes live particles and shake offsets into the render frame', () => {
    const input = createFakeInput();
    let state: GameState = createGame(
      { sources: [FIXTURE_SOURCES['corridor']], atlas: ATLAS },
      input,
    );

    input.keyDown('KeyR');
    state = stepGame(state, DT);
    input.keyUp('KeyR');
    expect(state.effects.particles.particles.length).toBeGreaterThan(0);

    const ctx = mockBlitContext();
    renderGame(state, ctx, 0.5);

    // Particle fill-rects reached the canvas: at least the clear rect plus
    // the death-burst rects are present.
    const fills = ctx.calls.filter((c) => c.method === 'fillRect');
    expect(fills.length).toBeGreaterThan(1);
  });
});
