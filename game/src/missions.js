// Senja Heist — jobs, objectives, payouts and the planning board.
//
// This module is pure data plus small decisions: it never touches the
// canvas and never mutates the world. main.js asks it what the campaign
// looks like (which jobs are open, what the crew still has to do, what a
// finished score is worth) and the planning board renders the answers.
//
// Money rule: a payout is the loot actually carried out, plus a speed
// bonus for a quick room, plus a ghost bonus for never letting the alarm
// climb past the point where the crew gets suspicious. The two bonuses
// are reported separately and summed into `bonus`.

import { ALARM, TOOLS } from './config.js';

/** How many seconds in the room still earns the full speed bonus. */
const FAST_ROOM_SECONDS = 90;
/** Past this many seconds in the room the speed bonus is gone entirely. */
const SLOW_ROOM_SECONDS = 300;
/** The biggest speed bonus a job can pay, in dollars. */
const MAX_TIME_BONUS = 500;
/** Ghost bonus: this share of the carried loot, when the alarm stayed quiet. */
const GHOST_SHARE = 0.1;
/** EMP charges one purchase adds, and the most charges the crew can hold. */
const EMP_PACK = 3;
const EMP_MAX = 9;

/**
 * The five jobs of the campaign, in climbing order. `take` is the headline
 * value of the loot on site — the crew only banks what they actually carry
 * out. `guards` and `cameras` are the counts world.js builds the room from;
 * `vault` marks the jobs with a vault minigame instead of grab-and-go loot.
 */
export const JOBS = [
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
  {
    id: 'jewellers',
    name: 'Glass & Gold',
    target: 'Aurelia Jewellers',
    take: 18500,
    guards: 3,
    cameras: 2,
    vault: false,
    blurb: 'Glass cases, gold chains, two cameras over the door.',
  },
  {
    id: 'gallery',
    name: 'The Quiet Gallery',
    target: 'Galeri Nara',
    take: 44000,
    guards: 3,
    cameras: 3,
    vault: true,
    blurb: 'Art on the walls and a small vault behind the office.',
  },
  {
    id: 'bank',
    name: 'Meridian Vault',
    target: 'Meridian Bank',
    take: 128000,
    guards: 5,
    cameras: 4,
    vault: true,
    blurb: 'Five guards, four cameras, one very serious door.',
  },
  {
    id: 'museum',
    name: 'The Senja Museum',
    target: 'Museum Senja',
    take: 310000,
    guards: 6,
    cameras: 5,
    vault: true,
    blurb: 'The big one. The whole city will hear about this.',
  },
];

/**
 * The job at `index`. Indexes past the end clamp to the last job, so a
 * replayed campaign and a stale save both land on the museum, never on
 * undefined.
 */
export function jobFor(index) {
  const clamped = Math.max(0, Math.min(Math.floor(index), JOBS.length - 1));
  return JOBS[clamped];
}

/** True when every piece of loot in the room has been lifted. */
function lootLifted(state) {
  const loot = Array.isArray(state.loot) ? state.loot : [];
  return loot.length > 0 && loot.every((item) => item.taken);
}

/** True when the job has no vault, or its vault stands open. */
function vaultCracked(state) {
  if (!state.mission || !state.mission.vault) return true;
  return state.vault !== null && state.vault !== undefined && state.vault.state === 'open';
}

/**
 * The objective list for the current job, in the order the crew reads it.
 * Every job needs the loot lifted and the exit reached; vault jobs add the
 * crack in the middle. The exit reads as done once the rest of the job is
 * done — reaching it is the last step, and main.js only lets the crew leave
 * through it when everything required is finished.
 */
export function jobObjectives(state) {
  const lifted = lootLifted(state);
  const cracked = vaultCracked(state);
  const list = [{ text: 'Lift the loot', done: lifted, required: true }];
  if (state.mission && state.mission.vault) {
    list.push({ text: 'Crack the vault', done: cracked, required: true });
  }
  list.push({ text: 'Reach the exit', done: lifted && cracked, required: true });
  return list;
}

/** True when every required objective on the board is checked off. */
export function objectivesDone(state) {
  return jobObjectives(state).every((objective) => !objective.required || objective.done);
}

/** Value of the loot the thief is carrying out, from the vault module's tally. */
function carriedValue(state) {
  const carrying = state.player && Array.isArray(state.player.carrying)
    ? state.player.carrying
    : [];
  let total = 0;
  for (const item of carrying) total += item.value || 0;
  return total;
}

/**
 * Speed bonus: the full $500 for a room cleared inside FAST_ROOM_SECONDS,
 * sliding linearly down to nothing at SLOW_ROOM_SECONDS. A slow, careful
 * crew still banks the loot; they just do not get paid for being quick.
 */
function speedBonus(state) {
  const seconds = state.stats && typeof state.stats.timeInRoom === 'number'
    ? state.stats.timeInRoom
    : 0;
  if (seconds <= FAST_ROOM_SECONDS) return MAX_TIME_BONUS;
  if (seconds >= SLOW_ROOM_SECONDS) return 0;
  const share = (SLOW_ROOM_SECONDS - seconds) / (SLOW_ROOM_SECONDS - FAST_ROOM_SECONDS);
  return Math.round(MAX_TIME_BONUS * share);
}

/**
 * Ghost bonus: 10% of the carried loot when the alarm never climbed past
 * the suspicion line and never tripped once. The alarm meter decays, so the
 * trip counter is the memory — a crew that spiked the alarm and waited it
 * out does not count as ghosts.
 */
function ghostBonus(state, loot) {
  const tripped = state.stats && state.stats.alarmsTripped > 0;
  if (tripped || state.alarm >= ALARM.suspectAt) return 0;
  return Math.round(loot * GHOST_SHARE);
}

/**
 * The payout for the job just finished. `loot` is the carried value,
 * `timeBonus` and `ghostBonus` are the two extras, `bonus` is their sum,
 * and `total` is what lands in the bank.
 */
export function payoutFor(state) {
  const loot = carriedValue(state);
  const time = speedBonus(state);
  const ghost = ghostBonus(state, loot);
  const bonus = time + ghost;
  return { loot, bonus, timeBonus: time, ghostBonus: ghost, total: loot + bonus };
}

/**
 * Everything the planning board needs in one object: the job list with
 * each job's lock state, the tool shop with prices and what the crew
 * already owns, the crew's current role picks, and the banked cash.
 * Job `i` unlocks once `i` jobs are done; a finished job stays open for
 * replays.
 */
export function planOptions(state) {
  const jobsDone = typeof state.jobsDone === 'number' ? state.jobsDone : 0;
  const jobs = JOBS.map((job, i) => ({
    job,
    unlocked: i <= jobsDone,
    done: i < jobsDone,
  }));
  const shop = Object.entries(TOOLS).map(([id, tool]) => {
    const owned = id === 'emp'
      ? state.tools.emp > 0
      : state.tools[id] === true;
    return {
      id,
      name: tool.name,
      cost: tool.cost,
      owned,
      charges: id === 'emp' ? state.tools.emp : undefined,
      desc: tool.desc,
    };
  });
  const crew = Array.isArray(state.crew)
    ? state.crew.map((member) => ({ id: member.id, name: member.name, role: member.role }))
    : [];
  return { jobs, shop, crew, cash: state.cash };
}

/**
 * Buy a tool for the crew. Returns false when the tool does not exist,
 * when the crew cannot afford it, or when it is already owned — an EMP
 * purchase is the exception: it tops up charges, 3 at a time, up to 9.
 * A successful purchase deducts the cash and updates `state.tools`.
 */
export function buyTool(state, toolId) {
  const tool = TOOLS[toolId];
  if (!tool) return false;
  if (state.cash < tool.cost) return false;
  if (toolId === 'emp') {
    if (state.tools.emp >= EMP_MAX) return false;
    state.tools.emp = Math.min(EMP_MAX, state.tools.emp + (tool.charges ?? EMP_PACK));
  } else {
    if (state.tools[toolId] === true) return false;
    state.tools[toolId] = true;
  }
  state.cash -= tool.cost;
  return true;
}
