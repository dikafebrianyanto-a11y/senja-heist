// player.js — Mara Voss, the thief the player drives.
//
// Top-down movement with three gaits: crouch is slow and quiet and makes
// Mara harder to spot, a walk is the working pace, a sprint is fast and
// loud. Everything she lifts has weight, and past a threshold the bag
// drags her down — a full haul is a slow walk to the exit. Collision is
// axis-separated against the room's walls and cover during a heist and
// against the city's building blocks on foot during a getaway, so she
// slides along a wall instead of sticking to it.

import { THIEF, SCREEN } from './config.js';
import { roomSolidAt, citySolidAt } from './world.js';

/** How far past the weight threshold the thief can still be slowed. */
const MIN_SPEED = 42;

/**
 * Fresh thief at a spawn point, matching the shared player shape:
 * position, facing, gait flags, noise the guards can hear, carried loot
 * and its weight, health, ammo, and the action cooldowns main.js reads.
 */
export function createThief(x, y) {
  return {
    x,
    y,
    facing: 0,
    speed: 0,
    crouched: false,
    moving: false,
    noise: 0,
    noiseTimer: 0,
    weight: 0,
    carrying: [],
    hp: THIEF.hp,
    maxHp: THIEF.hp,
    ammo: THIEF.ammoStart,
    disguised: false,
    disguiseTimer: 0,
    hidden: false,
    punchTimer: 0,
    shootTimer: 0,
  };
}

/**
 * Current effective speed: the gait's base pace, minus a penalty for
 * every kilo carried past the threshold where the bag starts to drag.
 * Crouching with a heavy bag is the slowest Mara ever moves.
 */
export function thiefSpeed(state) {
  const player = state.player;
  if (!player) return 0;
  const base = player.crouched ? THIEF.crouch : THIEF.walk;
  // Sprint is a live gait flag on the step call, not stored on the
  // player, so this stored pace is walk/crouch; stepThief folds the
  // sprint pace in through `player.speed` while a sprint is happening.
  const excess = Math.max(0, player.weight - THIEF.weightSlowsAt);
  return Math.max(MIN_SPEED, base - excess * THIEF.weightSlowPerKg);
}

/** Live pace for this step, given the move's gait flags. */
function paceFor(state, move) {
  const player = state.player;
  const base = move.crouch ? THIEF.crouch : move.sprint ? THIEF.sprint : THIEF.walk;
  const excess = Math.max(0, player.weight - THIEF.weightSlowsAt);
  return Math.max(MIN_SPEED, base - excess * THIEF.weightSlowPerKg);
}

/** Noise radius thrown by the current gait, or 0 while standing still. */
function noiseFor(move, moving) {
  if (!moving) return 0;
  if (move.crouch) return THIEF.noiseCrouch;
  if (move.sprint) return THIEF.noiseSprint;
  return THIEF.noiseWalk;
}

/**
 * True when a circle of the thief's radius centred at (x, y) would touch
 * anything solid in the place she is standing in right now.
 */
function bodyBlocked(state, x, y) {
  const r = THIEF.radius;
  const probes = [
    [x, y - r], [x, y + r], [x - r, y], [x + r, y],
    [x - r * 0.7, y - r * 0.7], [x + r * 0.7, y - r * 0.7],
    [x - r * 0.7, y + r * 0.7], [x + r * 0.7, y + r * 0.7],
  ];
  if (state.screen === SCREEN.GETAWAY && state.city) {
    return probes.some(([px, py]) => citySolidAt(state.city, px, py));
  }
  if (state.room) {
    return probes.some(([px, py]) => roomSolidAt(state.room, px, py));
  }
  if (state.city) {
    return probes.some(([px, py]) => citySolidAt(state.city, px, py));
  }
  return false;
}

/**
 * Advance the thief one fixed step. `move` is a normalised vector plus
 * gait flags. Sets `moving`, `facing`, `speed`, `crouched` and `noise`;
 * ticks the action and disguise timers down; walks axis by axis so a
 * diagonal push slides along a wall instead of stopping dead.
 */
export function stepThief(state, dt, move) {
  const player = state.player;
  if (!player || !move) return;
  if (player.punchTimer > 0) player.punchTimer = Math.max(0, player.punchTimer - dt);
  if (player.shootTimer > 0) player.shootTimer = Math.max(0, player.shootTimer - dt);
  if (player.disguiseTimer > 0) {
    player.disguiseTimer = Math.max(0, player.disguiseTimer - dt);
    if (player.disguiseTimer === 0) player.disguised = false;
  }

  player.crouched = Boolean(move.crouch);
  const mx = move.x ?? 0;
  const my = move.y ?? 0;
  const len = Math.hypot(mx, my);
  player.moving = len > 0.01;
  if (!player.moving) {
    player.speed = 0;
    if (player.noiseTimer > 0) {
      player.noiseTimer = Math.max(0, player.noiseTimer - dt);
      if (player.noiseTimer === 0) player.noise = 0;
    } else {
      player.noise = 0;
    }
    return;
  }
  const nx = mx / len;
  const ny = my / len;
  player.facing = Math.atan2(ny, nx);
  const pace = paceFor(state, move);
  player.speed = pace;
  const stepX = nx * pace * dt;
  const stepY = ny * pace * dt;
  if (!bodyBlocked(state, player.x + stepX, player.y)) player.x += stepX;
  if (!bodyBlocked(state, player.x, player.y + stepY)) player.y += stepY;
  player.noise = noiseFor(move, true);
  player.noiseTimer = 0.25;
}

/**
 * Take a loot item into the bag. Returns false when it is already taken
 * (or there is no thief); otherwise marks it, adds its weight, and books
 * its value into the run's taken total.
 */
export function grabLoot(state, item) {
  if (!item || item.taken || !state.player) return false;
  item.taken = true;
  state.player.carrying.push(item);
  state.player.weight += item.weight ?? 0;
  if (state.stats) state.stats.taken += item.value ?? 0;
  return true;
}

/** Hurt the thief, clamping health at zero; main.js busts at zero. */
export function thiefHurt(state, dmg) {
  if (!state.player) return;
  state.player.hp = Math.max(0, state.player.hp - (dmg ?? 0));
}
