// Senja Heist — stealth: patrol guards, sweeping cameras, the alarm meter.
//
// The room is read at a glance: a guard's vision is a sector that turns with
// him, a camera's is a sector that swings on its mount. Being inside a sector
// with a clear line of sight feeds suspicion; full suspicion means a chase,
// and a chase the player cannot shake feeds the alarm. The alarm is the
// room's memory — it climbs while anyone watches and drains when the crew
// goes quiet again. At 100 main.js seals the exits and calls the police.
//
// Nothing here reaches into another worker's module: line of sight and wall
// tests are done against the room's own rect lists, so this file works even
// while world.js is still the kit stub.

import { GUARD, CAMERA, ALARM, THIEF } from './config.js';

/** Suspicion above this line puts a guard on edge: he stops and stares. */
const EDGE_SUSPICION = 0.35;
/** Suspicion drains this fast per second while the thief is unseen. */
const SUSPICION_DRAIN = 0.45;
/** Seconds a searching guard spends sweeping the last-seen spot. */
const SEARCH_SWEEP_SECONDS = 3.5;
/** Seconds between a chasing guard's grabs once he is on the thief. */
const GRAB_COOLDOWN = 1.0;
/** A guard hears a noise a little beyond the noise radius itself. */
const HEARING_REACH = 2.2;
/** Alarm level where the HUD stops calling the room calm. */
const UNEASY_ALARM = 15;

// ---------------------------------------------------------------------------
// Small geometry: angles and segments against the room's own rects.
// ---------------------------------------------------------------------------

/** Wrap an angle difference into [-PI, PI]. */
function wrapAngle(diff) {
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
}

/** True when (x, y) sits inside a wall rect of the room. */
function pointInWalls(room, x, y) {
  if (!room) return false;
  if (x < 0 || y < 0 || x > room.w || y > room.h) return true;
  for (const wall of room.walls ?? []) {
    if (x >= wall.x && x <= wall.x + wall.w && y >= wall.y && y <= wall.y + wall.h) return true;
  }
  return false;
}

/**
 * True when the segment (ax, ay)-(bx, by) crosses a wall rect or a closed
 * door. Cover never blocks sight — only walls and shut doors do — which is
 * what makes crouching behind a counter a real tactic.
 */
function sightBlocked(room, ax, ay, bx, by) {
  if (!room) return false;
  const solids = [...(room.walls ?? [])];
  for (const door of room.doors ?? []) {
    if (!door.open) solids.push(door);
  }
  for (const rect of solids) {
    if (segmentHitsRect(ax, ay, bx, by, rect)) return true;
  }
  return false;
}

/** Slab test: does the segment cross this axis-aligned rect? */
function segmentHitsRect(ax, ay, bx, by, rect) {
  const dx = bx - ax;
  const dy = by - ay;
  let tMin = 0;
  let tMax = 1;
  for (const [origin, delta, lo, hi] of [
    [ax, dx, rect.x, rect.x + rect.w],
    [ay, dy, rect.y, rect.y + rect.h],
  ]) {
    if (Math.abs(delta) < 1e-9) {
      if (origin < lo || origin > hi) return false;
    } else {
      let t0 = (lo - origin) / delta;
      let t1 = (hi - origin) / delta;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tMin = Math.max(tMin, t0);
      tMax = Math.min(tMax, t1);
      if (tMin > tMax) return false;
    }
  }
  return true;
}

/**
 * Step toward (tx, ty) at `speed`, sliding along walls instead of sticking:
 * try the full step, then x-only, then y-only. Returns the distance left.
 */
function walkToward(room, body, tx, ty, speed, dt) {
  const dx = tx - body.x;
  const dy = ty - body.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return 0;
  const step = Math.min(dist, speed * dt);
  const nx = body.x + (dx / dist) * step;
  const ny = body.y + (dy / dist) * step;
  if (!pointInWalls(room, nx, ny)) {
    body.x = nx;
    body.y = ny;
  } else if (!pointInWalls(room, nx, body.y)) {
    body.x = nx;
  } else if (!pointInWalls(room, body.x, ny)) {
    body.y = ny;
  }
  body.angle = Math.atan2(dy, dx);
  return Math.hypot(tx - body.x, ty - body.y);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * One guard per post, up to `job.guards`. When the room has fewer posts than
 * the job wants, posts repeat with a staggered start waypoint so two guards
 * never march in lockstep on the same route.
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
    });
  }
  return guards;
}

/**
 * One camera per post, up to `job.cameras`. Each keeps its mount's base
 * angle and sweeps around it; `speed` is the sweep rate, `range` the cone.
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
    spotTimer: 0,
  }));
}

/**
 * How clearly `guard` sees the thief right now, 0..1. Zero outside the
 * cone, beyond effective range, behind a wall, while the guard is down, or
 * while the thief is hidden. Crouching and the crew disguise each halve the
 * range they are spotted at — a crouched thief in disguise has to be nearly
 * stepped on. Inside range the value is strongest up close and thins toward
 * the edge, so a distant glimpse builds suspicion slowly and a close one
 * turns a guard fast.
 */
export function guardSees(state, guard) {
  const player = state.player;
  if (!player || !guard || guard.down || player.hidden) return 0;
  let range = GUARD.sight;
  if (player.crouched) range *= 0.5;
  if (player.disguised) range *= 0.5;
  const dx = player.x - guard.x;
  const dy = player.y - guard.y;
  const dist = Math.hypot(dx, dy);
  if (dist > range) return 0;
  if (!inCone(player.x, player.y, guard.x, guard.y, guard.angle, range, GUARD.halfCone)) return 0;
  if (sightBlocked(state.room, guard.x, guard.y, player.x, player.y)) return 0;
  const closeness = 1 - dist / range;
  return 0.45 + 0.55 * closeness;
}

/** True when `camera` has the thief in its sweeping cone with a clear view. */
export function cameraSees(state, camera) {
  const player = state.player;
  if (!player || !camera || camera.disabled || player.hidden) return false;
  return inCone(player.x, player.y, camera.x, camera.y, camera.angle, camera.range, CAMERA.halfCone)
    && !sightBlocked(state.room, camera.x, camera.y, player.x, player.y);
}

/**
 * Run every guard one step: patrol the route, stare when something feels
 * off, chase a confirmed thief, search the last place he was seen, then go
 * back to the route. A loud thief pulls the nearest guard over to listen.
 */
export function stepGuards(state, dt) {
  const player = state.player;
  if (!player) return;

  // Noise pulls exactly one guard: the nearest patrolling guard in earshot.
  if (player.noise > 0 && player.moving) {
    let nearest = null;
    let nearestDist = Infinity;
    for (const guard of state.guards ?? []) {
      if (guard.down || (guard.mode !== 'patrol' && guard.mode !== 'suspicious')) continue;
      const dist = Math.hypot(player.x - guard.x, player.y - guard.y);
      if (dist < player.noise * HEARING_REACH && dist < nearestDist) {
        nearest = guard;
        nearestDist = dist;
      }
    }
    if (nearest) {
      nearest.lastSeen = { x: player.x, y: player.y };
      nearest.suspicion = Math.max(nearest.suspicion, EDGE_SUSPICION);
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

    const seen = guardSees(state, guard);
    if (seen > 0) {
      guard.suspicion = Math.min(1, guard.suspicion + GUARD.suspicionPerSecond * seen * dt);
      guard.lastSeen = { x: player.x, y: player.y };
      guard.alertTimer = 0;
    } else {
      guard.suspicion = Math.max(0, guard.suspicion - SUSPICION_DRAIN * dt);
      guard.alertTimer += dt;
    }

    if (guard.suspicion >= 1) {
      guard.mode = 'chase';
    } else if (guard.mode === 'chase' && guard.alertTimer >= GUARD.loseSeconds) {
      guard.mode = 'search';
      guard.searchTimer = 0;
    } else if (guard.mode === 'chase' && seen <= 0) {
      // Still chasing on memory: the timer above decides when to give up.
    } else if (guard.mode === 'search' && guard.searchTimer >= SEARCH_SWEEP_SECONDS) {
      guard.mode = 'patrol';
      guard.suspicion = 0;
      guard.lastSeen = null;
    } else if (guard.mode !== 'chase' && guard.mode !== 'search') {
      guard.mode = guard.suspicion > EDGE_SUSPICION ? 'suspicious' : 'patrol';
    }

    switch (guard.mode) {
      case 'patrol': {
        guard.speed = GUARD.patrol;
        if (guard.pauseTimer > 0) {
          guard.pauseTimer -= dt;
          break;
        }
        const target = guard.route[guard.wp % guard.route.length];
        const left = walkToward(state.room, guard, target.x, target.y, GUARD.patrol, dt);
        if (left < 6) {
          guard.wp = (guard.wp + 1) % guard.route.length;
          guard.pauseTimer = 0.6;
        }
        break;
      }
      case 'suspicious': {
        // Freeze and stare at the last glimpse. Standing still is what lets
        // suspicion drain if it was only a shadow; staring is what confirms it.
        guard.speed = 0;
        if (guard.lastSeen) {
          guard.angle = Math.atan2(guard.lastSeen.y - guard.y, guard.lastSeen.x - guard.x);
        }
        break;
      }
      case 'chase': {
        guard.speed = GUARD.chase;
        walkToward(state.room, guard, player.x, player.y, GUARD.chase, dt);
        const dist = Math.hypot(player.x - guard.x, player.y - guard.y);
        if (dist <= GUARD.catchRange && guard.grabTimer <= 0) {
          player.hp = Math.max(0, player.hp - GUARD.punchDamage);
          guard.grabTimer = GRAB_COOLDOWN;
          if (state.fx) {
            state.fx.shakeT = Math.max(state.fx.shakeT, 0.25);
            state.fx.shakeMag = Math.max(state.fx.shakeMag, 5);
          }
        }
        break;
      }
      case 'search': {
        guard.searchTimer += dt;
        guard.speed = GUARD.search;
        if (guard.lastSeen) {
          const left = walkToward(state.room, guard, guard.lastSeen.x, guard.lastSeen.y, GUARD.search, dt);
          if (left < 10) {
            // Arrived with nothing there: sweep the room with his eyes.
            guard.angle += guard.sweepDir * 1.6 * dt;
            if (guard.searchTimer > 1 && Math.abs(wrapAngle(guard.angle)) > 2.4) guard.sweepDir *= -1;
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Sweep every camera around its mount. A disabled camera sits dark until
 * its timer runs out. A camera that holds the thief in frame counts up; at
 * CAMERA.spotSeconds the alarm jumps and the count restarts, so staying in
 * a camera's eye keeps costing the crew.
 */
export function stepCameras(state, dt) {
  for (const camera of state.cameras ?? []) {
    if (camera.disabled) {
      camera.disabledTimer -= dt;
      if (camera.disabledTimer <= 0) {
        camera.disabled = false;
        camera.disabledTimer = 0;
      }
      continue;
    }
    camera.angle = camera.baseAngle + Math.sin(state.time * camera.speed) * camera.sweep;
    if (cameraSees(state, camera)) {
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

/**
 * The alarm meter: climbs while any guard or camera has eyes on the thief,
 * climbs a little on a sprinting thief's noise, and drains while the room is
 * quiet. Main.js seals the room when it reaches 100 — this module never
 * flips lockdown itself.
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
  if (state.alarm >= UNEASY_ALARM) return 'suspicious';
  return 'calm';
}

/**
 * Pure geometry: is point (x, y) inside the sector centred on (ox, oy),
 * facing `angle`, reaching `range`, half-width `halfAngle`?
 */
export function inCone(x, y, ox, oy, angle, range, halfAngle) {
  const dx = x - ox;
  const dy = y - oy;
  if (dx * dx + dy * dy > range * range) return false;
  if (dx === 0 && dy === 0) return true;
  return Math.abs(wrapAngle(Math.atan2(dy, dx) - angle)) <= halfAngle;
}

/** EMP: blind every camera for `seconds`. Guards are unaffected. */
export function disableCameras(state, seconds) {
  for (const camera of state.cameras ?? []) {
    camera.disabled = true;
    camera.disabledTimer = Math.max(camera.disabledTimer, seconds);
  }
}
