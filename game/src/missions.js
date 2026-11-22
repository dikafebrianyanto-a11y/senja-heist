// Senja Heist — the campaign ledger: which scores are on the board, what a
// finished night pays, and what the crew can buy before they go in.
//
// Nothing here draws pixels or steps the simulation. It answers questions
// from main.js: what jobs exist, which objectives are still open, how much
// a haul is worth, and what the planning screen should show. State flows
// in, plain objects flow out; the only writes happen inside buyTool, which
// spends cash and stocks the tool bag.
//
// How a score pays out: the crew banks exactly the loot they walk out
// with, then two extras stack on top. A fast room earns a speed bonus that
// fades as the clock runs, and a run where the alarm never rose past the
// suspicious line earns a ghost cut of the haul. On top of the cash, every
// finished job banks crew XP that grows with the job's place in the list,
// and the chosen difficulty scales the whole cash total.

import { ALARM, DIFFICULTY, TOOLS } from './config.js';

// Seconds inside before the speed bonus starts shrinking.
const FAST_ROOM = 90;
// Seconds inside at which the speed bonus has faded to nothing.
const SLOW_ROOM = 300;
// Largest speed bonus a job can pay, in dollars.
const MAX_TIME_BONUS = 500;
// Ghost cut: this fraction of the carried loot when the alarm stayed quiet.
const GHOST_SHARE = 0.1;
// How many charges one purchase of a charge-based tool adds.
const EMP_PACK = 3;
// Most charges of one tool the crew can carry at once.
const EMP_MAX = 9;
// XP banked for finishing any job, plus this much per job index.
const XP_BASE = 40;
const XP_PER_JOB = 15;
// Fallback difficulty table, used only if config has not defined one yet.
const FALLBACK_DIFFICULTY = { normal: { payoutMul: 1 } };

// The campaign, in rising order of heat. `take` is the headline value of
// everything sitting in the room — the crew only banks what they actually
// carry out the door. `guards` and `cameras` are the counts world.js uses
// to build the room; `vault` means the job ends with the vault minigame
// instead of simple grab-and-go loot.
export const JOBS = [
  { id: 'pawnshop', name: 'Pawnshop Lights', target: 'Marlow Pawnshop', take: 4800, guards: 2, cameras: 1, vault: false, blurb: 'A quiet till, a sleepy guard, a first score.' },
  { id: 'jewellers', name: 'Glass & Gold', target: 'Aurelia Jewellers', take: 18500, guards: 3, cameras: 2, vault: false, blurb: 'Glass cases, gold chains, two cameras over the door.' },
  { id: 'gallery', name: 'The Quiet Gallery', target: 'Galeri Nara', take: 44000, guards: 3, cameras: 3, vault: true, blurb: 'Art on the walls and a small vault behind the office.' },
  { id: 'bank', name: 'Meridian Vault', target: 'Meridian Bank', take: 128000, guards: 5, cameras: 4, vault: true, blurb: 'Five guards, four cameras, one very serious door.' },
  { id: 'museum', name: 'The Senja Museum', target: 'Museum Senja', take: 310000, guards: 6, cameras: 5, vault: true, blurb: 'The big one. The whole city will hear about this.' },
  { id: 'casino', name: 'Kasino Meridian', target: 'Kasino Meridian', take: 420000, guards: 7, cameras: 6, vault: true, blurb: 'Chips stacked high, seven guards on the floor, and a cage full of cash behind the vault door.' },
  { id: 'penthouse', name: 'Penthouse Aurelia', target: 'Penthouse Aurelia', take: 540000, guards: 8, cameras: 6, vault: true, blurb: 'The last score. Eight guards, a rooftop view, and a safe that holds a fortune in one room.' },
];

// Pin an index into the legal range so stale saves and replayed campaigns
// always land on a real job instead of falling off the end of the list.
function pinIndex(index) {
  const n = Number.isFinite(index) ? Math.floor(index) : 0;
  return Math.max(0, Math.min(n, JOBS.length - 1));
}

// The job at `index`; anything past the end clamps to the final job.
export function jobFor(index) {
  return JOBS[pinIndex(index)];
}

// True when the room holds loot and every last piece of it is lifted.
function allLootLifted(state) {
  const roomLoot = Array.isArray(state.loot) ? state.loot : [];
  if (roomLoot.length === 0) return false;
  for (const piece of roomLoot) {
    if (!piece.taken) return false;
  }
  return true;
}

// True when the job has no vault at all, or its vault already stands open.
function vaultIsOpen(state) {
  const mission = state.mission || {};
  if (!mission.vault) return true;
  return Boolean(state.vault && state.vault.state === 'open');
}

// The objective list for the job in progress, in the order the crew reads
// it. Every job needs the loot lifted and the exit reached; vault jobs add
// the crack between them. The exit counts as done once the rest is done —
// it is the last step, and main.js only lets the crew leave through it
// once everything required is finished.
export function jobObjectives(state) {
  const lifted = allLootLifted(state);
  const cracked = vaultIsOpen(state);
  const board = [];
  board.push({ text: 'Lift the loot', done: lifted, required: true });
  if (state.mission && state.mission.vault) {
    board.push({ text: 'Crack the vault', done: cracked, required: true });
  }
  board.push({ text: 'Reach the exit', done: lifted && cracked, required: true });
  return board;
}

// True when every required line on the objective board is checked off.
export function objectivesDone(state) {
  const board = jobObjectives(state);
  for (const line of board) {
    if (line.required && !line.done) return false;
  }
  return true;
}

// Add up the value of everything the thief is carrying out the door.
function haulValue(state) {
  const pocket = state.player && Array.isArray(state.player.carrying)
    ? state.player.carrying
    : [];
  let sum = 0;
  for (const piece of pocket) sum += piece.value || 0;
  return sum;
}

// How long the crew has spent inside the room, in seconds.
function roomSeconds(state) {
  const t = state.stats && state.stats.timeInRoom;
  return typeof t === 'number' ? t : 0;
}

// Speed bonus: the full amount for a room cleared inside FAST_ROOM, then a
// straight slide down to nothing at SLOW_ROOM. A slow, careful crew still
// banks the loot; they simply do not get paid for being quick.
function quickBonus(state) {
  const seconds = roomSeconds(state);
  if (seconds <= FAST_ROOM) return MAX_TIME_BONUS;
  if (seconds >= SLOW_ROOM) return 0;
  const remaining = (SLOW_ROOM - seconds) / (SLOW_ROOM - FAST_ROOM);
  return Math.round(MAX_TIME_BONUS * remaining);
}

// Ghost bonus: a slice of the carried loot when the alarm never tripped
// and never even reached the suspicion line. The meter decays on its own,
// so the trip counter is the memory — a crew that spiked the alarm and
// waited it out does not count as ghosts.
function quietBonus(state, loot) {
  const stats = state.stats || {};
  const everTripped = stats.alarmsTripped > 0;
  const tooLoud = state.alarm >= ALARM.suspectAt;
  if (everTripped || tooLoud) return 0;
  return Math.round(loot * GHOST_SHARE);
}

// Which job number this payout belongs to, defaulting to the first job
// and never going below zero, so a corrupt save cannot pay negative XP.
function payoutJobIndex(state) {
  const n = state.jobIndex;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

// Multiplier for the chosen difficulty; unknown keys fall back to normal.
function payoutMultiplier(state) {
  const table = DIFFICULTY || FALLBACK_DIFFICULTY;
  const key = state.difficulty ?? 'normal';
  const entry = table[key] || table.normal || { payoutMul: 1 };
  return typeof entry.payoutMul === 'number' ? entry.payoutMul : 1;
}

// The payout for the job just finished. `loot` is the carried value,
// `timeBonus` and `ghostBonus` are the two extras, `bonus` is their sum,
// `total` is the cash that lands in the bank after the difficulty
// multiplier, and `xp` is the crew experience the job banks.
export function payoutFor(state) {
  const loot = haulValue(state);
  const time = quickBonus(state);
  const ghost = quietBonus(state, loot);
  const bonus = time + ghost;
  const total = Math.round((loot + bonus) * payoutMultiplier(state));
  const xp = XP_BASE + XP_PER_JOB * payoutJobIndex(state);
  return { loot, bonus, timeBonus: time, ghostBonus: ghost, total, xp };
}

// One entry of the tool shop, in display form. A tool that carries
// `charges` is a count tool — owned while at least one charge is held, and
// the count is shown. A tool without `charges` is a one-off: owned once
// bought, full stop. Nothing here hardcodes which tools exist; any tool
// config gains is picked up by the same rule.
function shopEntry(id, tool, bag) {
  const isChargeTool = typeof tool.charges === 'number';
  const held = isChargeTool ? (bag[id] || 0) : bag[id];
  return {
    id,
    name: tool.name,
    cost: tool.cost,
    owned: isChargeTool ? held > 0 : held === true,
    charges: isChargeTool ? held : undefined,
    desc: tool.desc,
  };
}

// Everything the planning board needs in one object: the job list with
// each job's lock state, the tool shop with prices and what the crew
// already owns, the crew's current role picks, the banked cash, and the
// difficulty the next job will run at. Job `i` unlocks once `i` jobs are
// done; a finished job stays open for replays.
export function planOptions(state) {
  const finished = typeof state.jobsDone === 'number' ? state.jobsDone : 0;
  const jobs = JOBS.map((job, i) => ({
    job,
    unlocked: i <= finished,
    done: i < finished,
  }));
  const bag = state.tools || {};
  const shop = Object.entries(TOOLS).map(([id, tool]) => shopEntry(id, tool, bag));
  const crew = Array.isArray(state.crew)
    ? state.crew.map((member) => ({ id: member.id, name: member.name, role: member.role }))
    : [];
  return { jobs, shop, crew, cash: state.cash, difficulty: state.difficulty ?? 'normal' };
}

// Buy a tool for the crew. Returns false when the tool does not exist,
// when the crew cannot afford it, when a one-off tool is already owned, or
// when a charge tool is already at the cap. A charge tool tops up by its
// own pack size (3 by default) up to EMP_MAX; a one-off tool is bought
// once. The cap applies to every charge tool alike, not just the EMP.
// A successful purchase deducts the cash and updates `state.tools`.
export function buyTool(state, toolId) {
  const tool = TOOLS[toolId];
  if (!tool) return false;
  if (state.cash < tool.cost) return false;
  const bag = state.tools || {};
  if (typeof tool.charges === 'number') {
    const held = bag[toolId] || 0;
    if (held >= EMP_MAX) return false;
    bag[toolId] = Math.min(EMP_MAX, held + (tool.charges ?? EMP_PACK));
  } else {
    if (bag[toolId] === true) return false;
    bag[toolId] = true;
  }
  state.tools = bag;
  state.cash -= tool.cost;
  return true;
}
