// Senja Heist — street life for the getaway.
//
// Kota Senja is not an empty set: while Mara drives, the roads carry
// ordinary night traffic and the pavements carry pedestrians. Both exist
// to make the escape feel like a city and to give the chase something to
// weave through — traffic cars are also the soft obstacles stepCar bumps
// into, and walkers are the reason a wild driver should watch the kerb.
//
// Traffic cars drive their road in a lane, one direction each, and they
// queue instead of piling up: a car stops for the one ahead, and if the
// queue sits too long it creeps forward so the street never deadlocks.
// Walkers drift along the pavements and scatter when a fast car bears
// down on them. Everything here is cheap — a handful of cars and
// walkers, no pathfinding, no allocations in the hot loop.

import { PALETTE } from './config.js';

/** How many cars and walkers share the streets. */
const CAR_COUNT = 12;
const WALKER_COUNT = 14;
/** Traffic cruise speed, px/s, before the queue logic trims it. */
const CRUISE_MIN = 95;
const CRUISE_MAX = 165;
/** Gap a car keeps to the bumper ahead; closer than this it brakes. */
const FOLLOW_GAP = 78;
/** A stopped queue starts creeping after this many seconds. */
const CREEP_AFTER = 2.5;
const CREEP_SPEED = 26;
/** Walkers run from a player car closer than this, faster than this. */
const SCATTER_RANGE = 130;
const SCATTER_SPEED = 220;

/** Paint for the traffic fleet — muted steel and taxi amber. */
const CAR_COLORS = ['#8d93b8', '#a8aec9', '#c9a25e', '#7d8aa8', '#b8bcd4', '#5f6b8f'];
const WALKER_COLORS = ['#e8c9a0', '#c9a25e', '#9aa0c4', '#d98cff', '#8fb7ff', '#e6e6e6'];

/** Clamp a number into [lo, hi]. */
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
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

/** The unit vector along a road, for a car heading one way down it. */
function roadVector(road, heading) {
  if (road.dir === 'h') return { x: heading, y: 0 };
  return { x: 0, y: heading };
}

/**
 * Place one traffic car on a road: a random lane offset from the
 * centre line, a random direction along the road, and a random spot
 * along its length. `lane` is -1 or 1, which side of the centre it
 * drives on; the renderer draws the car at its x/y/angle.
 */
function spawnTrafficCar(rng, city) {
  const road = rng.pick(city.roads);
  const lane = rng.pick([-1, 1]);
  const heading = rng.pick([-1, 1]);
  const cruise = rng.range(CRUISE_MIN, CRUISE_MAX);
  // Lane offset: a quarter of the road width off the centre line, so
  // the two directions pass each other instead of head-on.
  const offset = lane * road.h / 4;
  let x;
  let y;
  if (road.dir === 'h') {
    x = rng.range(road.x + 60, road.x + road.w - 60);
    y = road.y + road.h / 2 + offset;
  } else {
    x = road.x + road.w / 2 + offset;
    y = rng.range(road.y + 60, road.y + road.h - 60);
  }
  const vector = roadVector(road, heading);
  return {
    x,
    y,
    angle: Math.atan2(vector.y, vector.x),
    speed: cruise,
    color: rng.pick(CAR_COLORS),
    lane,
    // Simulation-only bookkeeping the renderer never reads: which road
    // this car belongs to, which way it drives, its cruise speed, and
    // how long it has been held up in a queue.
    road,
    heading,
    cruise,
    wait: 0,
  };
}

/**
 * Place one walker on a pavement: beside a road, just outside its
 * edge, with a slow wander heading. The anchor is home — the walker
 * drifts around it and never strays far.
 */
function spawnWalker(rng, city) {
  const road = rng.pick(city.roads);
  const side = rng.pick([-1, 1]);
  let x;
  let y;
  if (road.dir === 'h') {
    x = rng.range(road.x + 40, road.x + road.w - 40);
    y = road.y + (side < 0 ? -16 : road.h + 16);
  } else {
    x = road.x + (side < 0 ? -16 : road.w + 16);
    y = rng.range(road.y + 40, road.y + road.h - 40);
  }
  const angle = rng.range(0, Math.PI * 2);
  return {
    x,
    y,
    angle,
    speed: rng.range(22, 46),
    color: rng.pick(WALKER_COLORS),
    // Wander bookkeeping: the anchor the walker stays near, and a
    // timer for the next random change of direction.
    anchorX: x,
    anchorY: y,
    turnTimer: rng.range(1, 4),
    fleeing: false,
  };
}

/**
 * Build the street life for a getaway: cars on the roads, walkers on
 * the pavements. Only called when the city exists; with no roads the
 * street is empty rather than crashing.
 */
export function createTraffic(rng, city) {
  if (!city || !city.roads || city.roads.length === 0) {
    return { cars: [], walkers: [] };
  }
  const cars = [];
  for (let i = 0; i < CAR_COUNT; i += 1) cars.push(spawnTrafficCar(rng, city));
  const walkers = [];
  for (let i = 0; i < WALKER_COUNT; i += 1) walkers.push(spawnWalker(rng, city));
  return {
    cars,
    walkers,
    // A private stroll sequence for the walkers, seeded once per scene so
    // the street behaves the same way every time it is staged from one seed.
    stroll: { seed: rng.int(1, 2147483646) },
  };
}

/**
 * Next value in [0, 1) from the traffic object's own stroll sequence.
 * A tiny Lehmer generator kept on the traffic object: cheap, seeded, and
 * independent of the shared rng once the scene is built, so walker turns
 * stay deterministic for a staged scene without touching the main stream.
 */
function nextStroll(traffic) {
  const sequence = traffic.stroll;
  sequence.seed = (sequence.seed * 48271) % 2147483647;
  return sequence.seed / 2147483647;
}

/**
 * Advance every car and walker one step. Cars follow their road and
 * brake for the car ahead in the same lane; a queue that has waited
 * too long creeps forward so traffic can never jam solid. Cars that
 * run off the end of their road wrap to the other end. Walkers
 * wander near their anchor and scatter from a speeding player car.
 */
export function stepTraffic(state, dt) {
  const traffic = state.traffic;
  const city = state.city;
  if (!traffic || !city) return;
  stepCars(state, traffic, dt);
  stepWalkers(state, traffic, dt);
}

/** Move the traffic cars: follow, queue, creep, wrap. */
function stepCars(state, traffic, dt) {
  const city = state.city;
  for (const car of traffic.cars) {
    // Find the nearest car ahead in the same lane on the same road.
    let aheadGap = Infinity;
    for (const other of traffic.cars) {
      if (other === car || other.road !== car.road || other.lane !== car.lane) continue;
      const along = car.road.dir === 'h'
        ? (other.x - car.x) * car.heading
        : (other.y - car.y) * car.heading;
      if (along > 0 && along < aheadGap) aheadGap = along;
    }

    let target = car.cruise;
    if (aheadGap < FOLLOW_GAP) {
      // Queue: stop, and start counting how long we have waited.
      target = 0;
      car.wait += dt;
      if (car.wait > CREEP_AFTER) target = CREEP_SPEED;
    } else {
      car.wait = 0;
    }
    // Ease toward the target speed instead of snapping to it.
    const rate = target < car.speed ? 320 : 140;
    if (car.speed < target) car.speed = Math.min(target, car.speed + rate * dt);
    else if (car.speed > target) car.speed = Math.max(target, car.speed - rate * dt);

    const vector = roadVector(car.road, car.heading);
    car.x += vector.x * car.speed * dt;
    car.y += vector.y * car.speed * dt;
    car.angle = Math.atan2(vector.y, vector.x);

    // Wrap at the ends of the road so the street never empties out.
    const road = car.road;
    if (road.dir === 'h') {
      if (car.heading > 0 && car.x > road.x + road.w + 40) car.x = road.x - 40;
      if (car.heading < 0 && car.x < road.x - 40) car.x = road.x + road.w + 40;
    } else {
      if (car.heading > 0 && car.y > road.y + road.h + 40) car.y = road.y - 40;
      if (car.heading < 0 && car.y < road.y - 40) car.y = road.y + road.h + 40;
    }
    // Keep the car on the map even if a road runs past its edge.
    car.x = clamp(car.x, -60, city.w + 60);
    car.y = clamp(car.y, -60, city.h + 60);
  }
}

/** Move the walkers: wander, stay out of buildings, scatter. */
function stepWalkers(state, traffic, dt) {
  const playerCar = state.car;
  const playerFast = playerCar && playerCar.inUse && Math.abs(playerCar.speed) > SCATTER_SPEED;
  for (const walker of traffic.walkers) {
    walker.turnTimer -= dt;

    if (playerFast) {
      const gap = Math.hypot(walker.x - playerCar.x, walker.y - playerCar.y);
      if (gap < SCATTER_RANGE && gap > 0) {
        // Flee: straight away from the car, at a run.
        walker.angle = Math.atan2(walker.y - playerCar.y, walker.x - playerCar.x);
        walker.fleeing = true;
        walker.turnTimer = 0.6;
      }
    }
    if (walker.turnTimer <= 0) {
      walker.fleeing = false;
      // A new heading: mostly keep drifting, sometimes turn properly.
      walker.angle += (nextStroll(traffic) - 0.5) * 2.4;
      walker.turnTimer = 1 + nextStroll(traffic) * 3;
    }

    const speed = walker.fleeing ? 95 : walker.speed;
    const nx = walker.x + Math.cos(walker.angle) * speed * dt;
    const ny = walker.y + Math.sin(walker.angle) * speed * dt;

    // Turn away from buildings and the map edge instead of walking
    // through them; drift back toward the anchor when too far away.
    const farFromHome = Math.hypot(nx - walker.anchorX, ny - walker.anchorY) > 150;
    if (pointSolid(state.city, nx, ny) || farFromHome) {
      walker.angle += Math.PI * (0.6 + nextStroll(traffic) * 0.8);
      walker.turnTimer = 0.8;
    } else {
      walker.x = nx;
      walker.y = ny;
    }
  }
}

/**
 * The nearest traffic car within `r` pixels of (x, y), or null.
 * Vehicles and police use this as their collision query; the radius
 * is measured centre to centre, with a little slack for the car's
 * body, so a near miss stays a near miss.
 */
export function trafficCarNear(state, x, y, r) {
  const traffic = state.traffic;
  if (!traffic || !traffic.cars) return null;
  let best = null;
  let bestGap = Infinity;
  for (const car of traffic.cars) {
    const gap = Math.hypot(car.x - x, car.y - y);
    if (gap < r + 14 && gap < bestGap) {
      best = car;
      bestGap = gap;
    }
  }
  return best;
}
