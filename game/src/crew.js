// crew.js — Senja's crew, the people Mara runs with.
//
// The player drives Mara, so the leader's crew entry is pinned to the
// player's position every tick and never walks on its own. The other
// three each do a job: Iko Tan hacks cameras and cracks the vault,
// Sable Wren shadows the crew at a distance and keeps a guard tagged
// for the HUD, and Reno Kartika parks himself by the way out — the
// room exit mid-heist, the safehouse once the getaway is on.
//
// As the crew pulls off jobs they pick up experience. Every member
// carries an xp total and a level derived from it; higher levels pay
// out as small multipliers on the things each person is good at, so a
// veteran crew moves a little faster, spots a little further, and
// keeps cameras dark a little longer.

import { SCREEN } from './config.js';
import { roomSolidAt, citySolidAt } from './world.js';

/** Pixels back from Mara where a follower settles while trailing. */
const GAP_CLOSE = 70;
const GAP_WIDE = 115;

/** Base walking pace of a follower chasing their trail spot. */
const PACE_BASE = 205;

/** Iko's camera trick: how close he must be, and how long it lasts. */
const SPOOF_RANGE = 150;
const SPOOF_SECONDS = 10;

/** How far out Sable's tag on a guard can reach. */
const TAG_RANGE = 430;

/** Close enough to a destination to stop walking. */
const CLOSE_ENOUGH = 10;

/** How near the vault Iko must stand before the HUD calls it hacking. */
const AT_VAULT = 46;

/** XP needed for each level step. */
const XP_PER_LEVEL = 100;

/** Per-level bonus rates, keyed by the skill they feed. */
const LEVEL_GAINS = { speed: 0.03, stealth: 0.05, crack: 0.04, drive: 0.05 };

/** Lateral offsets from Mara's trail line, one side per follower. */
const OFFSET_HACKER = -26;
const OFFSET_LOOKOUT = 34;

/**
 * The four people on the job, with starting roles, colours and a
 * 1–5 skill rating each. Skill travels with the person, not the job,
 * so swapping roles on the planning board moves the person and their
 * number together. Everyone starts fresh: zero experience, level one.
 */
export function createCrew() {
  const roster = [
    { id: 'mara', name: 'Mara Voss', role: 'leader', color: '#7ee0c3', x: 0, y: 0, status: 'ready', skill: 4, xp: 0, level: 1 },
    { id: 'iko', name: 'Iko Tan', role: 'hacker', color: '#8fb7ff', x: 0, y: 0, status: 'ready', skill: 5, xp: 0, level: 1 },
    { id: 'reno', name: 'Reno Kartika', role: 'driver', color: '#ffb454', x: 0, y: 0, status: 'waiting', skill: 3, xp: 0, level: 1 },
    { id: 'sable', name: 'Sable Wren', role: 'lookout', color: '#d98cff', x: 0, y: 0, status: 'ready', skill: 4, xp: 0, level: 1 },
  ];
  return roster;
}

/**
 * Level a member sits at from their experience: one plus a level for
 * every full hundred XP banked. Also writes the result back onto the
 * member so the stored level never drifts from the XP total, and
 * hands the level back to the caller.
 */
export function crewLevel(member) {
  const earned = Math.max(0, Math.floor((member.xp || 0) / XP_PER_LEVEL));
  member.level = 1 + earned;
  return member.level;
}

/**
 * Multiplier a member's level gives them on one skill: level one is
 * even money, and each level past the first adds the skill's rate —
 * speed climbs slowest, stealth and drive fastest. Unknown skill
 * names fall back to no bonus rather than blowing up.
 */
export function crewBonus(member, skill) {
  const rate = LEVEL_GAINS[skill];
  if (rate === undefined) return 1;
  const extra = crewLevel(member) - 1;
  return 1 + extra * rate;
}

/**
 * Hand a lump of experience to the whole crew at once — a completed
 * job, a clean vault, a getaway with no alarms. Every member's total
 * grows, their level is refreshed from it, and the call reports back
 * one entry per member who stepped up a level, so the HUD can flash
 * their name.
 */
export function awardCrewXp(state, amount) {
  const promoted = [];
  if (!state.crew || !amount) return promoted;
  for (const member of state.crew) {
    const before = crewLevel(member);
    member.xp = (member.xp || 0) + amount;
    const after = crewLevel(member);
    if (after > before) promoted.push({ id: member.id, name: member.name, leveledUp: true });
  }
  return promoted;
}

/** Whoever is holding a given role right now, or null if it's empty. */
export function crewByRole(state, role) {
  if (!state.crew) return null;
  const holder = state.crew.find((person) => person.role === role);
  return holder === undefined ? null : holder;
}

/**
 * Deal the three working jobs out from the planning board. `picks`
 * pairs each job name with a member id; Mara is always the leader and
 * never in the pool. A pick that names nobody, names a stranger, or
 * repeats a member already placed is dropped. When a job ends up
 * empty after the picks, the first unplaced member takes it, so the
 * crew is never short a hacker, a driver, or a lookout.
 */
export function assignRoles(state, picks) {
  if (!state.crew || !picks) return;
  const pool = state.crew.filter((person) => person.id !== 'mara');
  if (pool.length === 0) return;
  const jobs = ['hacker', 'driver', 'lookout'];
  const seats = { hacker: null, driver: null, lookout: null };
  for (const person of pool) {
    if (person.role === 'hacker' || person.role === 'driver' || person.role === 'lookout') {
      seats[person.role] = person.id;
    }
  }
  const taken = new Set();
  for (const job of jobs) {
    const pick = picks[job];
    if (typeof pick !== 'string') continue;
    const found = pool.some((person) => person.id === pick);
    if (!found || taken.has(pick)) continue;
    for (const other of jobs) {
      if (seats[other] === pick) seats[other] = null;
    }
    seats[job] = pick;
    taken.add(pick);
  }
  for (const job of jobs) {
    if (seats[job]) continue;
    const spare = pool.find((person) => !taken.has(person.id));
    if (!spare) break;
    seats[job] = spare.id;
    taken.add(spare.id);
  }
  for (const person of pool) {
    for (const job of jobs) {
      if (seats[job] === person.id) person.role = job;
    }
    person.status = person.role === 'driver' ? 'waiting' : 'following';
  }
}

/** Straight-line distance between two spots. */
function gapBetween(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.hypot(dx, dy);
}

/**
 * Steer a member toward a point without walking through walls or
 * display cases: move axis by axis and only commit each axis when
 * the new spot is clear, exactly how the thief herself moves. A
 * veteran follower walks a touch faster, scaled by their speed
 * bonus; callers can pass one more multiplier for the job at hand,
 * such as a driver's drive bonus on the way to a staging post.
 * Gives up once inside CLOSE_ENOUGH of the target.
 */
function moveToward(state, member, goalX, goalY, dt, extraPace = 1) {
  const dx = goalX - member.x;
  const dy = goalY - member.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= CLOSE_ENOUGH) return;
  const pace = PACE_BASE * crewBonus(member, 'speed') * extraPace;
  const stride = Math.min(distance, pace * dt);
  const nextX = member.x + (dx / distance) * stride;
  const nextY = member.y + (dy / distance) * stride;
  const solid = (x, y) => {
    if (state.screen === SCREEN.GETAWAY && state.city) return citySolidAt(state.city, x, y);
    if (state.room) return roomSolidAt(state.room, x, y);
    if (state.city) return citySolidAt(state.city, x, y);
    return false;
  };
  if (!solid(nextX, member.y)) member.x = nextX;
  if (!solid(member.x, nextY)) member.y = nextY;
}

/**
 * Iko's camera trick: find the nearest camera still live and within
 * reach, then switch its feed off. The blackout lasts the base ten
 * seconds, stretched by his crack bonus as he levels up. Reports
 * whether anything was actually spoofed this tick.
 */
function spoofCamera(state, hacker) {
  if (!state.cameras) return false;
  let target = null;
  let best = SPOOF_RANGE;
  for (const camera of state.cameras) {
    if (camera.disabled) continue;
    const d = gapBetween(hacker.x, hacker.y, camera.x, camera.y);
    if (d < best) {
      target = camera;
      best = d;
    }
  }
  if (!target) return false;
  target.disabled = true;
  target.disabledTimer = SPOOF_SECONDS * crewBonus(hacker, 'crack');
  return true;
}

/**
 * Sable's tag: clear every guard's marker, then flag the closest one
 * inside reach so the HUD can keep an eye on them. A seasoned
 * lookout's sharper eye reaches further, scaled by stealth bonus.
 */
function tagGuard(state, lookout) {
  if (!state.guards) return;
  const reach = TAG_RANGE * crewBonus(lookout, 'stealth');
  let target = null;
  let best = reach;
  for (const guard of state.guards) {
    guard.marked = false;
    const d = gapBetween(lookout.x, lookout.y, guard.x, guard.y);
    if (d < best) {
      target = guard;
      best = d;
    }
  }
  if (target) target.marked = true;
}

/**
 * One tick of crew behaviour. Nothing moves outside the heist and the
 * getaway; on any other screen the crew stands where it is. Mara is
 * pinned to the player. Iko trails close behind Mara, detouring to
 * the vault to crack it while it is still locked, and spoofing any
 * camera he can reach. Sable trails wider and keeps a guard tagged.
 * Reno waits by the room exit mid-heist — the car is out there — and
 * by the safehouse once the getaway starts, so there is always a
 * place to run to. A veteran driver gets to his post a little
 * quicker, scaled by his drive bonus.
 */
export function stepCrew(state, dt) {
  if (!state.crew || !state.player) return;
  if (state.screen !== SCREEN.HEIST && state.screen !== SCREEN.GETAWAY) return;
  const player = state.player;
  const leader = crewByRole(state, 'leader');
  if (leader) {
    leader.x = player.x;
    leader.y = player.y;
    leader.status = 'following';
  }
  const backX = Math.cos(player.facing + Math.PI);
  const backY = Math.sin(player.facing + Math.PI);
  const sideX = Math.cos(player.facing + Math.PI / 2);
  const sideY = Math.sin(player.facing + Math.PI / 2);

  const hacker = crewByRole(state, 'hacker');
  if (hacker && hacker.id !== 'mara') {
    const vaultSpot = state.room?.vaultSpot;
    const vaultLocked = state.vault && state.vault.state !== 'open' && vaultSpot;
    if (state.screen === SCREEN.HEIST && vaultLocked) {
      moveToward(state, hacker, vaultSpot.x, vaultSpot.y, dt);
      const nearVault = gapBetween(hacker.x, hacker.y, vaultSpot.x, vaultSpot.y) < AT_VAULT;
      hacker.status = nearVault ? 'hacking' : 'following';
    } else {
      // Iko drops back to his usual spot, left of Mara's trail line,
      // and keeps an eye out for cameras while he walks.
      const goalX = player.x + backX * GAP_CLOSE + sideX * OFFSET_HACKER;
      const goalY = player.y + backY * GAP_CLOSE + sideY * OFFSET_HACKER;
      moveToward(state, hacker, goalX, goalY, dt);
      hacker.status = 'following';
      if (state.screen === SCREEN.HEIST) spoofCamera(state, hacker);
    }
  }

  const lookout = crewByRole(state, 'lookout');
  if (lookout && lookout.id !== 'mara') {
    // Sable holds the wide spot, right of Mara's trail line, and
    // keeps the nearest guard tagged for the HUD.
    const goalX = player.x + backX * GAP_WIDE + sideX * OFFSET_LOOKOUT;
    const goalY = player.y + backY * GAP_WIDE + sideY * OFFSET_LOOKOUT;
    moveToward(state, lookout, goalX, goalY, dt);
    lookout.status = 'following';
    if (state.screen === SCREEN.HEIST) tagGuard(state, lookout);
  }

  const driver = crewByRole(state, 'driver');
  if (driver && driver.id !== 'mara') {
    // Reno's post is the way out: the room exit mid-heist, the
    // safehouse once the getaway starts. A veteran driver gets to
    // his post sooner, scaled by his drive bonus on top of his pace.
    if (state.screen === SCREEN.HEIST && state.room) {
      moveToward(state, driver, state.room.exit.x, state.room.exit.y, dt, crewBonus(driver, 'drive'));
      driver.status = 'waiting';
    } else if (state.screen === SCREEN.GETAWAY && state.city) {
      moveToward(state, driver, state.city.safehouse.x, state.city.safehouse.y, dt, crewBonus(driver, 'drive'));
      driver.status = 'waiting';
    }
  }
}
