// Senja Heist — heat and the police response.
//
// The alarm calls the police; heat is how many of them come. Heat 0 is
// a quiet city, heat 5 is the whole night shift. Police cars spawn at
// the ends of roads and chase the getaway car, ramming it to slow it
// down — each ram has a cooldown, so one leaning cop cannot wreck the
// car in a single second. If Mara is on foot while wanted, foot police
// come for her instead.
//
// A unit that cannot see its target for a while gives up the chase and
// searches the last place it saw her, then leaves. Heat only cools
// when no unit is close enough to see the crew — running silent and
// far away is how a crew goes quiet again. Reaching the safehouse is
// main.js's job; this module just makes sure heat can actually get
// there by falling when the pursuit is lost.

import { CAR, HEAT, POLICE } from './config.js';

/** How far a unit can still be said to see its target, in pixels. */
const SIGHT_RANGE = 520;
/** A unit gives up and goes home once it is this far from the crew. */
const LEAVE_RANGE = 900;
/** How far from the crew a fresh unit must spawn, at minimum. */
const SPAWN_MIN_GAP = 480;
/** Foot police chase speed, and what a touch from one costs. */
const FOOT_SPEED = 178;
const FOOT_DAMAGE = 8;
const FOOT_COOLDOWN = 1.2;
/** Ram cooldown per unit, so a leaning cop cannot insta-wreck the car. */
const RAM_COOLDOWN = 1.5;
/** Contact distance for a ram, and for a foot cop catching the thief. */
const RAM_RANGE = 36;
const CATCH_RANGE = 24;
/** At most this many foot units hunt the thief at once. */
const MAX_FOOT = 2;

/** Clamp a number into [lo, hi]. */
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Smallest signed angle from `from` to `to`, in (-PI, PI]. */
function angleTo(from, to) {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff <= -Math.PI) diff += Math.PI * 2;
  return diff;
}

/** True when the point is inside a building block or off the map. */
function pointSolid(city, x, y) {
  if (!city) return false;
  if (x < 0 || y < 0 || x > city.w || y > city.h) return true;
  for (const block of city.blocks) {
    if (x >= block.x && x <= block.x + block.w && y >= block.y && y <= block.y + block.h) {
      return true;
    }
  }
  return false;
}

/** The corners of a car body at a candidate pose, for wall checks. */
function cornersSolid(city, x, y, angle, length, width) {
  const hl = length / 2;
  const hw = width / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offsets = [
    [hl, hw],
    [hl, -hw],
    [-hl, hw],
    [-hl, -hw],
  ];
  for (const [along, across] of offsets) {
    const px = x + along * cos - across * sin;
    const py = y + along * sin + across * cos;
    if (pointSolid(city, px, py)) return true;
  }
  return false;
}

/**
 * Fresh police state: no units on the street, no siren. main.js
 * creates this at the start of every job and every getaway.
 */
export function createPolice() {
  return { units: [], spawnTimer: 0, siren: false };
}

/**
 * The target every unit hunts: the getaway car while Mara drives it,
 * the thief on foot otherwise. Returns the object to chase and whether
 * it is a car, so the right kind of unit is sent after it.
 */
function huntTarget(state) {
  if (state.car && state.car.inUse) return { x: state.car.x, y: state.car.y, isCar: true };
  if (state.player) return { x: state.player.x, y: state.player.y, isCar: false };
  return null;
}

/**
 * Pick a spawn point at the end of a road, far enough from the crew
 * that the unit arrives instead of appearing on top of them. Falls
 * back to a map corner when every road end is too close.
 */
function spawnPoint(state) {
  const city = state.city;
  const target = huntTarget(state);
  if (!city || !city.roads || city.roads.length === 0) {
    return { x: 60, y: 60 };
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const road = city.roads[Math.floor(Math.random() * city.roads.length)];
    const end = Math.random() < 0.5 ? 0 : 1;
    let x;
    let y;
    if (road.dir === 'h') {
      x = end === 0 ? road.x + 50 : road.x + road.w - 50;
      y = road.y + road.h / 2;
    } else {
      x = road.x + road.w / 2;
      y = end === 0 ? road.y + 50 : road.y + road.h - 50;
    }
    if (!target || Math.hypot(x - target.x, y - target.y) >= SPAWN_MIN_GAP) {
      return { x, y };
    }
  }
  return { x: 60, y: city.h - 60 };
}

/** How many units the current heat calls for, capped by the config. */
function wantedUnits(state) {
  return clamp(Math.ceil(state.heat), 0, POLICE.maxUnits);
}

/** A fresh pursuit car, arriving at the edge of the map. */
function spawnCarUnit(state) {
  const spot = spawnPoint(state);
  return {
    x: spot.x,
    y: spot.y,
    angle: -Math.PI / 2,
    speed: 0,
    kind: 'car',
    mode: 'arrive',
    // Pursuit bookkeeping: seconds since the target was last seen,
    // seconds left searching a last-seen spot, and the ram cooldown.
    unseenFor: 0,
    searchLeft: 0,
    ramAt: -99,
    lastX: spot.x,
    lastY: spot.y,
  };
}

/** A fresh foot officer, sent after the thief on foot. */
function spawnFootUnit(state) {
  const spot = spawnPoint(state);
  return {
    x: spot.x,
    y: spot.y,
    angle: -Math.PI / 2,
    speed: 0,
    kind: 'foot',
    mode: 'arrive',
    unseenFor: 0,
    searchLeft: 0,
    ramAt: -99,
    lastX: spot.x,
    lastY: spot.y,
  };
}

/**
 * Advance the whole pursuit one step: spawn units up to what the heat
 * calls for, move each unit toward its target, ram or catch on
 * contact, and let units that have lost the trail search and leave.
 * The siren runs while any unit is actively chasing.
 */
export function stepPolice(state, dt) {
  const police = state.police;
  if (!police) return;
  const target = huntTarget(state);
  if (!target) {
    police.siren = false;
    return;
  }

  // Spawning: one unit per gap, up to what the heat calls for. Foot
  // units only while the thief is on foot; cars only while she drives.
  police.spawnTimer -= dt;
  const wanted = wantedUnits(state);
  const cars = police.units.filter((unit) => unit.kind === 'car').length;
  const feet = police.units.filter((unit) => unit.kind === 'foot').length;
  if (police.spawnTimer <= 0 && police.units.length < wanted) {
    if (target.isCar && cars < wanted) {
      police.units.push(spawnCarUnit(state));
      police.spawnTimer = POLICE.spawnGap;
    } else if (!target.isCar && feet < MAX_FOOT) {
      police.units.push(spawnFootUnit(state));
      police.spawnTimer = POLICE.spawnGap;
    }
  }

  // Too many units for the current heat: the extras stop chasing and
  // head for the last place they saw the crew, then leave.
  const extra = police.units.length - wanted;
  for (let i = 0; i < extra; i += 1) {
    const unit = police.units[police.units.length - 1 - i];
    if (unit && unit.mode !== 'search') {
      unit.mode = 'search';
      unit.searchLeft = 2;
    }
  }

  let chasing = false;
  for (let i = police.units.length - 1; i >= 0; i -= 1) {
    const unit = police.units[i];
    const alive = unit.kind === 'car' ? stepCarUnit(state, unit, target, dt) : stepFootUnit(state, unit, target, dt);
    if (unit.mode === 'chase') chasing = true;
    if (!alive) police.units.splice(i, 1);
  }
  police.siren = chasing;
}

/**
 * One pursuit car: steer toward the target, accelerate to chase
 * speed, and ram on contact. Returns false when the unit has left
 * the map and should be removed.
 */
function stepCarUnit(state, unit, target, dt) {
  const gap = Math.hypot(target.x - unit.x, target.y - unit.y);

  if (gap <= SIGHT_RANGE) {
    unit.unseenFor = 0;
    unit.lastX = target.x;
    unit.lastY = target.y;
    if (unit.mode !== 'search' || gap < SIGHT_RANGE * 0.6) unit.mode = 'chase';
  } else {
    unit.unseenFor += dt;
    if (unit.unseenFor > POLICE.searchSeconds && unit.mode === 'chase') {
      unit.mode = 'search';
      unit.searchLeft = POLICE.searchSeconds;
    }
  }

  if (unit.mode === 'search') {
    unit.searchLeft -= dt;
    // Drive to the last-seen spot, look around, then leave for good.
    const spotGap = Math.hypot(unit.lastX - unit.x, unit.lastY - unit.y);
    if (spotGap > 30) {
      driveToward(state, unit, unit.lastX, unit.lastY, POLICE.chaseSpeed * 0.55, dt);
    } else {
      unit.angle += 1.6 * dt;
    }
    if (unit.searchLeft <= 0 || gap > LEAVE_RANGE) return false;
    return true;
  }

  // Chase: full speed at the getaway car, steering hard.
  driveToward(state, unit, target.x, target.y, POLICE.chaseSpeed, dt);
  unit.mode = unit.mode === 'arrive' && gap > SIGHT_RANGE * 0.5 ? 'arrive' : 'chase';

  // Ram: on contact, damage the player's car and shove it, on a
  // cooldown so one cop cannot wreck it in a single lean.
  const car = state.car;
  if (car && car.inUse && gap < RAM_RANGE) {
    const now = state.time ?? 0;
    if (now - unit.ramAt >= RAM_COOLDOWN) {
      unit.ramAt = now;
      car.hp = Math.max(0, car.hp - POLICE.ramDamage);
      car.speed *= 0.78;
      const push = 26;
      const nx = (car.x - unit.x) / (gap || 1);
      const ny = (car.y - unit.y) / (gap || 1);
      car.x += nx * push;
      car.y += ny * push;
      unit.speed *= 0.55;
      if (state.fx) {
        state.fx.shakeT = Math.max(state.fx.shakeT ?? 0, 0.3);
        state.fx.shakeMag = Math.max(state.fx.shakeMag ?? 0, 6);
      }
    }
  }

  // Nudge traffic out of the way instead of piling into it.
  if (state.traffic) {
    for (const other of state.traffic.cars) {
      const tGap = Math.hypot(other.x - unit.x, other.y - unit.y);
      if (tGap < 40 && tGap > 0) {
        other.x += ((other.x - unit.x) / tGap) * 10;
        other.y += ((other.y - unit.y) / tGap) * 10;
        other.speed = Math.max(0, other.speed - 40);
      }
    }
  }
  return true;
}

/**
 * Steer a pursuit car toward (tx, ty) at up to `topSpeed`, sliding
 * along buildings when the direct line is blocked. The car turns
 * toward its target and probes left and right when a wall stops it.
 */
function driveToward(state, unit, tx, ty, topSpeed, dt) {
  const want = Math.atan2(ty - unit.y, tx - unit.x);
  const turn = clamp(angleTo(unit.angle, want), -1, 1);
  unit.angle += turn * 3.1 * dt;
  unit.speed = Math.min(topSpeed, unit.speed + 420 * dt);

  const fx = Math.cos(unit.angle);
  const fy = Math.sin(unit.angle);
  const dx = fx * unit.speed * dt;
  const dy = fy * unit.speed * dt;
  const city = state.city;
  if (!cornersSolid(city, unit.x + dx, unit.y + dy, unit.angle, 46, 22)) {
    unit.x += dx;
    unit.y += dy;
    return;
  }
  // Blocked: slide along one axis, or swing the nose to feel for a gap.
  if (!cornersSolid(city, unit.x + dx, unit.y, unit.angle, 46, 22)) {
    unit.x += dx;
    unit.speed *= 0.6;
    return;
  }
  if (!cornersSolid(city, unit.x, unit.y + dy, unit.angle, 46, 22)) {
    unit.y += dy;
    unit.speed *= 0.6;
    return;
  }
  unit.speed *= 0.4;
  unit.angle += 0.9 * dt;
}

/**
 * One foot officer: run at the thief on foot and grab her on contact.
 * Returns false when the unit has lost the trail and left.
 */
function stepFootUnit(state, unit, target, dt) {
  const player = state.player;
  if (!player || target.isCar) return false;
  const gap = Math.hypot(target.x - unit.x, target.y - unit.y);

  if (gap <= SIGHT_RANGE) {
    unit.unseenFor = 0;
    unit.lastX = target.x;
    unit.lastY = target.y;
    unit.mode = 'chase';
  } else {
    unit.unseenFor += dt;
    if (unit.unseenFor > POLICE.searchSeconds && unit.mode === 'chase') {
      unit.mode = 'search';
      unit.searchLeft = POLICE.searchSeconds;
    }
  }

  if (unit.mode === 'search') {
    unit.searchLeft -= dt;
    const spotGap = Math.hypot(unit.lastX - unit.x, unit.lastY - unit.y);
    if (spotGap > 20) {
      unit.angle = Math.atan2(unit.lastY - unit.y, unit.lastX - unit.x);
      unit.x += Math.cos(unit.angle) * FOOT_SPEED * 0.6 * dt;
      unit.y += Math.sin(unit.angle) * FOOT_SPEED * 0.6 * dt;
    }
    if (unit.searchLeft <= 0 || gap > LEAVE_RANGE) return false;
    return true;
  }

  // Chase on foot: straight at the thief, through the street.
  unit.angle = Math.atan2(target.y - unit.y, target.x - unit.x);
  const nx = unit.x + Math.cos(unit.angle) * FOOT_SPEED * dt;
  const ny = unit.y + Math.sin(unit.angle) * FOOT_SPEED * dt;
  if (!pointSolid(state.city, nx, ny)) {
    unit.x = nx;
    unit.y = ny;
  }
  unit.speed = FOOT_SPEED;

  // Caught: a touch costs the thief health, on a cooldown.
  if (gap < CATCH_RANGE) {
    const now = state.time ?? 0;
    if (now - unit.ramAt >= FOOT_COOLDOWN) {
      unit.ramAt = now;
      player.hp = Math.max(0, player.hp - FOOT_DAMAGE);
      if (state.fx) {
        state.fx.shakeT = Math.max(state.fx.shakeT ?? 0, 0.25);
        state.fx.shakeMag = Math.max(state.fx.shakeMag ?? 0, 5);
      }
    }
  }
  return true;
}

/**
 * Raise the heat by `amount`, never past the configured maximum.
 * The alarm and gunfire call this; the getaway starts wherever the
 * heist left it.
 */
export function raiseHeat(state, amount) {
  state.heat = clamp((state.heat ?? 0) + amount, 0, HEAT.max);
}

/**
 * Cool the heat down — but only while no police unit is close enough
 * to see the crew. A unit on the crew's tail holds the heat where it
 * is; slipping away and going quiet is what lets it fall.
 */
export function lowerHeat(state, dt) {
  if ((state.heat ?? 0) <= 0) {
    state.heat = 0;
    return;
  }
  const police = state.police;
  const target = huntTarget(state);
  let seen = false;
  if (police && target) {
    for (const unit of police.units) {
      if (Math.hypot(unit.x - target.x, unit.y - target.y) <= SIGHT_RANGE) {
        seen = true;
        break;
      }
    }
  }
  if (!seen) {
    state.heat = Math.max(0, state.heat - HEAT.coolPerSecond * dt);
  }
}
