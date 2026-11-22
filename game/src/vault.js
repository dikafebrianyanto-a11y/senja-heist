// vault.js — the vault timing game and the loot on the floor.
//
// Two economies meet here. The loose loot scattered around the room is the
// quick money: grab it and go, but every kilo slows Mara down. The vault is
// the big money behind a timing game: a needle sweeps the dial and the
// player stops it inside the gold window, four pins in a row. A miss is
// loud — the alarm hears it — unless a tool eats the mistake: the lockpick
// set swallows one, and a masterpick swallows one too, while also widening
// the gold window. The gold window itself jumps to a new spot after every
// pin, so the fourth pin is never the same shot as the first.
//
// Loot values scale with the job's take, so a pawnshop till and a museum
// vault feel like different leagues without any per-job special cases.

import { VAULT } from './config.js';

/** Kilos the thief carries per kind of loot. */
const LOAD_KG = { cash: 1, jewels: 1, art: 4, gold: 5, data: 0 };

/** Display names for the loot kinds. */
const LOAD_LABEL = {
  cash: 'Bundled cash',
  jewels: 'Loose jewels',
  art: 'Framed art',
  gold: 'Gold bars',
  data: 'Ledger drive',
};

/**
 * Share of the job's take one loose item of this kind is roughly worth.
 * The room total lands near half the take; the vault stash holds the rest.
 */
const LOAD_SHARE = { cash: 0.12, jewels: 0.2, art: 0.24, gold: 0.27, data: 0.1 };

/** Where the gold window sits for each pin, in order — it never repeats a spot. */
const PIN_CENTRES = [0.5, 0.27, 0.73, 0.42];

/** What the vault spills when it opens: kind and share of the job's take. */
const STASH_PIECES = [
  { kind: 'gold', share: 0.22 },
  { kind: 'jewels', share: 0.12 },
  { kind: 'art', share: 0.11 },
];

/** How much wider the masterpick makes the gold window. */
const MASTERPICK_BONUS = 0.07;

/** Round a loot value to the nearest ten so the HUD reads cleanly. */
function roundToTen(amount) {
  const rounded = Math.round(amount / 10) * 10;
  return Math.max(50, rounded);
}

/**
 * A fresh vault for `job`. Jobs without a vault get one that is already
 * open with zero pins, so the minigame — and the vault objective — simply
 * vanish. `target` is the centre of the gold window for the pin being
 * worked on; `masterpickUsed` tracks the masterpick's one forgiven miss.
 */
export function createVault(job) {
  const vault = {
    state: 'open',
    pins: 0,
    set: 0,
    needle: 0,
    dir: 1,
    window: VAULT.window,
    speed: VAULT.needleSpeed,
    target: 0.5,
    forgiven: false,
    masterpickUsed: false,
  };
  if (job?.vault) {
    vault.state = 'locked';
    vault.pins = VAULT.pins;
    vault.target = PIN_CENTRES[0];
  }
  return vault;
}

/**
 * Start cracking: locked becomes cracking and the needle starts at the
 * bottom of the dial. Main.js only calls this beside the vault, so no
 * distance check lives here. Re-calling it mid-crack is a no-op — the
 * needle keeps whatever position it already has.
 */
export function startCrack(state) {
  const vault = state.vault;
  if (!vault || vault.state !== 'locked') return;
  Object.assign(vault, { state: 'cracking', needle: 0, dir: 1, target: PIN_CENTRES[0] });
}

/**
 * The gold window's live width: the drill's wider window when the silent
 * drill is fitted, plus the masterpick's bonus when that tool is carried.
 * The two tools stack — a drilled masterpick vault is the widest window
 * the game ever offers — and the bonus is added here, in exactly one
 * place, so the pin check and the sweep can never disagree about it.
 */
function liveWindow(state) {
  let span = state.tools?.drill ? VAULT.drillWindow : VAULT.window;
  if (state.tools?.masterpick) span += MASTERPICK_BONUS;
  return span;
}

/**
 * Sweep the needle back and forth across the dial while cracking. With the
 * silent drill fitted the needle runs slower and the gold window runs
 * wider — the tool's whole benefit, applied here and nowhere else.
 */
export function stepVault(state, dt) {
  const vault = state.vault;
  if (!vault || vault.state !== 'cracking') return;
  vault.speed = VAULT.needleSpeed;
  if (state.tools?.drill) vault.speed = VAULT.drillNeedle;
  vault.window = liveWindow(state);
  vault.needle += vault.dir * vault.speed * dt;
  const edge = vault.needle >= 1 ? 1 : vault.needle <= 0 ? 0 : null;
  if (edge !== null) {
    vault.needle = edge;
    vault.dir = edge === 1 ? -1 : 1;
  }
}

/** Flip the vault open. */
function markOpen(vault) {
  vault.state = 'open';
}

/**
 * The player pressed E while cracking. Inside the gold window the pin locks
 * and the window jumps to its next spot; on the last pin the vault opens
 * and its stash spills onto the floor as fresh loot. Outside the window the
 * pin slips: the alarm climbs, unless a tool swallows the mistake — the
 * masterpick forgives one miss per vault, and so does the lockpick set,
 * each tracked on its own flag.
 *
 * Returns 'hit', 'miss', 'open', or null when the vault is not cracking.
 */
export function vaultPin(state) {
  const vault = state.vault;
  if (!vault || vault.state !== 'cracking') return null;
  const span = liveWindow(state);
  vault.window = span;
  const onTarget = Math.abs(vault.needle - vault.target) <= span / 2;
  if (!onTarget) {
    // Forgiveness order: the masterpick's one free miss first, then the
    // lockpick set's. A vault carrying both tools can therefore absorb two
    // bad pins before the alarm hears anything.
    if (state.tools?.masterpick && !vault.masterpickUsed) {
      vault.masterpickUsed = true;
    } else if (state.tools?.lockpick && !vault.forgiven) {
      vault.forgiven = true;
    } else {
      state.alarm = Math.min(100, VAULT.missAlarm + (state.alarm ?? 0));
    }
    return 'miss';
  }
  vault.set = vault.set + 1;
  if (vault.set >= vault.pins) {
    markOpen(vault);
    spillStash(state);
    return 'open';
  }
  vault.target = PIN_CENTRES[vault.set % PIN_CENTRES.length];
  return 'hit';
}

/**
 * Drop the vault's stash on the floor beside the vault door, as loot items
 * the player still has to walk over and pick up. Nothing is banked for
 * free — opening the vault is only half the job.
 */
function spillStash(state) {
  const job = state.mission;
  const spot = state.room?.vaultSpot;
  if (!job || !spot || !state.loot) return;
  const offsets = [-46, 0, 46];
  for (let i = 0; i < STASH_PIECES.length; i += 1) {
    const piece = STASH_PIECES[i];
    state.loot.push({
      id: state.loot.length,
      x: spot.x + (offsets[i] ?? 0),
      y: spot.y + 58,
      kind: piece.kind,
      name: LOAD_LABEL[piece.kind],
      value: roundToTen(job.take * piece.share),
      weight: LOAD_KG[piece.kind] ?? 1,
      taken: false,
    });
  }
}

/**
 * One loot item per loot spot in the room, values scaled to the job's take
 * with a little seeded jitter so no two runs price a room identically.
 * A room with no spots simply has nothing lying around.
 */
export function createLoot(rng, room, job) {
  const spots = room?.lootSpots ?? [];
  const take = job?.take ?? 0;
  const out = [];
  for (let i = 0; i < spots.length; i += 1) {
    const spot = spots[i];
    const kind = spot.kind || 'cash';
    const jitter = rng ? rng.range(0.85, 1.15) : 1.0;
    out.push({
      id: i,
      x: spot.x,
      y: spot.y,
      kind,
      name: LOAD_LABEL[kind] ?? kind,
      value: roundToTen(take * (LOAD_SHARE[kind] ?? 0.1) * jitter),
      weight: LOAD_KG[kind] ?? 1,
      taken: false,
    });
  }
  return out;
}

/** Total value of what the thief is carrying right now. */
export function lootValue(state) {
  const thief = state.player;
  if (!thief) return 0;
  let total = 0;
  for (const item of thief.carrying) total += item.value ?? 0;
  return total;
}

/** Total weight of what the thief is carrying right now. */
export function lootWeight(state) {
  const thief = state.player;
  if (!thief) return 0;
  let total = 0;
  for (const item of thief.carrying) total += item.weight ?? 0;
  return total;
}
