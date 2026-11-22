// Senja Heist — the city breathing around the getaway.
//
// The streets are alive while Mara drives: ordinary night traffic on
// the roads, pedestrians on the pavements. They make the escape feel
// like a real city and give the chase something to thread through — a
// traffic car is a soft obstacle the getaway car can bump, and a
// walker is a reason not to drive like a maniac on the kerb.
//
// Each traffic car keeps to its own road and lane, travelling one way,
// and it queues behind the car ahead instead of overlapping it. A
// queue that has sat still too long inches forward, so the street can
// never jam solid. Walkers amble near a home spot on the pavement and
// bolt when a fast car closes in. The whole thing stays cheap: a
// small fleet, a few walkers, no pathfinding, no fresh objects in the
// hot loop except the occasional top-up car.
//
// Rush hour changes the density. state.trafficLevel runs 0..1 — a job
// may set it, and it reads 0.5 when nobody does — and the street
// fills or thins to match it: quiet hours run about six cars, the
// rush runs about eighteen. Fresh cars roll in while the fleet is
// short, and spare cars drive off the end of a road instead of
// wrapping when the street is over-full. A quarter of the cars are
// taxis, and a taxi sometimes drifts into the other lane, so traffic
// never sits in perfectly straight lines.

/** Cars and walkers on the streets at a middling traffic level. */
const FLEET_BASE = 12;
const FOOT_COUNT = 14;
/** Traffic cruise speed, px/s, before queuing trims it back. */
const CRUISE_LO = 95;
const CRUISE_HI = 165;
/** Bumper gap a car keeps; inside it, the car brakes. */
const TAIL_GAP = 78;
/** Seconds a stopped queue waits before it starts creeping. */
const CREEP_WAIT = 2.5;
const CREEP_PACE = 26;
/** Walkers bolt from a player car nearer than this, faster than this. */
const FLEE_RANGE = 130;
const FLEE_SPEED = 220;
/** Fleet size at the quiet and busy ends of the traffic level. */
const FLEET_MIN = 6;
const FLEET_MAX = 18;
/** Pause between top-up cars while the street is under-filled. */
const TOP_UP_EVERY = 1.2;
/** Sideways drift speed of a taxi changing lanes, px/s. */
const LANE_DRIFT = 55;
/** Pause after a walker turns away from a wall before it may turn again. */
const TURN_PAUSE = 0.8;

/** Fleet paint — dull steel, with amber for the taxis among them. */
const CAR_PAINT = ['#8d93b8', '#a8aec9', '#c9a25e', '#7d8aa8', '#b8bcd4', '#5f6b8f'];
const FOOT_PAINT = ['#e8c9a0', '#c9a25e', '#9aa0c4', '#d98cff', '#8fb7ff', '#e6e6e6'];

/** Keep a number inside [low, high]. */
function bound(n, low, high) {
  if (n <= low) return low;
  if (n >= high) return high;
  return n;
}

/** True when a point falls inside a building block or off the map. */
function spotBlocked(city, x, y) {
  const usable = Boolean(city);
  if (!usable) return false;
  const pastEdge = x < 0 || y < 0 || x > city.w || y > city.h;
  if (pastEdge) return true;
  return city.blocks.some(
    (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h,
  );
}

/** Unit vector down a road, for a car travelling one way along it. */
function alongRoad(road, heading) {
  return road.dir === 'h' ? { x: heading, y: 0 } : { x: 0, y: heading };
}

/**
 * One traffic car, placed on a road: a random lane offset from the
 * middle of the road, a random direction to travel in, and a random
 * spot down its length. `lane` is -1 or 1, the side of the centre it
 * drives on; the renderer draws the car from x/y/angle. A quarter of
 * the fleet are taxis — laneOffset tracks where a taxi actually sits,
 * laneGoal where it is drifting to.
 */
function makeCar(rng, city) {
  const street = rng.pick(city.roads);
  const laneSide = rng.pick([-1, 1]);
  const direction = rng.pick([-1, 1]);
  const pace = rng.range(CRUISE_LO, CRUISE_HI);
  // Offset a quarter of the road width off the centre line, so the two
  // directions pass each other instead of driving head-on.
  const offset = (laneSide * street.h) / 4;
  const cab = rng.pick([true, false, false, false]);
  const firstTurn = rng.range(3, 9);
  let x;
  let y;
  const flat = street.dir === 'h';
  if (flat) {
    x = rng.range(street.x + 60, street.x + street.w - 60);
    y = street.y + street.h / 2 + offset;
  } else {
    x = street.x + street.w / 2 + offset;
    y = rng.range(street.y + 60, street.y + street.h - 60);
  }
  const vector = alongRoad(street, direction);
  const facing = Math.atan2(vector.y, vector.x);
  return {
    x,
    y,
    angle: facing,
    speed: pace,
    color: rng.pick(CAR_PAINT),
    lane: laneSide,
    // Bookkeeping only the simulation reads: which road the car is
    // on, which way it drives, its cruise speed, how long it has sat
    // in a queue, and — for taxis — the lane it is drifting toward
    // and the timer for its next lane change.
    road: street,
    heading: direction,
    cruise: pace,
    wait: 0,
    taxi: cab,
    laneOffset: offset,
    laneGoal: offset,
    laneTimer: firstTurn,
  };
}

/**
 * One walker, placed on a pavement: beside a road, just outside its
 * edge, ambling with a slow random heading. The anchor is home — the
 * walker wanders around it and never drifts far from it.
 */
function makeWalker(rng, city) {
  const street = rng.pick(city.roads);
  const kerb = rng.pick([-1, 1]);
  const startTurn = rng.range(1, 4);
  const amble = rng.range(22, 46);
  const heading = rng.range(0, Math.PI * 2);
  let x;
  let y;
  if (street.dir === 'h') {
    x = rng.range(street.x + 40, street.x + street.w - 40);
    y = street.y + (kerb < 0 ? -16 : street.h + 16);
  } else {
    x = street.x + (kerb < 0 ? -16 : street.w + 16);
    y = rng.range(street.y + 40, street.y + street.h - 40);
  }
  const walker = {
    x,
    y,
    angle: heading,
    speed: amble,
    color: rng.pick(FOOT_PAINT),
    // Wander notes: the anchor the walker stays near, and a timer for
    // the next random change of direction.
    anchorX: x,
    anchorY: y,
    turnTimer: startTurn,
  };
  Object.assign(walker, { fleeing: false });
  return walker;
}

/**
 * Street life for a getaway: cars on the roads, walkers on the
 * pavements. Only called when the city exists; with no roads the
 * street comes back empty rather than crashing. The result also
 * carries a private stroll sequence for the walkers, seeded once per
 * scene so the street behaves the same way every time it is staged
 * from one seed, plus a top-up timer for rush-hour density.
 */
export const createTraffic = (rng, city) => {
  const noRoads = !city || !city.roads || city.roads.length === 0;
  const seed = noRoads ? 1 : rng.int(1, 2147483646);
  if (noRoads) return { cars: [], walkers: [], stroll: { seed }, spawnTimer: 0 };
  const fleet = [];
  for (let i = 0; i < FLEET_BASE; i += 1) fleet.push(makeCar(rng, city));
  const crowd = [];
  for (let i = 0; i < FOOT_COUNT; i += 1) crowd.push(makeWalker(rng, city));
  return {
    cars: fleet,
    walkers: crowd,
    stroll: { seed },
    spawnTimer: 0,
  };
};

/**
 * Draw the next value in [0, 1) from the traffic object's stroll sequence.
 * The sequence is a small Lehmer generator kept on the traffic
 * object: cheap, seeded, and separate from the shared rng once the
 * scene is built, so walker turns stay deterministic for a staged
 * scene without touching the main stream.
 */
function strollNext(traffic) {
  const seq = traffic.stroll;
  seq.seed = (seq.seed * 48271) % 2147483647;
  return seq.seed / 2147483647;
}

/** Fleet size the current traffic level calls for, 6..18 cars. */
function carsWanted(state) {
  const raw = state.trafficLevel ?? 0.5;
  const level = bound(raw, 0, 1);
  return Math.round(FLEET_MIN + level * (FLEET_MAX - FLEET_MIN));
}

/** A stand-in rng backed by Math.random, for top-up cars mid-getaway. */
const looseRng = {
  pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  },
  range(min, max) {
    return min + Math.random() * (max - min);
  },
};

/**
 * One step for every car and walker. Cars follow their road and brake
 * for the car ahead in the same lane; a queue that has waited too
 * long creeps forward so traffic can never jam solid. Cars that run
 * off the end of their road wrap to the other end — unless the street
 * is over-filled for the traffic level, in which case they drive off
 * and are gone. Taxis drift between lanes. Walkers wander near their
 * anchor and scatter from a speeding player car.
 */
export const stepTraffic = (state, dt) => {
  const flow = state.traffic;
  const town = state.city;
  if (!flow || !town) return;
  stepCars(state, flow, dt);
  stepWalkers(state, flow, dt);
};

/** How far `other` sits ahead of `car` along their shared road. */
function gapAlong(car, other) {
  const forward = car.road.dir === 'h' ? other.x - car.x : other.y - car.y;
  return forward * car.heading;
}

/** Move the traffic cars: follow, queue, creep, wrap, thin, fill. */
function stepCars(state, flow, dt) {
  const town = state.city;
  const wanted = carsWanted(state);

  // Rush hour fills the street: roll a fresh car in now and then
  // while the fleet is short of the count the level calls for.
  flow.spawnTimer -= dt;
  const short = flow.cars.length < wanted && flow.spawnTimer <= 0;
  if (short) {
    flow.cars.push(makeCar(looseRng, town));
    flow.spawnTimer = TOP_UP_EVERY;
  }

  for (let i = flow.cars.length - 1; i >= 0; i -= 1) {
    const car = flow.cars[i];
    // Nearest car ahead in the same lane on the same road.
    let gapAhead = Infinity;
    for (const other of flow.cars) {
      const sameStreet = other !== car && other.road === car.road && other.lane === car.lane;
      if (!sameStreet) continue;
      const along = gapAlong(car, other);
      if (along > 0 && along < gapAhead) gapAhead = along;
    }

    // Queue: stop behind the car ahead, counting the wait; a queue
    // that has sat too long creeps forward instead of sitting solid.
    const queued = gapAhead < TAIL_GAP;
    car.wait = queued ? car.wait + dt : 0;
    let goal = car.cruise;
    if (queued) goal = car.wait > CREEP_WAIT ? CREEP_PACE : 0;
    // Ease toward the goal speed instead of snapping to it.
    const ease = goal < car.speed ? 320 : 140;
    if (car.speed < goal) car.speed = Math.min(goal, car.speed + ease * dt);
    else if (car.speed > goal) car.speed = Math.max(goal, car.speed - ease * dt);

    // Taxis drift between lanes: pick the other lane now and then,
    // then ease sideways toward it until they arrive.
    if (car.taxi) {
      car.laneTimer -= dt;
      if (car.laneTimer <= 0) {
        car.laneGoal = -car.laneOffset;
        car.laneTimer = 3 + Math.random() * 6;
      }
      const shift = bound(car.laneGoal - car.laneOffset, -LANE_DRIFT * dt, LANE_DRIFT * dt);
      if (shift !== 0) {
        car.laneOffset += shift;
        if (car.road.dir === 'h') car.y += shift;
        else car.x += shift;
        const arrived = Math.abs(car.laneGoal - car.laneOffset) < 1;
        if (arrived) {
          car.laneOffset = car.laneGoal;
          car.lane = car.laneGoal < 0 ? -1 : 1;
        }
      }
    }

    const dir = alongRoad(car.road, car.heading);
    car.x = car.x + dir.x * car.speed * dt;
    car.y = car.y + dir.y * car.speed * dt;
    car.angle = Math.atan2(dir.y, dir.x);

    // Off the end of the road: wrap to the other end so the street
    // never empties out — unless the street is over-filled for the
    // traffic level, in which case the car drives off for good.
    const street = car.road;
    const overFilled = flow.cars.length > wanted;
    const flat = street.dir === 'h';
    let pastEnd = false;
    if (flat) {
      pastEnd = car.heading > 0
        ? car.x > street.x + street.w + 40
        : car.x < street.x - 40;
    } else {
      pastEnd = car.heading > 0
        ? car.y > street.y + street.h + 40
        : car.y < street.y - 40;
    }
    if (pastEnd) {
      if (overFilled) {
        flow.cars.splice(i, 1);
        continue;
      }
      if (flat) {
        car.x = car.heading > 0 ? street.x - 40 : street.x + street.w + 40;
      } else {
        car.y = car.heading > 0 ? street.y - 40 : street.y + street.h + 40;
      }
    }
    // Clamp the car to the map even when a road runs past its edge.
    car.x = bound(car.x, -60, town.w + 60);
    car.y = bound(car.y, -60, town.h + 60);
  }
}

/** Walkers, one step: amble, keep off the buildings, bolt if needed. */
function stepWalkers(state, flow, dt) {
  const getaway = state.car;
  const speeding = getaway && getaway.inUse && Math.abs(getaway.speed) > FLEE_SPEED;
  for (const walker of flow.walkers) {
    walker.turnTimer = walker.turnTimer - dt;

    if (speeding) {
      const gap = Math.hypot(walker.x - getaway.x, walker.y - getaway.y);
      const bearingDown = gap < FLEE_RANGE && gap > 0;
      if (bearingDown) {
        // Bolt: straight away from the car, at a run.
        walker.angle = Math.atan2(walker.y - getaway.y, walker.x - getaway.x);
        Object.assign(walker, { fleeing: true, turnTimer: 0.6 });
      }
    }
    const timeToTurn = walker.turnTimer <= 0;
    if (timeToTurn) {
      // The timer has run out, so the walker calms down and picks a
      // fresh heading: mostly keep drifting, sometimes turn properly.
      walker.fleeing = walker.turnTimer > 0;
      walker.angle += (strollNext(flow) - 0.5) * 2.4;
      walker.turnTimer = 1 + strollNext(flow) * 3;
    }

    const pace = walker.fleeing ? 95 : walker.speed;
    const nextX = walker.x + Math.cos(walker.angle) * pace * dt;
    const nextY = walker.y + Math.sin(walker.angle) * pace * dt;

    // Blocked by a building or the map edge, or too far from home:
    // turn around instead of walking through the wall, and drift back
    // toward the anchor.
    const strayed = Math.hypot(nextX - walker.anchorX, nextY - walker.anchorY) > 150;
    const blocked = spotBlocked(state.city, nextX, nextY) || strayed;
    if (blocked) {
      walker.angle += Math.PI * (0.6 + strollNext(flow) * 0.8);
      walker.turnTimer = TURN_PAUSE;
    } else {
      walker.x = nextX;
      walker.y = nextY;
    }
  }
}

/**
 * Nearest traffic car within `r` pixels of (x, y), or null. Vehicles
 * and police use it as their collision query; the radius is measured
 * centre to centre, with a little slack for the car's body, so a near
 * miss stays a near miss.
 */
export const trafficCarNear = (state, x, y, r) => {
  const flow = state.traffic;
  if (!flow || !flow.cars) return null;
  let nearest = null;
  let nearestGap = Infinity;
  for (const car of flow.cars) {
    const dist = Math.hypot(car.x - x, car.y - y);
    const closer = dist < r + 14 && dist < nearestGap;
    if (!closer) continue;
    nearest = car;
    nearestGap = dist;
  }
  return nearest;
};
