// End screen state and render model builder.
// Pure data: produces a RenderModel, never draws directly.

import type { InputSnapshot } from '../engine/input';
import type { PaletteToken } from '../render/palette';
import type { DrawText, FillRect, RenderModel } from '../render/model';

export interface EndState {
  /** Total deaths across the whole campaign, summed from the save payload. */
  readonly totalDeaths: number;
  readonly flashTimer: number;
}

export function createEndState(totalDeaths: number): EndState {
  return { totalDeaths: Math.max(0, Math.floor(totalDeaths)), flashTimer: 0 };
}

export function stepEnd(state: EndState, input: InputSnapshot, dt: number): EndState {
  void input;
  void dt;
  return { ...state, flashTimer: (state.flashTimer + 1) % 60 };
}

/** Rising-edge confirm on the end screen: jump restarts the campaign. */
export function getEndTransition(state: EndState, input: InputSnapshot): 'replay' | null {
  void state;
  return input.pressed.jump ? 'replay' : null;
}

/** Human-readable total-death line, singular/plural safe. */
export function formatTotalDeaths(totalDeaths: number): string {
  return totalDeaths === 1 ? '1 death' : `${totalDeaths} deaths`;
}

export function buildEndModel(state: EndState): RenderModel {
  const rects: FillRect[] = [];
  const texts: DrawText[] = [];

  rects.push({
    x: 60,
    y: 100,
    w: 200,
    h: 2,
    color: 'edge' as PaletteToken,
  });

  texts.push({
    text: 'CAMPAIGN COMPLETE',
    x: 64,
    y: 56,
    color: 'bone' as PaletteToken,
  });
  texts.push({
    text: `TOTAL DEATHS ${state.totalDeaths}`,
    x: 64,
    y: 72,
    color: 'bone' as PaletteToken,
  });

  // The replay prompt blinks so it reads as an invitation, not a label.
  if (state.flashTimer < 30) {
    texts.push({
      text: 'JUMP TO REPLAY',
      x: 64,
      y: 120,
      color: 'edge' as PaletteToken,
    });
  }

  return {
    clear: 'void',
    layers: [
      { kind: 'world', sprites: [], rects, texts: [] },
      { kind: 'entities', sprites: [], rects: [], texts: [] },
      { kind: 'effects', sprites: [], rects: [], texts: [] },
      { kind: 'hud', sprites: [], rects: [], texts },
    ],
  };
}
