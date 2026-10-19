// Completion regressions for the fake-exit levels (issue #160, batch #164).
//
// Four of the six fake-exit levels complete under a deterministic bunny-hop
// bot aimed at the runtime exit. The two finales need scripted routes:
//   mvp/15 climbs the west one-way ladder (columns 2-6, clear of the
//   vanishing-floor gauntlet and the spike tile), hops east onto the row-2
//   band to trigger the fleeing door, then drops back west and jumps up
//   through the escaped door at (2,1).
//   w3/45 rides the bottom teleporter WEST to the pillar dock at (64,256),
//   boards the column-4 elevator to the row-13 ledge, alternates 16-px hops
//   up the west band ladder to the row-4 corridor, walks east along row 4 to
//   the trigger ring of the fleeing door, then doubles back west and jumps
//   up through the escaped door at (2,1). Inputs are mirrored: the level
//   carries a permanent control-inversion mechanic.
import { describe, expect, it } from 'vitest';
import { createScene, stepScene, type SceneActions, type SceneState } from './scene';
import { MVP_LEVELS } from '../levels/mvp/index';
import { WORLD2_LEVELS } from '../levels/world2/index';
import { WORLD3_LEVELS } from '../levels/world3/index';

const DT = 1 / 60;

/** Bunny-hop policy: walk toward the runtime exit, jump on every landing. */
function hopBot(s: SceneState, jump: boolean): SceneActions {
  const body = s.controller.body;
  const exit = s.runtime.world.exitPos;
  const pcx = body.x + body.width / 2;
  const tx = exit.col * 16 + 8;
  const d = tx - pcx;
  const dir = Math.abs(d) < 6 ? 0 : d > 0 ? 1 : -1;
  return {
    left: dir < 0,
    right: dir > 0,
    jumpPressed: jump && body.grounded,
    jumpHeld: jump,
    restart: false,
  };
}

interface Waypoint {
  /** Target body-center x in pixels. */
  x: number;
  /** Target body-top y in pixels (standing on a band top T means T - 16). */
  y: number;
  /** Hold position until the condition holds (door finished fleeing). */
  waitFor?: (s: SceneState) => boolean;
}

/**
 * Drives a scene with a per-step policy until it leaves the playing phase or
 * exhausts the step budget.
 */
function play(
  source: unknown,
  policy: (s: SceneState, step: number) => SceneActions,
  maxSteps: number,
): { state: SceneState; steps: number } {
  let s = createScene([source as never]);
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    s = stepScene(s, policy(s, steps), DT);
    if (s.phase !== 'playing') break;
  }
  return { state: s, steps: steps + 1 };
}

/**
 * Waypoint follower with full-height jumps: while a waypoint sits above the
 * body, jump is HELD (a tap triggers the release cut and halves the hop).
 * Horizontal input is mirrored for control-inverted levels.
 */
function waypointBot(wps: Waypoint[], mirror = false) {
  let idx = 0;
  let airborneForWp = false;
  return (s: SceneState): SceneActions => {
    const body = s.controller.body;
    const cx = body.x + body.width / 2;
    const cy = body.y;
    let wp: Waypoint = wps[idx]!;
    if (
      idx < wps.length - 1 &&
      (wp.waitFor ? wp.waitFor(s) : true) &&
      body.grounded &&
      Math.abs(cx - wp.x) <= 10 &&
      Math.abs(cy - wp.y) <= 12
    ) {
      idx += 1;
      wp = wps[idx]!;
    }
    if (body.grounded) airborneForWp = false;
    const waiting = wp.waitFor ? !wp.waitFor(s) : false;
    let left = false;
    let right = false;
    let jumpPressed = false;
    let jumpHeld = false;
    if (!waiting) {
      const d = wp.x - cx;
      // Align horizontally first; freeze horizontal input once a jump is
      // airborne so hops land on the intended tile (gauntlet survivor).
      if (!airborneForWp && Math.abs(d) > 4) {
        left = d < 0;
        right = d > 0;
      }
      // Initiate a jump toward a higher waypoint, then LATCH jump-held
      // until the next landing: releasing mid-rise triggers the release
      // cut and halves the hop height.
      if (wp.y < cy - 8 && body.grounded && Math.abs(d) <= 2) {
        jumpPressed = true;
        airborneForWp = true;
      }
      jumpHeld = airborneForWp;
    }
    if (mirror) {
      const t = left;
      left = right;
      right = t;
    }
    return { left, right, jumpPressed, jumpHeld, restart: false };
  };
}

const fledTo = (col: number, row: number) => (s: SceneState) =>
  s.runtime.world.exitPos.col === col && s.runtime.world.exitPos.row === row;

describe('fake-exit levels remain completable', () => {
  it.each([
    ['mvp/06 fake-door', MVP_LEVELS['fake-door'], 400],
    ['mvp/11 maze-of-doors', MVP_LEVELS['maze-of-doors'], 600],
    ['w2/30 world-2-finale', WORLD2_LEVELS['world-2-finale'], 400],
    ['w3/43 glitch', WORLD3_LEVELS['glitch'], 200],
  ])('%s completes via the moved door', (_label, source, budget) => {
    const { state } = play(source, (s) => hopBot(s, true), Number(budget));
    expect(state.phase).toMatch(/entering|complete/);
  });

  it('w2/17 ceiling-walk completes via gravity inversion (flip and ceiling glide)', () => {
    // Issue #174 executable acceptance proof, evolving the old engine-parity
    // pin: with gravity inversion actually wired, the level's designed route
    // is playable end to end. The spawn sits on the floor OUTSIDE the zone
    // (the zone spans y 16..144, the floor row is below it), so the body
    // starts in normal gravity. Walk east to column 8 - a gap in the row-2
    // solid band - and jump: the hop carries the body's top edge into the
    // zone, gravity flips UPWARD mid-rise, and the body accelerates to the
    // row-0 ceiling, landing inverted at row 1. Gliding east along the
    // ceiling (no hops: a hop would drop the body back toward the spike
    // columns) brings the AABB over the floating exit at (17,1) and the
    // level completes on overlap. If inversion ever regresses to a no-op,
    // the jump apexes short of the ceiling and this goes red.
    let phase: 'floor' | 'ascent' | 'glide' = 'floor';
    const policy = (s: SceneState): SceneActions => {
      const body = s.controller.body;
      const cx = body.x + body.width / 2;
      if (phase === 'floor') {
        if (Math.abs(cx - 136) <= 2 && body.grounded) {
          phase = 'ascent';
          return { left: false, right: false, jumpPressed: true, jumpHeld: true, restart: false };
        }
        return { left: cx > 136, right: cx < 136, jumpPressed: false, jumpHeld: false, restart: false };
      }
      if (phase === 'ascent') {
        if (body.grounded) phase = 'glide';
        return { left: false, right: false, jumpPressed: false, jumpHeld: true, restart: false };
      }
      return { left: false, right: true, jumpPressed: false, jumpHeld: false, restart: false };
    };
    const { state } = play(WORLD2_LEVELS['ceiling-walk'], policy, 600);
    expect(state.phase).toMatch(/entering|complete/);
  });

  it('w2/18 gravitas completes via gravity-zone inversion (hopBot)', () => {
    // Issue #174 executable acceptance proof: the gravity-zone adapter
    // publishes `gravityDirection` (-1 while the body AABB overlaps the zone
    // rectangle x16 y16 w288 h128, so the whole play area above the floor row
    // is inverted) and scene.stepPlaying feeds it to the signed controller.
    // The spawn sits on the floor in normal gravity; the first hop carries
    // the body into the zone, the pull flips UPWARD, and the bot bunny-hops
    // east along the row-3/row-6 one-way ceilings to the exit at (17,1).
    // Deterministically driven, this completes end to end in ~170 steps.
    const { state } = play(WORLD2_LEVELS.gravitas, (s) => hopBot(s, true), 1200);
    expect(state.phase).toMatch(/entering|complete/);
  });

  it('mvp/15 finale completes via the zig-zag ladder', () => {
    // Band map (one-way rows): r20/r16/r12/r8/r4 span cols 1-9 (west),
    // r18/r14/r6 span cols 10-18 (east), r10 spans cols 7-12. The vanishing
    // gauntlet removes r10 cols 7-8 and 11-12 at step 40 and the spike sits
    // at col 10, so the only safe r10 landing is col 9 - conveniently
    // straight above the west bands' right edge, making the whole climb a
    // 16 px zig-zag with no dependence on the vanish timing.
    // Standing heights: band top T means body y = T - 16.
    const wps: Waypoint[] = [
      { x: 152, y: 304 }, // r20 west, right edge
      { x: 168, y: 272 }, // r18 east, left edge
      { x: 152, y: 240 }, // r16 west
      { x: 168, y: 208 }, // r14 east
      { x: 152, y: 176 }, // r12 west
      { x: 152, y: 144 }, // r10 col-9 survivor tile, straight up
      { x: 152, y: 112 }, // r8 west
      { x: 168, y: 80 }, // r6 east
      { x: 152, y: 48 }, // r4 west; proximity triggers the fleeing door
      { x: 152, y: 48, waitFor: fledTo(2, 1) }, // hold while it slides away
      { x: 40, y: 48 }, // walk west under the escaped door
      { x: 40, y: 16 }, // full jump rises through the door AABB at (2,1)
    ];
    const { state } = play(MVP_LEVELS.finale, waypointBot(wps), 2500);
    expect(state.phase).toMatch(/entering|complete/);
  });

  it('w3/45 world-3-finale completes via the west-pillar elevator', () => {
    // Issue #171 executable acceptance proof. The teleporter pair now docks
    // at the west pillar: TP-a (160,336) deposits the body at (64,256),
    // standing on the row-17 solid at column 4, clear of the crusher's
    // on-enter danger zone (x 112-144, y 224-272). finale-platform-left is
    // a pure vertical elevator at column 4: it rests flush with the pillar
    // top (y 272), so boarding is wait-only, and it ferries the rider up
    // 64 px to the row-13 one-way ledge (cols 4-5, top y 208). From there
    // the climb alternates 16-px hops up the west band ladder (rows 13,
    // 12, 11, ..., 4; odd/even bands are offset one column apart) to the
    // row-4 corridor, then east along row 4 into the fleeing door's
    // trigger ring near the original exit. Doubling back west reaches the
    // escaped door at (2,1). Inputs are mirrored throughout: the level
    // carries a permanent control-inversion mechanic. If the dock ever
    // drifts back into the crusher zone, the body dies in the pocket and
    // this goes red; if the elevator or inversion regresses, the ride or
    // the climb stalls and this goes red.
    const platRest = (s: SceneState): number => {
      const solids = s.mechanicsRuntime.publishedSolids;
      const p = solids.find((sol) => sol.id === 'finale-platform-left');
      return p ? p.y : -1;
    };
    // Phase machine (the waypointBot strands on this level: the teleporter
    // fires at the pad's west edge, before any pad-centered waypoint's
    // advance window opens). Phases advance on robust physical cues:
    //   floorWalkEast -> (teleport: sudden y drop) -> dockWait ->
    //   (elevator rests at 272) -> rideHold -> (deposited on row-12 band,
    //   platform heading down) -> ladderHop -> (body row 4) -> corridorEast
    //   -> (door fled to (2,1)) -> corridorWest -> (under the door) ->
    //   doorJump -> entering|complete.
    let phase: 'floorWalkEast' | 'dockWait' | 'rideHold' | 'ladderHop' | 'corridorEast' | 'corridorWest' | 'doorJump' =
      'floorWalkEast';
    const policy = (s: SceneState): SceneActions => {
      const body = s.controller.body;
      const cx = body.x + body.width / 2;
      const idle: SceneActions = { left: false, right: false, jumpPressed: false, jumpHeld: false, restart: false };
      switch (phase) {
        case 'floorWalkEast':
          if (body.y < 300) {
            phase = 'dockWait';
            return idle;
          }
          return { ...idle, right: true };
        case 'dockWait':
          // Stand still on the dock; board when the elevator rests at the
          // pillar top. Mirrored: emitted right steers the body west onto
          // the platform center if the dock nudged it east.
          if (platRest(s) >= 270) return { ...idle, left: true };
          return idle;
        case 'rideHold':
          // Carried up; released when the body stands on the row-12 band
          // and the platform has begun its descent (topped out).
          if (body.grounded && body.y <= 193 && platRest(s) > 209) {
            phase = 'ladderHop';
          }
          return idle;
        case 'ladderHop': {
          // Hop north up the west band ladder: full-height jumps (held),
          // aligned to column 3 (cx 40..56), 16 px per landing.
          const aligned = Math.abs(cx - 40) <= 2;
          if (body.grounded && aligned && body.y > 52) {
            return { ...idle, jumpPressed: true, jumpHeld: true };
          }
          if (body.grounded && !aligned) {
            return body.y > 52 ? { ...idle, left: cx > 40, right: cx < 40 } : idle;
          }
          if (body.y <= 52 && body.grounded) {
            phase = 'corridorEast';
            return idle;
          }
          return { ...idle, jumpHeld: true };
        }
        case 'corridorEast':
          // Bunny-hop east along row 4: the closest grounded stance is
          // 48.2 px from the exit center (trigger needs < 48), but a hop
          // apex puts the body center ~10 px from it mid-air, firing the
          // flee deterministically. Wrapper pre-mirrors, the level's
          // inversion mirrors again: policy directions are PHYSICAL.
          if (fledTo(2, 1)(s)) {
            phase = 'corridorWest';
            return idle;
          }
          if (body.grounded) return { ...idle, right: true, jumpPressed: true, jumpHeld: true };
          return { ...idle, right: true, jumpHeld: true };
        case 'corridorWest':
          // Return west along row 4 to under the escaped door at (2,1).
          if (cx <= 44) {
            phase = 'doorJump';
            return idle;
          }
          return { ...idle, left: true };
        case 'doorJump':
          // Full jump from row 4 rises through the door AABB at (2,1).
          if (s.phase === 'playing' && body.grounded) {
            return { ...idle, jumpPressed: true, jumpHeld: true };
          }
          return { ...idle, jumpHeld: true };
      }
    };
    // Ride transition: dockWait hands to rideHold once boarded (carried
    // above the dock height). Emissions are mirrored here because the
    // level's control-inversion mechanic mirrors them AGAIN after the
    // policy (net normal), matching the waypointBot mirror convention.
    const wrapped = (s: SceneState): SceneActions => {
      if (phase === 'dockWait') {
        const b = s.controller.body;
        if (b.y < 250) phase = 'rideHold';
      }
      const a = policy(s);
      return { ...a, left: a.right, right: a.left };
    };
    const { state } = play(WORLD3_LEVELS['world-3-finale'], wrapped, 2500);
    expect(state.phase).toMatch(/entering|complete/);
  });

  it('w3/45 structural pins: teleport dock is disjoint from every crusher danger zone', () => {
    // Pure data assertions, no RNG, no timing. The relocated dock must be
    // standable (solid support below) and clear of every on-enter crusher
    // zone in the level. The negative probe asserts the PRE-FIX dock
    // (112,256) DOES intersect the zone, proving the pin detects exactly
    // the failure class that made the level impossible.
    const source = WORLD3_LEVELS['world-3-finale'] as {
      traps: Array<{
        type: string;
        params: { col: number; row: number; width: number; height: number; dropDistance: number };
      }>;
      mechanics: Array<{ id: string; params: Record<string, number> }>;
      tiles: string[];
    };
    const zones = source.traps
      .filter((t) => t.type === 'crusher')
      .map((t) => {
        const { col, row, width, height, dropDistance } = t.params;
        return { x: col * 16, y: (row + height) * 16, w: width * 16, h: dropDistance };
      });
    expect(zones.length).toBeGreaterThanOrEqual(1);

    // Body AABB at the dock: 16x16 anchored at (destX, destY).
    const disjoint = (dock: { x: number; y: number }) =>
      zones.every(
        (z) =>
          dock.x + 16 <= z.x ||
          dock.x >= z.x + z.w ||
          dock.y + 16 <= z.y ||
          dock.y >= z.y + z.h,
      );
    // Pin 1: the shipped dock is clear of every crusher zone.
    const dock = source.mechanics.find((m) => m.id === 'finale-tp-a')!.params;
    expect(disjoint({ x: dock.destX!, y: dock.destY! })).toBe(true);
    // Negative probe: the PRE-FIX dock (112,256) sat inside the zone.
    expect(disjoint({ x: 112, y: 256 })).toBe(false);
    // Pin 2: the dock is standable - solid support at (row 17, col 4).
    expect(source.tiles[17]![4]).toBe('1');

    // Sanity anchors for the elevator: docks flush with the pillar top.
    const plat = source.mechanics.find((m) => m.id === 'finale-platform-left')!;
    expect(plat.params.startX!).toBe(64);
    expect(plat.params.startY!).toBe(272);
    expect(plat.params.dy!).toBe(-64);
    expect(plat.params.distance!).toBe(64);
  });
});
