// The campaign save in localStorage: banked cash, best take, which job the
// crew is on, the tools they own, and whether the sound is muted. One key,
// one version, plain JSON. A missing, corrupt or wrong-version save is a
// fresh crew — the game never refuses to start over a save file.

import { SAVE_KEY } from './config.js';

export const SAVE_VERSION = 1;

export function defaultSave() {
  return {
    version: SAVE_VERSION,
    cash: 0,
    bestCash: 0,
    jobIndex: 0,
    jobsDone: 0,
    tools: { lockpick: false, emp: 0, disguise: false, drill: false },
    muted: false,
  };
}

/** The saved campaign, or null when there is nothing usable to load. */
export function loadSave() {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SAVE_VERSION) return null;
    const fresh = defaultSave();
    return {
      version: SAVE_VERSION,
      cash: Number.isFinite(parsed.cash) ? parsed.cash : fresh.cash,
      bestCash: Number.isFinite(parsed.bestCash) ? parsed.bestCash : fresh.bestCash,
      jobIndex: Number.isInteger(parsed.jobIndex) ? parsed.jobIndex : fresh.jobIndex,
      jobsDone: Number.isInteger(parsed.jobsDone) ? parsed.jobsDone : fresh.jobsDone,
      tools: {
        lockpick: parsed.tools?.lockpick === true,
        emp: Number.isInteger(parsed.tools?.emp) ? parsed.tools.emp : 0,
        disguise: parsed.tools?.disguise === true,
        drill: parsed.tools?.drill === true,
      },
      muted: parsed.muted === true,
    };
  } catch {
    return null;
  }
}

/** Persist the campaign. Quietly keeps the session-only values when storage is off. */
export function writeSave(save) {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

/** Wipe the campaign (the title screen's "new crew" choice). */
export function clearSave() {
  try {
    window.localStorage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}
