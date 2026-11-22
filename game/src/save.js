// Campaign persistence for the crew of Kota Senja: banked cash, best take,
// current job, difficulty, per-member experience, owned tools and the mute
// flag, all under one localStorage key as versioned JSON. Anything the
// loader cannot trust — no entry, broken JSON, a stale version — counts as
// no save at all, so the game always falls back to a fresh crew instead of
// dying over a bad file. Saves written before difficulty, crew XP or the
// new tools existed are upgraded on load: missing fields are filled from
// defaultSave(), so an old campaign never loses its progress.

import { SAVE_KEY } from './config.js'; // the single storage key, defined in config

export const SAVE_VERSION = 1; // bump this whenever the save shape changes

// Difficulties the loader accepts; anything else falls back to 'normal'.
const DIFFICULTIES = ['easy', 'normal', 'hard'];

// The four crew members, in the order their experience is stored.
const CREW_MEMBERS = ['mara', 'iko', 'reno', 'sable'];

/** Fresh experience totals: every member of the crew starts at zero. */
function freshCrewXp() {
  const xp = {};
  for (const member of CREW_MEMBERS) xp[member] = 0;
  return xp;
}

/** An empty loadout: no tools owned and no consumables stocked. */
function freshTools() {
  return {
    lockpick: false, emp: 0, disguise: false,
    drill: false, smoke: 0, masterpick: false,
  };
}

/** A brand-new campaign: broke, unranked, on the first job, normal difficulty. */
export function defaultSave() {
  return {
    version: SAVE_VERSION, // save format version
    difficulty: 'normal',
    cash: 0, bestCash: 0,
    jobIndex: 0, jobsDone: 0,
    crewXp: freshCrewXp(),
    tools: freshTools(),
    muted: false,
  };
}

/** A finite number from storage, or the fallback when the stored value is junk. */
function asCount(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** A whole number from storage, or the fallback when the stored value is junk. */
function asIndex(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

/** A strict true/false from storage: only a real `true` counts as on. */
function asFlag(value) {
  return value === true;
}

/** A stored difficulty, or 'normal' when it is missing or unknown. */
function validDifficulty(value) {
  return DIFFICULTIES.includes(value) ? value : 'normal';
}

/** Crew experience with every member present, missing members at zero. */
function mergedCrewXp(raw) {
  const xp = freshCrewXp();
  if (raw && typeof raw === 'object') {
    for (const member of CREW_MEMBERS) {
      // Only sane totals survive: a stored value must be a finite number
      // and can never go below zero.
      if (Number.isFinite(raw[member]) && raw[member] >= 0) xp[member] = raw[member];
    }
  }
  return xp;
}

/** The loadout with every tool present, missing entries at their defaults. */
function mergedTools(raw) {
  const tools = freshTools();
  if (!raw || typeof raw !== 'object') return tools;
  tools.lockpick = asFlag(raw.lockpick);
  tools.emp = asIndex(raw.emp, 0);
  tools.disguise = asFlag(raw.disguise);
  tools.drill = asFlag(raw.drill);
  tools.smoke = asIndex(raw.smoke, 0);
  tools.masterpick = asFlag(raw.masterpick);
  return tools;
}

/**
 * Read the stored campaign, filling any gaps with fresh defaults so saves
 * written before difficulty, crew XP or the new tools existed still load.
 * Returns null when nothing usable is stored — the caller starts a new crew.
 */
export function loadSave() {
  let stored;
  try {
    stored = window.localStorage.getItem(SAVE_KEY);
  } catch {
    return null; // storage unavailable
  }
  if (!stored) return null; // nothing saved yet
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null; // broken JSON is a fresh crew, not a crash
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.version !== SAVE_VERSION) return null; // stale format, start over
  const baseline = defaultSave();
  return {
    version: SAVE_VERSION,
    difficulty: validDifficulty(parsed.difficulty),
    cash: asCount(parsed.cash, baseline.cash),
    bestCash: asCount(parsed.bestCash, baseline.bestCash),
    jobIndex: asIndex(parsed.jobIndex, baseline.jobIndex),
    jobsDone: asIndex(parsed.jobsDone, baseline.jobsDone),
    crewXp: mergedCrewXp(parsed.crewXp),
    tools: mergedTools(parsed.tools),
    muted: asFlag(parsed.muted),
  };
}

/** Store the campaign as JSON. Returns false instead of throwing when storage is off. */
export function writeSave(save) {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    return false; // storage full or unavailable
  }
  return true;
}

/** Delete the stored campaign so the next launch starts a fresh crew. */
export function clearSave() {
  try {
    window.localStorage.removeItem(SAVE_KEY);
  } catch {
    return false; // storage unavailable
  }
  return true;
}
