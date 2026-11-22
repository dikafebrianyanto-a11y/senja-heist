// Senja Heist — boot, the single shared state, the fixed-step loop and the
// screen machine (title, plan, heist, getaway, pause, busted, payout).
//
// Every gameplay module is loaded dynamically and checked function by
// function: a module the crew has not written yet is replaced by a small
// fallback, so the page still loads, draws and plays with what exists. The
// core modules (config, random, input, save) are static imports and always
// present. The full module contract lives in /tmp/heist-contract.md.
//
// ?seed=N fixes the city and the rooms. ?shot=cover|plan|getaway (with
// &seed=N) stages that scene instead of running the loop, paints it twice
// and sets window.__shotReady for a screenshot.

import { ALARM, CAR, CITY, GUARD, HEAT, PALETTE, ROOM, SCREEN, STEP, THIEF, TOOLS, VAULT, VIEW } from './config.js';
import { createSeeded, hashSeed } from './random.js';
import { ACT_BUY, ACT_CONFIRM, ACT_DOWN, ACT_EMP, ACT_INTERACT, ACT_MUTE, ACT_PAUSE, ACT_PUNCH, ACT_SHOOT, ACT_UP, createInput } from './input.js';
import { clearSave, defaultSave, loadSave, writeSave } from './save.js';

/** The longest frame the loop catches up on; a longer stall (a hidden tab) is dropped, not replayed. */
const MAX_FRAME = 0.25;

const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const status = document.getElementById('status');

// ---------------------------------------------------------------------------
// Fallbacks: what the game runs on while a module is still unwritten.
// Each one matches the contract's shape, so swapping in the real module
// changes behaviour, never the shape of the state.
// ---------------------------------------------------------------------------

const FALLBACK_JOBS = [
  { id: 'pawnshop', name: 'Pawnshop Lights', target: 'Marlow Pawnshop', take: 4800, guards: 2, cameras: 1, vault: false, blurb: 'A quiet till, a sleepy guard, a first score.' },
];

function fallbackRoom(rng, job) {
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
      { x: 500, y: 300, route: [{ x: 500, y: 300 }, { x: 900, y: 300 }, { x: 900, y: 500 }, { x: 500, y: 500 }] },
      { x: 850, y: 120, route: [{ x: 850, y: 120 }, { x: 300, y: 120 }] },
    ],
    camPosts: [{ x: 1060, y: 60, angle: Math.PI * 0.75, sweep: 1.0 }],
  };
}

function fallbackCity(rng) {
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
    lamps: [{ x: 640, y: 760 }, { x: 1280, y: 760 }, { x: 1920, y: 760 }],
    spawn: { x: 1280, y: 800 },
    carSpawn: { x: 1340, y: 800 },
    safehouse: { x: 2240, y: 1280 },
  };
}

function fallbackCrew() {
  return [
    { id: 'mara', name: 'Mara Voss', role: 'leader', color: PALETTE.thief, x: 0, y: 0, status: 'ready', skill: 3 },
    { id: 'iko', name: 'Iko Tan', role: 'hacker', color: '#8fb7ff', x: 0, y: 0, status: 'ready', skill: 3 },
    { id: 'reno', name: 'Reno Kartika', role: 'driver', color: '#ffb454', x: 0, y: 0, status: 'waiting', skill: 3 },
    { id: 'sable', name: 'Sable Wren', role: 'lookout', color: '#d98cff', x: 0, y: 0, status: 'ready', skill: 3 },
  ];
}

function fallbackThief(x, y) {
  return {
    x, y, facing: 0, speed: 0, crouched: false, moving: false,
    noise: 0, noiseTimer: 0, weight: 0, carrying: [],
    hp: THIEF.hp, maxHp: THIEF.hp, ammo: THIEF.ammoStart,
    disguised: false, disguiseTimer: 0, hidden: false,
    punchTimer: 0, shootTimer: 0,
  };
}

function fallbackGuards(rng, room, job) {
  void rng;
  void job;
  return room.guardPosts.map((post, i) => ({
    x: post.x, y: post.y, angle: 0, speed: 0,
    route: post.route, wp: 1,
    mode: 'patrol', suspicion: 0, alertTimer: 0, lastSeen: null, id: i,
  }));
}

function fallbackCameras(rng, room, job) {
  void rng;
  void job;
  return room.camPosts.map((post, i) => ({
    x: post.x, y: post.y, angle: post.angle, baseAngle: post.angle,
    sweep: post.sweep, speed: 0.5, range: 265,
    disabled: false, disabledTimer: 0, spotTimer: 0, id: i,
  }));
}

function fallbackLoot(rng, room, job) {
  void rng;
  void job;
  const values = { cash: 900, jewels: 1600, art: 3200, gold: 2400, data: 1200 };
  const weights = { cash: 1, jewels: 1, art: 4, gold: 5, data: 0 };
  return room.lootSpots.map((spot, i) => ({
    id: i, x: spot.x, y: spot.y, kind: spot.kind,
    name: spot.kind, value: values[spot.kind] ?? 500,
    weight: weights[spot.kind] ?? 1, taken: false,
  }));
}

function noop() {}
function falseFn() { return false; }
function zeroFn() { return 0; }

// ---------------------------------------------------------------------------
// Module loading: dynamic import, checked function by function.
// ---------------------------------------------------------------------------

const MODULE_WANTS = {
  world: ['buildRoom', 'buildCity', 'roomSolidAt', 'citySolidAt', 'losBlocked', 'roomExit', 'citySafehouse'],
  player: ['createThief', 'stepThief', 'thiefSpeed', 'grabLoot', 'thiefHurt'],
  crew: ['createCrew', 'stepCrew', 'assignRoles', 'crewByRole'],
  stealth: ['createGuards', 'createCameras', 'stepGuards', 'stepCameras', 'guardSees', 'cameraSees', 'stepAlarm', 'alarmLevel', 'inCone', 'disableCameras'],
  vault: ['createVault', 'startCrack', 'stepVault', 'vaultPin', 'createLoot', 'lootValue', 'lootWeight'],
  vehicles: ['createCar', 'stepCar', 'enterCar', 'exitCar'],
  traffic: ['createTraffic', 'stepTraffic', 'trafficCarNear'],
  police: ['createPolice', 'stepPolice', 'raiseHeat', 'lowerHeat'],
  missions: ['jobFor', 'jobObjectives', 'objectivesDone', 'payoutFor', 'planOptions', 'buyTool'],
  combat: ['createCombat', 'stepCombat', 'punch', 'shoot'],
  hud: ['drawHud', 'drawMinimap', 'drawTitle', 'drawPlan', 'drawPause', 'drawBusted', 'drawPayout', 'drawBanner'],
  audio: ['createAudio', 'audioUnlock', 'audioStep', 'sfx', 'setMuted'],
  effects: ['createEffects', 'stepEffects', 'burst', 'floatText', 'shake', 'drawEffects'],
  render: ['createRenderer'],
  shots: ['stageShot'],
};

async function loadModules() {
  const found = {};
  for (const name of Object.keys(MODULE_WANTS)) {
    try {
      found[name] = await import(`./${name}.js`);
    } catch {
      found[name] = null;
    }
  }

  const jobs = Array.isArray(found.missions?.JOBS) && found.missions.JOBS.length > 0
    ? found.missions.JOBS
    : FALLBACK_JOBS;

  const pick = (moduleName, fnName, fallback) => {
    const mod = found[moduleName];
    return mod && typeof mod[fnName] === 'function' ? mod[fnName] : fallback;
  };

  const mods = {
    jobs,
    shotNames: Array.isArray(found.shots?.SHOT_NAMES) ? found.shots.SHOT_NAMES : ['cover', 'plan', 'getaway'],
    stageShot: pick('shots', 'stageShot', null),
    createRenderer: pick('render', 'createRenderer', null),
  };

  // world
  mods.buildRoom = pick('world', 'buildRoom', fallbackRoom);
  mods.buildCity = pick('world', 'buildCity', fallbackCity);
  mods.roomSolidAt = pick('world', 'roomSolidAt', falseFn);
  mods.citySolidAt = pick('world', 'citySolidAt', falseFn);
  mods.losBlocked = pick('world', 'losBlocked', falseFn);
  mods.roomExit = pick('world', 'roomExit', (room) => room.exit);
  mods.citySafehouse = pick('world', 'citySafehouse', (city) => city.safehouse);

  // player
  mods.createThief = pick('player', 'createThief', fallbackThief);
  mods.stepThief = pick('player', 'stepThief', noop);
  mods.thiefSpeed = pick('player', 'thiefSpeed', zeroFn);
  mods.grabLoot = pick('player', 'grabLoot', (state, item) => {
    if (!item || item.taken || !state.player) return false;
    item.taken = true;
    state.player.carrying.push(item);
    state.player.weight += item.weight;
    state.stats.taken += item.value;
    return true;
  });
  mods.thiefHurt = pick('player', 'thiefHurt', (state, dmg) => {
    if (state.player) state.player.hp = Math.max(0, state.player.hp - dmg);
  });

  // crew
  mods.createCrew = pick('crew', 'createCrew', fallbackCrew);
  mods.stepCrew = pick('crew', 'stepCrew', noop);
  mods.assignRoles = pick('crew', 'assignRoles', noop);
  mods.crewByRole = pick('crew', 'crewByRole', (state, role) => state.crew.find((m) => m.role === role) ?? null);

  // stealth
  mods.createGuards = pick('stealth', 'createGuards', fallbackGuards);
  mods.createCameras = pick('stealth', 'createCameras', fallbackCameras);
  mods.stepGuards = pick('stealth', 'stepGuards', (state, dt) => {
    for (const guard of state.guards) {
      const target = guard.route[guard.wp % guard.route.length];
      const dx = target.x - guard.x;
      const dy = target.y - guard.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 6) { guard.wp += 1; continue; }
      guard.x += (dx / dist) * GUARD.patrol * dt;
      guard.y += (dy / dist) * GUARD.patrol * dt;
      guard.angle = Math.atan2(dy, dx);
    }
  });
  mods.stepCameras = pick('stealth', 'stepCameras', (state, dt) => {
    for (const cam of state.cameras) {
      if (cam.disabled) continue;
      cam.angle = cam.baseAngle + Math.sin(state.time * cam.speed) * cam.sweep;
    }
  });
  mods.guardSees = pick('stealth', 'guardSees', zeroFn);
  mods.cameraSees = pick('stealth', 'cameraSees', falseFn);
  mods.stepAlarm = pick('stealth', 'stepAlarm', (state, dt) => {
    state.alarm = Math.max(0, state.alarm - ALARM.decay * dt);
  });
  mods.alarmLevel = pick('stealth', 'alarmLevel', (state) => (state.alarm >= ALARM.lockdownAt ? 'lockdown' : state.alarm >= ALARM.suspectAt ? 'suspicious' : 'calm'));
  mods.inCone = pick('stealth', 'inCone', (x, y, ox, oy, angle, range, halfAngle) => {
    const dx = x - ox;
    const dy = y - oy;
    if (dx * dx + dy * dy > range * range) return false;
    let diff = Math.atan2(dy, dx) - angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) <= halfAngle;
  });
  mods.disableCameras = pick('stealth', 'disableCameras', (state, seconds) => {
    for (const cam of state.cameras) {
      cam.disabled = true;
      cam.disabledTimer = seconds;
    }
  });

  // vault
  mods.createVault = pick('vault', 'createVault', (job) => {
    if (job && !job.vault) return { state: 'open', pins: 0, set: 0, needle: 0, dir: 1, window: VAULT.window, speed: VAULT.needleSpeed };
    return {
      state: 'locked', pins: VAULT.pins, set: 0, needle: 0, dir: 1,
      window: VAULT.window,
      speed: VAULT.needleSpeed,
    };
  });
  mods.startCrack = pick('vault', 'startCrack', (state) => {
    if (state.vault && state.vault.state === 'locked') state.vault.state = 'cracking';
  });
  mods.stepVault = pick('vault', 'stepVault', (state, dt) => {
    const v = state.vault;
    if (!v || v.state !== 'cracking') return;
    v.needle += v.dir * v.speed * dt;
    if (v.needle >= 1) { v.needle = 1; v.dir = -1; }
    else if (v.needle <= 0) { v.needle = 0; v.dir = 1; }
  });
  mods.vaultPin = pick('vault', 'vaultPin', (state) => {
    const v = state.vault;
    if (!v || v.state !== 'cracking') return null;
    const inWindow = Math.abs(v.needle - 0.5) <= v.window / 2;
    if (!inWindow) {
      state.alarm = Math.min(100, state.alarm + VAULT.missAlarm);
      return 'miss';
    }
    v.set += 1;
    if (v.set >= v.pins) {
      v.state = 'open';
      return 'open';
    }
    return 'hit';
  });
  mods.createLoot = pick('vault', 'createLoot', fallbackLoot);
  mods.lootValue = pick('vault', 'lootValue', (state) => state.player.carrying.reduce((sum, item) => sum + item.value, 0));
  mods.lootWeight = pick('vault', 'lootWeight', (state) => state.player.carrying.reduce((sum, item) => sum + item.weight, 0));

  // vehicles
  mods.createCar = pick('vehicles', 'createCar', (x, y, kind) => ({
    x, y, angle: -Math.PI / 2, speed: 0, kind: kind ?? 'sedan',
    color: PALETTE.carPlayer, hp: CAR.hp, inUse: false,
  }));
  mods.stepCar = pick('vehicles', 'stepCar', noop);
  mods.enterCar = pick('vehicles', 'enterCar', (state) => {
    if (!state.car) return false;
    state.car.inUse = true;
    return true;
  });
  mods.exitCar = pick('vehicles', 'exitCar', (state) => {
    if (!state.car) return false;
    state.car.inUse = false;
    return true;
  });

  // traffic
  mods.createTraffic = pick('traffic', 'createTraffic', () => ({ cars: [], walkers: [] }));
  mods.stepTraffic = pick('traffic', 'stepTraffic', noop);
  mods.trafficCarNear = pick('traffic', 'trafficCarNear', () => null);

  // police
  mods.createPolice = pick('police', 'createPolice', () => ({ units: [], spawnTimer: 0, siren: false }));
  mods.stepPolice = pick('police', 'stepPolice', noop);
  mods.raiseHeat = pick('police', 'raiseHeat', (state, amount) => {
    state.heat = Math.min(HEAT.max, state.heat + amount);
  });
  mods.lowerHeat = pick('police', 'lowerHeat', (state, dt) => {
    state.heat = Math.max(0, state.heat - HEAT.coolPerSecond * dt);
  });

  // missions
  mods.jobFor = pick('missions', 'jobFor', (index) => jobs[Math.min(index, jobs.length - 1)]);
  mods.jobObjectives = pick('missions', 'jobObjectives', (state) => {
    const list = [{ text: 'Lift the loot', done: state.loot.length > 0 && state.loot.every((item) => item.taken), required: true }];
    if (state.mission?.vault) list.push({ text: 'Crack the vault', done: state.vault?.state === 'open', required: true });
    list.push({ text: 'Reach the exit', done: false, required: true });
    return list;
  });
  mods.objectivesDone = pick('missions', 'objectivesDone', (state) => {
    const list = mods.jobObjectives(state);
    return list.filter((o) => o.required).every((o) => o.done);
  });
  mods.payoutFor = pick('missions', 'payoutFor', (state) => {
    const loot = mods.lootValue(state);
    const ghostBonus = state.alarm < ALARM.suspectAt ? Math.round(loot * 0.1) : 0;
    return { loot, bonus: ghostBonus, timeBonus: 0, ghostBonus, total: loot + ghostBonus };
  });
  mods.planOptions = pick('missions', 'planOptions', (state) => ({
    jobs: jobs.map((job, i) => ({ job, unlocked: i <= state.jobsDone, done: i < state.jobsDone })),
    shop: Object.entries(TOOLS).map(([id, tool]) => ({
      id, name: tool.name, cost: tool.cost,
      owned: id === 'emp' ? state.tools.emp > 0 : state.tools[id] === true,
      desc: tool.desc,
    })),
    cash: state.cash,
  }));
  mods.buyTool = pick('missions', 'buyTool', (state, toolId) => {
    const tool = TOOLS[toolId];
    if (!tool || state.cash < tool.cost) return false;
    if (toolId === 'emp') {
      if (state.tools.emp >= 9) return false;
      state.tools.emp += tool.charges ?? 3;
    } else {
      if (state.tools[toolId] === true) return false;
      state.tools[toolId] = true;
    }
    state.cash -= tool.cost;
    return true;
  });

  // combat
  mods.createCombat = pick('combat', 'createCombat', () => ({ bullets: [] }));
  mods.stepCombat = pick('combat', 'stepCombat', noop);
  mods.punch = pick('combat', 'punch', falseFn);
  mods.shoot = pick('combat', 'shoot', falseFn);

  // hud — a missing draw is skipped, never faked.
  for (const fn of MODULE_WANTS.hud) mods[fn] = pick('hud', fn, null);

  // audio
  mods.createAudio = pick('audio', 'createAudio', () => ({ muted: false }));
  mods.audioUnlock = pick('audio', 'audioUnlock', noop);
  mods.audioStep = pick('audio', 'audioStep', noop);
  mods.sfx = pick('audio', 'sfx', noop);
  mods.setMuted = pick('audio', 'setMuted', (audio, muted) => { audio.muted = muted; });

  // effects
  mods.createEffects = pick('effects', 'createEffects', () => ({ particles: [], floats: [], shakeT: 0, shakeMag: 0, flash: 0 }));
  mods.stepEffects = pick('effects', 'stepEffects', noop);
  mods.burst = pick('effects', 'burst', noop);
  mods.floatText = pick('effects', 'floatText', noop);
  mods.shake = pick('effects', 'shake', (state, mag, time) => {
    state.fx.shakeMag = mag;
    state.fx.shakeT = time;
  });
  mods.drawEffects = pick('effects', 'drawEffects', null);

  return mods;
}

// ---------------------------------------------------------------------------
// The single shared state. Every module reads and writes this object;
// main owns the order they run in. Nothing in here is saved except through
// save.js (cash, bestCash, jobIndex, jobsDone, tools, muted).
// ---------------------------------------------------------------------------

export function createHeistState(seedValue, save) {
  return {
    seed: seedValue,
    rng: createSeeded(seedValue),
    time: 0,
    screen: SCREEN.TITLE,
    screenBeforePause: SCREEN.TITLE,
    cash: save.cash,
    bestCash: save.bestCash,
    jobIndex: save.jobIndex,
    jobsDone: save.jobsDone,
    tools: { ...save.tools },
    heat: 0,
    alarm: 0,
    lockdown: false,
    lockdownTimer: 0,
    player: null,
    crew: null,
    room: null,
    city: null,
    guards: [],
    cameras: [],
    loot: [],
    vault: null,
    car: null,
    traffic: null,
    combat: null,
    police: null,
    mission: null,
    objectives: [],
    fx: null,
    camera: { x: 0, y: 0 },
    events: [],
    banner: '',
    bannerTimer: 0,
    plan: { cursor: 0 },
    payout: null,
    bustReason: '',
    stats: { taken: 0, timeInRoom: 0, shotsFired: 0, alarmsTripped: 0 },
    muted: save.muted,
    input: null,
    audio: null,
  };
}

function saveCampaign(state) {
  writeSave({
    version: 1,
    cash: state.cash,
    bestCash: state.bestCash,
    jobIndex: state.jobIndex,
    jobsDone: state.jobsDone,
    tools: { ...state.tools },
    muted: state.muted,
  });
}

function say(state, text, seconds) {
  state.banner = text;
  state.bannerTimer = seconds ?? 2.5;
}

function announce(message) {
  status.textContent = message;
}

// ---------------------------------------------------------------------------
// Job flow: plan -> heist -> getaway -> payout, or busted.
// ---------------------------------------------------------------------------

function startJob(state, mods, index) {
  const job = mods.jobFor(index);
  const roomSeed = createSeeded(hashSeed(`room:${job.id}:${state.seed}`));
  state.mission = job;
  state.jobIndex = index;
  state.room = mods.buildRoom(roomSeed, job);
  state.guards = mods.createGuards(roomSeed, state.room, job);
  state.cameras = mods.createCameras(roomSeed, state.room, job);
  state.loot = mods.createLoot(roomSeed, state.room, job);
  state.vault = mods.createVault(job);
  state.player = mods.createThief(state.room.entry.x, state.room.entry.y);
  state.crew = mods.createCrew();
  state.combat = mods.createCombat();
  state.police = mods.createPolice();
  state.alarm = 0;
  state.lockdown = false;
  state.lockdownTimer = 0;
  state.stats.taken = 0;
  state.stats.timeInRoom = 0;
  state.objectives = mods.jobObjectives(state);
  state.payout = null;
  state.bustReason = '';
  state.screen = SCREEN.HEIST;
  saveCampaign(state);
  announce(`${job.name} at ${job.target}. Lift the loot and reach the exit.`);
}

function beginGetaway(state, mods) {
  const spawn = state.city?.carSpawn ?? { x: 1340, y: 800 };
  // Stand the thief on the spawn first: enterCar only boards within
  // boarding range, so the car must be created after the move.
  if (state.player) {
    state.player.x = spawn.x;
    state.player.y = spawn.y;
  }
  state.car = mods.createCar(spawn.x, spawn.y, 'sedan');
  mods.enterCar(state);
  state.screen = SCREEN.GETAWAY;
  say(state, 'Get to the safehouse. Lose the heat.', 3);
  announce('Getaway. Drive to the safehouse.');
}

function bankPayout(state, mods) {
  const payout = mods.payoutFor(state);
  state.cash += payout.total;
  state.bestCash = Math.max(state.bestCash, state.cash);
  state.jobsDone += 1;
  state.jobIndex = Math.min(state.jobIndex + 1, mods.jobs.length - 1);
  state.heat = Math.max(0, state.heat - 1);
  state.payout = payout;
  state.screen = SCREEN.PAYOUT;
  saveCampaign(state);
  announce(`Score banked: $${payout.total}. Total cash $${state.cash}.`);
}

function bust(state, reason) {
  state.bustReason = reason;
  state.heat = Math.min(HEAT.max, state.heat + 1);
  state.screen = SCREEN.BUSTED;
  saveCampaign(state);
  announce(`Busted. ${reason}`);
}

// ---------------------------------------------------------------------------
// Planning board rows: jobs first, then the tool shop. The cursor lives in
// state.plan.cursor; hud.drawPlan renders these rows.
// ---------------------------------------------------------------------------

function planRows(state, mods) {
  const options = mods.planOptions(state);
  const rows = options.jobs.map((entry, i) => ({ kind: 'job', index: i, ...entry }));
  for (const tool of options.shop) rows.push({ kind: 'tool', ...tool });
  return rows;
}

// ---------------------------------------------------------------------------
// Input: one frame of actions, routed by screen.
// ---------------------------------------------------------------------------

function handleActions(state, mods) {
  const input = state.input;
  const actions = input.takeActions();
  const digit = input.takeDigit();

  if (actions & ACT_MUTE) {
    state.muted = !state.muted;
    mods.setMuted(state.audio, state.muted);
    saveCampaign(state);
    say(state, state.muted ? 'Sound off.' : 'Sound on.', 1.2);
  }

  if (state.screen === SCREEN.PAUSE) {
    if (actions & (ACT_PAUSE | ACT_CONFIRM)) {
      state.screen = state.screenBeforePause;
      announce('Playing.');
    }
    return;
  }
  if (actions & ACT_PAUSE && (state.screen === SCREEN.HEIST || state.screen === SCREEN.GETAWAY)) {
    state.screenBeforePause = state.screen;
    state.screen = SCREEN.PAUSE;
    announce('Paused.');
    return;
  }

  if (state.screen === SCREEN.TITLE) {
    if (actions & ACT_CONFIRM) {
      state.screen = SCREEN.PLAN;
      state.plan.cursor = 0;
      announce('Planning board. Pick a job.');
    }
    return;
  }

  if (state.screen === SCREEN.PLAN) {
    const rows = planRows(state, mods);
    if (rows.length === 0) return;
    if (actions & ACT_UP) state.plan.cursor = (state.plan.cursor - 1 + rows.length) % rows.length;
    if (actions & ACT_DOWN) state.plan.cursor = (state.plan.cursor + 1) % rows.length;
    if (digit >= 1 && digit <= mods.jobs.length) {
      const rowIndex = rows.findIndex((row) => row.kind === 'job' && row.index === digit - 1);
      if (rowIndex !== -1) state.plan.cursor = rowIndex;
    }
    const row = rows[state.plan.cursor];
    if (actions & ACT_CONFIRM) {
      if (row.kind === 'job') {
        if (!row.unlocked) say(state, 'Finish the earlier job first.', 2);
        else startJob(state, mods, row.index);
      } else if (mods.buyTool(state, row.id)) {
        mods.sfx(state.audio, 'cash');
        say(state, `${row.name} bought.`, 2);
        saveCampaign(state);
      } else {
        say(state, 'Not enough cash, or already owned.', 2);
      }
    } else if (actions & ACT_BUY && row.kind === 'tool') {
      if (mods.buyTool(state, row.id)) {
        mods.sfx(state.audio, 'cash');
        say(state, `${row.name} bought.`, 2);
        saveCampaign(state);
      } else {
        say(state, 'Not enough cash, or already owned.', 2);
      }
    }
    return;
  }

  if (state.screen === SCREEN.HEIST) {
    if (actions & ACT_EMP) {
      if (state.tools.emp > 0) {
        state.tools.emp -= 1;
        mods.disableCameras(state, 8);
        mods.sfx(state.audio, 'emp');
        say(state, 'EMP pulse — cameras blind for 8 seconds.', 2);
      } else {
        say(state, 'No EMP charges. Buy them on the planning board.', 2);
      }
    }
    if (actions & ACT_PUNCH) mods.punch(state);
    if (actions & ACT_SHOOT) {
      if (mods.shoot(state)) state.stats.shotsFired += 1;
    }
    if (actions & ACT_INTERACT) interact(state, mods);
    return;
  }

  if (state.screen === SCREEN.GETAWAY) {
    if (actions & ACT_INTERACT && state.car?.inUse) {
      mods.exitCar(state);
      say(state, 'On foot. Get back in the car to drive.', 2);
    } else if (actions & ACT_INTERACT && state.car && !state.car.inUse) {
      mods.enterCar(state);
    }
    return;
  }

  if (state.screen === SCREEN.PAYOUT || state.screen === SCREEN.BUSTED) {
    if (actions & ACT_CONFIRM) {
      if (state.screen === SCREEN.BUSTED) {
        state.screen = SCREEN.PLAN;
        state.plan.cursor = 0;
        announce('Planning board. The crew goes again.');
      } else if (state.jobsDone >= mods.jobs.length) {
        state.screen = SCREEN.TITLE;
        announce('Campaign complete. Senja Heist.');
      } else {
        state.screen = SCREEN.PLAN;
        state.plan.cursor = 0;
        announce('Planning board. Next job.');
      }
    }
  }
}

/** What E does in the heist room: vault first, then loot, then the exit. */
function interact(state, mods) {
  const player = state.player;
  if (!player || !state.room) return;
  const near = (spot, range) => Math.hypot(player.x - spot.x, player.y - spot.y) <= range;

  if (state.vault && state.room.vaultSpot && near(state.room.vaultSpot, 64)) {
    if (state.vault.state === 'locked') {
      mods.startCrack(state);
      mods.sfx(state.audio, 'crack');
      say(state, 'Cracking the vault — press E as the needle crosses gold.', 3);
    } else if (state.vault.state === 'cracking') {
      const result = mods.vaultPin(state);
      if (result === 'hit') mods.sfx(state.audio, 'pin');
      else if (result === 'miss') {
        mods.sfx(state.audio, 'alarm');
        mods.shake(state, 6, 0.3);
        say(state, 'Missed pin — the alarm heard that.', 2);
      } else if (result === 'open') {
        mods.sfx(state.audio, 'vault');
        say(state, 'Vault open. Take it all.', 2);
      }
    }
    return;
  }

  for (const item of state.loot) {
    if (!item.taken && near(item, 48)) {
      if (mods.grabLoot(state, item)) {
        mods.sfx(state.audio, 'pickup');
        mods.floatText(state, item.x, item.y - 20, `+$${item.value}`, PALETTE.loot);
        state.objectives = mods.jobObjectives(state);
      }
      return;
    }
  }

  if (near(state.room.exit, 56)) {
    if (mods.objectivesDone(state)) {
      mods.sfx(state.audio, 'door');
      beginGetaway(state, mods);
    } else {
      say(state, 'Finish the job first — check the objectives.', 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Simulation: one fixed step, routed by screen.
// ---------------------------------------------------------------------------

function step(state, mods, dt, move) {
  state.time += dt;
  if (state.bannerTimer > 0) state.bannerTimer = Math.max(0, state.bannerTimer - dt);
  if (state.fx) mods.stepEffects(state, dt);
  if (state.audio) mods.audioStep(state.audio, state, dt);

  if (state.screen === SCREEN.TITLE || state.screen === SCREEN.PLAN) {
    if (state.traffic) mods.stepTraffic(state, dt);
    return;
  }

  if (state.screen === SCREEN.HEIST) {
    state.stats.timeInRoom += dt;
    if (state.player) mods.stepThief(state, dt, move);
    mods.stepCrew(state, dt);
    mods.stepGuards(state, dt);
    mods.stepCameras(state, dt);
    mods.stepAlarm(state, dt);
    mods.stepVault(state, dt);
    mods.stepCombat(state, dt);
    state.objectives = mods.jobObjectives(state);

    if (!state.lockdown && state.alarm >= ALARM.lockdownAt) {
      state.lockdown = true;
      state.lockdownTimer = ALARM.lockdownSeconds;
      state.stats.alarmsTripped += 1;
      mods.raiseHeat(state, HEAT.perLockdown);
      mods.sfx(state.audio, 'lockdown');
      mods.shake(state, 8, 0.5);
      say(state, 'LOCKDOWN — the police are coming.', 3);
    }
    if (state.lockdown) {
      state.lockdownTimer -= dt;
      if (state.lockdownTimer <= 0) state.lockdown = false;
    }
    if (state.player && state.player.hp <= 0) {
      bust(state, 'The crew dragged Mara out of the room.');
    }
    return;
  }

  if (state.screen === SCREEN.GETAWAY) {
    const drive = {
      forward: Math.max(0, -move.y),
      reverse: Math.max(0, move.y),
      steer: move.x,
    };
    if (state.car?.inUse) mods.stepCar(state, dt, drive);
    else if (state.player) mods.stepThief(state, dt, move);
    mods.stepTraffic(state, dt);
    mods.stepPolice(state, dt);
    mods.lowerHeat(state, dt);
    if (state.car && state.car.hp <= 0) {
      bust(state, 'The getaway car gave out under the pursuit.');
      return;
    }
    const safe = state.city ? mods.citySafehouse(state.city) : null;
    if (safe && state.car?.inUse && Math.hypot(state.car.x - safe.x, state.car.y - safe.y) < 70) {
      bankPayout(state, mods);
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing: the renderer paints the world; hud paints the panels on top.
// Without a renderer yet, a small built-in painter keeps the page alive.
// ---------------------------------------------------------------------------

function draw(state, mods) {
  if (mods.renderer && !mods.rendererBroken) {
    try {
      mods.renderer.draw(state);
    } catch {
      // A renderer that cannot draw this state (a stale module, a worker's
      // bug) must not kill the loop: fall back to the built-in painter.
      mods.rendererBroken = true;
      fallbackDraw(state);
      return;
    }
    const ctx = mods.renderer.context;
    if (ctx && mods.drawEffects) mods.drawEffects(ctx, state);
    if (!ctx) return;
    if (state.screen === SCREEN.TITLE && mods.drawTitle) mods.drawTitle(ctx, state);
    else if (state.screen === SCREEN.PLAN && mods.drawPlan) mods.drawPlan(ctx, state, planRows(state, mods));
    else if (state.screen === SCREEN.HEIST || state.screen === SCREEN.GETAWAY) {
      if (mods.drawHud) mods.drawHud(ctx, state);
      if (mods.drawMinimap) mods.drawMinimap(ctx, state);
    } else if (state.screen === SCREEN.PAUSE && mods.drawPause) mods.drawPause(ctx, state);
    else if (state.screen === SCREEN.BUSTED && mods.drawBusted) mods.drawBusted(ctx, state);
    else if (state.screen === SCREEN.PAYOUT && mods.drawPayout) mods.drawPayout(ctx, state);
    if (mods.drawBanner) mods.drawBanner(ctx, state);
    return;
  }
  fallbackDraw(state);
}

let fallbackCtx = null;

function fallbackDraw(state) {
  if (!fallbackCtx) fallbackCtx = canvas.getContext('2d');
  const ctx = fallbackCtx;
  const scale = Math.min(canvas.width / VIEW.width, canvas.height / VIEW.height);
  const ox = (canvas.width - VIEW.width * scale) / 2;
  const oy = (canvas.height - VIEW.height * scale) / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PALETTE.backdrop;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);

  ctx.fillStyle = PALETTE.floor;
  ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  if (state.room) {
    ctx.fillStyle = PALETTE.wall;
    for (const wall of state.room.walls) ctx.fillRect(wall.x, wall.y, wall.w, wall.h);
    ctx.fillStyle = PALETTE.cover;
    for (const block of state.room.cover) ctx.fillRect(block.x, block.y, block.w, block.h);
    ctx.fillStyle = PALETTE.loot;
    for (const item of state.loot) {
      if (item.taken) continue;
      ctx.beginPath();
      ctx.arc(item.x, item.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = PALETTE.guard;
    for (const guard of state.guards) {
      ctx.beginPath();
      ctx.arc(guard.x, guard.y, 11, 0, Math.PI * 2);
      ctx.fill();
    }
    if (state.player) {
      ctx.fillStyle = PALETTE.thief;
      ctx.beginPath();
      ctx.arc(state.player.x, state.player.y, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = PALETTE.text;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SENJA HEIST', VIEW.width / 2, 90);
  ctx.font = '20px system-ui, sans-serif';
  ctx.fillStyle = PALETTE.muted;
  ctx.fillText(`Kota Senja  ·  ${state.screen}`, VIEW.width / 2, 130);
  if (state.banner) {
    ctx.fillStyle = PALETTE.accent;
    ctx.fillText(state.banner, VIEW.width / 2, VIEW.height - 60);
  }
}

// ---------------------------------------------------------------------------
// Screenshot staging: the real shots module when it exists, else a small
// built-in staging that plays the real rules forward a couple of seconds.
// ---------------------------------------------------------------------------

function fallbackStage(name, state, mods) {
  if (name === 'plan') return { screen: SCREEN.PLAN };
  startJob(state, mods, 0);
  if (name === 'getaway') {
    beginGetaway(state, mods);
    state.heat = 2;
    return { screen: SCREEN.GETAWAY };
  }
  // cover: the heist room mid-crossing — guards mid-patrol, alarm already warm.
  state.player.x = state.room.w / 2;
  state.player.y = state.room.h - 120;
  state.alarm = 34;
  const still = { x: 0, y: 0, crouch: false, sprint: false };
  for (let i = 0; i < 120; i += 1) step(state, mods, STEP, still);
  return { screen: SCREEN.HEIST };
}

async function runShot(name) {
  const mods = await loadModules();
  const save = loadSave() ?? defaultSave();
  const state = createHeistState(seed, save);
  state.input = createInput(canvas);
  state.audio = mods.createAudio();
  state.crew = mods.createCrew();
  state.city = mods.buildCity(createSeeded(hashSeed(`city:${seed}`)));
  state.fx = mods.createEffects();
  state.police = mods.createPolice();
  state.traffic = mods.createTraffic(createSeeded(hashSeed(`traffic:${seed}`)), state.city);
  state.combat = mods.createCombat();
  mods.renderer = mods.createRenderer ? mods.createRenderer(canvas) : null;

  let staged;
  try {
    staged = mods.stageShot
      ? mods.stageShot(name, state, mods)
      : fallbackStage(name, state, mods);
  } catch {
    // A stager that cannot stage this state falls back to the built-in one,
    // which rebuilds the scene fresh from startJob.
    staged = fallbackStage(name, state, mods);
  }
  state.screen = staged.screen;

  let painted = 0;
  function paint() {
    draw(state, mods);
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

// ---------------------------------------------------------------------------
// The live game.
// ---------------------------------------------------------------------------

async function runGame() {
  const mods = await loadModules();
  const save = loadSave() ?? defaultSave();
  const state = createHeistState(seed, save);
  state.input = createInput(canvas);
  state.audio = mods.createAudio();
  mods.setMuted(state.audio, state.muted);
  state.crew = mods.createCrew();
  state.city = mods.buildCity(createSeeded(hashSeed(`city:${seed}`)));
  state.fx = mods.createEffects();
  state.police = mods.createPolice();
  state.traffic = mods.createTraffic(createSeeded(hashSeed(`traffic:${seed}`)), state.city);
  state.combat = mods.createCombat();
  mods.renderer = mods.createRenderer ? mods.createRenderer(canvas) : null;
  window.__heist = state;

  // First gesture unlocks the synthesized audio; browsers block it before that.
  const unlock = () => mods.audioUnlock(state.audio);
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  let accumulator = 0;
  let last = performance.now();

  function frame(now) {
    requestAnimationFrame(frame);
    accumulator += Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    handleActions(state, mods);
    const move = state.input.moveVector();
    move.crouch = state.input.crouching();
    move.sprint = state.input.sprinting();
    if (state.screen === SCREEN.TITLE || state.screen === SCREEN.PLAN
      || state.screen === SCREEN.HEIST || state.screen === SCREEN.GETAWAY) {
      while (accumulator >= STEP) {
        step(state, mods, STEP, move);
        accumulator -= STEP;
      }
    } else {
      accumulator = 0;
    }
    draw(state, mods);
  }

  // Leaving the tab pauses a running game rather than letting the alarm climb unseen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (state.screen === SCREEN.HEIST || state.screen === SCREEN.GETAWAY)) {
      state.screenBeforePause = state.screen;
      state.screen = SCREEN.PAUSE;
      announce('Paused.');
    }
  });

  announce('Senja Heist. Press Space or click to start.');
  requestAnimationFrame(frame);
}

if (shot) runShot(shot).catch((error) => console.error(error));
else runGame().catch((error) => console.error(error));
