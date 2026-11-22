// Senja Heist — every panel and the in-game HUD, drawn on the canvas
// main.js hands over. The renderer paints the world; this module paints
// the information on top of it: the alarm meter, the loot, the objectives,
// the minimap, and the title / planning / pause / busted / payout screens.
//
// Night-city styling throughout: dark indigo panels with a thin edge,
// amber and gold for money, red for the alarm, teal for the crew. Every
// draw call works in the 1280x720 logical view — `fitView` rebuilds the
// letterboxed transform from the canvas backing size first, so these
// panels land in the same place whatever the window is.

import { ALARM, FONT, PALETTE, VIEW } from './config.js';

/** Alarm colours by level, calm to lockdown. */
const ALARM_COLORS = {
  calm: PALETTE.safe,
  suspicious: PALETTE.accent,
  hunted: '#ff7a4d',
  lockdown: PALETTE.danger,
};

/** Heat stars: one pip per heat level, five in total. */
const HEAT_PIPS = 5;

/** Minimap size and margin, in logical pixels. */
const MAP = { width: 232, height: 158, margin: 16 };

/** Crew status colours, so a glance says who is ready and who is down. */
const CREW_STATUS_COLORS = {
  ready: PALETTE.safe,
  following: PALETTE.thief,
  waiting: PALETTE.accent,
  hacking: '#b48cff',
  down: PALETTE.danger,
};

const fonts = new Map();

/** Cached font strings: one entry per size, built once. */
function font(size, bold) {
  const key = `${bold ? 'b' : ''}${size}`;
  if (!fonts.has(key)) fonts.set(key, `${bold ? '700 ' : ''}${size}px ${FONT}`);
  return fonts.get(key);
}

/**
 * Reset the transform to the letterboxed 1280x720 logical view, using the
 * canvas's real backing size. Call this at the top of every public draw
 * function — the renderer leaves its own camera transform behind.
 */
function fitView(ctx) {
  const canvas = ctx.canvas;
  const scale = Math.min(canvas.width / VIEW.width, canvas.height / VIEW.height);
  const x = (canvas.width - VIEW.width * scale) / 2;
  const y = (canvas.height - VIEW.height * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, x, y);
}

/** Plain text, one call: size, colour, alignment, baseline. */
function text(ctx, value, x, y, size, color, align, bold) {
  ctx.font = font(size, bold);
  ctx.fillStyle = color;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x, y);
}

/** Dollars with a thousands separator: 18500 → "$18,500". */
function money(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** A dark panel with a thin edge and a slightly lighter title strip. */
function panel(ctx, x, y, w, h) {
  ctx.fillStyle = PALETTE.panel;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
}

/** A centred panel sized for a full screen message. */
function centredPanel(ctx, w, h) {
  const x = (VIEW.width - w) / 2;
  const y = (VIEW.height - h) / 2;
  panel(ctx, x, y, w, h);
  return { x, y };
}

/** The alarm's level name from the meter value, for colours and labels. */
function alarmLevelName(state) {
  if (state.lockdown || state.alarm >= ALARM.lockdownAt) return 'lockdown';
  if (state.alarm >= 75) return 'hunted';
  if (state.alarm >= ALARM.suspectAt) return 'suspicious';
  return 'calm';
}

/** Value of the loot the thief is carrying right now. */
function carriedValue(state) {
  const carrying = state.player && Array.isArray(state.player.carrying)
    ? state.player.carrying
    : [];
  let total = 0;
  for (const item of carrying) total += item.value || 0;
  return total;
}

/** The crew as a list of { name, role, status, color }, safe when null. */
function crewList(state) {
  if (!Array.isArray(state.crew)) return [];
  return state.crew;
}

/**
 * The in-heist / in-getaway HUD. Top bar: alarm meter with its level
 * colour, loot carried, banked cash, heat pips. Left side: the objective
 * list with checkmarks, then the tools and EMP charges, then the crew
 * status dots. During a vault crack a needle dial appears under the bar.
 */
export function drawHud(ctx, state) {
  fitView(ctx);
  const level = alarmLevelName(state);
  const alarmColor = ALARM_COLORS[level];
  const inGetaway = state.screen === 'getaway';

  // Top bar.
  ctx.fillStyle = 'rgba(7,8,26,0.82)';
  ctx.fillRect(0, 0, VIEW.width, 64);
  ctx.fillStyle = PALETTE.panelEdge;
  ctx.fillRect(0, 64, VIEW.width, 2);

  // Alarm meter, always visible during a heist.
  text(ctx, 'ALARM', 20, 26, 13, PALETTE.muted, 'left', true);
  const meterX = 20;
  const meterY = 34;
  const meterW = 260;
  const meterH = 14;
  ctx.fillStyle = '#0a0c20';
  ctx.fillRect(meterX, meterY, meterW, meterH);
  const fill = Math.max(0, Math.min(1, state.alarm / 100));
  ctx.fillStyle = alarmColor;
  ctx.fillRect(meterX, meterY, meterW * fill, meterH);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(meterX + 0.5, meterY + 0.5, meterW, meterH);
  // Suspicion line: the point where ghosts stop being ghosts.
  const suspectX = meterX + (ALARM.suspectAt / 100) * meterW;
  ctx.strokeStyle = PALETTE.text;
  ctx.beginPath();
  ctx.moveTo(suspectX, meterY - 3);
  ctx.lineTo(suspectX, meterY + meterH + 3);
  ctx.stroke();
  const levelLabel = level === 'lockdown' ? 'LOCKDOWN' : level.toUpperCase();
  text(ctx, levelLabel, meterX + meterW + 12, meterY + 12, 14, alarmColor, 'left', true);

  // Loot carried and banked cash, gold for money.
  const loot = carriedValue(state);
  text(ctx, 'LOOT', 430, 26, 13, PALETTE.muted, 'left', true);
  text(ctx, money(loot), 430, 50, 22, PALETTE.loot, 'left', true);
  text(ctx, 'BANK', 570, 26, 13, PALETTE.muted, 'left', true);
  text(ctx, money(state.cash), 570, 50, 22, PALETTE.text, 'left', true);

  // Heat pips, top right — five stars, filled up to the current heat.
  text(ctx, 'HEAT', VIEW.width - 210, 26, 13, PALETTE.muted, 'left', true);
  for (let i = 0; i < HEAT_PIPS; i += 1) {
    const cx = VIEW.width - 196 + i * 34;
    const cy = 44;
    ctx.fillStyle = i < state.heat ? PALETTE.policeLight : '#262b4a';
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, '★', cx, cy + 5, 15, i < state.heat ? '#ffffff' : PALETTE.muted, 'center', true);
  }

  // Objectives, left edge under the bar.
  const objectives = Array.isArray(state.objectives) ? state.objectives : [];
  let oy = 100;
  text(ctx, inGetaway ? 'GETAWAY' : 'OBJECTIVES', 20, oy, 13, PALETTE.muted, 'left', true);
  oy += 24;
  for (const objective of objectives) {
    const mark = objective.done ? '✓' : '○';
    const color = objective.done ? PALETTE.safe : PALETTE.text;
    text(ctx, mark, 20, oy, 16, color, 'left', true);
    text(ctx, objective.text, 44, oy, 16, color, 'left');
    oy += 26;
  }
  if (inGetaway) {
    text(ctx, '○', 20, oy, 16, PALETTE.text, 'left', true);
    text(ctx, 'Reach the safehouse', 44, oy, 16, PALETTE.text, 'left');
  }

  // Tools: lockpick, disguise, drill as owned tags, EMP as a charge count.
  oy += 14;
  text(ctx, 'TOOLS', 20, oy, 13, PALETTE.muted, 'left', true);
  oy += 24;
  const toolBits = [];
  if (state.tools.lockpick) toolBits.push('Lockpick');
  if (state.tools.disguise) toolBits.push('Disguise');
  if (state.tools.drill) toolBits.push('Drill');
  toolBits.push(`EMP ×${state.tools.emp}`);
  text(ctx, toolBits.length > 0 ? toolBits.join('  ·  ') : 'None — buy gear on the planning board', 20, oy, 15, PALETTE.text, 'left');

  // Crew status dots, bottom left.
  const crew = crewList(state);
  let cy = VIEW.height - 24;
  for (const member of crew) {
    const color = CREW_STATUS_COLORS[member.status] || PALETTE.muted;
    ctx.fillStyle = member.color || color;
    ctx.beginPath();
    ctx.arc(28, cy - 5, 7, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, `${member.name} — ${member.status}`, 42, cy, 14, color, 'left');
    cy -= 24;
  }

  // Vault crack dial, while the needle is sweeping.
  if (state.vault && state.vault.state === 'cracking') {
    const dialX = VIEW.width / 2;
    const dialY = 108;
    const dialW = 320;
    panel(ctx, dialX - dialW / 2 - 16, dialY - 30, dialW + 32, 76);
    text(ctx, 'VAULT — press E in the gold window', dialX, dialY - 8, 14, PALETTE.text, 'center', true);
    ctx.fillStyle = '#0a0c20';
    ctx.fillRect(dialX - dialW / 2, dialY + 4, dialW, 12);
    const windowW = dialW * (state.vault.window || 0.17);
    const windowX = dialX - dialW / 2 + dialW * 0.5 - windowW / 2;
    ctx.fillStyle = PALETTE.loot;
    ctx.fillRect(windowX, dialY + 4, windowW, 12);
    const needleX = dialX - dialW / 2 + dialW * (state.vault.needle || 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(needleX - 2, dialY, 4, 20);
    const pins = state.vault.pins || 0;
    const set = state.vault.set || 0;
    text(ctx, `Pins ${set}/${pins}`, dialX, dialY + 40, 13, PALETTE.muted, 'center');
  }

  // Lockdown warning strip.
  if (state.lockdown) {
    const blink = Math.floor(state.time * 4) % 2 === 0;
    if (blink) {
      ctx.fillStyle = 'rgba(255,77,109,0.9)';
      ctx.fillRect(0, 70, VIEW.width, 26);
      text(ctx, `LOCKDOWN — police incoming, ${Math.ceil(state.lockdownTimer)}s`, VIEW.width / 2, 88, 14, '#ffffff', 'center', true);
    }
  }
}

/**
 * The minimap, bottom right. During a heist it shows the room: walls as
 * dark blocks, guards as red dots, cameras as amber dots, loot as gold
 * dots, the exit as a green square and the thief as a teal dot. During a
 * getaway it shows the city: roads as grey lines, the safehouse as a green
 * square, police as blue dots and the player car as a teal dot.
 */
export function drawMinimap(ctx, state) {
  fitView(ctx);
  const x = VIEW.width - MAP.width - MAP.margin;
  const y = VIEW.height - MAP.height - MAP.margin;
  panel(ctx, x, y, MAP.width, MAP.height);
  text(ctx, state.screen === 'getaway' ? 'KOTA SENJA' : 'FLOOR PLAN', x + 10, y + 18, 11, PALETTE.muted, 'left', true);

  const innerX = x + 8;
  const innerY = y + 26;
  const innerW = MAP.width - 16;
  const innerH = MAP.height - 34;

  if (state.screen === 'getaway' && state.city) {
    const city = state.city;
    const scale = Math.min(innerW / city.w, innerH / city.h);
    const ox = innerX + (innerW - city.w * scale) / 2;
    const oy = innerY + (innerH - city.h * scale) / 2;
    const px = (wx) => ox + wx * scale;
    const py = (wy) => oy + wy * scale;
    ctx.strokeStyle = '#3a3f66';
    ctx.lineWidth = Math.max(1, 3 * scale);
    for (const road of city.roads || []) {
      ctx.beginPath();
      ctx.moveTo(px(road.x), py(road.y));
      ctx.lineTo(px(road.x + road.w), py(road.y + road.h));
      ctx.stroke();
    }
    const safe = city.safehouse;
    if (safe) {
      ctx.fillStyle = PALETTE.safe;
      ctx.fillRect(px(safe.x) - 4, py(safe.y) - 4, 8, 8);
    }
    for (const unit of (state.police && state.police.units) || []) {
      ctx.fillStyle = PALETTE.police;
      ctx.beginPath();
      ctx.arc(px(unit.x), py(unit.y), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const car = state.car;
    if (car) {
      ctx.fillStyle = PALETTE.thief;
      ctx.beginPath();
      ctx.arc(px(car.x), py(car.y), 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (state.player) {
      ctx.fillStyle = PALETTE.thief;
      ctx.beginPath();
      ctx.arc(px(state.player.x), py(state.player.y), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }

  const room = state.room;
  if (!room) return;
  const scale = Math.min(innerW / room.w, innerH / room.h);
  const ox = innerX + (innerW - room.w * scale) / 2;
  const oy = innerY + (innerH - room.h * scale) / 2;
  const px = (wx) => ox + wx * scale;
  const py = (wy) => oy + wy * scale;

  ctx.fillStyle = '#0d0f24';
  ctx.fillRect(innerX, innerY, innerW, innerH);
  for (const wall of room.walls || []) {
    ctx.fillStyle = PALETTE.wall;
    ctx.fillRect(px(wall.x), py(wall.y), Math.max(1, wall.w * scale), Math.max(1, wall.h * scale));
  }
  for (const spot of room.cover || []) {
    ctx.fillStyle = PALETTE.cover;
    ctx.fillRect(px(spot.x), py(spot.y), Math.max(1, spot.w * scale), Math.max(1, spot.h * scale));
  }
  const exit = room.exit;
  if (exit) {
    ctx.fillStyle = PALETTE.safe;
    ctx.fillRect(px(exit.x) - 4, py(exit.y) - 4, 8, 8);
  }
  for (const item of state.loot || []) {
    if (item.taken) continue;
    ctx.fillStyle = PALETTE.loot;
    ctx.beginPath();
    ctx.arc(px(item.x), py(item.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  if (room.vaultSpot) {
    ctx.fillStyle = PALETTE.loot;
    ctx.fillRect(px(room.vaultSpot.x) - 3, py(room.vaultSpot.y) - 3, 6, 6);
  }
  for (const cam of state.cameras || []) {
    ctx.fillStyle = cam.disabled ? PALETTE.muted : PALETTE.camera;
    ctx.beginPath();
    ctx.arc(px(cam.x), py(cam.y), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const guard of state.guards || []) {
    ctx.fillStyle = guard.mode === 'chase' ? '#ffffff' : PALETTE.guard;
    ctx.beginPath();
    ctx.arc(px(guard.x), py(guard.y), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (state.player) {
    ctx.fillStyle = PALETTE.thief;
    ctx.beginPath();
    ctx.arc(px(state.player.x), py(state.player.y), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The title screen: game name, crew, best take, controls, press Space. */
export function drawTitle(ctx, state) {
  fitView(ctx);
  const { x, y } = centredPanel(ctx, 640, 460);
  text(ctx, 'SENJA HEIST', VIEW.width / 2, y + 92, 56, PALETTE.loot, 'center', true);
  text(ctx, 'A night-crew heist in Kota Senja', VIEW.width / 2, y + 126, 20, PALETTE.text, 'center');
  text(ctx, 'Mara Voss  ·  Iko Tan  ·  Reno Kartika  ·  Sable Wren', VIEW.width / 2, y + 168, 16, PALETTE.muted, 'center');
  text(ctx, 'Five jobs. One crew. The museum is waiting.', VIEW.width / 2, y + 200, 16, PALETTE.text, 'center');

  const controls = [
    'WASD / arrows — move    C — crouch    Shift — sprint',
    'E — grab loot / crack vault / exit    Q — EMP pulse',
    'F — punch    Click — silenced shot    P — pause    M — mute',
  ];
  let cy = y + 252;
  for (const line of controls) {
    text(ctx, line, VIEW.width / 2, cy, 15, PALETTE.muted, 'center');
    cy += 26;
  }
  if (state.bestCash > 0) {
    text(ctx, `Best banked: ${money(state.bestCash)}`, VIEW.width / 2, cy + 8, 16, PALETTE.loot, 'center', true);
  }
  const blink = Math.floor(state.time * 2) % 2 === 0;
  if (blink) text(ctx, 'Press Space to start', VIEW.width / 2, y + 460 - 52, 20, PALETTE.accent, 'center', true);
  void x;
}

/**
 * The planning board. `rows` comes from main.js: job rows first, then
 * tool rows, in cursor order. Each row shows its number, name, target or
 * description, price or take, and locked / done / owned state; the row
 * under `state.plan.cursor` is highlighted. Cash and crew sit at the top.
 */
export function drawPlan(ctx, state, rows) {
  fitView(ctx);
  const list = Array.isArray(rows) ? rows : [];
  const { x, y } = centredPanel(ctx, 880, 560);
  text(ctx, 'PLANNING BOARD', VIEW.width / 2, y + 52, 30, PALETTE.loot, 'center', true);
  text(ctx, `Cash ${money(state.cash)}   ·   Jobs done ${state.jobsDone} / 5`, VIEW.width / 2, y + 82, 16, PALETTE.text, 'center');

  const crew = crewList(state);
  if (crew.length > 0) {
    const names = crew.map((m) => `${m.name} (${m.role})`).join('  ·  ');
    text(ctx, names, VIEW.width / 2, y + 108, 14, PALETTE.muted, 'center');
  }

  const rowTop = y + 132;
  const rowH = 40;
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    const ry = rowTop + i * rowH;
    const selected = i === state.plan.cursor;
    if (selected) {
      ctx.fillStyle = '#232744';
      ctx.fillRect(x + 16, ry - 4, 880 - 32, rowH - 6);
      ctx.strokeStyle = PALETTE.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 16.5, ry - 3.5, 880 - 33, rowH - 7);
    }
    const marker = selected ? '▶' : ' ';
    if (row.kind === 'job') {
      const job = row.job;
      const status = row.done ? 'DONE' : row.unlocked ? money(job.take) : 'LOCKED';
      const statusColor = row.done ? PALETTE.safe : row.unlocked ? PALETTE.loot : PALETTE.muted;
      const nameColor = row.unlocked ? PALETTE.text : PALETTE.muted;
      text(ctx, `${marker} ${i + 1}. ${job.name}`, x + 36, ry + 20, 17, nameColor, 'left', selected);
      text(ctx, `${job.target} — ${job.guards} guards, ${job.cameras} cameras${job.vault ? ', vault' : ''}`, x + 36, ry + 38, 12, PALETTE.muted, 'left');
      text(ctx, status, x + 880 - 36, ry + 20, 17, statusColor, 'right', true);
    } else {
      const owned = row.owned ? 'OWNED' : money(row.cost);
      const ownedColor = row.owned ? PALETTE.safe : PALETTE.loot;
      const extra = row.id === 'emp' && row.charges > 0 ? ` (${row.charges} charges)` : '';
      text(ctx, `${marker} ${row.name}${extra}`, x + 36, ry + 20, 17, PALETTE.text, 'left', selected);
      text(ctx, row.desc || '', x + 36, ry + 38, 12, PALETTE.muted, 'left');
      text(ctx, owned, x + 880 - 36, ry + 20, 17, ownedColor, 'right', true);
    }
  }

  const footerY = y + 560 - 44;
  text(ctx, 'Up/Down pick a row  ·  Enter start or buy  ·  B buy the highlighted tool  ·  1–5 pick a job', VIEW.width / 2, footerY, 14, PALETTE.muted, 'center');
}

/** The pause overlay: what is paused, and how to get back in. */
export function drawPause(ctx, state) {
  fitView(ctx);
  const { y } = centredPanel(ctx, 520, 300);
  text(ctx, 'PAUSED', VIEW.width / 2, y + 96, 44, PALETTE.text, 'center', true);
  const where = state.screenBeforePause === 'getaway' ? 'The getaway is waiting.' : 'The crew is holding position.';
  text(ctx, where, VIEW.width / 2, y + 140, 17, PALETTE.muted, 'center');
  if (state.mission) {
    text(ctx, `${state.mission.name} — ${state.mission.target}`, VIEW.width / 2, y + 172, 16, PALETTE.text, 'center');
  }
  text(ctx, 'Press P or Space to resume', VIEW.width / 2, y + 300 - 52, 18, PALETTE.accent, 'center', true);
}

/** The busted screen: the reason, the cash the crew kept, and the retry. */
export function drawBusted(ctx, state) {
  fitView(ctx);
  const { y } = centredPanel(ctx, 560, 320);
  text(ctx, 'BUSTED', VIEW.width / 2, y + 92, 48, PALETTE.danger, 'center', true);
  text(ctx, state.bustReason || 'The crew got caught.', VIEW.width / 2, y + 136, 18, PALETTE.text, 'center');
  text(ctx, `Banked cash kept: ${money(state.cash)}`, VIEW.width / 2, y + 176, 17, PALETTE.loot, 'center', true);
  text(ctx, 'Carried loot is lost. The job is still on the board.', VIEW.width / 2, y + 206, 15, PALETTE.muted, 'center');
  const blink = Math.floor(state.time * 2) % 2 === 0;
  if (blink) text(ctx, 'Press Space to plan again', VIEW.width / 2, y + 320 - 52, 18, PALETTE.accent, 'center', true);
}

/**
 * The payout screen: the score breakdown, the new bank total, campaign
 * progress, and the next job — or the campaign-complete line when the
 * museum is done.
 */
export function drawPayout(ctx, state) {
  fitView(ctx);
  const payout = state.payout || { loot: 0, bonus: 0, timeBonus: 0, ghostBonus: 0, total: 0 };
  const { y } = centredPanel(ctx, 600, 440);
  text(ctx, 'SCORE BANKED', VIEW.width / 2, y + 84, 40, PALETTE.loot, 'center', true);
  if (state.mission) {
    text(ctx, `${state.mission.name} — ${state.mission.target}`, VIEW.width / 2, y + 118, 17, PALETTE.text, 'center');
  }
  const lines = [
    ['Loot carried out', money(payout.loot)],
    ['Speed bonus', payout.timeBonus > 0 ? `+${money(payout.timeBonus)}` : money(0)],
    ['Ghost bonus', payout.ghostBonus > 0 ? `+${money(payout.ghostBonus)}` : money(0)],
  ];
  let ly = y + 168;
  for (const [label, value] of lines) {
    text(ctx, label, VIEW.width / 2 - 180, ly, 17, PALETTE.muted, 'left');
    text(ctx, value, VIEW.width / 2 + 180, ly, 17, PALETTE.text, 'right', true);
    ly += 34;
  }
  ctx.fillStyle = PALETTE.panelEdge;
  ctx.fillRect(VIEW.width / 2 - 180, ly - 6, 360, 1);
  ly += 30;
  text(ctx, 'Total', VIEW.width / 2 - 180, ly, 20, PALETTE.text, 'left', true);
  text(ctx, money(payout.total), VIEW.width / 2 + 180, ly, 20, PALETTE.loot, 'right', true);
  ly += 44;
  text(ctx, `Banked cash: ${money(state.cash)}`, VIEW.width / 2, ly, 17, PALETTE.text, 'center');
  ly += 30;
  const done = state.jobsDone >= 5;
  if (done) {
    text(ctx, 'CAMPAIGN COMPLETE — the museum is yours, Mara.', VIEW.width / 2, ly, 17, PALETTE.safe, 'center', true);
  } else {
    text(ctx, `Jobs done: ${state.jobsDone} / 5 — next up, the board has more work.`, VIEW.width / 2, ly, 16, PALETTE.muted, 'center');
  }
  const blink = Math.floor(state.time * 2) % 2 === 0;
  if (blink) text(ctx, 'Press Space to continue', VIEW.width / 2, y + 440 - 48, 18, PALETTE.accent, 'center', true);
}

/** The transient banner: a short message at the bottom of the screen. */
export function drawBanner(ctx, state) {
  if (!state.banner || state.bannerTimer <= 0) return;
  fitView(ctx);
  const message = state.banner;
  ctx.font = font(16, true);
  const width = ctx.measureText(message).width + 36;
  const x = (VIEW.width - width) / 2;
  const y = VIEW.height - 84;
  ctx.fillStyle = 'rgba(7,8,26,0.85)';
  ctx.fillRect(x, y, width, 34);
  ctx.strokeStyle = PALETTE.panelEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, 33);
  text(ctx, message, VIEW.width / 2, y + 22, 16, PALETTE.text, 'center', true);
}
