import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE, PALETTE_ORDER } from './palette';

describe('PALETTE', () => {
  it('has exactly 6 entries', () => {
    expect(Object.keys(PALETTE)).toHaveLength(6);
  });

  it('every value is a lowercase 6-digit hex color', () => {
    for (const value of Object.values(PALETTE)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('has 6 distinct values', () => {
    const values = Object.values(PALETTE);
    expect(new Set(values).size).toBe(values.length);
  });

  it('PALETTE_ORDER lists every palette key exactly once', () => {
    const keys = Object.keys(PALETTE).sort();
    expect([...PALETTE_ORDER].sort()).toEqual(keys);
    expect(new Set(PALETTE_ORDER).size).toBe(PALETTE_ORDER.length);
  });
});

describe('index.html boot-error palette', () => {
  /** The #boot-error rule body, or null when the rule is missing. */
  function bootErrorBlock(): string | null {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    return /#boot-error\s*\{[^}]*\}/.exec(html)?.[0] ?? null;
  }

  function declarationValue(block: string, property: string): string | undefined {
    const match = new RegExp(`${property}:\\s*([^;]+);`).exec(block);
    return match?.[1]?.trim();
  }

  it('mirrors PALETTE night/bone/lethal in the #boot-error rule', () => {
    const block = bootErrorBlock();
    expect(block).not.toBeNull();
    const css = block ?? '';

    // The DOM fallback is not palette-token driven, so this assertion is the
    // only thing keeping index.html and src/render/palette.ts in step.
    expect(declarationValue(css, 'color')).toBe(PALETTE.bone);
    expect(declarationValue(css, 'background')).toBe(PALETTE.night);
    expect(declarationValue(css, 'border')).toBe(`1px solid ${PALETTE.lethal}`);
  });
});
