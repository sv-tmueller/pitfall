import { describe, expect, it } from 'vitest';
import { createAccessibilitySettings, setReducedMotion, setColorblindMode, remapKey, getColorblindPalette, getEffectsIntensity } from './accessibility';

describe('accessibility', () => {
  it('defaults to no reduced motion', () => {
    expect(createAccessibilitySettings().reducedMotion).toBe(false);
  });

  it('honors prefers-reduced-motion', () => {
    expect(createAccessibilitySettings(true).reducedMotion).toBe(true);
  });

  it('setReducedMotion toggles', () => {
    const s = setReducedMotion(createAccessibilitySettings(), true);
    expect(s.reducedMotion).toBe(true);
  });

  it('setColorblindMode toggles', () => {
    const s = setColorblindMode(createAccessibilitySettings(), true);
    expect(s.colorblindMode).toBe(true);
  });

  it('remapKey changes bindings', () => {
    const s = remapKey(createAccessibilitySettings(), 'jump', ['KeyZ']);
    expect(s.keyBindings.jump).toEqual(['KeyZ']);
  });

  it('getColorblindPalette enables outlines when on', () => {
    expect(getColorblindPalette(true).outlineTiles).toBe(true);
    expect(getColorblindPalette(false).outlineTiles).toBe(false);
  });

  it('getEffectsIntensity zeroes effects under reduced motion', () => {
    const normal = getEffectsIntensity(createAccessibilitySettings(false));
    const reduced = getEffectsIntensity(createAccessibilitySettings(true));
    expect(normal).toBe(1);
    expect(reduced).toBe(0);
  });
});
