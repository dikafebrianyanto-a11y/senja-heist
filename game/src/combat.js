// combat.js — what happens when staying unseen stops working.
//
// Stealth is the plan; this is the fallback. A punch is short, quiet, and
// only lands up close and roughly in front — a guard who goes down stays
// down a while, then wakes up searching, never dead. The silenced pistol
// is the louder fallback: one shot drops a guard longer, but the shot
// costs heat and a little alarm, and ammo is scarce on purpose. A smoke
// bomb buys a different kind of escape: a cloud the guards cannot see
// through, bought with a charge from the thief's pocket. And a disguise,
// while the thief is walking rather than sprinting, halves how far a
// guard's eyes reach. Nobody dies here; getting caught is the player's
// mistake, not a lost firefight.

import { THIEF, ALARM, HEAT } from './config.js';
import { smokeCloud } from './effects.js';

/** How fast a bullet travels, px per second. */
const SHOT_SPEED = 640;
/** Seconds a bullet stays in the air before it fizzles. */
const SHOT_TTL = 0.9;
/** How close a bullet must pass a body to count as a hit. */
const SHOT_HIT_DIST = 20;
/** Seconds a punched guard or officer stays on the floor. */
const DOWN_AFTER_PUNCH = 12;
/** Seconds a shot guard or officer stays on the floor. */
const DOWN_AFTER_SHOT = 20;
/** Smallest gap between two punches, and between two shots. */
const PUNCH_COOLDOWN = 0.5;
const SHOT_COOLDOWN = 0.35;
/** A punch only lands on someone roughly ahead of the thief, in radians. */
const PUNCH_HALF_ARC = 1.1;
/** Centre of the 1280x720 view, which the pointer is read against. */
const AIM_CENTER = { x: 640, y: 360 };

/** True when the point (x, y) lies inside the rect. */
function insideRect(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/** True when (x, y) is inside a solid rect of the room or the city. */
function solidPoint(state, x, y) {
  const room = state.room;
  if (room) {
    if (x < 0 || y < 0 || x > room.w || y > room.h) return true;
    for (const wall of room.walls ?? []) if (insideRect(wall, x, y)) return true;
    for (const block of room.cover ?? []) if (insideRect(block, x, y)) return true;
    for (const door of room.doors ?? []) {
      if (!door.open && insideRect(door, x, y)) return true;
    }
  }
  const city = state.city;
  if (city) {
    if (x < 0 || y < 0 || x > city.w || y > city.h) return true;
    for (const block of city.blocks ?? []) if (insideRect(block, x, y)) return true;
  }
  return false;
}

/** Fold an angle difference into the [-PI, PI] range. */
function foldAngle(diff) {
  return Math.atan2(Math.sin(diff), Math.cos(diff));
}

/** Guards on foot and police units, as one list of bodies still standing. */
function uprightTargets(state) {
  const out = [];
  for (const guard of state.guards ?? []) if (!guard.down) out.push(guard);
  for (const unit of state.police?.units ?? []) if (!unit.down) out.push(unit);
  return out;
}

/** Put a body on the floor for `seconds`: it wakes up searching, not patrolling. */
function floorBody(body, seconds) {
  body.down = true;
  body.downTimer = seconds;
  body.suspicion = 0;
  body.lastSeen = null;
  if (body.mode) body.mode = 'search';
  if (typeof body.searchTimer === 'number') body.searchTimer = 0;
}

/** A fresh combat state: the bullet list and the two cooldown clocks. */
export function createCombat() {
  return { bullets: [], lastPunch: -99, lastShot: -99 };
}

/**
 * Refresh the disguise's effect on guard sight: while the thief walks in
 * disguise — moving, not sprinting — guards see half as far, so stealthMul
 * is 2; otherwise it is 1. stealth.js divides its sight range by this.
 * The value is written every step, so taking the disguise off (or
 * breaking into a sprint) restores full sight range on the next frame.
 */
function refreshDisguise(state) {
  const thief = state.player;
  if (!thief) return;
  const disguisedWalk = Boolean(state.tools?.disguise) && thief.moving && !thief.sprinting;
  thief.stealthMul = disguisedWalk ? 2 : 1;
}

/**
 * Fly every bullet forward. A bullet dies on a wall, a building, the edge
 * of the map, or when its life runs out — and one shot puts a guard down
 * long enough to walk straight past him. With no bullets in the air there
 * is nothing to fly, so the loop is skipped outright.
 */
export function stepCombat(state, dt) {
  refreshDisguise(state);
  const combat = state.combat;
  if (!combat || combat.bullets.length === 0) return;
  const alive = [];
  for (const shot of combat.bullets) {
    shot.x += Math.cos(shot.angle) * shot.speed * dt;
    shot.y += Math.sin(shot.angle) * shot.speed * dt;
    shot.life -= dt;
    if (shot.life <= 0 || solidPoint(state, shot.x, shot.y)) continue;
    let landed = false;
    for (const body of uprightTargets(state)) {
      if (Math.hypot(body.x - shot.x, body.y - shot.y) > SHOT_HIT_DIST) continue;
      floorBody(body, DOWN_AFTER_SHOT);
      landed = true;
      break;
    }
    if (!landed) alive.push(shot);
  }
  combat.bullets = alive;
}

/**
 * Punch the nearest guard or officer inside range and roughly ahead of
 * the thief. A hit is silent and drops him for a while. A whiff is not
 * silent: the swing whooshes loud enough to nudge the alarm, so punching
 * at air is a mistake the room hears.
 */
export function punch(state) {
  const combat = state.combat;
  const thief = state.player;
  if (!combat || !thief) return false;
  if (state.time - combat.lastPunch < PUNCH_COOLDOWN) return false;
  combat.lastPunch = state.time;

  let target = null;
  let targetDist = THIEF.punchRange;
  for (const body of uprightTargets(state)) {
    const dx = body.x - thief.x;
    const dy = body.y - thief.y;
    const dist = Math.hypot(dx, dy);
    if (dist > targetDist) continue;
    const offAngle = Math.abs(foldAngle(Math.atan2(dy, dx) - thief.facing));
    if (offAngle > PUNCH_HALF_ARC) continue;
    target = body;
    targetDist = dist;
  }
  if (!target) {
    state.alarm = Math.min(100, (state.alarm ?? 0) + ALARM.riseNoise);
    return false;
  }
  floorBody(target, DOWN_AFTER_PUNCH);
  return true;
}

/**
 * Fire the silenced pistol once. False with no ammo, on cooldown, or while
 * driving — the driver shoots with the car, not a handgun. The bullet flies
 * toward the mouse: the pointer is read against the centre of the 1280x720
 * view, which is exact when the canvas is shown at logical size and still
 * points at the right quarter of the screen when it is scaled. With the
 * pointer off the canvas, the shot goes where the thief is facing. Every
 * shot costs one ammo, a little alarm, and one heat — the street remembers
 * gunfire even when the room does not.
 */
export function shoot(state) {
  const combat = state.combat;
  const thief = state.player;
  if (!combat || !thief) return false;
  if (thief.ammo <= 0) return false;
  if (state.car?.inUse) return false;
  if (state.time - combat.lastShot < SHOT_COOLDOWN) return false;
  combat.lastShot = state.time;

  let angle = thief.facing;
  const pointer = state.input?.pointer?.();
  if (pointer?.inside) {
    angle = Math.atan2(pointer.y - AIM_CENTER.y, pointer.x - AIM_CENTER.x);
  }
  thief.facing = angle;
  thief.ammo -= 1;
  combat.bullets.push({
    x: thief.x + Math.cos(angle) * (THIEF.radius + 6),
    y: thief.y + Math.sin(angle) * (THIEF.radius + 6),
    angle,
    speed: SHOT_SPEED,
    life: SHOT_TTL,
  });
  state.alarm = Math.min(100, (state.alarm ?? 0) + ALARM.riseNoise / 2);
  state.heat = Math.min(HEAT.max, HEAT.perShot + (state.heat ?? 0));
  return true;
}

/**
 * Drop a smoke cloud on the thief's position. The charge itself is spent
 * by main.js's trySmoke, which drops both counts — the thief's carried
 * charges and the crew's tool stock — together, so a save/load round-trip
 * cannot duplicate one; this function only checks that a charge exists
 * and pops the cloud. No sound is played here — audio belongs to main.js.
 * Returns true when a cloud went down, false when there was no charge.
 */
export function useSmokeBomb(state) {
  const thief = state.player;
  if (!thief) return false;
  const carried = typeof thief.smoke === 'number' ? thief.smoke : 0;
  const stocked = typeof state.tools?.smoke === 'number' ? state.tools.smoke : 0;
  if (carried <= 0 && stocked <= 0) return false;
  smokeCloud(state, thief.x, thief.y);
  return true;
}
