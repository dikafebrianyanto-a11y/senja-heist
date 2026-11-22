// Senja Heist — boot helpers: difficulty tuning and the stand-in world.
//
// main.js owns the loop and the screens. This file owns two things main.js
// needs before any real module has loaded: how each difficulty bends a
// job's guard and camera counts, and a playable pawnshop to fall back on
// when world.js / crew.js / vault.js have not landed yet. Everything here
// is shaped exactly like the real modules' output, so the moment a real
// module arrives the game just gets richer — nothing downstream changes.

import { CITY, PALETTE, ROOM, THIEF, VAULT } from './config.js';

/** Difficulty rungs, in order. Each rung multiplies a job's guard and camera counts. */
export const DIFFICULTY_ORDER = ['easy', 'normal', 'hard'];

export const DIFFICULTY_LEVELS = {
  easy: { label: 'Easy', guardMul: 0.6, cameraMul: 0.6, blurb: 'Fewer eyes on the room.' },
  normal: { label: 'Normal', guardMul: 1, cameraMul: 1, blurb: 'The job as planned.' },
  hard: { label: 'Hard', guardMul: 1.5, cameraMul: 1.5, blurb: 'More guards, more cameras.' },
};

/** The tuning entry for a difficulty name, falling back to normal for anything unknown. */
export function difficultyEntry(name) {
  return DIFFICULTY_LEVELS[name] ?? DIFFICULTY_LEVELS.normal;
}

/**
 * A copy of a job with its guard/camera counts bent by the difficulty rung.
 * Counts round to whole people and never drop below one — an easy job is
 * still guarded, just thinly. The input job is never mutated.
 */
export function scaledJob(job, difficultyName) {
  const tuning = difficultyEntry(difficultyName);
  const bend = (count, mul) => Math.max(1, Math.round((count ?? 0) * mul));
  return {
    ...job,
    guards: bend(job?.guards, tuning.guardMul),
    cameras: bend(job?.cameras, tuning.cameraMul),
  };
}

/** The one job the stand-in world knows: a quiet pawnshop, first score. */
export function fallbackJobs() {
  return [
    {
      id: 'pawnshop',
      name: 'Pawnshop Lights',
      target: 'Marlow Pawnshop',
      take: 4800,
      guards: 2,
      cameras: 1,
      vault: false,
      blurb: 'A quiet till, a sleepy guard, a first score.',
    },
  ];
}

/** A minimal pawnshop interior: four walls, two shelves of cover, three loot spots. */
export function buildFallbackRoom(rng, job) {
  void rng;
  void job;
  return {
    name: 'Marlow Pawnshop',
    w: ROOM.width,
    h: ROOM.height,
    entry: { x: 80, y: 560 },
    exit: { x: 1040, y: 80 },
    walls: [
      { x: 0, y: 0, w: ROOM.width, h: 24 },
      { x: 0, y: ROOM.height - 24, w: ROOM.width, h: 24 },
      { x: 0, y: 0, w: 24, h: ROOM.height },
      { x: ROOM.width - 24, y: 0, w: 24, h: ROOM.height },
      { x: 380, y: 180, w: 220, h: 26 },
      { x: 700, y: 380, w: 26, h: 180 },
    ],
    cover: [
      { x: 220, y: 300, w: 120, h: 60 },
      { x: 620, y: 150, w: 120, h: 60 },
      { x: 820, y: 460, w: 140, h: 60 },
    ],
    doors: [{ x: 520, y: 0, w: 90, h: 24, open: false }],
    lootSpots: [
      { x: 300, y: 120, kind: 'cash' },
      { x: 900, y: 200, kind: 'jewels' },
      { x: 560, y: 500, kind: 'gold' },
    ],
    vaultSpot: null,
    guardPosts: [
      {
        x: 500,
        y: 300,
        route: [
          { x: 500, y: 300 },
          { x: 900, y: 300 },
          { x: 900, y: 500 },
          { x: 500, y: 500 },
        ],
      },
      { x: 850, y: 120, route: [{ x: 850, y: 120 }, { x: 300, y: 120 }] },
    ],
    camPosts: [{ x: 1060, y: 60, angle: Math.PI * 0.75, sweep: 1.0 }],
  };
}

/** A minimal street map: three roads, four blocks, a spawn and a safehouse. */
export function buildFallbackCity(rng) {
  void rng;
  return {
    w: CITY.width,
    h: CITY.height,
    roads: [
      { x: 0, y: 760, w: CITY.width, h: 90, dir: 'h' },
      { x: 0, y: 1240, w: CITY.width, h: 90, dir: 'v' },
      { x: 1240, y: 0, w: 90, h: CITY.height, dir: 'v' },
    ],
    blocks: [
      { x: 120, y: 120, w: 480, h: 480 },
      { x: 1500, y: 120, w: 480, h: 480 },
      { x: 120, y: 980, w: 480, h: 200 },
      { x: 1500, y: 980, w: 480, h: 200 },
    ],
    lamps: [
      { x: 640, y: 760 },
      { x: 1280, y: 760 },
      { x: 1920, y: 760 },
    ],
    spawn: { x: 1280, y: 800 },
    carSpawn: { x: 1340, y: 800 },
    safehouse: { x: 2240, y: 1280 },
  };
}

/** The four crew members with their starting roles, colours and skills. */
export function buildFallbackCrew() {
  return [
    { id: 'mara', name: 'Mara Voss', role: 'leader', color: PALETTE.thief, x: 0, y: 0, status: 'ready', skill: 3 },
    { id: 'iko', name: 'Iko Tan', role: 'hacker', color: '#8fb7ff', x: 0, y: 0, status: 'ready', skill: 3 },
    { id: 'reno', name: 'Reno Kartika', role: 'driver', color: '#ffb454', x: 0, y: 0, status: 'waiting', skill: 3 },
    { id: 'sable', name: 'Sable Wren', role: 'lookout', color: '#d98cff', x: 0, y: 0, status: 'ready', skill: 3 },
  ];
}

/** A fresh thief standing at (x, y): full health, starting ammo, empty hands. */
export function buildFallbackThief(x, y) {
  return {
    x,
    y,
    facing: 0,
    speed: 0,
    crouched: false,
    moving: false,
    noise: 0,
    noiseTimer: 0,
    weight: 0,
    carrying: [],
    hp: THIEF.hp,
    maxHp: THIEF.hp,
    ammo: THIEF.ammoStart,
    disguised: false,
    disguiseTimer: 0,
    hidden: false,
    punchTimer: 0,
    shootTimer: 0,
  };
}

/** One patrolling guard per post, walking its route from the second waypoint. */
export function buildFallbackGuards(rng, room, job) {
  void rng;
  void job;
  return room.guardPosts.map((post, i) => ({
    x: post.x,
    y: post.y,
    angle: 0,
    speed: 0,
    route: post.route,
    wp: 1,
    mode: 'patrol',
    suspicion: 0,
    alertTimer: 0,
    lastSeen: null,
    id: i,
  }));
}

/** One sweeping camera per post, starting at its base angle. */
export function buildFallbackCameras(rng, room, job) {
  void rng;
  void job;
  return room.camPosts.map((post, i) => ({
    x: post.x,
    y: post.y,
    angle: post.angle,
    baseAngle: post.angle,
    sweep: post.sweep,
    speed: 0.5,
    range: 265,
    disabled: false,
    disabledTimer: 0,
    spotTimer: 0,
    id: i,
  }));
}

/** One loot item per spot, priced and weighed by kind. */
export function buildFallbackLoot(rng, room, job) {
  void rng;
  void job;
  const prices = { cash: 900, jewels: 1600, art: 3200, gold: 2400, data: 1200 };
  const heft = { cash: 1, jewels: 1, art: 4, gold: 5, data: 0 };
  return room.lootSpots.map((spot, i) => ({
    id: i,
    x: spot.x,
    y: spot.y,
    kind: spot.kind,
    name: spot.kind,
    value: prices[spot.kind] ?? 500,
    weight: heft[spot.kind] ?? 1,
    taken: false,
  }));
}

/** A vault in its starting state: locked with all pins unset, or already open for vault-less jobs. */
export function buildFallbackVault(job) {
  if (job && !job.vault) {
    return { state: 'open', pins: 0, set: 0, needle: 0, dir: 1, window: VAULT.window, speed: VAULT.needleSpeed };
  }
  return {
    state: 'locked',
    pins: VAULT.pins,
    set: 0,
    needle: 0,
    dir: 1,
    window: VAULT.window,
    speed: VAULT.needleSpeed,
  };
}
