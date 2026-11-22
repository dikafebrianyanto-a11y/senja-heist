// Senja Heist — the vault timing game and the loot on the floor.
//
// Two economies meet here. The loose loot scattered around the room is the
// quick money: grab it and go, but every kilo slows Mara down. The vault is
// the big money behind a timing game: a needle sweeps the dial and the
// player stops it inside the gold window, four pins in a row. A miss is
// loud — the alarm hears it — unless the lockpick set eats one mistake.
// The gold window itself moves after every pin, so the fourth pin is never
// the same shot as the first.
//
// Loot values scale with the job's take, so a pawnshop till and a museum
// vault feel like different leagues without any per-job special cases.

import { VAULT } from './config.js';

/** Weight in kilos the thief carries per kind of loot. */
const KIND_WEIGHT = { cash: 1, jewels: 1, art: 4, gold: 5, data: 0 };

/** Display names for the loot kinds. */
const KIND_NAME = {
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
const KIND_SHARE = { cash: 0.12, jewels: 0.2, art: 0.24, gold: 0.27, data: 0.1 };

/** Where the gold window sits for each pin, in order — it never repeats a spot. */
const PIN_TARGETS = [0.5, 0.27, 0.73, 0.42];

/** What the vault spills when it opens: kind and share of the job's take. */
const VAULT_STASH = [
  { kind: 'gold', share: 0.22 },
  { kind: 'jewels', share: 0.12 },
  { kind: 'art', share: 0.11 },
];

/** Round a loot value to the nearest ten so the HUD reads cleanly. */
function roundValue(amount) {
  return Math.max(50, Math.round(amount / 10) * 10);
}

/**
 * A fresh vault for `job`. Jobs without a vault get one that is already open
 * with zero pins, so the minigame — and the vault objective — simply vanish.
 * `target` is the centre of the gold window for the pin being worked on.
 */
export function createVault(job) {
  if (!job || !job.vault) {
    return {
      state: 'open', pins: 0, set: 0,
      needle: 0, dir: 1, window: VAULT.window, speed: VAULT.needleSpeed,
      target: 0.5, forgiven: false,
    };
  }
  return {
    state: 'locked',
    pins: VAULT.pins,
    set: 0,
    needle: 0,
    dir: 1,
    window: VAULT.window,
    speed: VAULT.needleSpeed,
    target: PIN_TARGETS[0],
    forgiven: false,
  };
}

/**
 * Start cracking: locked becomes cracking and the needle starts at the
 * bottom of the dial. Main.js only calls this beside the vault, so no
 * distance check lives here.
 */
export function startCrack(state) {
  const vault = state.vault;
  if (!vault || vault.state !== 'locked') return;
  vault.state = 'cracking';
  vault.needle = 0;
  vault.dir = 1;
  vault.target = PIN_TARGETS[0];
}

/**
 * Sweep the needle back and forth across the dial while cracking. With the
 * silent drill fitted the needle runs slower and the gold window runs
 * wider — the tool's whole benefit, applied here and nowhere else.
 */
export function stepVault(state, dt) {
  const vault = state.vault;
  if (!vault || vault.state !== 'cracking') return;
  vault.speed = state.tools?.drill ? VAULT.drillNeedle : VAULT.needleSpeed;
  vault.window = state.tools?.drill ? VAULT.drillWindow : VAULT.window;
  vault.needle += vault.dir * vault.speed * dt;
  if (vault.needle >= 1) {
    vault.needle = 1;
    vault.dir = -1;
  } else if (vault.needle <= 0) {
    vault.needle = 0;
    vault.dir = 1;
  }
}

/**
 * The player pressed E while cracking. Inside the gold window the pin locks
 * and the window jumps to its next spot; on the last pin the vault opens
 * and its stash spills onto the floor as fresh loot. Outside the window the
 * pin slips: the alarm climbs, unless the lockpick set is there to swallow
 * one mistake — it only swallows one per vault.
 *
 * Returns 'hit', 'miss', 'open', or null when the vault is not cracking.
 */
export function vaultPin(state) {
  const vault = state.vault;
  if (!vault || vault.state !== 'cracking') return null;
  const inside = Math.abs(vault.needle - vault.target) <= vault.window / 2;
  if (!inside) {
    if (state.tools?.lockpick && !vault.forgiven) {
      vault.forgiven = true;
    } else {
      state.alarm = Math.min(100, state.alarm + VAULT.missAlarm);
    }
    return 'miss';
  }
  vault.set += 1;
  if (vault.set >= vault.pins) {
    vault.state = 'open';
    spillVaultStash(state);
    return 'open';
  }
  vault.target = PIN_TARGETS[vault.set % PIN_TARGETS.length];
  return 'hit';
}

/**
 * Drop the vault's stash on the floor beside the vault door, as loot items
 * the player still has to walk over and pick up. Nothing is banked for
 * free — opening the vault is only half the job.
 */
function spillVaultStash(state) {
  const job = state.mission;
  const spot = state.room?.vaultSpot;
  if (!job || !spot || !state.loot) return;
  const baseId = state.loot.length;
  VAULT_STASH.forEach((piece, i) => {
    const spread = [-46, 0, 46][i] ?? 0;
    state.loot.push({
      id: baseId + i,
      x: spot.x + spread,
      y: spot.y + 58,
      kind: piece.kind,
      name: KIND_NAME[piece.kind],
      value: roundValue(job.take * piece.share),
      weight: KIND_WEIGHT[piece.kind] ?? 1,
      taken: false,
    });
  });
}

/**
 * One loot item per loot spot in the room, values scaled to the job's take
 * with a little seeded jitter so no two runs price a room identically.
 * A room with no spots simply has nothing lying around.
 */
export function createLoot(rng, room, job) {
  const spots = room?.lootSpots ?? [];
  const take = job?.take ?? 0;
  return spots.map((spot, i) => {
    const kind = spot.kind ?? 'cash';
    const jitter = rng ? rng.range(0.85, 1.15) : 1;
    return {
      id: i,
      x: spot.x,
      y: spot.y,
      kind,
      name: KIND_NAME[kind] ?? kind,
      value: roundValue(take * (KIND_SHARE[kind] ?? 0.1) * jitter),
      weight: KIND_WEIGHT[kind] ?? 1,
      taken: false,
    };
  });
}

/** Total value of what the thief is carrying right now. */
export function lootValue(state) {
  if (!state.player) return 0;
  return state.player.carrying.reduce((sum, item) => sum + (item.value ?? 0), 0);
}

/** Total weight of what the thief is carrying right now. */
export function lootWeight(state) {
  if (!state.player) return 0;
  return state.player.carrying.reduce((sum, item) => sum + (item.weight ?? 0), 0);
}
