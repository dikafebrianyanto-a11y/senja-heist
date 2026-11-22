// player.js — Mara Voss, the thief on foot.
//
// Three gaits, three noise levels. Crouching creeps along slow and quiet
// and makes her a smaller target; walking is the working pace; sprinting
// is fast and loud enough for the whole floor to hear. Everything she
// lifts has weight, and past a threshold the bag drags her down, so a full
// haul is a slow walk to the door. Walls are tested one axis at a time,
// which lets a diagonal push slide along a wall instead of jamming.
// Smoke charges ride in her pocket, topped up from the crew's tool bag
// when a job starts, and the leader's speed bonus stretches every gait.
// The step also records whether she is sprinting right now, so combat can
// tell a disguised walk apart from a disguised sprint.

import { THIEF, SCREEN } from './config.js';
import { roomSolidAt, citySolidAt } from './world.js';

/** Floor on the pace: no load ever drags Mara below this, px per second. */
const PACE_FLOOR = 42;

/** Probe directions for wall tests, as fractions of the thief's radius. */
const PROBE_DIRS = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7],
];

/**
 * A fresh thief at a spawn point. `tools` is optional: when the caller
 * hands over the crew's tool bag, the smoke charges carried come from it;
 * otherwise the pocket starts empty and the first step syncs it from
 * state.tools instead. `speedMul` starts at 1 and is stretched by whoever
 * applies the leader's crew bonus; `smokeSynced` records which source the
 * pocket was filled from, so the first step never tops it up twice.
 */
export function createThief(x, y, tools) {
  return {
    x,
    y,
    facing: 0,
    speed: 0,
    sprinting: false,
    crouched: false,
    moving: false,
    noise: 0,
    noiseTimer: 0,
    weight: 0,
    carrying: [],
    hp: THIEF.hp,
    maxHp: THIEF.hp,
    ammo: THIEF.ammoStart,
    smoke: tools?.smoke ?? 0,
    smokeSynced: tools !== undefined,
    speedMul: 1,
    disguised: false,
    disguiseTimer: 0,
    hidden: false,
    punchTimer: 0,
    shootTimer: 0,
  };
}

/** Kilos past the threshold, expressed as a pace penalty in px per second. */
function loadDrag(thief) {
  const over = Math.max(0, thief.weight - THIEF.weightSlowsAt);
  return over * THIEF.weightSlowPerKg;
}

/** The leader's speed bonus, or 1 when nobody set one. */
function paceBonus(thief) {
  return typeof thief.speedMul === 'number' ? thief.speedMul : 1;
}

/** Base pace for a gait, before load and before the leader's bonus. */
function gaitBase(move) {
  if (move.crouch) return THIEF.crouch;
  if (move.sprint) return THIEF.sprint;
  return THIEF.walk;
}

/** Live pace for this step: gait pace, stretched by the bonus, dragged by the bag. */
function livePace(state, move) {
  const thief = state.player;
  const raw = gaitBase(move) * paceBonus(thief);
  return Math.max(PACE_FLOOR, raw - loadDrag(thief));
}

/**
 * The pace the HUD and other modules read: walk or crouch only, since
 * sprint is a live flag on the step rather than a stored gait — with the
 * same bonus and load rules as the live pace.
 */
export function thiefSpeed(state) {
  const thief = state.player;
  if (!thief) return 0;
  const base = thief.crouched ? THIEF.crouch : THIEF.walk;
  const raw = base * paceBonus(thief);
  return Math.max(PACE_FLOOR, raw - loadDrag(thief));
}

/** Noise radius for the gait being used, or silence while standing still. */
function gaitNoise(move, moving) {
  if (!moving) return 0;
  if (move.crouch) return THIEF.noiseCrouch;
  if (move.sprint) return THIEF.noiseSprint;
  return THIEF.noiseWalk;
}

// A sprint that starts from a standstill still counts as moving: the
// noise for the step is set from the gait flags, not from the speed.

/** Tick the action and disguise timers down by dt, never below zero. */
function tickTimers(thief, dt) {
  if (thief.punchTimer > 0) thief.punchTimer = Math.max(0, thief.punchTimer - dt);
  if (thief.shootTimer > 0) thief.shootTimer = Math.max(0, thief.shootTimer - dt);
  if (thief.disguiseTimer > 0) {
    thief.disguiseTimer = Math.max(0, thief.disguiseTimer - dt);
    if (thief.disguiseTimer === 0) thief.disguised = false;
  }
}

/**
 * True when a circle of the thief's radius around (x, y) touches anything
 * solid where she is standing: room walls and cover during a heist, city
 * blocks on foot during a getaway.
 */
function blockedAt(state, x, y) {
  const r = THIEF.radius;
  let solid = null;
  if (state.screen === SCREEN.GETAWAY && state.city) {
    solid = (px, py) => citySolidAt(state.city, px, py);
  } else if (state.room) {
    solid = (px, py) => roomSolidAt(state.room, px, py);
  } else if (state.city) {
    solid = (px, py) => citySolidAt(state.city, px, py);
  }
  if (!solid) return false;
  return PROBE_DIRS.some(([dx, dy]) => solid(x + dx * r, y + dy * r));
}

/** Fade the noise out once the thief stops moving. */
function settleNoise(thief, dt) {
  if (thief.noiseTimer > 0) {
    thief.noiseTimer = Math.max(0, thief.noiseTimer - dt);
    if (thief.noiseTimer === 0) thief.noise = 0;
  } else {
    thief.noise = 0;
  }
}

/**
 * Advance the thief one fixed step. `move` is a normalised direction plus
 * gait flags. Updates moving, facing, speed, sprinting, crouched and noise,
 * ticks the timers, and walks axis by axis so a diagonal push slides
 * along a wall instead of stopping dead.
 */
export function stepThief(state, dt, move) {
  const thief = state.player;
  if (!thief || !move) return;
  tickTimers(thief, dt);
  // Fill the pocket once from the crew's tool bag, the first step of the
  // job. After that the count is the thief's own: spending a charge in
  // combat must never be undone by a later step re-reading the bag.
  if (typeof thief.smoke !== 'number') thief.smoke = state.tools?.smoke ?? 0;
  if (!thief.smokeSynced && typeof state.tools?.smoke === 'number') {
    thief.smoke = state.tools.smoke;
    thief.smokeSynced = true;
  }

  thief.crouched = Boolean(move.crouch);
  const mx = move.x ?? 0;
  const my = move.y ?? 0;
  const len = Math.hypot(mx, my);
  thief.moving = len > 0.01;
  thief.sprinting = thief.moving && Boolean(move.sprint);
  if (!thief.moving) {
    thief.speed = 0;
    settleNoise(thief, dt);
    return;
  }
  const nx = mx / len;
  const ny = my / len;
  thief.facing = Math.atan2(ny, nx);
  const pace = livePace(state, move);
  thief.speed = pace;
  const dx = nx * pace * dt;
  const dy = ny * pace * dt;
  if (!blockedAt(state, thief.x + dx, thief.y)) thief.x += dx;
  if (!blockedAt(state, thief.x, thief.y + dy)) thief.y += dy;
  thief.noise = gaitNoise(move, true);
  thief.noiseTimer = 0.25;
}

/**
 * Take a loot item into the bag. False when it is already taken or there
 * is no thief; otherwise it is marked, its weight joins the bag, and its
 * value joins the run's taken total.
 */
export function grabLoot(state, item) {
  const thief = state.player;
  if (!thief || !item || item.taken) return false;
  item.taken = true;
  thief.carrying.push(item);
  thief.weight += item.weight ?? 0;
  if (state.stats) state.stats.taken += item.value ?? 0;
  return true;
}

/** Hurt the thief, clamping health at zero; main.js busts at zero. */
export function thiefHurt(state, dmg) {
  const thief = state.player;
  if (!thief) return;
  thief.hp = Math.max(0, thief.hp - (dmg ?? 0));
}
