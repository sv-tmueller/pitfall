import { describe, expect, it } from 'vitest';
import { computeCamera } from './camera';

describe('computeCamera', () => {
  it('centers on target when level is larger than viewport', () => {
    // Target at (500, 300) in a 1000x600 level.
    const cam = computeCamera(500, 300, 1000, 600);
    expect(cam.x).toBe(340); // 500 - 160
    expect(cam.y).toBe(210); // 300 - 90
  });

  it('clamps at the left/top edge (centerX < 160)', () => {
    const cam = computeCamera(50, 50, 1000, 600);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
  });

  it('clamps at the right/bottom edge (centerX near level end)', () => {
    const cam = computeCamera(950, 550, 1000, 600);
    expect(cam.x).toBe(680); // 1000 - 320
    expect(cam.y).toBe(420); // 600 - 180
  });

  it('handles level wider than viewport but shorter than viewport', () => {
    // Level 400x100: height < 180, so y clamps to 0.
    const cam = computeCamera(200, 50, 400, 100);
    expect(cam.x).toBe(40); // 200 - 160, clamped to [0, 80]
    expect(cam.y).toBe(0); // max(0, 100 - 180) = 0
  });

  it('handles level exactly fitting the viewport (320x180)', () => {
    const cam = computeCamera(160, 90, 320, 180);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
  });

  it('handles level smaller than viewport in both axes', () => {
    const cam = computeCamera(50, 50, 100, 80);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
  });

  it('produces symmetric clamp boundaries', () => {
    // At centerX = 160, camera x = 0 (boundary).
    expect(computeCamera(160, 90, 640, 360).x).toBe(0);
    // At centerX = 480 (= 640 - 160), camera x = 320.
    expect(computeCamera(480, 270, 640, 360).x).toBe(320);
  });

  it('does not mutate inputs (numbers are primitives, sanity check)', () => {
    const cx = 500;
    const cy = 300;
    computeCamera(cx, cy, 1000, 600);
    expect(cx).toBe(500);
    expect(cy).toBe(300);
  });

  it('rounds fractional target centers to whole pixels', () => {
    // Interpolated centers arrive fractional; the camera must snap to ints.
    const cam = computeCamera(500.7, 300.4, 1000, 600);
    expect(Number.isInteger(cam.x)).toBe(true);
    expect(Number.isInteger(cam.y)).toBe(true);
    expect(cam.x).toBe(341); // 500.7 - 160 = 340.7 -> 341
    expect(cam.y).toBe(210); // 300.4 - 90 = 210.4 -> 210
  });
});
