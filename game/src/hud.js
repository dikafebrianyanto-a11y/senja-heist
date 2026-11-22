// Senja Heist — every overlay the player ever reads, painted on canvas.
//
// The renderer owns the world (rooms, streets, the crew moving through
// them). This file owns everything laid on top: the alarm gauge, the cash
// readouts, the job checklist, the crew dots, the minimap, and the five
// full-screen boards (title, planning, pause, busted, payout) plus the
// little toast banner at the bottom.
//
// Look and feel: a night-city board — deep indigo cards edged in slate,
// gold for money, red for the alarm, teal for the crew. All coordinates
// are in the 1280x720 logical view; each public painter resets the
// transform first, because the renderer leaves its camera behind.

import { ALARM, DIFFICULTY, FONT, PALETTE, VIEW } from './config.js';
import { crewLevel } from './crew.js';
import { JOBS } from './missions.js';

/** Alarm tint per stage, from quiet green to lockdown red. */
const ALARM_TINTS = {
  calm: PALETTE.safe,
  suspicious: PALETTE.accent,
  hunted: '#ff7a4d',
  lockdown: PALETTE.danger,
};

/** How many heat stars the top bar can show. */
const HEAT_STARS = 5;

/** Minimap footprint and its margin from the corner. */
const MAP_BOX = { w: 232, h: 158, gap: 16 };

/** Dot colour per crew status, so readiness reads at a glance. */
const MEMBER_TINTS = {
  ready: PALETTE.safe,
  following: PALETTE.thief,
  waiting: PALETTE.accent,
  hacking: '#b48cff',
  down: PALETTE.danger,
};

/** XP that buys one crew level; the bar fills toward this each level. */
const XP_PER_LEVEL = 100;

/** Planning-board geometry: card width and the row heights. */
const BOARD = { w: 900, h: 648, jobRow: 42, toolRow: 34 };

/**
 * Difficulty cards when config.js has not supplied its own table yet.
 * Each entry carries its key, display label, payout multiplier and the
 * one-line effect note shown under the label.
 */
const FALLBACK_DIFFICULTIES = [
  { key: 'easy', label: 'Easy', mult: 0.85, note: 'Fewer guards, slower alarm' },
  { key: 'normal', label: 'Normal', mult: 1, note: 'The crew as planned' },
  { key: 'hard', label: 'Hard', mult: 1.25, note: 'More guards, faster alarm' },
];

/** Font strings, cached per size/weight so we stop rebuilding them. */
const typefaces = new Map();

/** A cached font string for the given size, bold when asked. */
function typeface(size, heavy) {
  const cacheKey = `${heavy ? 'b' : ''}${size}`;
  if (!typefaces.has(cacheKey)) {
    typefaces.set(cacheKey, `${heavy ? '700 ' : ''}${size}px ${FONT}`);
  }
  return typefaces.get(cacheKey);
}

/**
 * Restore the letterboxed 1280x720 transform from the canvas backing
 * size. Every public painter calls this first; without it the panels
 * would inherit the renderer's camera and land in the wrong place.
 */
function resetTransform(ctx) {
  const backing = ctx.canvas;
  const scale = Math.min(backing.width / VIEW.width, backing.height / VIEW.height);
  const offX = (backing.width - VIEW.width * scale) / 2;
  const offY = (backing.height - VIEW.height * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, offX, offY);
}

/** One line of text: size, colour, alignment, optional bold. */
function label(ctx, str, x, y, size, color, align, heavy) {
  ctx.font = typeface(size, heavy);
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(str, x, y);
}

/** Cash with a thousands separator, e.g. 18500 becomes "$18,500". */
function fmtCash(amount) {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** A dark card with a thin slate edge. */
function card(ctx, x, y, w, h) {
  ctx.fillStyle = PALETTE.panel;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** A card centred on screen, sized for a full-screen message. */
function centredCard(ctx, w, h) {
  const left = (VIEW.width - w) / 2;
  const top = (VIEW.height - h) / 2;
  card(ctx, left, top, w, h);
  return { left, top };
}

/** Which alarm stage the meter is in, for tints and labels. */
function alarmStage(state) {
  if (state.lockdown || state.alarm >= ALARM.lockdownAt) return 'lockdown';
  if (state.alarm >= 75) return 'hunted';
  if (state.alarm >= ALARM.suspectAt) return 'suspicious';
  return 'calm';
}

/** Total value of the loot Mara is carrying right now. */
function lootCarried(state) {
  const stash = state.player && Array.isArray(state.player.carrying)
    ? state.player.carrying
    : [];
  let sum = 0;
  for (const piece of stash) sum += piece.value || 0;
  return sum;
}

/** The crew array, or an empty list when the state has none yet. */
function crewMembers(state) {
  return Array.isArray(state.crew) ? state.crew : [];
}

/**
 * The difficulty table, in display order. Prefers the DIFFICULTY table
 * from config.js (object keyed by id, or an array of entries) and falls
 * back to the local table above when it is missing or unusable, so the
 * planning board still draws before the config worker lands.
 */
function difficultyEntries() {
  const source = typeof DIFFICULTY !== 'undefined' ? DIFFICULTY : null;
  if (Array.isArray(source) && source.length > 0) {
    return source.map((entry) => ({
      key: entry.key ?? entry.id,
      label: entry.label ?? entry.name ?? String(entry.key ?? entry.id),
      mult: entry.mult ?? entry.multiplier ?? entry.payoutMul ?? entry.payout ?? 1,
      note: entry.note ?? entry.desc ?? entry.effect ?? '',
    }));
  }
  if (source && typeof source === 'object') {
    const keys = Object.keys(source);
    if (keys.length > 0) {
      return keys.map((key) => {
        const entry = source[key] || {};
        return {
          key,
          label: entry.label ?? entry.name ?? key,
          mult: entry.mult ?? entry.multiplier ?? entry.payoutMul ?? entry.payout ?? 1,
          note: entry.note ?? entry.desc ?? entry.effect ?? '',
        };
      });
    }
  }
  return FALLBACK_DIFFICULTIES;
}

/** The difficulty the player picked on the board, defaulting to normal. */
function activeDifficulty(state) {
  return state.difficulty ?? 'normal';
}

/** A crew member's level: the crew module's helper when it exists. */
function memberLevel(member) {
  if (typeof crewLevel === 'function') return crewLevel(member);
  return member.level ?? 1;
}

/** A crew member's XP toward the next level. */
function memberXp(member, state) {
  if (typeof member.xp === 'number') return member.xp;
  const byId = state.crewXp && typeof state.crewXp === 'object' ? state.crewXp : {};
  return byId[member.id] ?? 0;
}

/** How many smoke bombs the thief has left, from either home. */
function smokeLeft(state) {
  if (state.player && typeof state.player.smoke === 'number') return state.player.smoke;
  if (state.tools && typeof state.tools.smoke === 'number') return state.tools.smoke;
  return 0;
}

/** A small filled dot on the minimap. */
function mapDot(ctx, toX, toY, px, py, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(toX(px), toY(py), radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * The live HUD during a heist or a getaway. Top bar: alarm gauge with
 * its stage colour, loot carried, banked cash, the difficulty tag, heat
 * stars. Down the left edge: objectives, tools (with EMP and smoke
 * charges), crew status dots. While a vault crack is running a needle
 * dial appears under the bar; in lockdown a flashing strip warns the
 * player.
 */
export function drawHud(ctx, state) {
  resetTransform(ctx);
  const stage = alarmStage(state);
  const stageTint = ALARM_TINTS[stage];
  const escaping = state.screen === 'getaway';

  // Top bar, dark and translucent so the room shows through.
  ctx.fillStyle = 'rgba(7,8,26,0.82)';
  ctx.fillRect(0, 0, VIEW.width, 64);
  ctx.fillStyle = PALETTE.panelEdge;
  ctx.fillRect(0, 64, VIEW.width, 2);

  // Alarm gauge with the suspicion tick on it.
  label(ctx, 'ALARM', 20, 26, 13, PALETTE.muted, 'left', true);
  const gaugeX = 20;
  const gaugeY = 34;
  const gaugeW = 260;
  const gaugeH = 14;
  ctx.fillStyle = '#0a0c20';
  ctx.fillRect(gaugeX, gaugeY, gaugeW, gaugeH);
  const gaugeFill = Math.max(0, Math.min(1, state.alarm / 100));
  ctx.fillStyle = stageTint;
  ctx.fillRect(gaugeX, gaugeY, gaugeW * gaugeFill, gaugeH);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(gaugeX + 0.5, gaugeY + 0.5, gaugeW, gaugeH);
  // The tick where a ghost sighting turns into a real alarm.
  const tickX = gaugeX + (ALARM.suspectAt / 100) * gaugeW;
  ctx.strokeStyle = PALETTE.text;
  ctx.beginPath();
  ctx.moveTo(tickX, gaugeY - 3);
  ctx.lineTo(tickX, gaugeY + gaugeH + 3);
  ctx.stroke();
  const stageWord = stage === 'lockdown' ? 'LOCKDOWN' : stage.toUpperCase();
  label(ctx, stageWord, gaugeX + gaugeW + 12, gaugeY + 12, 14, stageTint, 'left', true);

  // Money: what Mara carries, and what the crew already banked.
  const haul = lootCarried(state);
  label(ctx, 'LOOT', 430, 26, 13, PALETTE.muted, 'left', true);
  label(ctx, fmtCash(haul), 430, 50, 22, PALETTE.loot, 'left', true);
  label(ctx, 'BANK', 570, 26, 13, PALETTE.muted, 'left', true);
  label(ctx, fmtCash(state.cash), 570, 50, 22, PALETTE.text, 'left', true);

  // Difficulty tag: a small pill naming the run's difficulty. It sits
  // between the bank readout and the heat stars, and reads from the
  // same difficulty table the planning board draws, so the two agree.
  const diffs = difficultyEntries();
  const picked = diffs.find((d) => d.key === activeDifficulty(state)) || diffs[1] || diffs[0];
  const tagWord = (picked ? picked.label : 'Normal').toUpperCase();
  ctx.font = typeface(12, true);
  const tagW = ctx.measureText(tagWord).width + 24;
  const tagX = 700;
  ctx.fillStyle = '#232744';
  ctx.fillRect(tagX, 22, tagW, 22);
  ctx.strokeStyle = PALETTE.accent;
  ctx.lineWidth = 1;
  ctx.strokeRect(tagX + 0.5, 22.5, tagW - 1, 21);
  label(ctx, tagWord, tagX + 12, 38, 12, PALETTE.accent, 'left', true);

  // Heat stars, top right: filled up to the current heat.
  label(ctx, 'HEAT', VIEW.width - 210, 26, 13, PALETTE.muted, 'left', true);
  for (let i = 0; i < HEAT_STARS; i += 1) {
    const starX = VIEW.width - 196 + i * 34;
    const starY = 44;
    ctx.fillStyle = i < state.heat ? PALETTE.policeLight : '#262b4a';
    ctx.beginPath();
    ctx.arc(starX, starY, 11, 0, Math.PI * 2);
    ctx.fill();
    label(ctx, '★', starX, starY + 5, 15, i < state.heat ? '#ffffff' : PALETTE.muted, 'center', true);
  }

  // Objectives down the left edge; in a getaway the list swaps to the run.
  const jobs = Array.isArray(state.objectives) ? state.objectives : [];
  let lineY = 100;
  label(ctx, escaping ? 'GETAWAY' : 'OBJECTIVES', 20, lineY, 13, PALETTE.muted, 'left', true);
  lineY += 24;
  for (const job of jobs) {
    const tick = job.done ? '✓' : '○';
    const tint = job.done ? PALETTE.safe : PALETTE.text;
    label(ctx, tick, 20, lineY, 16, tint, 'left', true);
    label(ctx, job.text, 44, lineY, 16, tint, 'left');
    lineY += 26;
  }
  if (escaping) {
    label(ctx, '○', 20, lineY, 16, PALETTE.text, 'left', true);
    label(ctx, 'Reach the safehouse', 44, lineY, 16, PALETTE.text, 'left');
    lineY += 26;
  }

  // Tools line: owned kit as tags, EMP as a charge count. The tools
  // object is missing on screens that never enter a heist, so read it
  // through a fallback and let the line fall back to the shop hint.
  const tools = state.tools || {};
  lineY += 14;
  label(ctx, 'TOOLS', 20, lineY, 13, PALETTE.muted, 'left', true);
  lineY += 24;
  const kit = [];
  if (tools.lockpick) kit.push('Lockpick');
  if (tools.disguise) kit.push('Disguise');
  if (tools.drill) kit.push('Drill');
  if (tools.emp > 0) kit.push(`EMP ×${tools.emp}`);
  label(
    ctx,
    kit.length > 0 ? kit.join('  ·  ') : 'None — buy gear on the planning board',
    20, lineY, 15, PALETTE.text, 'left',
  );

  // Smoke pips: one small circle per smoke bomb left, beside the kit.
  // The count lives on the player when the crew module tracks it, and
  // falls back to the tools bag; zero shows a dash instead of pips.
  const smokes = smokeLeft(state);
  const smokeX = 20;
  const smokeY = lineY + 22;
  label(ctx, 'SMOKE', smokeX, smokeY, 13, PALETTE.muted, 'left', true);
  const pipsStart = smokeX + 62;
  for (let i = 0; i < Math.max(smokes, 0); i += 1) {
    ctx.fillStyle = PALETTE.thief;
    ctx.beginPath();
    ctx.arc(pipsStart + i * 18, smokeY - 4, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (smokes <= 0) {
    label(ctx, '—', pipsStart, smokeY, 13, PALETTE.muted, 'left');
  }

  // Crew status dots along the bottom left.
  const members = crewMembers(state);
  let dotY = VIEW.height - 24;
  for (const member of members) {
    const tint = MEMBER_TINTS[member.status] || PALETTE.muted;
    ctx.fillStyle = member.color || tint;
    ctx.beginPath();
    ctx.arc(28, dotY - 5, 7, 0, Math.PI * 2);
    ctx.fill();
    label(ctx, `${member.name} — ${member.status}`, 42, dotY, 14, tint, 'left');
    dotY -= 24;
  }

  // Vault crack dial, while the needle is sweeping for its window.
  if (state.vault && state.vault.state === 'cracking') {
    const centreX = VIEW.width / 2;
    const dialY = 108;
    const dialW = 320;
    card(ctx, centreX - dialW / 2 - 16, dialY - 30, dialW + 32, 76);
    label(ctx, 'VAULT — press E in the gold window', centreX, dialY - 8, 14, PALETTE.text, 'center', true);
    ctx.fillStyle = '#0a0c20';
    ctx.fillRect(centreX - dialW / 2, dialY + 4, dialW, 12);
    const goldW = dialW * (state.vault.window || 0.17);
    const goldX = centreX - dialW / 2 + dialW * 0.5 - goldW / 2;
    ctx.fillStyle = PALETTE.loot;
    ctx.fillRect(goldX, dialY + 4, goldW, 12);
    const needleX = centreX - dialW / 2 + dialW * (state.vault.needle || 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(needleX - 2, dialY, 4, 20);
    const pinsTotal = state.vault.pins || 0;
    const pinsSet = state.vault.set || 0;
    label(ctx, `Pins ${pinsSet}/${pinsTotal}`, centreX, dialY + 40, 13, PALETTE.muted, 'center');
  }

  // Lockdown strip: flashing red while the police are on their way.
  if (state.lockdown) {
    const on = Math.floor(state.time * 4) % 2 === 0;
    if (on) {
      ctx.fillStyle = 'rgba(255,77,109,0.9)';
      ctx.fillRect(0, 70, VIEW.width, 26);
      label(ctx, `LOCKDOWN — police incoming, ${Math.ceil(state.lockdownTimer)}s`, VIEW.width / 2, 88, 14, '#ffffff', 'center', true);
    }
  }
}

/**
 * The minimap, bottom right. Inside a job it shows the floor: walls as
 * dark blocks, cover as blue blocks, guards red, cameras amber, loose
 * loot gold, the exit green, the vault gold, Mara teal. In a getaway it
 * shows the city instead: roads as grey lines, the safehouse green,
 * police blue, the car teal.
 */
export function drawMinimap(ctx, state) {
  resetTransform(ctx);
  const left = VIEW.width - MAP_BOX.w - MAP_BOX.gap;
  const top = VIEW.height - MAP_BOX.h - MAP_BOX.gap;
  card(ctx, left, top, MAP_BOX.w, MAP_BOX.h);
  label(ctx, state.screen === 'getaway' ? 'KOTA SENJA' : 'FLOOR PLAN', left + 10, top + 18, 11, PALETTE.muted, 'left', true);

  const innerX = left + 8;
  const innerY = top + 26;
  const innerW = MAP_BOX.w - 16;
  const innerH = MAP_BOX.h - 34;

  if (state.screen === 'getaway' && state.city) {
    drawCityMap(ctx, state, innerX, innerY, innerW, innerH);
    return;
  }
  const room = state.room;
  if (!room) return;
  drawRoomMap(ctx, state, room, innerX, innerY, innerW, innerH);
}

/** The city half of the minimap: roads, safehouse, police, the car. */
function drawCityMap(ctx, state, innerX, innerY, innerW, innerH) {
  const city = state.city;
  const scale = Math.min(innerW / city.w, innerH / city.h);
  const originX = innerX + (innerW - city.w * scale) / 2;
  const originY = innerY + (innerH - city.h * scale) / 2;
  const toX = (wx) => originX + wx * scale;
  const toY = (wy) => originY + wy * scale;
  ctx.strokeStyle = '#3a3f66';
  ctx.lineWidth = Math.max(1, 3 * scale);
  for (const road of city.roads || []) {
    ctx.beginPath();
    ctx.moveTo(toX(road.x), toY(road.y));
    ctx.lineTo(toX(road.x + road.w), toY(road.y + road.h));
    ctx.stroke();
  }
  const house = city.safehouse;
  if (house) {
    ctx.fillStyle = PALETTE.safe;
    ctx.fillRect(toX(house.x) - 4, toY(house.y) - 4, 8, 8);
  }
  for (const unit of (state.police && state.police.units) || []) {
    mapDot(ctx, toX, toY, unit.x, unit.y, 3, PALETTE.police);
  }
  const ride = state.car;
  if (ride) {
    mapDot(ctx, toX, toY, ride.x, ride.y, 4, PALETTE.thief);
  } else if (state.player) {
    mapDot(ctx, toX, toY, state.player.x, state.player.y, 4, PALETTE.thief);
  }
}

/** The floor half of the minimap: walls, cover, loot, cameras, guards. */
function drawRoomMap(ctx, state, room, innerX, innerY, innerW, innerH) {
  const scale = Math.min(innerW / room.w, innerH / room.h);
  const originX = innerX + (innerW - room.w * scale) / 2;
  const originY = innerY + (innerH - room.h * scale) / 2;
  const toX = (wx) => originX + wx * scale;
  const toY = (wy) => originY + wy * scale;

  ctx.fillStyle = '#0d0f24';
  ctx.fillRect(innerX, innerY, innerW, innerH);
  for (const wall of room.walls || []) {
    ctx.fillStyle = PALETTE.wall;
    ctx.fillRect(toX(wall.x), toY(wall.y), Math.max(1, wall.w * scale), Math.max(1, wall.h * scale));
  }
  for (const nook of room.cover || []) {
    ctx.fillStyle = PALETTE.cover;
    ctx.fillRect(toX(nook.x), toY(nook.y), Math.max(1, nook.w * scale), Math.max(1, nook.h * scale));
  }
  const exit = room.exit;
  if (exit) {
    ctx.fillStyle = PALETTE.safe;
    ctx.fillRect(toX(exit.x) - 4, toY(exit.y) - 4, 8, 8);
  }
  for (const piece of state.loot || []) {
    if (piece.taken) continue;
    mapDot(ctx, toX, toY, piece.x, piece.y, 3, PALETTE.loot);
  }
  if (room.vaultSpot) {
    ctx.fillStyle = PALETTE.loot;
    ctx.fillRect(toX(room.vaultSpot.x) - 3, toY(room.vaultSpot.y) - 3, 6, 6);
  }
  for (const cam of state.cameras || []) {
    mapDot(ctx, toX, toY, cam.x, cam.y, 3, cam.disabled ? PALETTE.muted : PALETTE.camera);
  }
  for (const guard of state.guards || []) {
    mapDot(ctx, toX, toY, guard.x, guard.y, 3.5, guard.mode === 'chase' ? '#ffffff' : PALETTE.guard);
  }
  if (state.player) {
    mapDot(ctx, toX, toY, state.player.x, state.player.y, 4, PALETTE.thief);
  }
}

/** The title screen: name, crew, best take, the controls, press Space. */
export function drawTitle(ctx, state) {
  resetTransform(ctx);
  const { top } = centredCard(ctx, 640, 460);
  label(ctx, 'SENJA HEIST', VIEW.width / 2, top + 92, 56, PALETTE.loot, 'center', true);
  label(ctx, 'A night-crew heist in Kota Senja', VIEW.width / 2, top + 126, 20, PALETTE.text, 'center');
  label(ctx, 'Mara Voss  ·  Iko Tan  ·  Reno Kartika  ·  Sable Wren', VIEW.width / 2, top + 168, 16, PALETTE.muted, 'center');
  label(ctx, 'Five jobs. One crew. The museum is waiting.', VIEW.width / 2, top + 200, 16, PALETTE.text, 'center');

  const keys = [
    'WASD / arrows — move    C — crouch    Shift — sprint',
    'E — grab loot / crack vault / exit    Q — EMP pulse',
    'F — punch    Click — silenced shot    P — pause    M — mute',
  ];
  let keyY = top + 252;
  for (const line of keys) {
    label(ctx, line, VIEW.width / 2, keyY, 15, PALETTE.muted, 'center');
    keyY += 26;
  }
  if (state.bestCash > 0) {
    label(ctx, `Best banked: ${fmtCash(state.bestCash)}`, VIEW.width / 2, keyY + 8, 16, PALETTE.loot, 'center', true);
  }
  const blink = Math.floor(state.time * 2) % 2 === 0;
  if (blink) label(ctx, 'Press Space to start', VIEW.width / 2, top + 460 - 52, 20, PALETTE.accent, 'center', true);
}

/**
 * One crew member's XP row on the planning board: name and role on the
 * left, level in the middle, and a thin bar filling toward the next
 * level with the raw XP beside it. XP comes from the member itself when
 * the crew module tracks it, or from state.crewXp keyed by member id;
 * the bar wraps at 100 XP, so a member at 145 XP shows 45/100 at Lv 2
 * (or whatever level crewLevel reports for them).
 */
function drawCrewXpRow(ctx, member, state, x, y, w) {
  const level = memberLevel(member);
  const xp = memberXp(member, state);
  const intoLevel = ((xp % XP_PER_LEVEL) + XP_PER_LEVEL) % XP_PER_LEVEL;
  const barX = x + w - 220;
  const barW = 140;
  const barY = y - 8;
  label(ctx, `${member.name} — ${member.role}`, x, y, 13, PALETTE.text, 'left');
  label(ctx, `Lv ${level}`, barX - 12, y, 13, PALETTE.accent, 'right', true);
  ctx.fillStyle = '#0a0c20';
  ctx.fillRect(barX, barY, barW, 8);
  ctx.fillStyle = PALETTE.thief;
  ctx.fillRect(barX, barY, barW * (intoLevel / XP_PER_LEVEL), 8);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, 7);
  label(ctx, `${intoLevel}/${XP_PER_LEVEL} XP`, barX + barW + 8, y, 12, PALETTE.muted, 'left');
}

/**
 * The difficulty selector: three cards in a row, one per difficulty.
 * The card matching state.difficulty gets the gold edge and a filled
 * background; the others stay flat. Each card shows its label, its
 * payout multiplier and its one-line effect note. Input is main.js's
 * job — this only draws the current pick.
 */
function drawDifficultyStrip(ctx, state, x, y, w) {
  label(ctx, 'DIFFICULTY', x, y, 13, PALETTE.muted, 'left', true);
  const entries = difficultyEntries();
  const pickedKey = activeDifficulty(state);
  const cardW = (w - 2 * 12) / 3;
  const cardH = 44;
  const cardY = y + 8;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const cardX = x + i * (cardW + 12);
    const picked = entry.key === pickedKey;
    ctx.fillStyle = picked ? '#232744' : '#0d0f24';
    ctx.fillRect(cardX, cardY, cardW, cardH);
    ctx.strokeStyle = picked ? PALETTE.loot : PALETTE.panelEdge;
    ctx.lineWidth = picked ? 2 : 1;
    ctx.strokeRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2);
    const multWord = entry.mult === 1 ? '1.00x payout' : `${entry.mult.toFixed(2)}x payout`;
    label(ctx, `${picked ? '▶ ' : ''}${entry.label}  ·  ${multWord}`, cardX + 12, cardY + 19, 14, picked ? PALETTE.text : PALETTE.muted, 'left', picked);
    if (entry.note) label(ctx, entry.note, cardX + 12, cardY + 36, 12, PALETTE.muted, 'left');
  }
  return cardY + cardH;
}

/** One job row: name, target and guard/camera detail, take or state. */
function drawJobRow(ctx, row, index, x, y, w, selected) {
  const job = row.job;
  if (selected) {
    ctx.fillStyle = '#232744';
    ctx.fillRect(x, y - 4, w, BOARD.jobRow - 6);
    ctx.strokeStyle = PALETTE.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y - 3.5, w - 1, BOARD.jobRow - 7);
  }
  const marker = selected ? '▶' : ' ';
  const stateWord = row.done ? 'DONE' : row.unlocked ? fmtCash(job.take) : 'LOCKED';
  const stateTint = row.done ? PALETTE.safe : row.unlocked ? PALETTE.loot : PALETTE.muted;
  const nameTint = row.unlocked ? PALETTE.text : PALETTE.muted;
  label(ctx, `${marker} ${index + 1}. ${job.name}`, x + 20, y + 20, 17, nameTint, 'left', selected);
  label(ctx, `${job.target} — ${job.guards} guards, ${job.cameras} cameras${job.vault ? ', vault' : ''}`, x + 20, y + 38, 12, PALETTE.muted, 'left');
  label(ctx, stateWord, x + w - 20, y + 20, 17, stateTint, 'right', true);
}

/**
 * One shop row, drawn from whatever main.js passes in: name, price,
 * description, owned flag, and a charge count for charge tools. A tool
 * the crew owns reads green OWNED; a charge tool shows its charges
 * (e.g. "EMP ×3") and stays buyable; a tool the crew cannot afford
 * reads dimmed.
 */
function drawToolRow(ctx, row, x, y, w, selected, cash) {
  if (selected) {
    ctx.fillStyle = '#232744';
    ctx.fillRect(x, y - 4, w, BOARD.toolRow - 6);
    ctx.strokeStyle = PALETTE.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y - 3.5, w - 1, BOARD.toolRow - 7);
  }
  const marker = selected ? '▶' : ' ';
  const hasCharges = typeof row.charges === 'number';
  const chargesWord = hasCharges ? ` ×${row.charges}` : '';
  // A charge tool with no charges left is just another item for sale,
  // so it shows its price; one with charges left shows the top-up price.
  const nameWord = `${marker} ${row.name}${chargesWord}`;
  const canAfford = typeof cash === 'number' ? cash >= row.cost : true;
  let priceWord;
  let priceTint;
  if (row.owned && !hasCharges) {
    priceWord = 'OWNED';
    priceTint = PALETTE.safe;
  } else if (row.owned && hasCharges) {
    // Charge tools stay on sale so the crew can top up.
    priceWord = `${fmtCash(row.cost)} — top up`;
    priceTint = canAfford ? PALETTE.loot : PALETTE.muted;
  } else {
    priceWord = fmtCash(row.cost);
    priceTint = canAfford ? PALETTE.loot : PALETTE.muted;
  }
  const nameTint = row.owned && !hasCharges ? PALETTE.muted : PALETTE.text;
  label(ctx, nameWord, x + 20, y + 20, 16, nameTint, 'left', selected);
  if (row.desc) label(ctx, row.desc, x + 20, y + 36, 11, PALETTE.muted, 'left');
  label(ctx, priceWord, x + w - 20, y + 20, 16, priceTint, 'right', true);
}

/**
 * The planning board. `rows` arrives from main.js — job rows first,
 * then tool rows, in cursor order — and each row is drawn under the
 * cursor in state.plan.cursor. Above the rows sit the crew XP bars and
 * the difficulty selector; cash and jobs-done sit at the top.
 */
export function drawPlan(ctx, state, rows) {
  resetTransform(ctx);
  const list = Array.isArray(rows) ? rows : [];
  const { left, top } = centredCard(ctx, BOARD.w, BOARD.h);
  const innerX = left + 24;
  const innerW = BOARD.w - 48;
  label(ctx, 'PLANNING BOARD', VIEW.width / 2, top + 48, 30, PALETTE.loot, 'center', true);
  label(ctx, `Cash ${fmtCash(state.cash)}   ·   Jobs done ${state.jobsDone} / ${JOBS.length}`, VIEW.width / 2, top + 76, 16, PALETTE.text, 'center');

  // Crew XP: one compact row per member, level plus a bar to next level.
  const members = crewMembers(state);
  let cursorY = top + 104;
  if (members.length > 0) {
    label(ctx, 'CREW — XP', innerX, cursorY, 13, PALETTE.muted, 'left', true);
    cursorY += 20;
    for (const member of members) {
      drawCrewXpRow(ctx, member, state, innerX, cursorY, innerW);
      cursorY += 20;
    }
    cursorY += 6;
  }

  // Difficulty selector, drawn from state.difficulty.
  cursorY = drawDifficultyStrip(ctx, state, innerX, cursorY, innerW) + 14;

  // Jobs and shop, in the order main.js handed them over.
  const cursor = state.plan ? state.plan.cursor : 0;
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const picked = i === cursor;
    if (row.kind === 'job') {
      drawJobRow(ctx, row, i, innerX, cursorY, innerW, picked);
      cursorY += BOARD.jobRow;
    } else {
      drawToolRow(ctx, row, innerX, cursorY, innerW, picked, state.cash);
      cursorY += BOARD.toolRow;
    }
  }

  const footerY = top + BOARD.h - 20;
  label(ctx, 'Up/Down pick a row  ·  Enter start or buy  ·  B buy the highlighted tool  ·  1–5 pick a job', VIEW.width / 2, footerY, 14, PALETTE.muted, 'center');
}

/** The pause overlay: where the crew stopped, and how to get back in. */
export function drawPause(ctx, state) {
  resetTransform(ctx);
  const { top } = centredCard(ctx, 520, 300);
  label(ctx, 'PAUSED', VIEW.width / 2, top + 96, 44, PALETTE.text, 'center', true);
  const held = state.screenBeforePause === 'getaway' ? 'The getaway is waiting.' : 'The crew is holding position.';
  label(ctx, held, VIEW.width / 2, top + 140, 17, PALETTE.muted, 'center');
  if (state.mission) {
    label(ctx, `${state.mission.name} — ${state.mission.target}`, VIEW.width / 2, top + 172, 16, PALETTE.text, 'center');
  }
  label(ctx, 'Press P or Space to resume', VIEW.width / 2, top + 300 - 52, 18, PALETTE.accent, 'center', true);
}

/** The busted screen: why the crew got caught, and what they kept. */
export function drawBusted(ctx, state) {
  resetTransform(ctx);
  const { top } = centredCard(ctx, 560, 320);
  label(ctx, 'BUSTED', VIEW.width / 2, top + 92, 48, PALETTE.danger, 'center', true);
  label(ctx, state.bustReason || 'The crew got caught.', VIEW.width / 2, top + 136, 18, PALETTE.text, 'center');
  label(ctx, `Banked cash kept: ${fmtCash(state.cash)}`, VIEW.width / 2, top + 176, 17, PALETTE.loot, 'center', true);
  label(ctx, 'Carried loot is lost. The job is still on the board.', VIEW.width / 2, top + 206, 15, PALETTE.muted, 'center');
  const blink = Math.floor(state.time * 2) % 2 === 0;
  if (blink) label(ctx, 'Press Space to plan again', VIEW.width / 2, top + 320 - 52, 18, PALETTE.accent, 'center', true);
}

/**
 * The payout screen: loot, speed and ghost bonuses, the total, the new
 * bank balance, campaign progress — or the campaign-complete line once
 * the museum job is done.
 */
export function drawPayout(ctx, state) {
  resetTransform(ctx);
  const payout = state.payout || { loot: 0, bonus: 0, timeBonus: 0, ghostBonus: 0, total: 0 };
  const { top } = centredCard(ctx, 600, 440);
  label(ctx, 'SCORE BANKED', VIEW.width / 2, top + 84, 40, PALETTE.loot, 'center', true);
  if (state.mission) {
    label(ctx, `${state.mission.name} — ${state.mission.target}`, VIEW.width / 2, top + 118, 17, PALETTE.text, 'center');
  }
  const breakdown = [
    ['Loot carried out', fmtCash(payout.loot)],
    ['Speed bonus', payout.timeBonus > 0 ? `+${fmtCash(payout.timeBonus)}` : fmtCash(0)],
    ['Ghost bonus', payout.ghostBonus > 0 ? `+${fmtCash(payout.ghostBonus)}` : fmtCash(0)],
  ];
  let rowY = top + 168;
  for (const [word, amount] of breakdown) {
    label(ctx, word, VIEW.width / 2 - 180, rowY, 17, PALETTE.muted, 'left');
    label(ctx, amount, VIEW.width / 2 + 180, rowY, 17, PALETTE.text, 'right', true);
    rowY += 34;
  }
  ctx.fillStyle = PALETTE.panelEdge;
  ctx.fillRect(VIEW.width / 2 - 180, rowY - 6, 360, 1);
  rowY += 30;
  label(ctx, 'Total', VIEW.width / 2 - 180, rowY, 20, PALETTE.text, 'left', true);
  label(ctx, fmtCash(payout.total), VIEW.width / 2 + 180, rowY, 20, PALETTE.loot, 'right', true);
  rowY += 44;
  label(ctx, `Banked cash: ${fmtCash(state.cash)}`, VIEW.width / 2, rowY, 17, PALETTE.text, 'center');
  rowY += 30;
  const finished = state.jobsDone >= 5;
  if (finished) {
    label(ctx, 'CAMPAIGN COMPLETE — the museum is yours, Mara.', VIEW.width / 2, rowY, 17, PALETTE.safe, 'center', true);
  } else {
    label(ctx, `Jobs done: ${state.jobsDone} / ${JOBS.length} — next up, the board has more work.`, VIEW.width / 2, rowY, 16, PALETTE.muted, 'center');
  }
  const blink = Math.floor(state.time * 2) % 2 === 0;
  if (blink) label(ctx, 'Press Space to continue', VIEW.width / 2, top + 440 - 48, 18, PALETTE.accent, 'center', true);
}

/** The toast banner: a short message in a pill at the bottom. */
export function drawBanner(ctx, state) {
  if (!state.banner || state.bannerTimer <= 0) return;
  resetTransform(ctx);
  const message = state.banner;
  ctx.font = typeface(16, true);
  const width = ctx.measureText(message).width + 36;
  const left = (VIEW.width - width) / 2;
  const top = VIEW.height - 84;
  ctx.fillStyle = 'rgba(7,8,26,0.85)';
  ctx.fillRect(left, top, width, 34);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, width - 1, 33);
  label(ctx, message, VIEW.width / 2, top + 22, 16, PALETTE.text, 'center', true);
}
