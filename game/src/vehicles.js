// Senja Heist — the getaway car and how it drives.
//
// Arcade top-down driving for the escape leg: Mara takes the crew's
// car near the job's exit, threads the streets of Kota Senja, and has
// to reach the safehouse with the score. The car is a small physics
// body — forward speed along its heading, plus a sideways slip the
// tyres scrub off — so it leans into corners instead of snapping
// around them.
//
// Walls are tested corner by corner: all four corners of the car are
// checked against the city blocks, so it can scrape along a building
// face but can never cut through a corner. Traffic cars are soft
// obstacles instead: a bump hurts both cars and shoves them apart
// rather than letting them overlap.
//
// The crew's driver earns their keep here. When the crew has someone
// in the driver seat (Reno, by default), their driving skill feeds a
// small top-speed and acceleration lift into the getaway car through
// the crew module's bonus helper — guarded, so the car still drives
// exactly as before when that helper is not there. And when the
// player holds reverse and turns hard, the car throws a handbrake
// turn: extra yaw for a sharp change of direction, paid for with
// speed.

import * as gameCfg from './config.js';
import * as crewMod from './crew.js';

const CAR = gameCfg.CAR;
const PALETTE = gameCfg.PALETTE;

/** One body style: length, width, and paint. */
function bodyKind(length, width, color) {
  return { length, width, color };
}

/** Body size and paint for each kind; the renderer draws from x/y/angle/colour. */
const BODIES = {
  sedan: bodyKind(46, 22, PALETTE.carPlayer),
  van: bodyKind(56, 26, '#ffb454'),
  coupe: bodyKind(42, 20, '#d98cff'),
};

/** Distance the thief must be within to climb in, in pixels. */
const BOARD_DIST = 68;
/** Hurt each car takes from a traffic bump, and the gap between bumps. */
const BUMP_HURT = 6;
const BUMP_PAUSE = 0.9;
/** How long a bumped traffic car sits dazed before driving on. */
const BUMP_WAIT = 0.8;
/** How far beside the car the thief steps out when leaving, in pixels. */
const STEP_OUT = 34;
/** Floor and ceiling for the crew driver bonus multiplier. */
const BONUS_LO = 1;
const BONUS_HI = 1.3;
/** Handbrake turn: reverse pedal and steering past these bite. */
const BRAKE_REVERSE = 0.6;
const BRAKE_STEER = 0.7;
const BRAKE_MIN_SPEED = 80;

/** Last bump time per car, so a long scrape counts as one hit, not a dozen. */
const bumpClock = new WeakMap();

/** Keep a number inside [low, high]. */
function bound(n, low, high) {
  if (n <= low) return low;
  if (n >= high) return high;
  return n;
}

/** True when a point sits inside any building block or outside the map. */
function spotBlocked(city, x, y) {
  const usable = Boolean(city);
  if (!usable) return false;
  const pastEdge = x < 0 || y < 0 || x > city.w || y > city.h;
  if (pastEdge) return true;
  return city.blocks.some(
    (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h,
  );
}

/**
 * The car's four corners at a candidate pose. A corner inside a block
 * (or past the map edge) means the pose is illegal; checking corners
 * rather than the centre is what keeps the car from clipping through
 * a building corner.
 */
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

/** Body style for a car object, defaulting to the sedan's. */
function frameOf(car) {
  return BODIES[car.kind] ?? BODIES.sedan;
}

/**
 * The crew driver bonus for this run: when the crew has a driver and
 * the crew module offers its bonus helper, the driver's 'drive'
 * skill returns a multiplier for the getaway car. Anything missing,
 * unusable, or out of range reads as no bonus, so the car drives
 * exactly as before.
 */
function driverBonus(state) {
  const crew = state.crew;
  if (!Array.isArray(crew)) return 1;
  const driver = crew.find((member) => member.role === 'driver');
  if (!driver) return 1;
  const bonusFn = crewMod.crewBonus;
  if (typeof bonusFn !== 'function') return 1;
  const mult = bonusFn(driver, 'drive');
  const usable = typeof mult === 'number' && Number.isFinite(mult);
  if (!usable) return 1;
  return bound(mult, BONUS_LO, BONUS_HI);
}

/**
 * A getaway car at (x, y), facing up the street (north) with the
 * engine off; main.js puts Mara in it right away.
 */
export const createCar = (x, y, kind) => {
  const frame = BODIES[kind] ?? BODIES.sedan;
  const model = kind ?? 'sedan';
  const fresh = {
    x,
    y,
    angle: -Math.PI * 0.5,
    speed: 0,
    kind: model,
    color: frame.color,
    hp: CAR.hp,
    // Sideways slide, px/s. The renderer never reads it, and stepCar
    // owns it outright; driveBonus records the crew driver multiplier
    // the car is currently running with.
    slip: 0,
  };
  fresh.inUse = false;
  fresh.driveBonus = 1;
  return fresh;
};

/**
 * A handbrake turn: throw the tail around for a sharp change of
 * direction. Extra yaw in the steering direction, a hard bleed of
 * forward speed, and a kick of sideways slip the tyres then have to
 * scrub off. Arcade-simple — no spin-out, just a costly sharp turn.
 */
export function handbrakeTurn(car, steer, dt) {
  const direction = Math.sign(car.speed || 1);
  car.angle += 2.1 * steer * direction * dt;
  car.speed = car.speed * Math.max(0, 1 - 1.4 * dt);
  car.slip += steer * car.speed * 0.35 * dt;
}

/**
 * One step of the player's car.
 *
 * `drive.forward` / `drive.reverse` are 0..1 pedals, `drive.steer`
 * runs -1..1. The wheel only bites while the car is moving, and it
 * bites harder the faster the car goes; standing still, steering does
 * nothing at all. Backing up flips the steering sense, the way a real
 * car does. Off the pedals the car drags to a stop; pushing the pedal
 * against the direction of travel brakes hard first. The crew driver
 * bonus lifts top speed and acceleration a little, and reversing hard
 * into a turn throws a handbrake turn.
 */
export const stepCar = (state, dt, drive) => {
  const ride = state.car;
  if (!ride || !ride.inUse) return;
  const frame = frameOf(ride);
  const town = state.city;

  const mult = driverBonus(state);
  ride.driveBonus = mult;
  const top = CAR.topSpeed * mult;
  const accel = CAR.accel * mult;

  const gas = bound(drive.forward ?? 0, 0, 1);
  const backing = bound(drive.reverse ?? 0, 0, 1);
  const steer = bound(drive.steer ?? 0, -1, 1);

  // Pedals: speed up, brake against the way the car is travelling, or coast.
  if (gas > 0) {
    const slowing = ride.speed < 0;
    ride.speed = ride.speed + accel * (slowing ? 1.6 : 1) * gas * dt;
  } else if (backing > 0) {
    const slowing = ride.speed > 0;
    ride.speed = ride.speed - accel * (slowing ? 1.6 : 0.55) * backing * dt;
  } else {
    // Coasting drag: a firm stop, not a slow roll into the next block.
    const coastDrag = 260 * dt;
    if (Math.abs(ride.speed) <= coastDrag) ride.speed = 0;
    else ride.speed = ride.speed - Math.sign(ride.speed) * coastDrag;
  }
  ride.speed = bound(ride.speed, -CAR.reverse, top);

  // Steering grows with speed and flips when reversing; the sideways
  // slip it feeds in is what makes the tail step out in a hard turn.
  const speedRatio = bound(Math.abs(ride.speed) / top, 0, 1);
  const yawRate = CAR.turn * steer * (0.25 + 0.75 * speedRatio);
  ride.angle = ride.angle + yawRate * Math.sign(ride.speed || 1) * dt;
  ride.slip += yawRate * ride.speed * 0.28 * dt;

  // Reverse pedal held hard into a turn, with speed on: handbrake turn.
  const throwing = backing > BRAKE_REVERSE
    && Math.abs(steer) > BRAKE_STEER
    && Math.abs(ride.speed) > BRAKE_MIN_SPEED;
  if (throwing) handbrakeTurn(ride, steer, dt);

  // The tyres scrub the slide off; grip is how fast they manage it.
  ride.slip = ride.slip * Math.exp(-CAR.grip * dt);
  ride.slip = bound(ride.slip, -190, 190);

  // Travel: forward along the heading, sideways by the leftover slip.
  const dirX = Math.cos(ride.angle);
  const dirY = Math.sin(ride.angle);
  const sideX = -dirY;
  const sideY = dirX;
  const stepX = dirX * ride.speed * dt + sideX * ride.slip * dt;
  const stepY = dirY * ride.speed * dt + sideY * ride.slip * dt;

  // Try the whole move; when a corner clips a building, slide along
  // one axis at a time instead — the car scraping down a wall.
  const free = !bodyBlocked(town, ride.x + stepX, ride.y + stepY, ride.angle, frame.length, frame.width);
  if (free) {
    ride.x += stepX;
    ride.y += stepY;
  } else {
    const slideX = !bodyBlocked(town, ride.x + stepX, ride.y, ride.angle, frame.length, frame.width);
    const slideY = !bodyBlocked(town, ride.x, ride.y + stepY, ride.angle, frame.length, frame.width);
    if (slideX) {
      ride.x += stepX;
      ride.speed = ride.speed * 0.55;
      ride.slip = ride.slip * 0.4;
    } else if (slideY) {
      ride.y += stepY;
      ride.speed = ride.speed * 0.55;
      ride.slip = ride.slip * 0.4;
    } else {
      // Straight into a wall: stop dead and bleed the slide off.
      ride.speed = ride.speed * 0.25;
      ride.slip = ride.slip * 0.2;
    }
  }

  // Soft bumps with street traffic: a knock, not a pass-through.
  collideTraffic(state, ride);
};

/**
 * Shove the player's car and any traffic car it overlaps apart,
 * hurt both, and slow both down. Cooldown-gated per car so a long
 * push counts as one bump, not a machine-gun of them.
 */
function collideTraffic(state, ride) {
  const flow = state.traffic;
  if (!flow || !flow.cars) return;
  const clock = state.time ?? 0;
  for (const other of flow.cars) {
    const gap = Math.hypot(other.x - ride.x, other.y - ride.y);
    const touching = gap < 34 && gap !== 0;
    if (!touching) continue;
    const since = clock - (bumpClock.get(ride) ?? -99);
    if (since < BUMP_PAUSE) continue;
    bumpClock.set(ride, clock);

    // Drive both cars apart along the line between them.
    const pushX = (ride.x - other.x) / gap;
    const pushY = (ride.y - other.y) / gap;
    ride.x = ride.x + pushX * 8;
    ride.y = ride.y + pushY * 8;
    other.x = other.x - pushX * 8;
    other.y = other.y - pushY * 8;
    other.speed = other.speed > 60 ? other.speed - 60 : 0;
    other.wait = BUMP_WAIT;
    ride.speed = ride.speed * 0.6;
    ride.slip = ride.slip * 0.5;
    ride.hp = Math.max(0, ride.hp - BUMP_HURT);
    const fx = state.fx;
    if (fx) {
      fx.shakeT = Math.max(fx.shakeT ?? 0, 0.25);
      fx.shakeMag = Math.max(fx.shakeMag ?? 0, 5);
    }
  }
}

/**
 * Climb into the getaway car. The thief must be standing close by;
 * once in, the thief rides inside the car (hidden from the street)
 * until exitCar is called.
 */
export const enterCar = (state) => {
  const ride = state.car;
  const thief = state.player;
  if (!ride || !thief) return false;
  const far = Math.hypot(thief.x - ride.x, thief.y - ride.y) > BOARD_DIST;
  if (far) return false;
  ride.inUse = true;
  thief.hidden = true;
  thief.x = ride.x;
  thief.y = ride.y;
  thief.moving = false;
  thief.speed = 0;
  return true;
};

/**
 * Step out of the car. The thief is placed beside it on the street,
 * on the side with clear pavement — the driver-side door first, then
 * the passenger side, then behind — so Mara never spawns inside a
 * wall.
 */
export const exitCar = (state) => {
  const ride = state.car;
  const thief = state.player;
  if (!ride || !thief || !ride.inUse) return false;
  ride.inUse = false;
  ride.speed = 0;
  ride.slip = 0;

  const dirX = Math.cos(ride.angle);
  const dirY = Math.sin(ride.angle);
  const doors = [
    { x: ride.x - dirY * STEP_OUT, y: ride.y + dirX * STEP_OUT },
    { x: ride.x + dirY * STEP_OUT, y: ride.y - dirX * STEP_OUT },
    { x: ride.x - dirX * STEP_OUT, y: ride.y - dirY * STEP_OUT },
    { x: ride.x + dirX * STEP_OUT, y: ride.y + dirY * STEP_OUT },
  ];
  let steppedOut = false;
  for (const door of doors) {
    const clear = !spotBlocked(state.city, door.x, door.y);
    if (!clear) continue;
    thief.x = door.x;
    thief.y = door.y;
    steppedOut = true;
    break;
  }
  if (!steppedOut) {
    thief.x = ride.x;
    thief.y = ride.y;
  }
  thief.hidden = false;
  thief.moving = false;
  thief.speed = 0;
  return true;
};
