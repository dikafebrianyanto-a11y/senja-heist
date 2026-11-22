// Senja Heist — deterministic screenshot scenes for ?shot=cover|plan|getaway.
// Each scene plays the real rules forward from a fresh seeded state for a
// fixed number of ticks, steered by a tiny autopilot, so the frame is what
// a short stretch of real play looks like and the same seed always gives
// the same frame. Nothing here hand-places pixels: the room, the guards,
// the cameras, the traffic and the police all come out of the same module
// functions the live game uses, driven through the `mods` bundle main.js
// passes in. Unknown shot name falls back to the cover.
//
// runShot() in main.js has already built the city, the traffic, the crew,
// the police, the combat state and the effects pool before calling this;
// stageShot only has to open the job, steer, and report the screen.

import { SCREEN, STEP } from './config.js';
import { createSeeded, hashSeed } from './random.js';

export const SHOT_NAMES = ['cover', 'plan', 'getaway'];

// How long each scene runs forward, in fixed 60 Hz ticks.
const COVER_TICKS = 150;
const GETAWAY_TICKS = 540;
// The gallery (job index 2) is the cover job: it has a vault, three guards
// and three cameras, so one frame holds everything the cover needs.
const COVER_JOB = 2;
// The getaway follows the jewellers job: a mid-campaign score, heat 3.
const GETAWAY_JOB = 1;
// The staged alarm reading for the cover: warm, not locked down.
const COVER_ALARM = 38;

/** A move vector with no input: the thief stands still. */
const STILL = { x: 0, y: 0, crouch: false, sprint: false };

/** Wrap an angle difference into [-PI, PI]. */
function wrapAngle(angle) {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Open a job the way the live game does — same seeded room stream, same
 * order of module calls — but as a local helper, because main.js's own
 * startJob is not part of the mods bundle.
 */
function openJob(state, mods, index) {
  const job = mods.jobFor(index);
  const roomSeed = createSeeded(hashSeed(`room:${job.id}:${state.seed}`));
  state.mission = job;
  state.jobIndex = index;
  state.room = mods.buildRoom(roomSeed, job);
  state.guards = mods.createGuards(roomSeed, state.room, job);
  state.cameras = mods.createCameras(roomSeed, state.room, job);
  state.loot = mods.createLoot(roomSeed, state.room, job);
  state.vault = mods.createVault(job);
  state.player = mods.createThief(state.room.entry.x, state.room.entry.y);
  state.crew = mods.createCrew();
  state.combat = mods.createCombat();
  state.police = mods.createPolice();
  state.alarm = 0;
  state.lockdown = false;
  state.lockdownTimer = 0;
  state.stats.taken = 0;
  state.stats.timeInRoom = 0;
  state.objectives = mods.jobObjectives(state);
  state.payout = null;
  state.bustReason = '';
  state.screen = SCREEN.HEIST;
}

/** One fixed step of the heist room, in the same order main.js steps it. */
function stepRoom(state, mods, move) {
  state.time += STEP;
  if (state.bannerTimer > 0) state.bannerTimer = Math.max(0, state.bannerTimer - STEP);
  if (state.fx) mods.stepEffects(state, STEP);
  if (state.audio) mods.audioStep(state.audio, state, STEP);
  state.stats.timeInRoom += STEP;
  if (state.player) mods.stepThief(state, STEP, move);
  mods.stepCrew(state, STEP);
  mods.stepGuards(state, STEP);
  mods.stepCameras(state, STEP);
  mods.stepAlarm(state, STEP);
  mods.stepVault(state, STEP);
  mods.stepCombat(state, STEP);
  state.objectives = mods.jobObjectives(state);
}

/** One fixed step of the getaway, in the same order main.js steps it. */
function stepStreet(state, mods, drive) {
  state.time += STEP;
  if (state.bannerTimer > 0) state.bannerTimer = Math.max(0, state.bannerTimer - STEP);
  if (state.fx) mods.stepEffects(state, STEP);
  if (state.audio) mods.audioStep(state.audio, state, STEP);
  if (state.car && state.car.inUse) mods.stepCar(state, STEP, drive);
  else if (state.player) mods.stepThief(state, STEP, STILL);
  mods.stepTraffic(state, STEP);
  mods.stepPolice(state, STEP);
  mods.lowerHeat(state, STEP);
}

/** The nearest loot the thief has not taken yet, or null. */
function nearestLoot(state) {
  let best = null;
  let bestDistance = Infinity;
  for (const item of state.loot) {
    if (item.taken) continue;
    const distance = Math.hypot(item.x - state.player.x, item.y - state.player.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = item;
    }
  }
  return best;
}

/**
 * Cover: Mara mid-crossing in the gallery, guards on patrol, a camera
 * sweeping, the vault glinting, the alarm meter warm. The autopilot walks
 * her from the entry toward the nearest loot, grabs it when close, then
 * heads for the exit — two and a half seconds of real play.
 */
function stageCover(state, mods) {
  openJob(state, mods, COVER_JOB);
  let grabbed = false;
  for (let tick = 0; tick < COVER_TICKS; tick += 1) {
    const target = grabbed ? state.room.exit : nearestLoot(state);
    let move = STILL;
    if (target && state.player) {
      const dx = target.x - state.player.x;
      const dy = target.y - state.player.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 4) {
        move = { x: dx / distance, y: dy / distance, crouch: false, sprint: false };
      }
      if (!grabbed && nearestLoot(state) && distance <= 48) {
        const item = nearestLoot(state);
        if (mods.grabLoot(state, item)) {
          mods.floatText(state, item.x, item.y - 20, `+$${item.value}`, '#f5c542');
          mods.burst(state, item.x, item.y, '#f5c542', 10);
          grabbed = true;
        }
      }
    }
    stepRoom(state, mods, move);
    // Keep the frame honest: if a guard catches her mid-staging, stop
    // walking her into the same guard and let the patrols settle.
    if (state.player && state.player.hp <= 0) break;
  }
  // A few sparks off the vault so the gold in the room reads at a glance.
  if (state.room.vaultSpot) {
    mods.burst(state, state.room.vaultSpot.x, state.room.vaultSpot.y, '#f5c542', 8);
  }
  state.alarm = COVER_ALARM;
  state.lockdown = false;
  state.banner = 'The Quiet Gallery — lift the art, reach the exit.';
  state.bannerTimer = 3;
  return { screen: SCREEN.HEIST };
}

/**
 * Plan: the planning board one job in, with the first score banked and the
 * gallery highlighted — the job list, the shop and the crew's cash all
 * visible in one frame.
 */
function stagePlan(state, mods) {
  void mods;
  state.cash = 5200;
  state.bestCash = 5200;
  state.jobsDone = 1;
  state.jobIndex = 2;
  state.tools.lockpick = true;
  state.plan.cursor = 2;
  state.screen = SCREEN.PLAN;
  return { screen: SCREEN.PLAN };
}

/**
 * Getaway: the car rolling for the safehouse with the heat on and police
 * closing in from behind. Nine seconds of real driving: the autopilot
 * steers toward the safehouse while the pursuit spawns and chases under
 * the real police rules.
 */
function stageGetaway(state, mods) {
  openJob(state, mods, GETAWAY_JOB);
  const spawn = state.city ? state.city.carSpawn : { x: 1340, y: 800 };
  state.car = mods.createCar(spawn.x, spawn.y, 'sedan');
  mods.enterCar(state);
  if (state.player) {
    state.player.x = spawn.x;
    state.player.y = spawn.y;
  }
  mods.raiseHeat(state, 3);
  state.screen = SCREEN.GETAWAY;
  const safe = state.city ? mods.citySafehouse(state.city) : null;
  for (let tick = 0; tick < GETAWAY_TICKS; tick += 1) {
    let drive = { forward: 1, reverse: 0, steer: 0 };
    if (state.car && safe) {
      const bearing = Math.atan2(safe.y - state.car.y, safe.x - state.car.x);
      drive.steer = clamp(wrapAngle(bearing - state.car.angle) * 1.6, -1, 1);
    }
    stepStreet(state, mods, drive);
    if (state.car && state.car.hp <= 0) break;
    if (state.screen !== SCREEN.GETAWAY) break;
  }
  state.banner = 'Get to the safehouse. Lose the heat.';
  state.bannerTimer = 3;
  return { screen: SCREEN.GETAWAY };
}

/**
 * Stage the named scene on the fresh state main.js built and return the
 * screen to draw. Unknown names stage the cover.
 */
export function stageShot(name, state, mods) {
  if (name === 'plan') return stagePlan(state, mods);
  if (name === 'getaway') return stageGetaway(state, mods);
  return stageCover(state, mods);
}
