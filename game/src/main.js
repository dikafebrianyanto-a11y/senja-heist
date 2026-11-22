// Senja Heist — the spine: one shared state, a fixed-step loop, and the
// screen machine (title, plan, heist, getaway, pause, busted, payout).
//
// Gameplay lives in small modules loaded on demand and checked one function
// at a time: anything the crew has not finished yet is swapped for a
// stand-in from boot.js, so the page still loads, draws and plays with
// whatever exists. config, random, input and save are static imports and
// always there. The full module contract lives in /tmp/heist-contract.md.
//
// ?seed=N pins the city and the rooms. ?shot=cover|plan|getaway (with
// &seed=N) stages that scene instead of running the loop, paints it twice
// and raises window.__shotReady for a screenshot.

import { ALARM, CAR, CITY, GUARD, HEAT, PALETTE, ROOM, SCREEN, STEP, THIEF, TOOLS, VAULT, VIEW } from './config.js';
import { createSeeded, hashSeed } from './random.js';
import { ACT_BUY, ACT_CONFIRM, ACT_DOWN, ACT_EMP, ACT_INTERACT, ACT_MUTE, ACT_PAUSE, ACT_PUNCH, ACT_SHOOT, ACT_UP, createInput } from './input.js';
import { clearSave, defaultSave, loadSave, writeSave } from './save.js';
import { DIFFICULTY_LEVELS, DIFFICULTY_ORDER, buildFallbackCameras, buildFallbackCity, buildFallbackCrew, buildFallbackGuards, buildFallbackLoot, buildFallbackRoom, buildFallbackThief, buildFallbackVault, difficultyEntry, fallbackJobs, scaledJob } from './boot.js';

/** The longest frame the loop catches up on; a longer stall (a hidden tab) is dropped, not replayed. */
const FRAME_CAP = 0.25;

/**
 * The smoke-bomb action bit. input.js is gaining ACT_SMOKE = 1024 on KeyQ
 * from another worker; until that lands, the local key listener below
 * queues the same press, so either path reaches the heist handler.
 */
const SMOKE_BIT = 1024;

const query = new URLSearchParams(window.location.search);
const shotName = query.get('shot');
const seedText = Number.parseInt(query.get('seed') ?? '', 10);
const seed = Number.isInteger(seedText) ? seedText : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const status = document.getElementById('status');

/** The live state, once runGame / runShot has built it; the key listeners below read it. */
let liveState = null;
/** A difficulty rung picked with Digit1/2/3 on the plan screen, waiting for the next frame. */
let queuedDifficulty = null;
/** A KeyQ press on the heist screen, waiting for the next frame. */
let queuedSmoke = false;

window.addEventListener('keydown', (event) => {
  if (event.repeat || !liveState) return;
  if (liveState.screen === SCREEN.PLAN && event.code.startsWith('Digit')) {
    const rung = Number(event.code.slice(5));
    if (rung >= 1 && rung <= DIFFICULTY_ORDER.length) queuedDifficulty = DIFFICULTY_ORDER[rung - 1];
  } else if (liveState.screen === SCREEN.HEIST && event.code === 'KeyQ') {
    queuedSmoke = true;
  }
});

/** One line for the planning board: which keys pick a difficulty, and which rung is live. */
function difficultyHelp(current) {
  const parts = DIFFICULTY_ORDER.map((name, i) => `${i + 1}=${difficultyEntry(name).label}`);
  return `Difficulty [${parts.join(' / ')}]: ${difficultyEntry(current).label}. ${difficultyEntry(current).blurb}`;
}

// ---------------------------------------------------------------------------
// The single shared state. Every module reads and writes this object;
// main owns the order they run in. Only cash, bestCash, jobIndex,
// jobsDone, tools, muted, difficulty and crewXp are saved, via save.js.
// ---------------------------------------------------------------------------

export function createHeistState(seedValue, save) {
  const rung = DIFFICULTY_LEVELS[save?.difficulty] ? save.difficulty : 'normal';
  const savedXp = save?.crewXp ?? {};
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
    tools: { ...save.tools, smoke: Number.isInteger(save.tools?.smoke) ? save.tools.smoke : 0 },
    difficulty: rung,
    crewXp: {
      mara: Number.isInteger(savedXp.mara) ? savedXp.mara : 0,
      iko: Number.isInteger(savedXp.iko) ? savedXp.iko : 0,
      reno: Number.isInteger(savedXp.reno) ? savedXp.reno : 0,
      sable: Number.isInteger(savedXp.sable) ? savedXp.sable : 0,
    },
    planHelp: difficultyHelp(rung),
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
    difficulty: state.difficulty,
    crewXp: { ...state.crewXp },
  });
}

/** Copy the banked crew XP onto a freshly built crew (createCrew starts at zero). */
function applyCrewXp(state) {
  if (!state.crew) return;
  for (const member of state.crew) {
    if (member.xp === undefined) member.xp = state.crewXp?.[member.id] ?? 0;
  }
}

/** Fold each member's live XP back into the banked per-member totals. */
function syncCrewXp(state) {
  if (!state.crew) return;
  for (const member of state.crew) {
    state.crewXp[member.id] = member.xp ?? 0;
  }
}

function say(state, text, seconds) {
  state.banner = text;
  state.bannerTimer = seconds ?? 2.5;
}

function announce(message) {
  status.textContent = message;
}

function noOp() {}
function neverTrue() { return false; }
function zeroOut() { return 0; }

// ---------------------------------------------------------------------------
// Module loading: dynamic import, checked function by function.
// ---------------------------------------------------------------------------

const MODULE_WANTS = {
  world: ['buildRoom', 'buildCity', 'roomSolidAt', 'citySolidAt', 'losBlocked', 'roomExit', 'citySafehouse'],
  player: ['createThief', 'stepThief', 'thiefSpeed', 'grabLoot', 'thiefHurt'],
  crew: ['createCrew', 'stepCrew', 'assignRoles', 'crewByRole', 'awardCrewXp'],
  stealth: ['createGuards', 'createCameras', 'stepGuards', 'stepCameras', 'guardSees', 'cameraSees', 'stepAlarm', 'alarmLevel', 'inCone', 'disableCameras'],
  vault: ['createVault', 'startCrack', 'stepVault', 'vaultPin', 'createLoot', 'lootValue', 'lootWeight'],
  vehicles: ['createCar', 'stepCar', 'enterCar', 'exitCar'],
  traffic: ['createTraffic', 'stepTraffic', 'trafficCarNear'],
  police: ['createPolice', 'stepPolice', 'raiseHeat', 'lowerHeat'],
  missions: ['jobFor', 'jobObjectives', 'objectivesDone', 'payoutFor', 'planOptions', 'buyTool'],
  combat: ['createCombat', 'stepCombat', 'punch', 'shoot', 'useSmokeBomb'],
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
    : fallbackJobs();

  const resolveFn = (moduleName, fnName, fallback) => {
    const mod = found[moduleName];
    return mod && typeof mod[fnName] === 'function' ? mod[fnName] : fallback;
  };

  const mods = {
    jobs,
    shotNames: Array.isArray(found.shots?.SHOT_NAMES) ? found.shots.SHOT_NAMES : ['cover', 'plan', 'getaway'],
    stageShot: resolveFn('shots', 'stageShot', null),
    createRenderer: resolveFn('render', 'createRenderer', null),
  };

  // world
  mods.buildRoom = resolveFn('world', 'buildRoom', buildFallbackRoom);
  mods.buildCity = resolveFn('world', 'buildCity', buildFallbackCity);
  mods.roomSolidAt = resolveFn('world', 'roomSolidAt', neverTrue);
  mods.citySolidAt = resolveFn('world', 'citySolidAt', neverTrue);
  mods.losBlocked = resolveFn('world', 'losBlocked', neverTrue);
  mods.roomExit = resolveFn('world', 'roomExit', (room) => room.exit);
  mods.citySafehouse = resolveFn('world', 'citySafehouse', (city) => city.safehouse);

  // player
  mods.createThief = resolveFn('player', 'createThief', buildFallbackThief);
  mods.stepThief = resolveFn('player', 'stepThief', noOp);
  mods.thiefSpeed = resolveFn('player', 'thiefSpeed', zeroOut);
  mods.grabLoot = resolveFn('player', 'grabLoot', (state, item) => {
    if (!item || item.taken || !state.player) return false;
    item.taken = true;
    state.player.carrying.push(item);
    state.player.weight += item.weight;
    state.stats.taken += item.value;
    return true;
  });
  mods.thiefHurt = resolveFn('player', 'thiefHurt', (state, dmg) => {
    if (state.player) state.player.hp = Math.max(0, state.player.hp - dmg);
  });

  // crew
  mods.createCrew = resolveFn('crew', 'createCrew', buildFallbackCrew);
  mods.stepCrew = resolveFn('crew', 'stepCrew', noOp);
  mods.assignRoles = resolveFn('crew', 'assignRoles', noOp);
  mods.crewByRole = resolveFn('crew', 'crewByRole', (state, role) => state.crew.find((m) => m.role === role) ?? null);
  // awardCrewXp lands from another worker; null until it does, and bankPayout guards the call.
  mods.awardCrewXp = resolveFn('crew', 'awardCrewXp', null);

  // stealth
  mods.createGuards = resolveFn('stealth', 'createGuards', buildFallbackGuards);
  mods.createCameras = resolveFn('stealth', 'createCameras', buildFallbackCameras);
  mods.stepGuards = resolveFn('stealth', 'stepGuards', (state, dt) => {
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
  mods.stepCameras = resolveFn('stealth', 'stepCameras', (state, dt) => {
    for (const cam of state.cameras) {
      if (cam.disabled) continue;
      cam.angle = cam.baseAngle + Math.sin(state.time * cam.speed) * cam.sweep;
    }
  });
  mods.guardSees = resolveFn('stealth', 'guardSees', zeroOut);
  mods.cameraSees = resolveFn('stealth', 'cameraSees', neverTrue);
  mods.stepAlarm = resolveFn('stealth', 'stepAlarm', (state, dt) => {
    state.alarm = Math.max(0, state.alarm - ALARM.decay * dt);
  });
  mods.alarmLevel = resolveFn('stealth', 'alarmLevel', (state) => (state.alarm >= ALARM.lockdownAt ? 'lockdown' : state.alarm >= ALARM.suspectAt ? 'suspicious' : 'calm'));
  mods.inCone = resolveFn('stealth', 'inCone', (x, y, ox, oy, angle, range, halfAngle) => {
    const dx = x - ox;
    const dy = y - oy;
    if (dx * dx + dy * dy > range * range) return false;
    let diff = Math.atan2(dy, dx) - angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return Math.abs(diff) <= halfAngle;
  });
  mods.disableCameras = resolveFn('stealth', 'disableCameras', (state, seconds) => {
    for (const cam of state.cameras) {
      cam.disabled = true;
      cam.disabledTimer = seconds;
    }
  });

  // vault
  mods.createVault = resolveFn('vault', 'createVault', buildFallbackVault);
  mods.startCrack = resolveFn('vault', 'startCrack', (state) => {
    if (state.vault && state.vault.state === 'locked') state.vault.state = 'cracking';
  });
  mods.stepVault = resolveFn('vault', 'stepVault', (state, dt) => {
    const v = state.vault;
    if (!v || v.state !== 'cracking') return;
    v.needle += v.dir * v.speed * dt;
    if (v.needle >= 1) { v.needle = 1; v.dir = -1; }
    else if (v.needle <= 0) { v.needle = 0; v.dir = 1; }
  });
  mods.vaultPin = resolveFn('vault', 'vaultPin', (state) => {
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
  mods.createLoot = resolveFn('vault', 'createLoot', buildFallbackLoot);
  mods.lootValue = resolveFn('vault', 'lootValue', (state) => state.player.carrying.reduce((sum, item) => sum + item.value, 0));
  mods.lootWeight = resolveFn('vault', 'lootWeight', (state) => state.player.carrying.reduce((sum, item) => sum + item.weight, 0));

  // vehicles
  mods.createCar = resolveFn('vehicles', 'createCar', (x, y, kind) => ({
    x, y, angle: -Math.PI / 2, speed: 0, kind: kind ?? 'sedan',
    color: PALETTE.carPlayer, hp: CAR.hp, inUse: false,
  }));
  mods.stepCar = resolveFn('vehicles', 'stepCar', noOp);
  mods.enterCar = resolveFn('vehicles', 'enterCar', (state) => {
    if (!state.car) return false;
    state.car.inUse = true;
    return true;
  });
  mods.exitCar = resolveFn('vehicles', 'exitCar', (state) => {
    if (!state.car) return false;
    state.car.inUse = false;
    return true;
  });

  // traffic
  mods.createTraffic = resolveFn('traffic', 'createTraffic', () => ({ cars: [], walkers: [] }));
  mods.stepTraffic = resolveFn('traffic', 'stepTraffic', noOp);
  mods.trafficCarNear = resolveFn('traffic', 'trafficCarNear', () => null);

  // police
  mods.createPolice = resolveFn('police', 'createPolice', () => ({ units: [], spawnTimer: 0, siren: false }));
  mods.stepPolice = resolveFn('police', 'stepPolice', noOp);
  mods.raiseHeat = resolveFn('police', 'raiseHeat', (state, amount) => {
    state.heat = Math.min(HEAT.max, state.heat + amount);
  });
  mods.lowerHeat = resolveFn('police', 'lowerHeat', (state, dt) => {
    state.heat = Math.max(0, state.heat - HEAT.coolPerSecond * dt);
  });

  // missions
  mods.jobFor = resolveFn('missions', 'jobFor', (index) => jobs[Math.min(index, jobs.length - 1)]);
  mods.jobObjectives = resolveFn('missions', 'jobObjectives', (state) => {
    const list = [{ text: 'Lift the loot', done: state.loot.length > 0 && state.loot.every((item) => item.taken), required: true }];
    if (state.mission?.vault) list.push({ text: 'Crack the vault', done: state.vault?.state === 'open', required: true });
    list.push({ text: 'Reach the exit', done: false, required: true });
    return list;
  });
  mods.objectivesDone = resolveFn('missions', 'objectivesDone', (state) => {
    const list = mods.jobObjectives(state);
    return list.filter((o) => o.required).every((o) => o.done);
  });
  mods.payoutFor = resolveFn('missions', 'payoutFor', (state) => {
    const loot = mods.lootValue(state);
    const ghostBonus = state.alarm < ALARM.suspectAt ? Math.round(loot * 0.1) : 0;
    return { loot, bonus: ghostBonus, timeBonus: 0, ghostBonus, total: loot + ghostBonus, xp: 0 };
  });
  mods.planOptions = resolveFn('missions', 'planOptions', (state) => ({
    jobs: jobs.map((job, i) => ({ job, unlocked: i <= state.jobsDone, done: i < state.jobsDone })),
    shop: Object.entries(TOOLS).map(([id, tool]) => ({
      id, name: tool.name, cost: tool.cost,
      owned: id === 'emp' ? state.tools.emp > 0 : state.tools[id] === true,
      desc: tool.desc,
    })),
    cash: state.cash,
  }));
  mods.buyTool = resolveFn('missions', 'buyTool', (state, toolId) => {
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
  mods.createCombat = resolveFn('combat', 'createCombat', () => ({ bullets: [] }));
  mods.stepCombat = resolveFn('combat', 'stepCombat', noOp);
  mods.punch = resolveFn('combat', 'punch', neverTrue);
  mods.shoot = resolveFn('combat', 'shoot', neverTrue);
  // useSmokeBomb lands from another worker; null until it does, and trySmoke guards the call.
  mods.useSmokeBomb = resolveFn('combat', 'useSmokeBomb', null);

  // hud — a missing draw is skipped, never faked.
  for (const fn of MODULE_WANTS.hud) mods[fn] = resolveFn('hud', fn, null);

  // audio
  mods.createAudio = resolveFn('audio', 'createAudio', () => ({ muted: false }));
  mods.audioUnlock = resolveFn('audio', 'audioUnlock', noOp);
  mods.audioStep = resolveFn('audio', 'audioStep', noOp);
  mods.sfx = resolveFn('audio', 'sfx', noOp);
  mods.setMuted = resolveFn('audio', 'setMuted', (audio, muted) => { audio.muted = muted; });

  // effects
  mods.createEffects = resolveFn('effects', 'createEffects', () => ({ particles: [], floats: [], shakeT: 0, shakeMag: 0, flash: 0 }));
  mods.stepEffects = resolveFn('effects', 'stepEffects', noOp);
  mods.burst = resolveFn('effects', 'burst', noOp);
  mods.floatText = resolveFn('effects', 'floatText', noOp);
  mods.shake = resolveFn('effects', 'shake', (state, mag, time) => {
    state.fx.shakeMag = mag;
    state.fx.shakeT = time;
  });
  mods.drawEffects = resolveFn('effects', 'drawEffects', null);

  return mods;
}

// ---------------------------------------------------------------------------
// Job flow: plan -> heist -> getaway -> payout, or busted.
// ---------------------------------------------------------------------------

function startJob(state, mods, index) {
  const job = mods.jobFor(index);
  // The mission stays the job as written; only the room builder sees the
  // difficulty-bent copy, so objectives, vault and payout read the real job.
  const tuned = scaledJob(job, state.difficulty);
  const roomSeed = createSeeded(hashSeed(`room:${job.id}:${state.seed}`));
  state.mission = job;
  state.jobIndex = index;
  state.room = mods.buildRoom(roomSeed, tuned);
  state.guards = mods.createGuards(roomSeed, state.room, tuned);
  state.cameras = mods.createCameras(roomSeed, state.room, tuned);
  state.loot = mods.createLoot(roomSeed, state.room, tuned);
  state.vault = mods.createVault(job);
  state.player = mods.createThief(state.room.entry.x, state.room.entry.y);
  if (state.player) state.player.smoke = state.tools.smoke ?? 0;
  state.crew = mods.createCrew();
  applyCrewXp(state);
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
  const rungNote = state.difficulty === 'normal' ? '' : ` (${difficultyEntry(state.difficulty).label} difficulty)`;
  announce(`${job.name} at ${job.target}${rungNote}. Lift the loot and reach the exit.`);
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
  const xp = payout?.xp ?? 0;
  state.cash += payout.total;
  state.bestCash = Math.max(state.bestCash, state.cash);
  state.jobsDone += 1;
  state.jobIndex = Math.min(state.jobIndex + 1, mods.jobs.length - 1);
  state.heat = Math.max(0, state.heat - 1);
  if (xp > 0 && typeof mods.awardCrewXp === 'function') mods.awardCrewXp(state, xp);
  syncCrewXp(state);
  state.payout = payout;
  state.screen = SCREEN.PAYOUT;
  saveCampaign(state);
  const xpNote = xp > 0 ? ` Crew earned ${xp} XP.` : '';
  announce(`Score banked: $${payout.total}. Total cash $${state.cash}.${xpNote}`);
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

/**
 * Switch the difficulty rung from the plan screen and remember it.
 * The next startJob bends the job's guard/camera counts by the new rung;
 * a job already in progress keeps the counts it started with.
 */
function applyDifficulty(state, rung) {
  state.difficulty = rung;
  state.planHelp = difficultyHelp(rung);
  saveCampaign(state);
  say(state, `Difficulty: ${difficultyEntry(rung).label}. ${difficultyEntry(rung).blurb}`, 2);
}

/**
 * Spend one smoke bomb: the combat module pops the cloud, and both charge
 * counts — the tool stock and the thief's carried count — drop together so
 * a save/load round-trip cannot duplicate one. Returns true only when a
 * bomb actually went off; anything else leaves KeyQ free for the EMP.
 */
function trySmoke(state, mods) {
  if (typeof mods.useSmokeBomb !== 'function') return false;
  const carried = state.player?.smoke ?? 0;
  const stocked = state.tools.smoke ?? 0;
  const available = Math.max(carried, stocked);
  if (available <= 0) {
    say(state, 'No smoke bombs. Buy them on the planning board.', 2);
    return false;
  }
  const fired = mods.useSmokeBomb(state);
  if (fired === false) return false;
  state.tools.smoke = Math.max(0, stocked - 1);
  if (state.player) state.player.smoke = Math.max(0, carried - 1);
  mods.sfx(state.audio, 'smoke');
  say(state, 'Smoke out — the room just lost you.', 2);
  return true;
}

/** What E does in the heist room: vault first, then loot, then the exit. */
function interact(state, mods) {
  const player = state.player;
  if (!player || !state.room) return;
  const within = (spot, range) => Math.hypot(player.x - spot.x, player.y - spot.y) <= range;

  if (state.vault && state.room.vaultSpot && within(state.room.vaultSpot, 64)) {
    if (state.vault.state === 'locked') {
      mods.startCrack(state);
      mods.sfx(state.audio, 'crack');
      say(state, 'Cracking the vault — press E as the needle crosses gold.', 3);
      return;
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
      return;
    }
    // An open vault is done: fall through so E grabs the stash it spilled
    // (the stash lands 58 px below the vault door, inside this radius).
  }

  for (const item of state.loot) {
    if (!item.taken && within(item, 48)) {
      if (mods.grabLoot(state, item)) {
        mods.sfx(state.audio, 'pickup');
        mods.floatText(state, item.x, item.y - 20, `+$${item.value}`, PALETTE.loot);
        state.objectives = mods.jobObjectives(state);
      }
      return;
    }
  }

  if (within(state.room.exit, 56)) {
    if (mods.objectivesDone(state)) {
      mods.sfx(state.audio, 'door');
      beginGetaway(state, mods);
    } else {
      say(state, 'Finish the job first — check the objectives.', 2);
    }
  }
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
    const picked = queuedDifficulty;
    queuedDifficulty = null;
    if (picked) applyDifficulty(state, picked);
    if (actions & ACT_UP) state.plan.cursor = (state.plan.cursor - 1 + rows.length) % rows.length;
    if (actions & ACT_DOWN) state.plan.cursor = (state.plan.cursor + 1) % rows.length;
    // A digit still jumps the cursor to that job even on the frame it also
    // picks a difficulty: the difficulty listener consumes the same press,
    // so the jump must not hide behind the difficulty branch.
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
    const smokePressed = queuedSmoke || (actions & SMOKE_BIT) !== 0;
    queuedSmoke = false;
    const smoked = smokePressed ? trySmoke(state, mods) : false;
    if (!smoked && (actions & ACT_EMP)) {
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
  liveState = state;
  state.input = createInput(canvas);
  state.audio = mods.createAudio();
  state.crew = mods.createCrew();
  applyCrewXp(state);
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
  liveState = state;
  state.input = createInput(canvas);
  state.audio = mods.createAudio();
  mods.setMuted(state.audio, state.muted);
  state.crew = mods.createCrew();
  applyCrewXp(state);
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
    accumulator += Math.min((now - last) / 1000, FRAME_CAP);
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

if (shotName) runShot(shotName).catch((error) => console.error(error));
else runGame().catch((error) => console.error(error));
