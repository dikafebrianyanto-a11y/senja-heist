// crew.js — the rest of the Senja crew around Mara.
//
// Mara Voss is the leader and the thief the player drives, so she never
// moves by crew logic: her crew entry is kept glued to the player. The
// other three have jobs of their own. Iko Tan, the hacker, trails Mara
// close and, when a camera is in reach, slips its feed for ten seconds;
// near a locked vault he goes to the vault and works it. Sable Wren, the
// lookout, trails wider and keeps the nearest guard marked for the HUD.
// Reno Kartika, the driver, stages by the room's exit while the crew is
// inside — the car is waiting out there — and holds the safehouse once
// the getaway is running, so the crew always has somewhere to run to.

import { SCREEN } from './config.js';
import { roomSolidAt, citySolidAt } from './world.js';

/** How far behind Mara each follower trails, in pixels. */
const TRAIL_HACKER = 70;
const TRAIL_LOOKOUT = 115;

/** Follower foot speed; fast enough to keep up with a walking Mara. */
const FOLLOW_SPEED = 205;

/** Reach of Iko's camera hack, and how long the blind lasts. */
const HACK_REACH = 150;
const HACK_BLIND_SECONDS = 10;

/** How far Sable's mark reaches. */
const MARK_REACH = 430;

/** Distance that counts as "arrived" at a staging point. */
const ARRIVE = 10;

/**
 * The four crew members with their default roles, colours and skills.
 * Skill is 1..5 and belongs to the member, not the role, so reassigning
 * roles on the planning board moves the person, not the number.
 */
export function createCrew() {
  return [
    { id: 'mara', name: 'Mara Voss', role: 'leader', color: '#7ee0c3', x: 0, y: 0, status: 'ready', skill: 4 },
    { id: 'iko', name: 'Iko Tan', role: 'hacker', color: '#8fb7ff', x: 0, y: 0, status: 'ready', skill: 5 },
    { id: 'reno', name: 'Reno Kartika', role: 'driver', color: '#ffb454', x: 0, y: 0, status: 'waiting', skill: 3 },
    { id: 'sable', name: 'Sable Wren', role: 'lookout', color: '#d98cff', x: 0, y: 0, status: 'ready', skill: 4 },
  ];
}

/** The crew member currently holding a role, or null when nobody does. */
export function crewByRole(state, role) {
  if (!state.crew) return null;
  return state.crew.find((member) => member.role === role) ?? null;
}

/**
 * Reassign the three working roles from the planning board.
 * `picks` maps role names to member ids; Mara always stays leader, a
 * missing or duplicate pick is skipped, and a member who loses a role
 * falls back to following. Roles are unique: the first pick for an id
 * wins and later picks naming the same member are ignored.
 */
export function assignRoles(state, picks) {
  if (!state.crew || !picks) return;
  const members = state.crew.filter((member) => member.id !== 'mara');
  if (members.length === 0) return;
  // Start from the roles as they stand, then apply each pick in order.
  // A pick moves its member into the role and vacates whatever role
  // that member was holding; a duplicate pick is skipped.
  const slots = { hacker: null, driver: null, lookout: null };
  for (const member of members) {
    if (member.role in slots) slots[member.role] = member.id;
  }
  const placed = new Set();
  for (const role of ['hacker', 'driver', 'lookout']) {
    const id = picks[role];
    if (typeof id !== 'string') continue;
    if (!members.some((member) => member.id === id)) continue;
    if (placed.has(id)) continue;
    for (const other of Object.keys(slots)) {
      if (slots[other] === id) slots[other] = null;
    }
    slots[role] = id;
    placed.add(id);
  }
  // Fill any vacated slot with the first member not placed anywhere.
  for (const role of ['hacker', 'driver', 'lookout']) {
    if (slots[role]) continue;
    const spare = members.find((member) => !placed.has(member.id));
    if (!spare) break;
    slots[role] = spare.id;
    placed.add(spare.id);
  }
  for (const member of members) {
    for (const role of ['hacker', 'driver', 'lookout']) {
      if (slots[role] === member.id) member.role = role;
    }
    member.status = member.role === 'driver' ? 'waiting' : 'following';
  }
}

/** Distance between two points. */
function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Ease one member toward a target point, sliding along walls and cover
 * the same way the thief does, so followers do not cut through a display
 * case to catch up. Stops inside ARRIVE of the target.
 */
function walkToward(state, member, tx, ty, dt) {
  const dx = tx - member.x;
  const dy = ty - member.y;
  const d = Math.hypot(dx, dy);
  if (d <= ARRIVE) return;
  const step = Math.min(d, FOLLOW_SPEED * dt);
  const nx = member.x + (dx / d) * step;
  const ny = member.y + (dy / d) * step;
  const blocked = (x, y) => {
    if (state.screen === SCREEN.GETAWAY && state.city) return citySolidAt(state.city, x, y);
    if (state.room) return roomSolidAt(state.room, x, y);
    if (state.city) return citySolidAt(state.city, x, y);
    return false;
  };
  if (!blocked(nx, member.y)) member.x = nx;
  if (!blocked(member.x, ny)) member.y = ny;
}

/**
 * Iko's work: when a camera is close and live, blind it for ten
 * seconds. Returns true when a camera was hacked this step.
 */
function hackNearbyCamera(state, hacker) {
  if (!state.cameras) return false;
  let nearest = null;
  let nearestD = HACK_REACH;
  for (const cam of state.cameras) {
    if (cam.disabled) continue;
    const d = dist(hacker.x, hacker.y, cam.x, cam.y);
    if (d < nearestD) {
      nearest = cam;
      nearestD = d;
    }
  }
  if (!nearest) return false;
  nearest.disabled = true;
  nearest.disabledTimer = HACK_BLIND_SECONDS;
  return true;
}

/** Sable's work: mark the nearest guard so the HUD can show it. */
function markNearestGuard(state, lookout) {
  if (!state.guards) return;
  let nearest = null;
  let nearestD = MARK_REACH;
  for (const guard of state.guards) {
    guard.marked = false;
    const d = dist(lookout.x, lookout.y, guard.x, guard.y);
    if (d < nearestD) {
      nearest = guard;
      nearestD = d;
    }
  }
  if (nearest) nearest.marked = true;
}

/**
 * One fixed step of crew logic. Only the heist and the getaway move
 * anyone: on other screens the crew holds where it stands. The hacker
 * trails Mara at arm's length and drifts to a locked vault to work it;
 * the lookout trails wider and marks; the driver stages at the exit
 * during the heist and at the safehouse during the getaway.
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
  // Trail offsets sit behind Mara's facing, one on each side.
  const behindX = Math.cos(player.facing + Math.PI);
  const behindY = Math.sin(player.facing + Math.PI);
  const sideX = Math.cos(player.facing + Math.PI / 2);
  const sideY = Math.sin(player.facing + Math.PI / 2);

  const hacker = crewByRole(state, 'hacker');
  if (hacker && hacker.id !== 'mara') {
    const vault = state.room?.vaultSpot;
    const vaultBusy = state.vault && state.vault.state !== 'open' && vault;
    if (state.screen === SCREEN.HEIST && vaultBusy) {
      // Iko goes to the vault and works it while Mara lifts the rest.
      walkToward(state, hacker, vault.x, vault.y, dt);
      hacker.status = dist(hacker.x, hacker.y, vault.x, vault.y) < 46 ? 'hacking' : 'following';
    } else {
      const tx = player.x + behindX * TRAIL_HACKER - sideX * 26;
      const ty = player.y + behindY * TRAIL_HACKER - sideY * 26;
      walkToward(state, hacker, tx, ty, dt);
      hacker.status = 'following';
      if (state.screen === SCREEN.HEIST) hackNearbyCamera(state, hacker);
    }
  }

  const lookout = crewByRole(state, 'lookout');
  if (lookout && lookout.id !== 'mara') {
    const tx = player.x + behindX * TRAIL_LOOKOUT + sideX * 34;
    const ty = player.y + behindY * TRAIL_LOOKOUT + sideY * 34;
    walkToward(state, lookout, tx, ty, dt);
    lookout.status = 'following';
    if (state.screen === SCREEN.HEIST) markNearestGuard(state, lookout);
  }

  const driver = crewByRole(state, 'driver');
  if (driver && driver.id !== 'mara') {
    if (state.screen === SCREEN.HEIST && state.room) {
      // Reno stages by the exit with the route out already in mind.
      walkToward(state, driver, state.room.exit.x, state.room.exit.y, dt);
      driver.status = 'waiting';
    } else if (state.screen === SCREEN.GETAWAY && state.city) {
      walkToward(state, driver, state.city.safehouse.x, state.city.safehouse.y, dt);
      driver.status = 'waiting';
    }
  }
}
