// Senja Heist — the room's eyes: patrolling guards, sweeping cameras, alarm.
//
// A guard watches a wedge of floor that turns as he walks his route; a
// camera watches a wedge that swings back and forth on its mount. Stand in
// a wedge with nothing between you and the watcher and suspicion climbs;
// let it fill and the guard runs you down, and every second spent watched
// pushes the alarm higher. The alarm is the whole room's memory of the
// crew: it rises while anyone is seen and bleeds away while the crew stays
// quiet. When it crosses the suspicion line every guard drops his route
// and closes on the last place the thief was seen. At 100 main.js locks
// the exits and sends for the police.
//
// Smoke is the counter-play: a cloud between a watcher and the thief breaks
// the line of sight outright, for guards and cameras alike. Cameras can
// also be knocked out by an EMP pulse or by the hacker — a dead camera
// counts back down and comes back online on its own.
//
// This file only ever tests geometry against the room's own rect lists, so
// it keeps working even while other modules are still being reworked.

import { GUARD, CAMERA, ALARM, THIEF } from './config.js';

/** Suspicion past this point makes a guard stop walking and stare. */
const STARE_LINE = 0.35;
/** Suspicion lost per second while the thief is out of sight. */
const CALM_RATE = 0.45;
/** Seconds a guard spends sweeping around a spot where the thief vanished. */
const HUNT_SECONDS = 3.5;
/** Seconds a guard must wait between grabs once he is on the thief. */
const GRAB_GAP = 1.0;
/** A guard hears a noise a little past the noise radius itself. */
const EARSHOT = 2.2;
/** Alarm level where the HUD stops calling the room calm. */
const NERVOUS_ALARM = 15;
/** How much faster cameras sweep once the room is on alert. */
const ALERT_SWEEP_MULT = 1.6;
/** How close a guard must get to a converge point to count as arrived. */
const CONVERGE_CLOSE = 10;
/** How close a guard must get to a waypoint to count as reached. */
const WAYPOINT_CLOSE = 6;
/** Pause, in seconds, at each waypoint before walking on. */
const WAYPOINT_PAUSE = 0.6;

// ---------------------------------------------------------------------------
// Geometry helpers: angles, solids, and segments against the room's rects.
// ---------------------------------------------------------------------------

/** Fold an angle difference back into [-PI, PI]. */
function normAngle(delta) {
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** True when the point (x, y) is inside a wall or outside the room. */
function insideSolid(room, x, y) {
  if (!room) return false;
  if (x < 0 || y < 0 || x > room.w || y > room.h) return true;
  for (const wall of room.walls ?? []) {
    const inX = x >= wall.x && x <= wall.x + wall.w;
    const inY = y >= wall.y && y <= wall.y + wall.h;
    if (inX && inY) return true;
  }
  return false;
}

/**
 * True when the straight line from (ax, ay) to (bx, by) is cut by a wall
 * or a shut door. Crates and counters never block a look — only walls and
 * closed doors do — which is why crouching behind cover is a real tactic.
 */
function losBlocked(room, ax, ay, bx, by) {
  if (!room) return false;
  const solids = [...(room.walls ?? [])];
  for (const door of room.doors ?? []) {
    if (!door.open) solids.push(door);
  }
  for (const rect of solids) {
    if (segmentCrossesRect(ax, ay, bx, by, rect)) return true;
  }
  return false;
}

/** Slab test: does the segment pass through this axis-aligned rect? */
function segmentCrossesRect(ax, ay, bx, by, rect) {
  const dx = bx - ax;
  const dy = by - ay;
  let low = 0;
  let high = 1;
  const axes = [
    [ax, dx, rect.x, rect.x + rect.w],
    [ay, dy, rect.y, rect.y + rect.h],
  ];
  for (const [origin, delta, min, max] of axes) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < min || origin > max) return false;
    } else {
      let tA = (min - origin) / delta;
      let tB = (max - origin) / delta;
      if (tA > tB) [tA, tB] = [tB, tA];
      low = Math.max(low, tA);
      high = Math.min(high, tB);
      if (low > high) return false;
    }
  }
  return true;
}

/** Does the segment (ax, ay)-(bx, by) cut through the circle (cx, cy, r)? */
function segmentCrossesCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 1e-9) {
    t = ((cx - ax) * dx + (cy - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const px = ax + dx * t;
  const py = ay + dy * t;
  const ox = cx - px;
  const oy = cy - py;
  return ox * ox + oy * oy < r * r;
}

/**
 * Walk `body` toward (tx, ty) at `speed`, sliding along walls instead of
 * sticking to them: try the full step, then x-only, then y-only. Returns
 * the distance still left to the target.
 */
function slideToward(room, body, tx, ty, speed, dt) {
  const dx = tx - body.x;
  const dy = ty - body.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return 0;
  const step = Math.min(dist, speed * dt);
  const nextX = body.x + (dx / dist) * step;
  const nextY = body.y + (dy / dist) * step;
  if (!insideSolid(room, nextX, nextY)) {
    body.x = nextX;
    body.y = nextY;
  } else if (!insideSolid(room, nextX, body.y)) {
    body.x = nextX;
  } else if (!insideSolid(room, body.x, nextY)) {
    body.y = nextY;
  }
  body.angle = Math.atan2(dy, dx);
  return Math.hypot(tx - body.x, ty - body.y);
}

/** Index of the route point closest to where `guard` stands right now. */
function closestWaypoint(guard) {
  let best = 0;
  let bestDist = Infinity;
  guard.route.forEach((point, i) => {
    const d = Math.hypot(point.x - guard.x, point.y - guard.y);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Smoke: clouds laid down by effects.js that blind watchers.
// ---------------------------------------------------------------------------

/** The live smoke list, created on first use so older saves still load. */
function smokeClouds(state) {
  if (!state.smoke) state.smoke = [];
  return state.smoke;
}

/** True while a cloud still has time left on it (no timer means it lives). */
function cloudAlive(cloud) {
  return (cloud.t ?? 1) > 0;
}

/**
 * True when the line from watcher (ax, ay) to the thief (bx, by) runs
 * through any live smoke cloud. A watcher cannot see through smoke at all.
 */
export function smokeBlocksVision(state, ax, ay, bx, by) {
  for (const cloud of smokeClouds(state)) {
    if (!cloudAlive(cloud)) continue;
    if (segmentCrossesCircle(ax, ay, bx, by, cloud.x, cloud.y, cloud.r)) return true;
  }
  return false;
}

/** True when the point (x, y) sits inside any live smoke cloud. */
export function inSmoke(state, x, y) {
  for (const cloud of smokeClouds(state)) {
    if (!cloudAlive(cloud)) continue;
    const dx = x - cloud.x;
    const dy = y - cloud.y;
    if (dx * dx + dy * dy < cloud.r * cloud.r) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * One guard per post, up to `job.guards`. When the job wants more guards
 * than the room has posts, posts repeat with staggered starting waypoints
 * so two guards never march in lockstep down the same route.
 */
export function createGuards(rng, room, job) {
  const posts = room?.guardPosts ?? [];
  const wanted = job?.guards ?? posts.length;
  const guards = [];
  for (let i = 0; i < wanted; i += 1) {
    const post = posts[i % Math.max(posts.length, 1)];
    if (!post) break;
    const route = post.route?.length ? post.route : [{ x: post.x, y: post.y }];
    const startWp = posts.length > 0 ? i % route.length : 0;
    guards.push({
      id: i,
      x: route[startWp].x,
      y: route[startWp].y,
      angle: rng ? rng.range(0, Math.PI * 2) : 0,
      speed: 0,
      route,
      wp: (startWp + 1) % route.length,
      mode: 'patrol',
      suspicion: 0,
      alertTimer: 0,
      lastSeen: null,
      down: false,
      downTimer: 0,
      marked: false,
      pauseTimer: 0,
      searchTimer: 0,
      grabTimer: 0,
      sweepDir: 1,
      // Alert mode: true while the room is hot and this guard is closing
      // on the thief's last seen spot instead of walking his route.
      alertMode: false,
    });
  }
  return guards;
}

/**
 * One camera per post, up to `job.cameras`. Each keeps its mount's base
 * angle and swings around it; `speed` is the base sweep rate and `range`
 * the reach of its cone.
 */
export function createCameras(rng, room, job) {
  void rng;
  const posts = room?.camPosts ?? [];
  const wanted = job?.cameras ?? posts.length;
  return posts.slice(0, wanted).map((post, i) => ({
    id: i,
    x: post.x,
    y: post.y,
    angle: post.angle ?? 0,
    baseAngle: post.angle ?? 0,
    sweep: post.sweep ?? CAMERA.sweep,
    speed: CAMERA.sweepSpeed,
    range: CAMERA.range,
    disabled: false,
    disabledTimer: 0,
    // Who knocked this camera out ('emp' | 'hack'), null while it runs.
    disabledBy: null,
    // Sweep phase, advanced every frame so alert speed-ups stay smooth.
    phase: 0,
    spotTimer: 0,
  }));
}

// ---------------------------------------------------------------------------
// Sight checks
// ---------------------------------------------------------------------------

/**
 * How clearly `guard` sees the thief right now, 0..1. Zero outside the
 * cone, past effective range, behind a wall or a shut door, through smoke,
 * while the guard is down, or while the thief is hidden. Crouching and the
 * crew disguise each halve the distance he is spotted at, and the crew's
 * stealth bonus shortens it further — a quiet thief has to be nearly
 * stepped on. Inside range the value is strongest up close and thins
 * toward the edge, so a distant glimpse builds suspicion slowly while a
 * close one turns a guard fast.
 */
export function guardSees(state, guard) {
  const player = state.player;
  if (!player || !guard || guard.down || player.hidden) return 0;
  smokeClouds(state); // make sure the smoke list exists before testing it
  let reach = GUARD.sight;
  if (player.crouched) reach *= 0.5;
  if (player.disguised) reach *= 0.5;
  const stealthMul = typeof player.stealthMul === 'number' ? player.stealthMul : 1;
  if (stealthMul > 0) reach *= 1 / stealthMul;
  const dx = player.x - guard.x;
  const dy = player.y - guard.y;
  const dist = Math.hypot(dx, dy);
  if (dist > reach) return 0;
  if (!inCone(player.x, player.y, guard.x, guard.y, guard.angle, reach, GUARD.halfCone)) return 0;
  if (losBlocked(state.room, guard.x, guard.y, player.x, player.y)) return 0;
  if (smokeBlocksVision(state, guard.x, guard.y, player.x, player.y)) return 0;
  const closeness = 1 - dist / reach;
  return 0.45 + 0.55 * closeness;
}

/**
 * True when `camera` has the thief in its sweeping cone with a clear view.
 * A disabled camera sees nothing, and smoke blinds a camera like a guard.
 */
export function cameraSees(state, camera) {
  const player = state.player;
  if (!player || !camera || camera.disabled || player.hidden) return false;
  smokeClouds(state); // make sure the smoke list exists before testing it
  if (!inCone(player.x, player.y, camera.x, camera.y, camera.angle, camera.range, CAMERA.halfCone)) return false;
  if (losBlocked(state.room, camera.x, camera.y, player.x, player.y)) return false;
  if (smokeBlocksVision(state, camera.x, camera.y, player.x, player.y)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Guard behaviour, one mode at a time
// ---------------------------------------------------------------------------

/** Walk the route, pausing briefly at each waypoint. */
function walkRoute(state, guard, dt) {
  guard.speed = GUARD.patrol;
  if (guard.pauseTimer > 0) {
    guard.pauseTimer -= dt;
    return;
  }
  const target = guard.route[guard.wp % guard.route.length];
  const left = slideToward(state.room, guard, target.x, target.y, GUARD.patrol, dt);
  if (left < WAYPOINT_CLOSE) {
    guard.wp = (guard.wp + 1) % guard.route.length;
    guard.pauseTimer = WAYPOINT_PAUSE;
  }
}

/** Stand still and stare at the last glimpse. */
function stareAtLastSeen(guard) {
  guard.speed = 0;
  if (guard.lastSeen) {
    guard.angle = Math.atan2(guard.lastSeen.y - guard.y, guard.lastSeen.x - guard.x);
  }
}

/** Run the thief down and grab him when close enough. */
function runDownThief(state, guard, dt) {
  const player = state.player;
  guard.speed = GUARD.chase;
  slideToward(state.room, guard, player.x, player.y, GUARD.chase, dt);
  const dist = Math.hypot(player.x - guard.x, player.y - guard.y);
  if (dist <= GUARD.catchRange && guard.grabTimer <= 0) {
    player.hp = Math.max(0, player.hp - GUARD.punchDamage);
    guard.grabTimer = GRAB_GAP;
    if (state.fx) {
      state.fx.shakeT = Math.max(state.fx.shakeT, 0.25);
      state.fx.shakeMag = Math.max(state.fx.shakeMag, 5);
    }
  }
}

/**
 * Walk to the last seen spot, then sweep the room with his eyes until the
 * hunt timer runs out.
 */
function huntLastSeen(state, guard, dt) {
  guard.searchTimer += dt;
  guard.speed = GUARD.search;
  if (!guard.lastSeen) return;
  const left = slideToward(state.room, guard, guard.lastSeen.x, guard.lastSeen.y, GUARD.search, dt);
  if (left < CONVERGE_CLOSE) {
    guard.angle += guard.sweepDir * 1.6 * dt;
    if (guard.searchTimer > 1 && Math.abs(normAngle(guard.angle)) > 2.4) guard.sweepDir *= -1;
  }
}

/**
 * Alert response: the room is hot, so close on the thief's last seen spot
 * instead of walking the route. On arrival, keep sweeping the area — the
 * thief may still be nearby. Returns true while the guard is converging.
 */
function convergeOnAlert(state, guard, dt) {
  const target = state.lastSeen ?? guard.lastSeen;
  if (!target) return false;
  guard.speed = GUARD.search;
  const left = slideToward(state.room, guard, target.x, target.y, GUARD.search, dt);
  if (left < CONVERGE_CLOSE) {
    guard.angle += guard.sweepDir * 1.6 * dt;
    if (Math.abs(normAngle(guard.angle)) > 2.4) guard.sweepDir *= -1;
  }
  return true;
}

/**
 * Step every guard once: listen for noise, update suspicion, pick a mode,
 * then act on it. A loud thief pulls the nearest guard in earshot over to
 * listen; a guard who was knocked down wakes up hunting where he fell.
 */
export function stepGuards(state, dt) {
  const player = state.player;
  if (!player) return;
  const roomHot = state.alarm >= ALARM.suspectAt;

  // Noise pulls exactly one guard: the nearest patrolling guard in earshot.
  if (player.noise > 0 && player.moving) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const guard of state.guards ?? []) {
      if (guard.down || (guard.mode !== 'patrol' && guard.mode !== 'suspicious')) continue;
      const dist = Math.hypot(player.x - guard.x, player.y - guard.y);
      if (dist < player.noise * EARSHOT && dist < nearestDist) {
        nearest = guard;
        nearestDist = dist;
      }
    }
    if (nearest) {
      nearest.lastSeen = { x: player.x, y: player.y };
      nearest.suspicion = Math.max(nearest.suspicion, STARE_LINE);
      nearest.mode = 'search';
      nearest.searchTimer = 0;
    }
  }

  for (const guard of state.guards ?? []) {
    if (guard.down) {
      guard.downTimer -= dt;
      if (guard.downTimer <= 0) {
        guard.down = false;
        guard.downTimer = 0;
        guard.mode = 'search';
        guard.lastSeen = { x: guard.x, y: guard.y };
        guard.searchTimer = 0;
      }
      continue;
    }
    if (guard.grabTimer > 0) guard.grabTimer -= dt;

    // Seeing the thief fills suspicion and records where he was seen —
    // both on the guard and on the room, so the whole crew can react.
    const seen = guardSees(state, guard);
    if (seen > 0) {
      guard.suspicion = Math.min(1, guard.suspicion + GUARD.suspicionPerSecond * seen * dt);
      guard.lastSeen = { x: player.x, y: player.y };
      state.lastSeen = { x: player.x, y: player.y };
      guard.alertTimer = 0;
    } else {
      guard.suspicion = Math.max(0, guard.suspicion - CALM_RATE * dt);
      guard.alertTimer += dt;
    }

    // Mode transitions, in priority order: a full meter means a chase, a
    // chase only ends once the thief has stayed lost long enough, and a
    // finished search sends the guard back to his route.
    if (guard.suspicion >= 1) {
      guard.mode = 'chase';
    } else if (guard.mode === 'chase' && guard.alertTimer >= GUARD.loseSeconds) {
      guard.mode = 'search';
      guard.searchTimer = 0;
    } else if (guard.mode === 'search' && guard.searchTimer >= HUNT_SECONDS) {
      guard.mode = 'patrol';
      guard.suspicion = 0;
      guard.lastSeen = null;
    } else if (guard.mode !== 'chase' && guard.mode !== 'search') {
      guard.mode = guard.suspicion > STARE_LINE ? 'suspicious' : 'patrol';
    }

    // Alert handling: while the room is hot every guard who is not already
    // chasing converges on the last seen spot. Once the alarm cools and
    // the thief is lost, the guard drops back to his route, resuming from
    // the waypoint nearest to where he ended up.
    if (roomHot && guard.mode !== 'chase') {
      guard.alertMode = true;
    } else if (!roomHot && guard.alertMode) {
      guard.alertMode = false;
      if (guard.mode !== 'chase' && guard.mode !== 'search') {
        guard.mode = 'patrol';
        guard.wp = closestWaypoint(guard);
      }
    }

    if (guard.alertMode && guard.mode !== 'chase') {
      // Converge while there is a spot to converge on; with no last seen
      // position at all, fall through to the guard's normal behaviour
      // instead of standing frozen in a hot room.
      if (convergeOnAlert(state, guard, dt)) continue;
    }

    switch (guard.mode) {
      case 'patrol':
        walkRoute(state, guard, dt);
        break;
      case 'suspicious':
        // Freeze and stare at the last glimpse. Standing still is what
        // lets suspicion drain if it was only a shadow; staring is what
        // confirms it was a thief.
        stareAtLastSeen(guard);
        break;
      case 'chase':
        runDownThief(state, guard, dt);
        break;
      case 'search':
        huntLastSeen(state, guard, dt);
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

/**
 * Knock one camera out for `seconds`, noting who did it ('emp' for an EMP
 * pulse, 'hack' for the hacker). While it is out it cannot spot anyone;
 * when the timer runs out it comes back online by itself.
 */
export function disableCamera(cam, seconds, source) {
  if (!cam) return;
  cam.disabled = true;
  cam.disabledTimer = Math.max(cam.disabledTimer, seconds);
  cam.disabledBy = source ?? null;
}

/**
 * Sweep every camera around its mount. On alert the sweep runs faster, so
 * a hot room is harder to slip past. A disabled camera sits dark until its
 * timer runs out, then comes back online. A camera that holds the thief in
 * frame counts up; at CAMERA.spotSeconds the alarm jumps and the count
 * restarts, so staying in a camera's eye keeps costing the crew.
 */
export function stepCameras(state, dt) {
  const roomHot = state.alarm >= ALARM.suspectAt;
  for (const camera of state.cameras ?? []) {
    if (camera.disabled) {
      camera.disabledTimer -= dt;
      if (camera.disabledTimer <= 0) {
        camera.disabled = false;
        camera.disabledTimer = 0;
        camera.disabledBy = null;
      }
      continue;
    }
    const sweepRate = camera.speed * (roomHot ? ALERT_SWEEP_MULT : 1);
    camera.phase = (camera.phase ?? 0) + sweepRate * dt;
    camera.angle = camera.baseAngle + Math.sin(camera.phase) * camera.sweep;
    if (cameraSees(state, camera)) {
      state.lastSeen = { x: state.player.x, y: state.player.y };
      camera.spotTimer += dt;
      if (camera.spotTimer >= CAMERA.spotSeconds) {
        camera.spotTimer = 0;
        state.alarm = Math.min(100, state.alarm + ALARM.riseCamera);
      }
    } else {
      camera.spotTimer = Math.max(0, camera.spotTimer - dt * 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Alarm
// ---------------------------------------------------------------------------

/**
 * The alarm meter: climbs while any guard or camera has eyes on the thief,
 * climbs a little on a sprinting thief's noise, and drains while the room
 * is quiet. Main.js seals the room when it reaches 100 — this module
 * never flips lockdown itself.
 */
export function stepAlarm(state, dt) {
  let loudest = 0;
  for (const guard of state.guards ?? []) {
    loudest = Math.max(loudest, guardSees(state, guard));
  }
  let watched = false;
  for (const camera of state.cameras ?? []) {
    if (cameraSees(state, camera)) { watched = true; break; }
  }
  const sprinting = state.player?.moving && !state.player.crouched
    && state.player.noise >= THIEF.noiseSprint;

  let rise = 0;
  if (loudest > 0) rise += ALARM.riseSeen * loudest;
  if (watched) rise += ALARM.riseCamera;
  if (sprinting) rise += ALARM.riseNoise;

  if (rise > 0) {
    state.alarm = Math.min(100, state.alarm + rise * dt);
  } else {
    state.alarm = Math.max(0, state.alarm - ALARM.decay * dt);
  }
}

/** The room's mood for the HUD: calm, suspicious, hunted, or lockdown. */
export function alarmLevel(state) {
  if (state.alarm >= ALARM.lockdownAt || state.lockdown) return 'lockdown';
  if (state.alarm >= ALARM.suspectAt) return 'hunted';
  if (state.alarm >= NERVOUS_ALARM) return 'suspicious';
  return 'calm';
}

// ---------------------------------------------------------------------------
// Shared geometry, also used by render.js for drawing the cones.
// ---------------------------------------------------------------------------

/**
 * Pure geometry: is point (x, y) inside the sector centred on (ox, oy),
 * facing `angle`, reaching `range`, half-width `halfAngle`?
 */
export function inCone(x, y, ox, oy, angle, range, halfAngle) {
  const dx = x - ox;
  const dy = y - oy;
  if (dx * dx + dy * dy > range * range) return false;
  if (dx === 0 && dy === 0) return true;
  return Math.abs(normAngle(Math.atan2(dy, dx) - angle)) <= halfAngle;
}

/** EMP: blind every camera for `seconds`. Guards are unaffected. */
export function disableCameras(state, seconds) {
  for (const camera of state.cameras ?? []) {
    disableCamera(camera, seconds, 'emp');
  }
}
