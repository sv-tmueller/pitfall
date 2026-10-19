// Accessibility: reduced motion, colorblind-safe palette, remappable keys (#50).
// Honors prefers-reduced-motion, offers a colorblind-safe palette variant with
// redundant shape/outline channels, exposes key remapping.

import type { KeyBindings } from '../engine/input';
import { DEFAULT_BINDINGS } from '../engine/input';

export interface AccessibilitySettings {
  reducedMotion: boolean;
  colorblindMode: boolean;
  keyBindings: KeyBindings;
}

export function createAccessibilitySettings(prefersReducedMotion: boolean = false): AccessibilitySettings {
  return {
    reducedMotion: prefersReducedMotion,
    colorblindMode: false,
    keyBindings: DEFAULT_BINDINGS,
  };
}

export function setReducedMotion(settings: AccessibilitySettings, enabled: boolean): AccessibilitySettings {
  return { ...settings, reducedMotion: enabled };
}

export function setColorblindMode(settings: AccessibilitySettings, enabled: boolean): AccessibilitySettings {
  return { ...settings, colorblindMode: enabled };
}

export function remapKey(settings: AccessibilitySettings, action: keyof KeyBindings, codes: readonly string[]): AccessibilitySettings {
  return {
    ...settings,
    keyBindings: { ...settings.keyBindings, [action]: codes },
  };
}

// Colorblind-safe palette: uses shape redundancy (outlined tiles) since a
// second accent color would violate the single-accent-means-lethal rule.
export function getColorblindPalette(enabled: boolean): {
  outlineTiles: boolean;
  hazardPattern: 'striped' | 'solid';
} {
  return {
    outlineTiles: enabled,
    hazardPattern: enabled ? 'striped' : 'solid',
  };
}

export function getEffectsIntensity(settings: AccessibilitySettings): number {
  // Reduced motion ZEROES effects (issue #163 AC): no shake, no particles,
  // no hit-stop. Deliberately stricter than the previous 0.3 dimming.
  return settings.reducedMotion ? 0 : 1;
}
