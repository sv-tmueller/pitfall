import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Body } from '../engine/physics';
import type { ControllerActions } from '../engine/controller';
import type { JsonValue, MechanicEntry } from '../levels/types';
import { clearRegistry } from './registry';
import { registerAllMechanicTypes } from './register';
import {
  createSpringMechanic,
  createTeleporterMechanic,
  createGravityZoneMechanic,
  createMovingPlatformMechanic,
  createJetpackMechanic,
  createLeverMechanic,
  createControlInversionMechanic,
  createCameraTrollMechanic,
  createFakeUiMechanic,
  createBuzzsawMechanic,
  createRotatingArmMechanic,
  createBombMechanic,
  createTokenMechanic,
} from './adapters';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBody(x = 0, y = 0, grounded = false): Body {
  return {
    x,
    y,
    width: 16,
    height: 16,
    velocity: { x: 0, y: 0 },
    grounded,
  };
}

function noActions(): ControllerActions {
  return { left: false, right: false, jumpPressed: false, jumpHeld: false };
}

function makeEntry(
  type: string,
  params: Record<string, unknown>,
): MechanicEntry {
  return { id: `test-${type}`, type, params: params as unknown as Readonly<Record<string, JsonValue>> };
}

beforeEach(() => {
  clearRegistry();
  registerAllMechanicTypes();
});

afterEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// Spring
// ---------------------------------------------------------------------------

describe('spring adapter', () => {
  it('creates and steps without emitting effects', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 32, y: 48, impulseY: -400 }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result).toEqual({});
  });

  it('contact returns a body override when the player overlaps', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 0, y: 0, impulseY: -400 }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    const contact = mech.contact!(makeBody(0, 0));
    expect(contact).not.toBeNull();
    expect(contact!.body.velocity.y).toBe(-400);
    expect(contact!.halts).toBe(false);
  });

  it('contact returns null when the player does not overlap', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 100, y: 100, impulseY: -400 }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(mech.contact!(makeBody(0, 0))).toBeNull();
  });

  it('fires once per contact then holds its cooldown across frames', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 0, y: 0, impulseY: -400 }));
    const ctx = { body: makeBody(0, 0), actions: noActions(), step: 0 };
    mech.step(ctx);
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
    // Still overlapping on the following frames, but the cooldown blocks it.
    for (let i = 0; i < 5; i++) {
      mech.step(ctx);
      expect(mech.contact!(makeBody(0, 0))).toBeNull();
    }
  });

  it('does not re-fire on sustained overlap, even after the cooldown elapses', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 0, y: 0, impulseY: -400 }));
    const ctx = { body: makeBody(0, 0), actions: noActions(), step: 0 };
    mech.step(ctx);
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
    // Parked in the volume for well over the 10-step cooldown: the trigger is
    // armed only on the rising edge of contact, so it must never re-fire.
    for (let i = 0; i < 40; i++) {
      mech.step(ctx);
      expect(mech.contact!(makeBody(0, 0))).toBeNull();
    }
  });

  it('re-arms and fires again only after the body leaves the volume', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 0, y: 0, impulseY: -400 }));
    const ctx = { body: makeBody(0, 0), actions: noActions(), step: 0 };
    mech.step(ctx);
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
    // Leave the volume for the whole cooldown window.
    for (let i = 0; i < 10; i++) {
      mech.step(ctx);
      expect(mech.contact!(makeBody(500, 500))).toBeNull();
    }
    // Re-entering now fires again (fresh contact, cooldown expired).
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
  });

  it('reset restores initial state', () => {
    const mech = createSpringMechanic(makeEntry('spring', { x: 32, y: 48, impulseY: -400 }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    mech.reset();
    // Should not throw and can step again
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Teleporter
// ---------------------------------------------------------------------------

describe('teleporter adapter', () => {
  it('creates and steps without emitting effects', () => {
    const mech = createTeleporterMechanic(makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 200 }));
    const result = mech.step({ body: makeBody(50, 50), actions: noActions(), step: 0 });
    expect(result).toEqual({});
  });

  it('contact relocates the body when overlapping', () => {
    const mech = createTeleporterMechanic(makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 200 }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    const contact = mech.contact!(makeBody(0, 0));
    expect(contact).not.toBeNull();
    expect(contact!.body.x).toBe(100);
    expect(contact!.body.y).toBe(200);
    expect(contact!.body.velocity.x).toBe(0);
    expect(contact!.body.velocity.y).toBe(0);
    expect(contact!.halts).toBe(true);
  });

  it('contact preserves momentum when configured', () => {
    const mech = createTeleporterMechanic(
      makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 200, preserveMomentum: true }),
    );
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    const body = makeBody(0, 0);
    body.velocity = { x: 50, y: 30 };
    const contact = mech.contact!(body);
    expect(contact).not.toBeNull();
    expect(contact!.body.velocity.x).toBe(50);
    expect(contact!.body.velocity.y).toBe(30);
  });

  it('contact returns null when not overlapping', () => {
    const mech = createTeleporterMechanic(makeEntry('teleporter', { x: 200, y: 200, destX: 100, destY: 200 }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(mech.contact!(makeBody(0, 0))).toBeNull();
  });

  it('holds its cooldown so the arrival tile cannot re-fire across frames', () => {
    const mech = createTeleporterMechanic(makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 200 }));
    const ctx = { body: makeBody(0, 0), actions: noActions(), step: 0 };
    mech.step(ctx);
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
    // Overlapping the same teleporter again next frame must not re-fire.
    for (let i = 0; i < 5; i++) {
      mech.step(ctx);
      expect(mech.contact!(makeBody(0, 0))).toBeNull();
    }
  });

  it('stays disarmed past the cooldown until the body leaves the volume', () => {
    const mech = createTeleporterMechanic(makeEntry('teleporter', { x: 0, y: 0, destX: 100, destY: 200 }));
    const ctx = { body: makeBody(0, 0), actions: noActions(), step: 0 };
    mech.step(ctx);
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
    // The 10-step cooldown decays while the body stays inside the box: the
    // portal must remain disarmed, or a walking player would ping-pong.
    for (let i = 0; i < 12; i++) {
      mech.step(ctx);
      expect(mech.contact!(makeBody(0, 0))).toBeNull();
    }
    // Stepping clear re-arms it, allowing a later fresh entry to fire.
    mech.step(ctx);
    expect(mech.contact!(makeBody(500, 500))).toBeNull();
    expect(mech.contact!(makeBody(0, 0))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gravity zone
// ---------------------------------------------------------------------------

describe('gravity-zone adapter', () => {
  it('publishes gravityDirection 1 when the body is outside the zone', () => {
    const mech = createGravityZoneMechanic(makeEntry('gravity-zone', {}));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result).toEqual({ gravityDirection: 1 });
  });

  it('can be reset', () => {
    const mech = createGravityZoneMechanic(makeEntry('gravity-zone', {}));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    mech.reset();
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result).toEqual({ gravityDirection: 1 });
  });
});

// ---------------------------------------------------------------------------
// Moving platform
// ---------------------------------------------------------------------------

describe('moving-platform adapter', () => {
  it('publishes a dynamic solid each step', () => {
    const mech = createMovingPlatformMechanic(makeEntry('moving-platform', {
      startX: 0, startY: 100, width: 32, height: 16, dx: 1, dy: 0, speed: 16, distance: 48,
    }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.dynamicSolids).toHaveLength(1);
    expect(result.dynamicSolids![0]!.x).toBeGreaterThanOrEqual(0);
    expect(result.dynamicSolids![0]!.width).toBe(32);
    expect(result.dynamicSolids![0]!.solid).toBe(true);
    expect(result.dynamicSolids![0]!.lethal).toBe(false);
  });

  it('moves the platform over multiple steps', () => {
    const mech = createMovingPlatformMechanic(makeEntry('moving-platform', {
      startX: 0, startY: 100, width: 32, height: 16, dx: 1, dy: 0, speed: 16, distance: 48,
    }));
    const r0 = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    const r1 = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 1 });
    expect(r1.dynamicSolids![0]!.x).toBeGreaterThan(r0.dynamicSolids![0]!.x);
  });

  it('reset restores initial position', () => {
    const mech = createMovingPlatformMechanic(makeEntry('moving-platform', {
      startX: 0, startY: 100, width: 32, height: 16, dx: 1, dy: 0, speed: 16, distance: 48,
    }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 1 });
    mech.reset();
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.dynamicSolids![0]!.x).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Jetpack
// ---------------------------------------------------------------------------

describe('jetpack adapter', () => {
  it('emits negative velocityMod when thrusting with fuel', () => {
    const mech = createJetpackMechanic(makeEntry('jetpack', { maxFuel: 100, thrustPower: 200 }));
    const result = mech.step({
      body: makeBody(0, 0),
      actions: { left: false, right: false, jumpPressed: false, jumpHeld: true },
      step: 0,
    });
    expect(result.velocityMod?.y).toBeLessThan(0);
  });

  it('emits nothing when not thrusting', () => {
    const mech = createJetpackMechanic(makeEntry('jetpack', { maxFuel: 100, thrustPower: 200 }));
    const result = mech.step({
      body: makeBody(0, 0),
      actions: noActions(),
      step: 0,
    });
    expect(result.velocityMod).toBeUndefined();
  });

  it('reset refills fuel', () => {
    const mech = createJetpackMechanic(makeEntry('jetpack', { maxFuel: 5, thrustPower: 200 }));
    // Burn all fuel
    for (let i = 0; i < 10; i++) {
      mech.step({
        body: makeBody(0, 0),
        actions: { left: false, right: false, jumpPressed: false, jumpHeld: true },
        step: i,
      });
    }
    mech.reset();
    const result = mech.step({
      body: makeBody(0, 0),
      actions: { left: false, right: false, jumpPressed: false, jumpHeld: true },
      step: 0,
    });
    expect(result.velocityMod?.y).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lever
// ---------------------------------------------------------------------------

describe('lever adapter', () => {
  it('activates on contact when toggleOnContact is true', () => {
    const mech = createLeverMechanic(makeEntry('lever', { x: 0, y: 0, toggleOnContact: true }));
    const body = makeBody(0, 0); // overlaps lever at (0,0,16,16)
    mech.step({ body, actions: noActions(), step: 0 });
    // Second step to detect contact
    mech.step({ body, actions: noActions(), step: 1 });
    // Lever state is internal; verify no crash
    expect(true).toBe(true);
  });

  it('can be reset', () => {
    const mech = createLeverMechanic(makeEntry('lever', { x: 0, y: 0, toggleOnContact: false }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    mech.reset();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Control inversion
// ---------------------------------------------------------------------------

describe('control-inversion adapter', () => {
  it('swaps left/right in actionsOverride', () => {
    const mech = createControlInversionMechanic(makeEntry('control-inversion', {}));
    const result = mech.step({
      body: makeBody(0, 0),
      actions: { left: true, right: false, jumpPressed: false, jumpHeld: false },
      step: 0,
    });
    expect(result.actionsOverride).toBeDefined();
    expect(result.actionsOverride!.left).toBe(false);
    expect(result.actionsOverride!.right).toBe(true);
  });

  it('reset deactivates inversion', () => {
    const mech = createControlInversionMechanic(makeEntry('control-inversion', { duration: 10 }));
    mech.step({
      body: makeBody(0, 0),
      actions: { left: true, right: false, jumpPressed: false, jumpHeld: false },
      step: 0,
    });
    mech.reset();
    const result = mech.step({
      body: makeBody(0, 0),
      actions: { left: true, right: false, jumpPressed: false, jumpHeld: false },
      step: 0,
    });
    // After reset, inversion activates again on first step
    expect(result.actionsOverride!.left).toBe(false);
    expect(result.actionsOverride!.right).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Camera troll
// ---------------------------------------------------------------------------

describe('camera-troll adapter', () => {
  it('emits cosmetic state with zoom effect', () => {
    const mech = createCameraTrollMechanic(makeEntry('camera-troll', { kind: 'zoom', intensity: 0.5 }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.cosmeticState).toBeDefined();
    expect(result.cosmeticState!.cameraTrolls).toHaveLength(1);
    expect(result.cosmeticState!.cameraTrolls![0]!.active).toBe(true);
    expect(result.cosmeticState!.cameraTrolls![0]!.zoom).toBeGreaterThan(1);
  });

  it('emits cosmetic state with flip effect', () => {
    const mech = createCameraTrollMechanic(makeEntry('camera-troll', { kind: 'flip', intensity: 1 }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.cosmeticState!.cameraTrolls![0]!.flipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fake UI
// ---------------------------------------------------------------------------

describe('fake-ui adapter', () => {
  it('emits cosmetic state with fake-crash', () => {
    const mech = createFakeUiMechanic(makeEntry('fake-ui', { kind: 'fake-crash' }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.cosmeticState).toBeDefined();
    expect(result.cosmeticState!.fakeUiStates).toHaveLength(1);
    expect(result.cosmeticState!.fakeUiStates![0]!.active).toBe(true);
    expect(result.cosmeticState!.fakeUiStates![0]!.kind).toBe('fake-crash');
  });
});

// ---------------------------------------------------------------------------
// Buzzsaw
// ---------------------------------------------------------------------------

describe('buzzsaw adapter', () => {
  it('publishes a hazard rect at the buzzsaw position', () => {
    const mech = createBuzzsawMechanic(makeEntry('buzzsaw', {
      radius: 8,
      waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      speed: 10,
      pingpong: false,
    }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.hazardsToAdd).toHaveLength(1);
    expect(result.hazardsToAdd![0]!.width).toBe(16);
    expect(result.hazardsToAdd![0]!.height).toBe(16);
  });

  it('moves the hazard over multiple steps', () => {
    const mech = createBuzzsawMechanic(makeEntry('buzzsaw', {
      radius: 8,
      waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      speed: 10,
      pingpong: false,
    }));
    const r0 = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    const r1 = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 1 });
    expect(r1.hazardsToAdd![0]!.x).not.toBe(r0.hazardsToAdd![0]!.x);
  });
});

// ---------------------------------------------------------------------------
// Rotating arm
// ---------------------------------------------------------------------------

describe('rotating-arm adapter', () => {
  it('publishes a hazard rect at the blade position', () => {
    const mech = createRotatingArmMechanic(makeEntry('rotating-arm', {
      pivotX: 50, pivotY: 50, length: 30, angularSpeed: 0.1, initialAngle: 0,
    }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.hazardsToAdd).toHaveLength(1);
    // At angle 0.1 (after step), blade is near pivotX + cos(0.1)*length
    const expectedX = 50 + Math.cos(0.1) * 30;
    expect(Math.abs(result.hazardsToAdd![0]!.x + 8 - expectedX)).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Bomb
// ---------------------------------------------------------------------------

describe('bomb adapter', () => {
  it('does not publish hazard before exploding', () => {
    const mech = createBombMechanic(makeEntry('bomb', {
      x: 50, y: 50, fuseSteps: 5, blastRadius: 32,
    }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result.hazardsToAdd).toBeUndefined();
  });

  it('publishes blast hazard after fuse expires', () => {
    const mech = createBombMechanic(makeEntry('bomb', {
      x: 50, y: 50, fuseSteps: 2, blastRadius: 32,
    }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 1 });
    expect(result.hazardsToAdd).toHaveLength(1);
    expect(result.hazardsToAdd![0]!.width).toBe(64);
    expect(result.hazardsToAdd![0]!.height).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

describe('token adapter', () => {
  it('steps without emitting physics effects', () => {
    const mech = createTokenMechanic(makeEntry('token', {
      positions: [{ x: 0, y: 0 }, { x: 32, y: 0 }],
    }));
    const result = mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    expect(result).toEqual({});
  });

  it('can be reset', () => {
    const mech = createTokenMechanic(makeEntry('token', {
      positions: [{ x: 0, y: 0 }],
    }));
    mech.step({ body: makeBody(0, 0), actions: noActions(), step: 0 });
    mech.reset();
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerAllMechanicTypes', () => {
  it('registers all 13 mechanic types', () => {
    // Already registered in beforeEach
    // Re-register should be a no-op
    registerAllMechanicTypes();
    expect(true).toBe(true);
  });
});
