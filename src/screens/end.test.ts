import { describe, expect, it } from 'vitest';
import {
  buildEndModel,
  createEndState,
  formatTotalDeaths,
  getEndTransition,
  stepEnd,
} from './end';
import type { InputSnapshot } from '../engine/input';

function snap(
  pressed: Partial<Record<string, boolean>> = {},
  held: Partial<Record<string, boolean>> = {},
): InputSnapshot {
  const empty = { left: false, right: false, jump: false, restart: false, pause: false, confirm: false };
  return {
    held: { ...empty, ...held },
    pressed: { ...empty, ...pressed },
    released: { ...empty },
  };
}

const DT = 1 / 60;

describe('end screen', () => {
  it('stores the total death count and starts the flash at 0', () => {
    const s = createEndState(7);
    expect(s.totalDeaths).toBe(7);
    expect(s.flashTimer).toBe(0);
  });

  it('clamps negative and fractional death counts', () => {
    expect(createEndState(-3).totalDeaths).toBe(0);
    expect(createEndState(2.9).totalDeaths).toBe(2);
  });

  it('flash timer cycles 0-59', () => {
    let s = createEndState(0);
    s = stepEnd(s, snap(), DT);
    expect(s.flashTimer).toBe(1);
    for (let i = 0; i < 59; i++) {
      s = stepEnd(s, snap(), DT);
    }
    expect(s.flashTimer).toBe(0);
  });

  it('getEndTransition returns replay on a jump edge', () => {
    const s = createEndState(0);
    expect(getEndTransition(s, snap({ jump: true }))).toBe('replay');
  });

  it('getEndTransition returns replay on a confirm edge', () => {
    const s = createEndState(0);
    expect(getEndTransition(s, snap({ confirm: true }))).toBe('replay');
  });

  it('getEndTransition returns null without a jump or confirm edge', () => {
    const s = createEndState(0);
    expect(getEndTransition(s, snap())).toBeNull();
  });

  it('formatTotalDeaths is singular for one death', () => {
    expect(formatTotalDeaths(1)).toBe('1 death');
    expect(formatTotalDeaths(0)).toBe('0 deaths');
    expect(formatTotalDeaths(12)).toBe('12 deaths');
  });

  it('buildEndModel shows the total death count text', () => {
    const s = createEndState(5);
    const model = buildEndModel(s);
    expect(model.clear).toBe('void');
    const texts = model.layers.flatMap((layer) => layer.texts.map((t) => t.text));
    expect(texts).toContain('TOTAL DEATHS 5');
    expect(texts).toContain('CAMPAIGN COMPLETE');
  });

  it('buildEndModel blinks the replay prompt', () => {
    const visible = buildEndModel(createEndState(2));
    const visibleTexts = visible.layers.flatMap((layer) => layer.texts.map((t) => t.text));
    expect(visibleTexts).toContain('PRESS SPACE OR ENTER - OR CLICK');

    let s = createEndState(2);
    for (let i = 0; i < 30; i++) s = stepEnd(s, snap(), DT);
    const hidden = buildEndModel(s);
    const hiddenTexts = hidden.layers.flatMap((layer) => layer.texts.map((t) => t.text));
    expect(hiddenTexts).not.toContain('PRESS SPACE OR ENTER - OR CLICK');
  });
});
