import { describe, expect, it } from 'vitest';
import { createLevelSelectState, stepLevelSelect, getSelectedLevel, buildLevelSelectModel } from './level-select';
import type { LevelMeta } from './level-select';
import type { InputSnapshot } from '../engine/input';

const DT = 1 / 60;

function snap(pressed: Partial<Record<string, boolean>> = {}): InputSnapshot {
  const empty = { left: false, right: false, jump: false, restart: false, pause: false, confirm: false };
  return {
    held: { ...empty },
    pressed: { ...empty, ...pressed },
    released: { ...empty },
  };
}

function makeLevels(): LevelMeta[] {
  return [
    { id: 'lvl-1', name: 'First', unlocked: true, completed: false, deathCount: 0 },
    { id: 'lvl-2', name: 'Second', unlocked: true, completed: true, deathCount: 3 },
    { id: 'lvl-3', name: 'Third', unlocked: false, completed: false, deathCount: 0 },
  ];
}

describe('level select', () => {
  it('starts at index 0', () => {
    const s = createLevelSelectState(makeLevels());
    expect(s.selectedIndex).toBe(0);
  });

  it('right moves index +1 with wrap', () => {
    let s = createLevelSelectState(makeLevels());
    s = stepLevelSelect(s, snap({ right: true }), DT);
    expect(s.selectedIndex).toBe(1);
    s = stepLevelSelect(s, snap({ right: true }), DT);
    s = stepLevelSelect(s, snap({ right: true }), DT);
    expect(s.selectedIndex).toBe(0);
  });

  it('left wraps to last', () => {
    let s = createLevelSelectState(makeLevels());
    s = stepLevelSelect(s, snap({ left: true }), DT);
    expect(s.selectedIndex).toBe(2);
  });

  it('getSelectedLevel returns null for locked levels', () => {
    let s = createLevelSelectState(makeLevels());
    s = stepLevelSelect(s, snap({ right: true }), DT);
    s = stepLevelSelect(s, snap({ right: true }), DT);
    expect(getSelectedLevel(s)).toBeNull();
  });

  it('getSelectedLevel returns level for unlocked', () => {
    const s = createLevelSelectState(makeLevels());
    const lvl = getSelectedLevel(s);
    expect(lvl).not.toBeNull();
    expect(lvl!.id).toBe('lvl-1');
  });

  it('buildLevelSelectModel produces door sprites', () => {
    const s = createLevelSelectState(makeLevels());
    const model = buildLevelSelectModel(s);
    expect(model.layers[0]!.sprites.length).toBe(3);
    expect(model.layers[0]!.sprites[0]!.frame).toBe('exit.door');
  });

  it('selection flash highlights selected door', () => {
    const s = createLevelSelectState(makeLevels());
    const model = buildLevelSelectModel(s);
    expect(model.layers[0]!.rects.length).toBeGreaterThan(3);
  });
});
