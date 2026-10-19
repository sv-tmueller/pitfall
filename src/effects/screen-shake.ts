// Screen shake: deterministic shake offsets driven by a seeded PRNG.
// Cosmetically offsets the camera; never alters physics. Intensity scales magnitude.

import { createPrng } from '../engine/prng';

/**
 * Decay rate in magnitude units per second. The former fixed 1.5/step equals
 * 90/s at the fixed 60 Hz step, so tuning is expressed in time, not frames.
 */
const DECAY_PER_SECOND = 90;

export interface ShakeState {
  magnitude: number;
  /**
   * Evolving PRNG state. Stored (like particles.ts) instead of re-derived
   * from the magnitude so consecutive steps explore DIFFERENT angles; the
   * old derivation replayed one direction for a constant magnitude.
   */
  prngState: number;
  offsetX: number;
  offsetY: number;
  intensity: number;
}

export function createShake(seed: number, intensity: number): ShakeState {
  return { magnitude: 0, prngState: seed, offsetX: 0, offsetY: 0, intensity };
}

export function triggerShake(state: ShakeState, magnitude: number): ShakeState {
  const scaled = magnitude * state.intensity;
  if (scaled <= 0) return state;
  return { ...state, magnitude: Math.max(state.magnitude, scaled) };
}

export function stepShake(state: ShakeState, dt: number): ShakeState {
  if (state.magnitude <= 0) {
    return { ...state, offsetX: 0, offsetY: 0, magnitude: 0 };
  }
  const prng = createPrng(state.prngState);
  const angle = prng.next() * Math.PI * 2;
  const mag = state.magnitude;
  // Normalize -0 (Math.round of a negative-near-zero cosine/sine) to +0 so
  // serialized state never carries a signed zero.
  const ox = Math.round(Math.cos(angle) * mag) || 0;
  const oy = Math.round(Math.sin(angle) * mag) || 0;
  const newMag = Math.max(0, state.magnitude - DECAY_PER_SECOND * dt);
  return {
    ...state,
    prngState: prng.getState(),
    offsetX: ox,
    offsetY: oy,
    magnitude: newMag,
  };
}
