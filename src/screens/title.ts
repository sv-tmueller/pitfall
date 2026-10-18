// Title screen state and render model builder.
// Pure data: produces a RenderModel, never draws directly.

import type { InputSnapshot } from '../engine/input';
import type { PaletteToken } from '../render/palette';
import type { AtlasFrameName } from '../render/atlas';
import type { DrawSprite, DrawText, FillRect, RenderModel } from '../render/model';

export type TitleTransition = 'start' | 'continue' | 'new-game' | 'how-to-play';

export interface TitleState {
  readonly showInstructions: boolean;
  readonly selectedOption: number;
  readonly flashTimer: number;
  /**
   * Whether saved progress exists. When true the option list grows to
   * continue / new game / how to play; when false it stays as
   * start / how to play.
   */
  readonly hasProgress: boolean;
}

export interface TitleOptions {
  readonly hasProgress?: boolean;
}

export function createTitleState(options: TitleOptions = {}): TitleState {
  return {
    showInstructions: false,
    selectedOption: 0,
    flashTimer: 0,
    hasProgress: options.hasProgress === true,
  };
}

/** Number of selectable options for the current state. */
export function titleOptionCount(state: TitleState): number {
  return state.hasProgress ? 3 : 2;
}

/** Index of the how-to-play option: always the last entry. */
function howToPlayIndex(state: TitleState): number {
  return titleOptionCount(state) - 1;
}

export function stepTitle(state: TitleState, input: InputSnapshot, dt: number): TitleState {
  void dt;
  const count = titleOptionCount(state);
  let { selectedOption } = state;

  if (input.pressed.right) {
    selectedOption = (selectedOption + 1) % count;
  }
  if (input.pressed.left) {
    selectedOption = (selectedOption - 1 + count) % count;
  }

  // Instructions are shown whenever how-to-play is the highlighted option,
  // so the jump key is not handled twice (once here, once in the transition).
  const showInstructions = selectedOption === howToPlayIndex(state);

  const flashTimer = (state.flashTimer + 1) % 60;

  return { ...state, showInstructions, selectedOption, flashTimer };
}

export function getTitleTransition(
  state: TitleState,
  input: InputSnapshot,
): TitleTransition | null {
  if (!input.pressed.jump) return null;
  if (state.selectedOption === 0) {
    return state.hasProgress ? 'continue' : 'start';
  }
  if (state.selectedOption === howToPlayIndex(state)) {
    return 'how-to-play';
  }
  return 'new-game';
}

export function buildTitleModel(state: TitleState): RenderModel {
  const sprites: DrawSprite[] = [];
  const rects: FillRect[] = [];
  const texts: DrawText[] = [];

  sprites.push({
    frame: 'title.mark' as AtlasFrameName,
    dstX: 152,
    dstY: 40,
    flipX: false,
  });

  if (state.flashTimer < 30) {
    rects.push({ x: 100, y: 100, w: 120, h: 8, color: 'bone' as PaletteToken });
  }

  const startY = 120;
  rects.push({
    x: 90,
    y: startY + state.selectedOption * 16,
    w: 4,
    h: 8,
    color: 'bone' as PaletteToken,
  });

  const labels = state.hasProgress
    ? ['CONTINUE', 'NEW GAME', 'HOW TO PLAY']
    : ['START', 'HOW TO PLAY'];
  for (let i = 0; i < labels.length; i++) {
    texts.push({
      text: labels[i] ?? '',
      x: 100,
      y: startY + i * 16,
      color: (i === state.selectedOption ? 'bone' : 'edge') as PaletteToken,
    });
  }

  if (state.showInstructions) {
    rects.push({ x: 60, y: 140, w: 200, h: 2, color: 'edge' as PaletteToken });
  }

  return {
    clear: 'void',
    layers: [
      { kind: 'world', sprites, rects, texts },
      { kind: 'entities', sprites: [], rects: [], texts: [] },
      { kind: 'effects', sprites: [], rects: [], texts: [] },
    ],
  };
}
