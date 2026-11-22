// Senja Heist — combat, the fallback the crew hopes not to need.
//
// Stealth is the plan; this file is what happens when the plan fails. A
// punch is short, quiet, and only works up close and in front of the thief
// — a guard who goes down stays down twelve seconds and then wakes up
// searching, not dead. The silenced pistol is the louder fallback: one
// shot drops a guard for twenty seconds, but the shot itself costs heat
// and a little alarm, and ammo is scarce on purpose. Nothing here kills
// anyone. Getting caught should be the player's mistake, not a lost
// firefight, so both tools are deliberately weaker than staying unseen.
//
// This module never imports another worker's file: bullets test walls
// against the room's and city's own rect lists, and cooldowns live on the
// combat object itself, so it keeps working while the other modules land.

import { THIEF, ALARM, HEAT } from './config.js';

/** Bullet speed in pixels per second. */
const BULLET_SPEED = 640;
/** Seconds a bullet lives before it fizzles out. */
const BULLET_LIFE = 0.9;
/** How close a bullet must pass to count as a hit. */
const BULLET_HIT_RANGE = 20;
/** Seconds a punched guard or officer stays down. */
const PUNCH_DOWN_SECONDS = 12;
/** Seconds a shot guard or officer stays down. */
const SHOT_DOWN_SECONDS = 20;
/** Smallest gap between punches, and between shots, in seconds. */
const PUNCH_GAP = 0.5;
const SHOT_GAP = 0.35;
/** A punch only lands on someone roughly in front of the thief. */
const PUNCH_ARC = 1.1;
/** Logical view size: the pointer is read against its centre. */
const VIEW_CENTRE = { x: 640, y: 360 };

/** True when (x, y) is inside a solid rect of the room or the city. */
function pointIsSolid(state, x, y) {
  const room = state.room;
  if (room) {
    if (x < 0 || y < 0 || x > room.w || y > room.h) return true;
    for (const rect of room.walls ?? []) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return true;
    }
    for (const rect of room.cover ?? []) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) return true;
    }
    for (const door of room.doors ?? []) {
      if (!door.open && x >= door.x && x <= door.x + door.w && y >= door.y && y <= door.y + door.h) return true;
    }
  }
  const city = state.city;
  if (city) {
    if (x < 0 || y < 0 || x > city.w || y > city.h) return true;
    for (const block of city.blocks ?? []) {
      if (x >= block.x && x <= block.x + block.w && y >= block.y && y <= block.y + block.h) return true;
    }
  }
  return false;
}

/** Wrap an angle difference into [-PI, PI]. */
function wrapAngle(diff) {
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/** Guards on foot plus any police units, as one list of hittable bodies. */
function hittableBodies(state) {
  const bodies = [];
  for (const guard of state.guards ?? []) {
    if (!guard.down) bodies.push(guard);
  }
  for (const unit of state.police?.units ?? []) {
    if (!unit.down) bodies.push(unit);
  }
  return bodies;
}

/** Put a body down for `seconds`: it wakes up searching, not patrolling. */
function knockDown(body, seconds) {
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
 * Fly every bullet forward. A bullet dies on a wall, on a building, at the
 * edge of the map, or when its life runs out — and one shot puts a guard
 * down for twenty seconds, which is a long time to walk past him.
 */
export function stepCombat(state, dt) {
  const combat = state.combat;
  if (!combat) return;
  const kept = [];
  for (const bullet of combat.bullets) {
    bullet.x += Math.cos(bullet.angle) * bullet.speed * dt;
    bullet.y += Math.sin(bullet.angle) * bullet.speed * dt;
    bullet.life -= dt;
    if (bullet.life <= 0 || pointIsSolid(state, bullet.x, bullet.y)) continue;
    let spent = false;
    for (const body of hittableBodies(state)) {
      if (Math.hypot(body.x - bullet.x, body.y - bullet.y) <= BULLET_HIT_RANGE) {
        knockDown(body, SHOT_DOWN_SECONDS);
        spent = true;
        break;
      }
    }
    if (!spent) kept.push(bullet);
  }
  combat.bullets = kept;
}

/**
 * Punch the nearest guard or officer inside range and roughly in front of
 * the thief. A hit is silent and drops him for twelve seconds. A whiff is
 * not silent: the swing whooshes loud enough to nudge the alarm, so
 * punching at air is a mistake the room hears.
 */
export function punch(state) {
  const combat = state.combat;
  const player = state.player;
  if (!combat || !player) return false;
  if (state.time - combat.lastPunch < PUNCH_GAP) return false;
  combat.lastPunch = state.time;

  let best = null;
  let bestDist = THIEF.punchRange;
  for (const body of hittableBodies(state)) {
    const dx = body.x - player.x;
    const dy = body.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > bestDist) continue;
    if (Math.abs(wrapAngle(Math.atan2(dy, dx) - player.facing)) > PUNCH_ARC) continue;
    best = body;
    bestDist = dist;
  }
  if (!best) {
    state.alarm = Math.min(100, state.alarm + ALARM.riseNoise);
    return false;
  }
  knockDown(best, PUNCH_DOWN_SECONDS);
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
  const player = state.player;
  if (!combat || !player) return false;
  if (player.ammo <= 0) return false;
  if (state.car?.inUse) return false;
  if (state.time - combat.lastShot < SHOT_GAP) return false;
  combat.lastShot = state.time;

  let angle = player.facing;
  const pointer = state.input?.pointer?.();
  if (pointer?.inside) {
    angle = Math.atan2(pointer.y - VIEW_CENTRE.y, pointer.x - VIEW_CENTRE.x);
  }
  player.facing = angle;
  player.ammo -= 1;
  combat.bullets.push({
    x: player.x + Math.cos(angle) * (THIEF.radius + 6),
    y: player.y + Math.sin(angle) * (THIEF.radius + 6),
    angle,
    speed: BULLET_SPEED,
    life: BULLET_LIFE,
  });
  state.alarm = Math.min(100, state.alarm + ALARM.riseNoise / 2);
  state.heat = Math.min(HEAT.max, (state.heat ?? 0) + HEAT.perShot);
  return true;
}
