// Senja Heist — getaway cars.
//
// Arcade top-down driving for the escape leg: Mara steals the crew's car
// near the job's exit, threads the streets of Kota Senja, and has to reach
// the safehouse with the score. The car is a small physics body — a forward
// speed along its heading plus a sideways slip that the tyres scrub off —
// so it leans into corners instead of snapping around them.
//
// Collision is corner-based: the car's four corners are tested against the
// city blocks, so it can slide along a building face but can never cut
// through a corner. Traffic cars are soft obstacles: a bump damages both
// cars and shoves them apart instead of letting them overlap.

import { CAR, PALETTE } from './config.js';

/** Body size and paint per kind; the renderer draws from x/y/angle/colour. */
const KINDS = {
  sedan: { length: 46, width: 22, color: PALETTE.carPlayer },
  van: { length: 56, width: 26, color: '#ffb454' },
  coupe: { length: 42, width: 20, color: '#d98cff' },
};

/** How close the thief must stand to climb in, in pixels. */
const ENTER_RANGE = 68;
/** Damage each car takes from a traffic bump, and the gap between bumps. */
const BUMP_DAMAGE = 6;
const BUMP_COOLDOWN = 0.9;
/** How far beside the car the thief steps out, in pixels. */
const EXIT_OFFSET = 34;

/** Last bump time per car, so one long scrape is not a dozen hits. */
const lastBumpAt = new WeakMap();

/** Clamp a number into [lo, hi]. */
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** True when the point sits inside any building block or outside the map. */
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

/**
 * The car's four corners at a candidate pose. A corner inside a block (or
 * past the map edge) means the pose is illegal; testing corners instead of
 * the centre is what stops the car clipping through building corners.
 */
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

/** Dimensions for a car object, falling back to the sedan's body. */
function bodyOf(car) {
  return KINDS[car.kind] ?? KINDS.sedan;
}

/**
 * Build a getaway car at (x, y). The car starts facing up the street
 * (north) with the engine off; main.js puts Mara in it right away.
 */
export function createCar(x, y, kind) {
  const body = KINDS[kind] ?? KINDS.sedan;
  return {
    x,
    y,
    angle: -Math.PI / 2,
    speed: 0,
    kind: kind ?? 'sedan',
    color: body.color,
    hp: CAR.hp,
    inUse: false,
    // Sideways slide, px/s. Not part of the saved shape; the renderer
    // never reads it, and stepCar owns it outright.
    slip: 0,
  };
}

/**
 * Advance the player's car one step.
 *
 * `drive.forward` / `drive.reverse` are 0..1 pedals, `drive.steer` is
 * -1..1. Steering only bites while the car is moving, and it bites
 * harder the faster the car goes; at a standstill the wheel does
 * nothing. Reversing flips the steering sense, like a real car.
 * Letting off the pedals drags the car to a stop; holding the pedal
 * against the direction of travel brakes hard first.
 */
export function stepCar(state, dt, drive) {
  const car = state.car;
  if (!car || !car.inUse) return;
  const body = bodyOf(car);
  const city = state.city;

  const forward = clamp(drive.forward ?? 0, 0, 1);
  const reverse = clamp(drive.reverse ?? 0, 0, 1);
  const steer = clamp(drive.steer ?? 0, -1, 1);

  // Pedals: accelerate, brake against the current direction, or coast.
  if (forward > 0) {
    if (car.speed < 0) car.speed += CAR.accel * 1.6 * forward * dt;
    else car.speed += CAR.accel * forward * dt;
  } else if (reverse > 0) {
    if (car.speed > 0) car.speed -= CAR.accel * 1.6 * reverse * dt;
    else car.speed -= CAR.accel * 0.55 * reverse * dt;
  } else {
    // Rolling drag: a firm stop, not a slow coast into the next block.
    const drag = 260 * dt;
    if (Math.abs(car.speed) <= drag) car.speed = 0;
    else car.speed -= Math.sign(car.speed) * drag;
  }
  car.speed = clamp(car.speed, -CAR.reverse, CAR.topSpeed);

  // Steering scales with speed and flips when reversing; the sideways
  // slip it feeds is what makes the tail step out in a hard turn.
  const speedRatio = clamp(Math.abs(car.speed) / CAR.topSpeed, 0, 1);
  const turnRate = CAR.turn * steer * (0.25 + 0.75 * speedRatio);
  car.angle += turnRate * Math.sign(car.speed || 1) * dt;
  car.slip += turnRate * car.speed * 0.28 * dt;
  // The tyres scrub the slide away; grip is how fast they manage it.
  car.slip *= Math.exp(-CAR.grip * dt);
  car.slip = clamp(car.slip, -190, 190);

  // Move: forward along the heading, sideways by the remaining slip.
  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  const px = -fy;
  const py = fx;
  const dx = fx * car.speed * dt + px * car.slip * dt;
  const dy = fy * car.speed * dt + py * car.slip * dt;

  // Try the full move; if a corner clips a building, slide along one
  // axis at a time instead — that is the car scraping down a wall.
  if (!cornersSolid(city, car.x + dx, car.y + dy, car.angle, body.length, body.width)) {
    car.x += dx;
    car.y += dy;
  } else if (!cornersSolid(city, car.x + dx, car.y, car.angle, body.length, body.width)) {
    car.x += dx;
    car.speed *= 0.55;
    car.slip *= 0.4;
  } else if (!cornersSolid(city, car.x, car.y + dy, car.angle, body.length, body.width)) {
    car.y += dy;
    car.speed *= 0.55;
    car.slip *= 0.4;
  } else {
    // Head-on into a wall: stop dead and bleed the slide off.
    car.speed *= 0.25;
    car.slip *= 0.2;
  }

  // Soft collision with street traffic: a bump, not a pass-through.
  bumpTraffic(state, car);
}

/**
 * Shove the player's car and any traffic car it overlaps apart, damage
 * both, and slow both down. Cooldown-gated per car so a sustained
 * push is one bump, not a machine-gun of them.
 */
function bumpTraffic(state, car) {
  const traffic = state.traffic;
  if (!traffic || !traffic.cars) return;
  const now = state.time ?? 0;
  for (const other of traffic.cars) {
    const gap = Math.hypot(other.x - car.x, other.y - car.y);
    if (gap >= 34 || gap === 0) continue;
    const since = now - (lastBumpAt.get(car) ?? -99);
    if (since < BUMP_COOLDOWN) continue;
    lastBumpAt.set(car, now);

    // Push both cars apart along the line between them.
    const nx = (car.x - other.x) / gap;
    const ny = (car.y - other.y) / gap;
    car.x += nx * 8;
    car.y += ny * 8;
    other.x -= nx * 8;
    other.y -= ny * 8;
    other.speed = Math.max(0, other.speed - 60);
    other.wait = 0.8;
    car.speed *= 0.6;
    car.slip *= 0.5;
    car.hp = Math.max(0, car.hp - BUMP_DAMAGE);
    if (state.fx) {
      state.fx.shakeT = Math.max(state.fx.shakeT ?? 0, 0.25);
      state.fx.shakeMag = Math.max(state.fx.shakeMag ?? 0, 5);
    }
  }
}

/**
 * Climb into the getaway car. The thief must be standing close by; once
 * in, the thief rides inside the car (hidden from the street) until
 * exitCar is called.
 */
export function enterCar(state) {
  const car = state.car;
  const player = state.player;
  if (!car || !player) return false;
  if (Math.hypot(player.x - car.x, player.y - car.y) > ENTER_RANGE) return false;
  car.inUse = true;
  player.hidden = true;
  player.x = car.x;
  player.y = car.y;
  player.moving = false;
  player.speed = 0;
  return true;
}

/**
 * Step out of the car. The thief is placed beside it on the street, on
 * the side with clear pavement — the driver-side door first, then the
 * passenger side, then behind — so Mara never spawns inside a wall.
 */
export function exitCar(state) {
  const car = state.car;
  const player = state.player;
  if (!car || !player || !car.inUse) return false;
  car.inUse = false;
  car.speed = 0;
  car.slip = 0;

  const fx = Math.cos(car.angle);
  const fy = Math.sin(car.angle);
  const spots = [
    { x: car.x - fy * EXIT_OFFSET, y: car.y + fx * EXIT_OFFSET },
    { x: car.x + fy * EXIT_OFFSET, y: car.y - fx * EXIT_OFFSET },
    { x: car.x - fx * EXIT_OFFSET, y: car.y - fy * EXIT_OFFSET },
    { x: car.x + fx * EXIT_OFFSET, y: car.y + fy * EXIT_OFFSET },
  ];
  let placed = false;
  for (const spot of spots) {
    if (!pointSolid(state.city, spot.x, spot.y)) {
      player.x = spot.x;
      player.y = spot.y;
      placed = true;
      break;
    }
  }
  if (!placed) {
    player.x = car.x;
    player.y = car.y;
  }
  player.hidden = false;
  player.moving = false;
  player.speed = 0;
  return true;
}
