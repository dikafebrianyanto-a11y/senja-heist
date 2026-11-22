// Senja Heist — the heat meter and the night-shift response.
//
// Once the alarm trips, heat decides how hard the city pushes back.
// A quiet street means no sirens at all; at full heat the whole shift
// is out looking for the crew. Pursuit cars roll in from the ends of
// roads, close on the getaway car, and lean on it to bleed its speed.
// On foot, Mara gets foot officers instead — they run her down and
// grab her if they get close enough.
//
// Two things make a unit give up: losing sight of the crew for long
// enough that it falls back to searching the last place it saw them,
// and then finding nothing there. Heat only drains while nobody can
// see the crew, so going dark and putting distance between the crew
// and the nearest unit is the way back to quiet streets. Getting to
// the safehouse itself is main.js's business; this file just runs the
// pursuit that has to be shaken off first.
//
// Difficulty bends the whole response through a multiplier from the
// config table: harder nights bring more units, sooner, and faster.
// At heat 4 and above the response grows a roadblock — one unit stops
// chasing and parks itself across the road ahead of the getaway car,
// so the driver has something solid to steer around.

import { CAR, HEAT, POLICE, DIFFICULTY } from './config.js';

// Stand-in difficulty rows, used only if the config table is missing a
// key or has not landed yet. The real table lives in config.js.
const FALLBACK_ROWS = {
  easy: { policeMul: 0.75 },
  normal: { policeMul: 1 },
  hard: { policeMul: 1.3 },
};

/** How far away a unit can still spot its quarry, in pixels. */
const SEE_FAR = 520;
/** Past this distance a searching unit packs up and drives away. */
const GIVE_UP_FAR = 900;
/** A fresh unit spawns no closer to the crew than this. */
const ARRIVE_FAR = 480;
/** Foot officer foot speed, and the health a grab costs the thief. */
const ON_FOOT_SPEED = 178;
const GRAB_HURT = 8;
const GRAB_PAUSE = 1.2;
/** Pause between rams from one unit, so a single cop cannot shred the car. */
const RAM_PAUSE = 1.5;
/** Contact distance for a ram, and for a foot officer catching Mara. */
const RAM_REACH = 36;
const GRAB_REACH = 24;
/** At most this many foot officers hunt the thief at the same time. */
const FOOT_CAP = 2;
/** Heat at which the response starts posting a roadblock. */
const BLOCK_HEAT = 4;
/** How far ahead of the getaway car a roadblock sets up, in pixels. */
const BLOCK_AHEAD = 300;
/** How long one roadblock holds its ground before chasing again. */
const BLOCK_HOLD = 7;
/** Quiet seconds after a roadblock ends before another is posted. */
const BLOCK_REST = 5;
/** Seconds a demoted unit keeps searching before it leaves. */
const DEMOTE_SEARCH = 2;
/** Fallback spawn corner when no road end is usable. */
const CORNER_PAD = 60;

/** Keep a number inside [low, high]. */
function bound(n, low, high) {
  if (n <= low) return low;
  if (n >= high) return high;
  return n;
}

/** Shortest signed turn from one heading to another, in (-PI, PI]. */
function turnTo(from, to) {
  let gap = to - from;
  while (gap > Math.PI) gap -= Math.PI * 2;
  while (gap <= -Math.PI) gap += Math.PI * 2;
  return gap;
}

/** True when a point sits inside a building block or past the map edge. */
function spotBlocked(city, x, y) {
  const usable = Boolean(city);
  if (!usable) return false;
  const pastEdge = x < 0 || y < 0 || x > city.w || y > city.h;
  if (pastEdge) return true;
  const hitsBlock = city.blocks.some(
    (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h,
  );
  return hitsBlock;
}

/** True when any corner of a car body at this pose clips a building. */
function bodyBlocked(city, x, y, angle, length, width) {
  const halfLen = length / 2;
  const halfWid = width / 2;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const foreSteps = [halfLen, halfLen, -halfLen, -halfLen];
  const sideSteps = [halfWid, -halfWid, halfWid, -halfWid];
  let clipped = false;
  for (let i = 0; i < 4; i += 1) {
    const px = x + foreSteps[i] * cosA - sideSteps[i] * sinA;
    const py = y + foreSteps[i] * sinA + sideSteps[i] * cosA;
    if (spotBlocked(city, px, py)) {
      clipped = true;
      break;
    }
  }
  return clipped;
}

/**
 * The difficulty row for this run: main.js may set state.difficulty to
 * 'easy', 'normal' or 'hard'; anything else falls back to normal.
 */
function difficultyRow(state) {
  const table = DIFFICULTY ?? FALLBACK_ROWS;
  const key = state.difficulty ?? 'normal';
  const row = table[key] ?? table.normal ?? FALLBACK_ROWS.normal;
  return row;
}

/** The police multiplier for this run: 0.75 easy, 1 normal, 1.3 hard. */
function policeMultiplier(state) {
  const row = difficultyRow(state);
  const mul = row.policeMul;
  const usable = typeof mul === 'number' && Number.isFinite(mul) && mul > 0;
  return usable ? mul : 1;
}

/**
 * Fresh pursuit state: an empty street, a silent siren, and no
 * roadblock on cooldown. main.js builds this at the start of every
 * job and every getaway.
 */
export const createPolice = () => ({ units: [], spawnTimer: 0, siren: false, blockRest: 0 });

/**
 * What every unit is hunting: the getaway car while Mara is driving
 * it, the thief herself on foot otherwise. The returned quarry says
 * where it is and whether it is a car, so the right kind of unit is
 * sent after it.
 */
function quarryOf(state) {
  const driving = state.car && state.car.inUse;
  if (driving) return { x: state.car.x, y: state.car.y, inCar: true };
  if (state.player) return { x: state.player.x, y: state.player.y, inCar: false };
  return null;
}

/** Swap a unit into a new pursuit mode. */
function setMode(unit, next) {
  unit.mode = next;
}

/** True when a unit has given up chasing and is searching instead. */
function isSearching(unit) {
  return unit.mode === 'search';
}

/** One end of a road, inset a little from the tip so the car is on tarmac. */
function roadEndPoint(road, farEnd) {
  const flat = road.dir === 'h';
  if (flat) {
    const x = farEnd ? road.x + road.w - 50 : road.x + 50;
    return { x, y: road.y + road.h / 2 };
  }
  const y = farEnd ? road.y + road.h - 50 : road.y + 50;
  return { x: road.x + road.w / 2, y };
}

/**
 * A spawn spot at the end of a road, far enough from the crew that the
 * unit drives in instead of appearing on top of them. A map corner is
 * the fallback when every road end is too close or there are no roads.
 */
function pickSpawn(state) {
  const town = state.city;
  const prey = quarryOf(state);
  const noRoads = !town || !town.roads || town.roads.length === 0;
  if (noRoads) return { x: CORNER_PAD, y: CORNER_PAD };
  let tries = 8;
  while (tries > 0) {
    tries -= 1;
    const index = Math.floor(Math.random() * town.roads.length);
    const spot = roadEndPoint(town.roads[index], Math.random() < 0.5);
    const farEnough = !prey || Math.hypot(spot.x - prey.x, spot.y - prey.y) >= ARRIVE_FAR;
    if (farEnough) return spot;
  }
  return { x: CORNER_PAD, y: town.h - CORNER_PAD };
}

/** The per-unit pursuit bookkeeping a fresh unit starts with. */
function freshNotes(spot) {
  // Seconds since the quarry was last seen, seconds left searching a
  // last-seen spot, the last ram time, the last spotted position,
  // and the roadblock timer.
  const notes = {};
  notes.unseenFor = 0;
  notes.searchLeft = 0;
  notes.ramAt = -99;
  notes.lastX = spot.x;
  notes.lastY = spot.y;
  notes.blockLeft = 0;
  return notes;
}

/** A fresh unit of either kind, rolling in from the edge of the map. */
function makeUnit(state, kind) {
  const spot = pickSpawn(state);
  const unit = {
    x: spot.x,
    y: spot.y,
    angle: -Math.PI * 0.5,
    speed: 0,
    kind,
    ...freshNotes(spot),
  };
  setMode(unit, 'arrive');
  return unit;
}

/**
 * How many units the current heat calls for, bent by difficulty: a
 * hard night fields more cars than a normal one, an easy night fewer.
 */
function unitsWanted(state) {
  const scaled = Math.round(POLICE.maxUnits * policeMultiplier(state));
  return bound(scaled, 0, 12);
}

/** Seconds between spawns: shorter on hard nights, longer on easy ones. */
function spawnGap(state) {
  return POLICE.spawnGap / policeMultiplier(state);
}

/**
 * Roll fresh units in, one per gap, up to what the heat calls for.
 * Foot officers only while Mara is on foot; cars only while she drives.
 */
function bringInUnits(state, prey) {
  const force = state.police;
  const wanted = unitsWanted(state);
  let cars = 0;
  let feet = 0;
  for (const unit of force.units) {
    if (unit.kind === 'car') cars += 1;
    else feet += 1;
  }
  if (force.spawnTimer > 0 || force.units.length >= wanted) return;
  if (prey.inCar && cars < wanted) {
    force.units.push(makeUnit(state, 'car'));
    force.spawnTimer = spawnGap(state);
  } else if (!prey.inCar && feet < FOOT_CAP) {
    force.units.push(makeUnit(state, 'foot'));
    force.spawnTimer = spawnGap(state);
  }
}

/**
 * More units than the heat calls for: the extras stop chasing, fall
 * back to searching the last place they saw the crew, then leave.
 */
function standDownExtras(force, wanted) {
  const surplus = force.units.length - wanted;
  for (let i = 0; i < surplus; i += 1) {
    const unit = force.units[force.units.length - 1 - i];
    if (!unit || isSearching(unit)) continue;
    setMode(unit, 'search');
    unit.searchLeft = DEMOTE_SEARCH;
  }
}

/**
 * High heat posts a roadblock: one car unit stops chasing and sets up
 * ahead of the getaway car instead. At most one at a time, and a short
 * rest follows each one so they do not chain back to back.
 */
function maybePostRoadblock(state, prey, dt) {
  const force = state.police;
  force.blockRest = Math.max(0, (force.blockRest ?? 0) - dt);
  const hotEnough = (state.heat ?? 0) >= BLOCK_HEAT;
  if (!hotEnough || !prey.inCar || force.blockRest > 0) return;
  const posted = force.units.some((unit) => unit.mode === 'roadblock');
  if (posted) return;
  const chaser = force.units.find((unit) => unit.kind === 'car' && unit.mode === 'chase');
  if (!chaser) return;
  chaser.mode = 'roadblock';
  chaser.blockLeft = BLOCK_HOLD;
}

/**
 * One step of the whole pursuit: bring units in up to what the heat
 * calls for, post a roadblock at high heat, move every unit toward
 * its quarry, ram or grab on contact, and let units that have lost
 * the trail search and then leave. The siren runs while any unit is
 * actively chasing or holding a roadblock.
 */
export const stepPolice = (state, dt) => {
  const force = state.police;
  if (!force) return;
  const prey = quarryOf(state);
  if (!prey) {
    force.siren = false;
    return;
  }
  const mul = policeMultiplier(state);
  force.spawnTimer -= dt;
  bringInUnits(state, prey);
  standDownExtras(force, unitsWanted(state));
  maybePostRoadblock(state, prey, dt);

  let active = false;
  for (let i = force.units.length - 1; i >= 0; i -= 1) {
    const unit = force.units[i];
    const stays = unit.kind === 'car'
      ? stepCarUnit(state, unit, prey, dt, mul)
      : stepFootUnit(state, unit, prey, dt);
    const busy = unit.mode === 'chase' || unit.mode === 'roadblock';
    if (busy) active = true;
    if (!stays) force.units.splice(i, 1);
  }
  force.siren = active;
};

/**
 * One pursuit car: steer at the quarry, run up to chase speed, and ram
 * on contact. A roadblocking unit instead drives to a point ahead of
 * the getaway car, parks across the road there, and holds its ground
 * as a solid obstacle until its hold runs out or the crew slips past.
 * Returns false once the unit has left the map and should be removed.
 */
function stepCarUnit(state, unit, prey, dt, mul) {
  const range = Math.hypot(prey.x - unit.x, prey.y - unit.y);

  if (unit.mode === 'roadblock') return stepRoadblock(state, unit, prey, dt, mul);

  if (range <= SEE_FAR) {
    Object.assign(unit, { unseenFor: 0, lastX: prey.x, lastY: prey.y });
    const closeIn = range < SEE_FAR * 0.6;
    if (!isSearching(unit) || closeIn) setMode(unit, 'chase');
  } else {
    unit.unseenFor = unit.unseenFor + dt;
    const lostIt = unit.unseenFor > POLICE.searchSeconds && unit.mode === 'chase';
    if (lostIt) Object.assign(unit, { mode: 'search', searchLeft: POLICE.searchSeconds });
  }

  if (isSearching(unit)) {
    unit.searchLeft = unit.searchLeft - dt;
    // Cruise to the last-seen spot, look around, then drive away.
    const toMark = Math.hypot(unit.lastX - unit.x, unit.lastY - unit.y);
    if (toMark > 30) {
      driveCar(state, unit, unit.lastX, unit.lastY, POLICE.chaseSpeed * 0.55 * mul, dt);
    } else {
      unit.angle = unit.angle + 1.6 * dt;
    }
    const done = unit.searchLeft <= 0 || range > GIVE_UP_FAR;
    return !done;
  }

  // Flat-out chase: full speed at the getaway car, steering hard.
  driveCar(state, unit, prey.x, prey.y, POLICE.chaseSpeed * mul, dt);
  const stillArriving = unit.mode === 'arrive' && range > SEE_FAR * 0.5;
  if (!stillArriving) setMode(unit, 'chase');

  // Ram: on contact, hurt the player's car and shove it, on a pause
  // so one leaning cop cannot wreck it in a single second.
  const getaway = state.car;
  const touching = getaway && getaway.inUse && range < RAM_REACH;
  if (touching) {
    const clock = state.time ?? 0;
    const cooled = clock - unit.ramAt >= RAM_PAUSE;
    if (cooled) {
      unit.ramAt = clock;
      getaway.hp = Math.max(0, getaway.hp - POLICE.ramDamage);
      getaway.speed = getaway.speed * 0.78;
      const shoveX = (getaway.x - unit.x) / (range || 1);
      const shoveY = (getaway.y - unit.y) / (range || 1);
      getaway.x += shoveX * 26;
      getaway.y += shoveY * 26;
      unit.speed = unit.speed * 0.55;
      const fx = state.fx;
      if (fx) {
        fx.shakeT = Math.max(fx.shakeT ?? 0, 0.3);
        fx.shakeMag = Math.max(fx.shakeMag ?? 0, 6);
      }
    }
  }

  // Shove street traffic aside instead of piling into it.
  nudgeTraffic(state, unit);
  return true;
}

/** Push nearby street traffic out of a pursuit car's way. */
function nudgeTraffic(state, unit) {
  const flow = state.traffic;
  if (!flow) return;
  for (const other of flow.cars) {
    const gapToCar = Math.hypot(other.x - unit.x, other.y - unit.y);
    const inWay = gapToCar < 40 && gapToCar > 0;
    if (!inWay) continue;
    const pushX = ((other.x - unit.x) / gapToCar) * 10;
    const pushY = ((other.y - unit.y) / gapToCar) * 10;
    other.x += pushX;
    other.y += pushY;
    other.speed = other.speed > 40 ? other.speed - 40 : 0;
  }
}

/**
 * A roadblocking unit: first it races to a point ahead of the getaway
 * car, then it parks across the road — nose turned square to the
 * crew's heading — and sits there as a wall the driver has to steer
 * around. It holds until its timer runs out, the heat drops, or the
 * crew gets past it, then it goes back to chasing.
 */
function stepRoadblock(state, unit, prey, dt, mul) {
  const getaway = state.car;
  const noBlock = !getaway || !getaway.inUse || (state.heat ?? 0) < BLOCK_HEAT;
  if (noBlock) {
    setMode(unit, 'chase');
    return true;
  }
  unit.blockLeft -= dt;
  const postX = prey.x + Math.cos(getaway.angle) * BLOCK_AHEAD;
  const postY = prey.y + Math.sin(getaway.angle) * BLOCK_AHEAD;
  const toPost = Math.hypot(postX - unit.x, postY - unit.y);

  // The crew slipped past the post: give up the block and chase again.
  const pastPost = (prey.x - unit.x) * Math.cos(getaway.angle)
    + (prey.y - unit.y) * Math.sin(getaway.angle);
  if (unit.blockLeft <= 0 || pastPost > 160) {
    setMode(unit, 'chase');
    if (state.police) state.police.blockRest = BLOCK_REST;
    return true;
  }

  if (toPost > 70) {
    // Still racing to the post: drive there nearly at chase speed.
    driveCar(state, unit, postX, postY, POLICE.chaseSpeed * 0.95 * mul, dt);
    return true;
  }

  // On the post: bleed off speed and swing the nose across the road.
  unit.speed *= Math.max(0, 1 - 6 * dt);
  if (Math.abs(unit.speed) < 4) unit.speed = 0;
  const across = getaway.angle + Math.PI / 2;
  unit.angle += bound(turnTo(unit.angle, across), -1, 1) * 2.4 * dt;

  // A solid obstacle: shove the getaway car aside and kill its speed
  // when it touches the parked unit, on a short pause per shove.
  const gap = Math.hypot(prey.x - unit.x, prey.y - unit.y);
  const touching = gap < 44 && gap > 0;
  if (touching) {
    const clock = state.time ?? 0;
    if (clock - unit.ramAt >= 1) {
      unit.ramAt = clock;
      const shoveX = (getaway.x - unit.x) / gap;
      const shoveY = (getaway.y - unit.y) / gap;
      getaway.x += shoveX * 14;
      getaway.y += shoveY * 14;
      getaway.speed *= 0.62;
      const fx = state.fx;
      if (fx) {
        fx.shakeT = Math.max(fx.shakeT ?? 0, 0.25);
        fx.shakeMag = Math.max(fx.shakeMag ?? 0, 5);
      }
    }
  }
  return true;
}

/**
 * Steer a pursuit car toward (tx, ty) at up to `top`, sliding along
 * buildings when the direct line is blocked. The car turns toward its
 * target and feels left and right for a gap when a wall stops it.
 */
function driveCar(state, unit, tx, ty, top, dt) {
  const heading = Math.atan2(ty - unit.y, tx - unit.x);
  const steer = bound(turnTo(unit.angle, heading), -1, 1);
  unit.angle += steer * 3.1 * dt;
  unit.speed = Math.min(top, unit.speed + 420 * dt);

  const dirX = Math.cos(unit.angle);
  const dirY = Math.sin(unit.angle);
  const stepX = dirX * unit.speed * dt;
  const stepY = dirY * unit.speed * dt;
  const town = state.city;
  const free = !bodyBlocked(town, unit.x + stepX, unit.y + stepY, unit.angle, 46, 22);
  if (free) {
    unit.x += stepX;
    unit.y += stepY;
    return;
  }
  // Blocked head-on: slide along one axis, or swing the nose to feel
  // for a gap in the wall.
  const slideX = !bodyBlocked(town, unit.x + stepX, unit.y, unit.angle, 46, 22);
  if (slideX) {
    unit.x += stepX;
    unit.speed = unit.speed * 0.6;
    return;
  }
  const slideY = !bodyBlocked(town, unit.x, unit.y + stepY, unit.angle, 46, 22);
  if (slideY) {
    unit.y += stepY;
    unit.speed = unit.speed * 0.6;
    return;
  }
  unit.speed = unit.speed * 0.4;
  unit.angle = unit.angle + 0.9 * dt;
}

/**
 * A foot officer runs the thief down on foot and grabs her on
 * contact. Returns false once the unit has lost the trail and
 * walked away.
 */
function stepFootUnit(state, unit, prey, dt) {
  const thief = state.player;
  if (!thief || prey.inCar) return false;
  const range = Math.hypot(prey.x - unit.x, prey.y - unit.y);

  if (range <= SEE_FAR) {
    Object.assign(unit, { unseenFor: 0, lastX: prey.x, lastY: prey.y });
    setMode(unit, 'chase');
  } else {
    unit.unseenFor = unit.unseenFor + dt;
    const lostIt = unit.unseenFor > POLICE.searchSeconds && unit.mode === 'chase';
    if (lostIt) Object.assign(unit, { mode: 'search', searchLeft: POLICE.searchSeconds });
  }

  if (isSearching(unit)) {
    unit.searchLeft = unit.searchLeft - dt;
    const toMark = Math.hypot(unit.lastX - unit.x, unit.lastY - unit.y);
    if (toMark > 20) {
      const towardMark = Math.atan2(unit.lastY - unit.y, unit.lastX - unit.x);
      unit.angle = towardMark;
      unit.x += Math.cos(unit.angle) * ON_FOOT_SPEED * 0.6 * dt;
      unit.y += Math.sin(unit.angle) * ON_FOOT_SPEED * 0.6 * dt;
    }
    const done = unit.searchLeft <= 0 || range > GIVE_UP_FAR;
    return !done;
  }

  // Foot chase: straight at the thief, down the street.
  unit.angle = Math.atan2(prey.y - unit.y, prey.x - unit.x);
  const nextX = unit.x + Math.cos(unit.angle) * ON_FOOT_SPEED * dt;
  const nextY = unit.y + Math.sin(unit.angle) * ON_FOOT_SPEED * dt;
  const clear = !spotBlocked(state.city, nextX, nextY);
  if (clear) {
    unit.x = nextX;
    unit.y = nextY;
  }
  unit.speed = ON_FOOT_SPEED;

  // Caught: a touch costs the thief health, on a pause per grab.
  if (range < GRAB_REACH) {
    const clock = state.time ?? 0;
    if (clock - unit.ramAt >= GRAB_PAUSE) {
      unit.ramAt = clock;
      thief.hp = Math.max(0, thief.hp - GRAB_HURT);
      const fx = state.fx;
      if (fx) {
        fx.shakeT = Math.max(fx.shakeT ?? 0, 0.25);
        fx.shakeMag = Math.max(fx.shakeMag ?? 0, 5);
      }
    }
  }
  return true;
}

/**
 * Push the heat up by `amount`, never past the configured ceiling.
 * Alarms and gunfire feed this; the getaway inherits whatever the
 * heist left on the meter.
 */
export const raiseHeat = (state, amount) => {
  state.heat = bound((state.heat ?? 0) + amount, 0, HEAT.max);
};

/**
 * Let the heat fall — but only while no police unit is close enough
 * to see the crew. A unit riding the crew's tail pins the heat where
 * it sits; slipping away and going quiet is what lets it drop.
 */
export const lowerHeat = (state, dt) => {
  const heat = state.heat ?? 0;
  if (heat <= 0) {
    // Drain whatever is left so the meter rests exactly at zero.
    state.heat -= heat;
    return;
  }
  const force = state.police;
  const prey = quarryOf(state);
  let spotted = false;
  if (force && prey) {
    for (const unit of force.units) {
      const near = Math.hypot(unit.x - prey.x, unit.y - prey.y) <= SEE_FAR;
      if (near) {
        spotted = true;
        break;
      }
    }
  }
  if (!spotted) {
    state.heat = Math.max(0, heat - HEAT.coolPerSecond * dt);
  }
};
