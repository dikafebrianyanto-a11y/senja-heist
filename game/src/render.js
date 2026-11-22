// Senja Heist — drawing the world. The renderer owns the canvas, the
// letterboxed 1280x720 view, and `state.camera`; everything else in the
// game hands it a state and gets pixels back.
//
// Layers, bottom to top: floor / street, loot and the vault, cover and
// walls, vision cones, actors, then the effects module (main.js calls it
// after `draw`, while the camera transform is still in place, so its
// particles land in world space). The HUD is hud.js's job and resets the
// transform for itself.
//
// The cover shot must read at a glance: safe cover is dark blue, danger
// is a red or amber cone, loot is gold. Nothing here depends on the
// window size — the logical view is scaled to fit and centred.

import { CAMERA, FONT, GUARD, PALETTE, SCREEN, VIEW } from './config.js';

/** How fast the camera eases toward its target each frame, 0..1. */
const CAMERA_EASE = 0.14;
/** Tile size for the room's chequered floor. */
const FLOOR_TILE = 80;
/** Loot glint pulse: how far the glow breathes. */
const GLINT_BREATH = 0.25;

/** Guard cone colour by mode — a chasing guard reads far angrier. */
const GUARD_CONE = {
  patrol: PALETTE.guardCone,
  suspicious: 'rgba(255,180,84,0.22)',
  chase: 'rgba(255,77,109,0.30)',
  search: 'rgba(255,180,84,0.18)',
};

/** Short role letters drawn on the crew followers. */
const ROLE_LETTER = { hacker: 'H', driver: 'D', lookout: 'L', leader: 'M' };

const fonts = new Map();

function font(size, bold) {
  const key = `${bold ? 'b' : ''}${size}`;
  if (!fonts.has(key)) fonts.set(key, `${bold ? '700 ' : ''}${size}px ${FONT}`);
  return fonts.get(key);
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/** A filled circle. */
function disc(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** A filled rectangle from a { x, y, w, h } box. */
function box(ctx, rect, color) {
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
}

/**
 * A translucent vision cone: a sector of `range` around `angle`, open
 * `halfAngle` either side. The edge is stroked slightly stronger so the
 * boundary of danger is visible even on a busy floor.
 */
function visionCone(ctx, x, y, angle, range, halfAngle, fill, edge) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, range, angle - halfAngle, angle + halfAngle);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(angle - halfAngle) * range, y + Math.sin(angle - halfAngle) * range);
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(angle + halfAngle) * range, y + Math.sin(angle + halfAngle) * range);
  ctx.stroke();
}

/** A small diamond, used for loot glints and marked guards. */
function diamond(ctx, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - size, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * A top-down car: a rounded body rotated to `angle`, a darker cabin,
 * headlights at the front. `length` and `width` come from the car kind
 * via the caller.
 */
function drawCarBody(ctx, x, y, angle, length, width, body, cabin) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(-length / 2, -width / 2, length, width, 7);
  ctx.fill();
  ctx.fillStyle = cabin;
  ctx.beginPath();
  ctx.roundRect(-length / 6, -width / 2 + 4, length / 3, width - 8, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,244,190,0.9)';
  ctx.fillRect(length / 2 - 3, -width / 2 + 4, 3, 5);
  ctx.fillRect(length / 2 - 3, width / 2 - 9, 3, 5);
  ctx.restore();
}

export function createRenderer(canvas) {
  const context = canvas.getContext('2d');
  const view = { scale: 1, x: 0, y: 0 };

  /**
   * Back the canvas at the device pixel ratio and fit the 1280x720
   * logical view inside the window, centred, margins in backdrop colour.
   */
  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(window.innerWidth * ratio));
    const height = Math.max(1, Math.round(window.innerHeight * ratio));
    canvas.width = width;
    canvas.height = height;
    view.scale = Math.min(width / VIEW.width, height / VIEW.height);
    view.x = (width - VIEW.width * view.scale) / 2;
    view.y = (height - VIEW.height * view.scale) / 2;
  }

  /** Paint the whole backing store with the backdrop colour. */
  function clearBackdrop() {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = PALETTE.backdrop;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  /** Set the transform to the letterboxed logical view, no camera. */
  function setViewTransform() {
    context.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
  }

  /**
   * Ease `state.camera` (the centre of the view, in world pixels) toward
   * a target, then clamp it so the view never shows past the map's edge.
   * When the map is smaller than the view, the camera sits on its centre.
   */
  function easeCamera(state, targetX, targetY, mapW, mapH) {
    const camera = state.camera;
    camera.x += (targetX - camera.x) * CAMERA_EASE;
    camera.y += (targetY - camera.y) * CAMERA_EASE;
    const halfW = VIEW.width / 2;
    const halfH = VIEW.height / 2;
    camera.x = mapW <= VIEW.width ? mapW / 2 : clamp(camera.x, halfW, mapW - halfW);
    camera.y = mapH <= VIEW.height ? mapH / 2 : clamp(camera.y, halfH, mapH - halfH);
  }

  /** Apply the camera transform, plus the effects shake while it lasts. */
  function setCameraTransform(state) {
    let shakeX = 0;
    let shakeY = 0;
    if (state.fx && state.fx.shakeT > 0) {
      const mag = state.fx.shakeMag || 0;
      shakeX = (Math.random() * 2 - 1) * mag;
      shakeY = (Math.random() * 2 - 1) * mag;
    }
    const cx = state.camera.x + shakeX;
    const cy = state.camera.y + shakeY;
    context.setTransform(
      view.scale, 0, 0, view.scale,
      view.x - (cx - VIEW.width / 2) * view.scale,
      view.y - (cy - VIEW.height / 2) * view.scale,
    );
  }

  // ------------------------------------------------------------------
  // Night-city backdrop: title and planning board.
  // ------------------------------------------------------------------

  /** A deterministic star field: the same index always lands in the same place. */
  function drawStars(seedBase) {
    for (let i = 0; i < 90; i += 1) {
      const sx = ((i * 373 + seedBase * 97) % 1280 + 1280) % 1280;
      const sy = ((i * 191 + seedBase * 53) % 300 + 300) % 300;
      const twinkle = 0.35 + 0.3 * Math.sin(i * 1.7 + (seedBase % 10));
      context.fillStyle = `rgba(238,240,255,${twinkle.toFixed(2)})`;
      context.fillRect(sx, sy, 2, 2);
    }
  }

  /** Rooftop silhouettes with lit windows, and a street at the bottom. */
  function drawSkyline() {
    const horizon = 560;
    // Sky.
    const sky = context.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#07081a');
    sky.addColorStop(1, '#141736');
    context.fillStyle = sky;
    context.fillRect(0, 0, VIEW.width, horizon);
    drawStars(7);
    // Moon.
    disc(context, 1120, 110, 34, '#f5efc9');
    disc(context, 1108, 102, 7, '#e3d9a8');
    disc(context, 1132, 122, 5, '#e3d9a8');
    // Buildings, back row then front row.
    const rows = [
      { base: horizon, color: '#0d0f24', heights: [180, 260, 210, 300, 240, 190, 280, 220] },
      { base: horizon, color: '#12152e', heights: [120, 170, 140, 200, 160, 130, 180, 150] },
    ];
    for (const row of rows) {
      let bx = 0;
      for (let i = 0; i < row.heights.length; i += 1) {
        const bw = VIEW.width / row.heights.length;
        const bh = row.heights[i];
        context.fillStyle = row.color;
        context.fillRect(bx, row.base - bh, bw - 6, bh);
        // Lit windows.
        for (let wy = row.base - bh + 16; wy < row.base - 18; wy += 26) {
          for (let wx = bx + 12; wx < bx + bw - 18; wx += 24) {
            if ((wx * 7 + wy * 13 + i * 31) % 5 < 2) {
              context.fillStyle = 'rgba(245,197,66,0.75)';
              context.fillRect(wx, wy, 9, 12);
            }
          }
        }
        bx += bw;
      }
    }
    // Street.
    context.fillStyle = PALETTE.street;
    context.fillRect(0, horizon, VIEW.width, VIEW.height - horizon);
    context.fillStyle = PALETTE.roadLine;
    for (let lx = 0; lx < VIEW.width; lx += 90) {
      context.fillRect(lx, 648, 46, 4);
    }
  }

  /** The city backdrop for title / plan, with live traffic rolling by. */
  function drawCityBackdrop(state) {
    setViewTransform();
    drawSkyline();
    const traffic = state.traffic;
    if (traffic && Array.isArray(traffic.cars)) {
      for (const car of traffic.cars.slice(0, 14)) {
        const tx = ((car.x * 0.4 + state.time * car.speed * 0.4) % 1400) - 60;
        const ty = 596 + ((car.y * 0.13) % 96);
        drawCarBody(context, tx, ty, 0, 44, 20, car.color || PALETTE.carTraffic, '#1a1d31');
      }
    }
    // Harbour glow along the bottom edge.
    const glow = context.createLinearGradient(0, 660, 0, VIEW.height);
    glow.addColorStop(0, 'rgba(87,217,119,0)');
    glow.addColorStop(1, 'rgba(87,217,119,0.10)');
    context.fillStyle = glow;
    context.fillRect(0, 660, VIEW.width, VIEW.height - 660);
  }

  // ------------------------------------------------------------------
  // The heist room.
  // ------------------------------------------------------------------

  function drawRoom(state) {
    const room = state.room;
    if (!room) {
      setViewTransform();
      context.fillStyle = PALETTE.floor;
      context.fillRect(0, 0, VIEW.width, VIEW.height);
      return;
    }
    const focus = state.player || { x: room.w / 2, y: room.h / 2 };
    easeCamera(state, focus.x, focus.y, room.w, room.h);
    setCameraTransform(state);

    // Floor: chequered tiles, slightly varied so the room reads as a floor.
    for (let ty = 0; ty < room.h; ty += FLOOR_TILE) {
      for (let tx = 0; tx < room.w; tx += FLOOR_TILE) {
        const even = ((tx + ty) / FLOOR_TILE) % 2 === 0;
        context.fillStyle = even ? PALETTE.floor : PALETTE.floorAlt;
        context.fillRect(tx, ty, FLOOR_TILE, FLOOR_TILE);
      }
    }

    // Entry and exit markers.
    if (room.entry) {
      context.fillStyle = 'rgba(126,224,195,0.18)';
      context.fillRect(room.entry.x - 34, room.entry.y - 34, 68, 68);
      context.strokeStyle = PALETTE.thief;
      context.lineWidth = 2;
      context.strokeRect(room.entry.x - 34, room.entry.y - 34, 68, 68);
    }
    if (room.exit) {
      const pulse = 0.5 + 0.3 * Math.sin(state.time * 3);
      context.fillStyle = `rgba(87,217,119,${pulse.toFixed(2)})`;
      context.fillRect(room.exit.x - 30, room.exit.y - 30, 60, 60);
      context.fillStyle = PALETTE.safe;
      context.font = font(15, true);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText('EXIT', room.exit.x, room.exit.y);
    }

    // Loot: a gold glint that breathes, so the target is obvious.
    const glint = 0.55 + GLINT_BREATH * Math.sin(state.time * 4);
    for (const item of state.loot || []) {
      if (item.taken) continue;
      context.fillStyle = `rgba(245,197,66,${(glint * 0.35).toFixed(2)})`;
      context.beginPath();
      context.arc(item.x, item.y, 26, 0, Math.PI * 2);
      context.fill();
      diamond(context, item.x, item.y, 11, PALETTE.loot);
      diamond(context, item.x, item.y, 5, '#fff3c4');
    }

    // Vault door: a heavy slab, gold-ringed once it stands open.
    if (room.vaultSpot && state.vault) {
      const vault = state.vault;
      const vx = room.vaultSpot.x;
      const vy = room.vaultSpot.y;
      context.fillStyle = '#2c3049';
      context.fillRect(vx - 34, vy - 34, 68, 68);
      context.strokeStyle = vault.state === 'open' ? PALETTE.loot : '#565d8a';
      context.lineWidth = 4;
      context.strokeRect(vx - 34, vy - 34, 68, 68);
      disc(context, vx, vy, 14, vault.state === 'open' ? PALETTE.loot : '#565d8a');
      if (vault.state === 'cracking') {
        context.fillStyle = PALETTE.loot;
        context.font = font(13, true);
        context.textAlign = 'center';
        context.textBaseline = 'alphabetic';
        context.fillText('CRACKING', vx, vy - 44);
      }
    }

    // Doors.
    for (const door of room.doors || []) {
      box(context, door, door.open ? '#1a1d31' : PALETTE.door);
    }

    // Cover: low, dark-blue blocks the thief can crouch behind.
    for (const spot of room.cover || []) {
      box(context, spot, PALETTE.cover);
      context.fillStyle = '#33395f';
      context.fillRect(spot.x, spot.y, spot.w, 5);
    }

    // Walls: solid blocks with a lighter top edge.
    for (const wall of room.walls || []) {
      box(context, wall, PALETTE.wall);
      context.fillStyle = PALETTE.wallTop;
      context.fillRect(wall.x, wall.y, wall.w, 5);
    }

    // Vision cones, under the actors: red for guards, amber for cameras.
    for (const guard of state.guards || []) {
      if (guard.mode === 'chase') continue;
      const color = GUARD_CONE[guard.mode] || GUARD_CONE.patrol;
      visionCone(context, guard.x, guard.y, guard.angle, GUARD.sight, GUARD.halfCone, color, 'rgba(255,93,93,0.35)');
    }
    for (const guard of state.guards || []) {
      if (guard.mode !== 'chase') continue;
      visionCone(context, guard.x, guard.y, guard.angle, GUARD.sight, GUARD.halfCone, GUARD_CONE.chase, 'rgba(255,77,109,0.55)');
    }
    for (const cam of state.cameras || []) {
      if (cam.disabled) continue;
      visionCone(context, cam.x, cam.y, cam.angle, CAMERA.range, CAMERA.halfCone, PALETTE.cameraCone, 'rgba(255,180,84,0.35)');
    }

    // Cameras: amber wall units, grey while EMP-blind.
    for (const cam of state.cameras || []) {
      disc(context, cam.x, cam.y, 9, cam.disabled ? PALETTE.muted : PALETTE.camera);
      disc(context, cam.x, cam.y, 4, '#1a1d31');
      if (cam.disabled) {
        context.strokeStyle = PALETTE.muted;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(cam.x - 6, cam.y - 6);
        context.lineTo(cam.x + 6, cam.y + 6);
        context.stroke();
      }
    }

    // Guards: red discs with a facing tick; a white ring while chasing,
    // a gold diamond above the one the lookout has marked.
    for (const guard of state.guards || []) {
      const down = guard.mode === 'search' && guard.suspicion <= 0 && guard.alertTimer > 0;
      disc(context, guard.x, guard.y, 13, down ? '#7a3a3a' : PALETTE.guard);
      context.strokeStyle = '#ffffff';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(guard.x, guard.y);
      context.lineTo(guard.x + Math.cos(guard.angle) * 18, guard.y + Math.sin(guard.angle) * 18);
      context.stroke();
      if (guard.mode === 'chase') {
        context.strokeStyle = '#ffffff';
        context.beginPath();
        context.arc(guard.x, guard.y, 18, 0, Math.PI * 2);
        context.stroke();
      }
      if (guard.marked) {
        diamond(context, guard.x, guard.y - 26, 7, PALETTE.loot);
      }
    }

    // Crew followers: coloured discs with a role letter.
    for (const member of crewList(state)) {
      if (member.role === 'leader') continue;
      if (member.status === 'down') continue;
      disc(context, member.x, member.y, 10, member.color || PALETTE.thief);
      context.fillStyle = '#0a0c20';
      context.font = font(11, true);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(ROLE_LETTER[member.role] || '?', member.x, member.y + 0.5);
    }

    // The thief: teal, with a facing tick; crouched she is smaller and darker.
    const player = state.player;
    if (player) {
      const radius = player.crouched ? 10 : 13;
      const body = player.crouched ? PALETTE.thiefDark : PALETTE.thief;
      if (player.hidden) {
        context.strokeStyle = 'rgba(126,224,195,0.6)';
        context.setLineDash([4, 4]);
        context.beginPath();
        context.arc(player.x, player.y, radius + 4, 0, Math.PI * 2);
        context.stroke();
        context.setLineDash([]);
      }
      disc(context, player.x, player.y, radius, body);
      context.strokeStyle = '#0a0c20';
      context.lineWidth = 2.5;
      context.beginPath();
      context.moveTo(player.x, player.y);
      context.lineTo(player.x + Math.cos(player.facing) * (radius + 7), player.y + Math.sin(player.facing) * (radius + 7));
      context.stroke();
      // Noise ring while moving loud.
      if (player.noise > 0 && player.moving) {
        context.strokeStyle = 'rgba(238,240,255,0.25)';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(player.x, player.y, player.noise, 0, Math.PI * 2);
        context.stroke();
      }
      // Disguise shimmer.
      if (player.disguised) {
        context.strokeStyle = 'rgba(180,140,255,0.8)';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(player.x, player.y, radius + 5, 0, Math.PI * 2);
        context.stroke();
      }
    }

    // Bullets, if combat has any in flight.
    if (state.combat && Array.isArray(state.combat.bullets)) {
      for (const bullet of state.combat.bullets) {
        disc(context, bullet.x, bullet.y, 3, '#fff3c4');
      }
    }
  }

  // ------------------------------------------------------------------
  // The getaway: Kota Senja's streets.
  // ------------------------------------------------------------------

  function drawCity(state) {
    const city = state.city;
    if (!city) {
      setViewTransform();
      context.fillStyle = PALETTE.street;
      context.fillRect(0, 0, VIEW.width, VIEW.height);
      return;
    }
    const focus = state.car && state.car.inUse
      ? state.car
      : state.player || { x: city.w / 2, y: city.h / 2 };
    easeCamera(state, focus.x, focus.y, city.w, city.h);
    setCameraTransform(state);

    // Ground and blocks.
    context.fillStyle = PALETTE.street;
    context.fillRect(0, 0, city.w, city.h);
    for (const block of city.blocks || []) {
      box(context, block, PALETTE.sidewalk);
      // Rooftop detail: a few lit windows per block.
      for (let wy = block.y + 12; wy < block.y + block.h - 12; wy += 30) {
        for (let wx = block.x + 12; wx < block.x + block.w - 12; wx += 30) {
          if ((wx * 5 + wy * 11) % 7 < 2) {
            context.fillStyle = 'rgba(245,197,66,0.55)';
            context.fillRect(wx, wy, 7, 9);
          }
        }
      }
    }

    // Roads with dashed centre lines.
    for (const road of city.roads || []) {
      box(context, road, PALETTE.road);
      context.fillStyle = PALETTE.roadLine;
      if (road.dir === 'h') {
        const midY = road.y + road.h / 2 - 2;
        for (let lx = road.x + 8; lx < road.x + road.w - 20; lx += 44) {
          context.fillRect(lx, midY, 24, 4);
        }
      } else {
        const midX = road.x + road.w / 2 - 2;
        for (let ly = road.y + 8; ly < road.y + road.h - 20; ly += 44) {
          context.fillRect(midX, ly, 4, 24);
        }
      }
    }

    // Lamps: small amber glows along the roads.
    for (const lamp of city.lamps || []) {
      disc(context, lamp.x, lamp.y, 10, 'rgba(255,180,84,0.16)');
      disc(context, lamp.x, lamp.y, 3, PALETTE.camera);
    }

    // Safehouse: green marker with a pulsing ring.
    const safe = city.safehouse;
    if (safe) {
      const pulse = 0.4 + 0.25 * Math.sin(state.time * 3);
      context.strokeStyle = `rgba(87,217,119,${pulse.toFixed(2)})`;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(safe.x, safe.y, 34 + 6 * Math.sin(state.time * 3), 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = PALETTE.safe;
      context.fillRect(safe.x - 16, safe.y - 8, 32, 22);
      context.beginPath();
      context.moveTo(safe.x - 20, safe.y - 8);
      context.lineTo(safe.x, safe.y - 24);
      context.lineTo(safe.x + 20, safe.y - 8);
      context.closePath();
      context.fill();
      context.fillStyle = PALETTE.safe;
      context.font = font(13, true);
      context.textAlign = 'center';
      context.textBaseline = 'alphabetic';
      context.fillText('SAFEHOUSE', safe.x, safe.y - 34);
    }

    // Walkers: small dots wandering the sidewalks.
    if (state.traffic && Array.isArray(state.traffic.walkers)) {
      for (const walker of state.traffic.walkers) {
        disc(context, walker.x, walker.y, 4, walker.color || '#c9cde8');
      }
    }

    // Traffic cars.
    if (state.traffic && Array.isArray(state.traffic.cars)) {
      for (const car of state.traffic.cars) {
        drawCarBody(context, car.x, car.y, car.angle, 46, 22, car.color || PALETTE.carTraffic, '#1a1d31');
      }
    }

    // Police units: blue cars with a flashing light bar, foot units as dots.
    const police = state.police;
    if (police && Array.isArray(police.units)) {
      const flash = Math.floor(state.time * 6) % 2 === 0;
      for (const unit of police.units) {
        if (unit.kind === 'car') {
          drawCarBody(context, unit.x, unit.y, unit.angle, 48, 22, PALETTE.carPolice, '#16224a');
          disc(context, unit.x, unit.y - 4, 4, flash ? PALETTE.policeLight : '#5aa9ff');
          disc(context, unit.x, unit.y + 4, 4, flash ? '#5aa9ff' : PALETTE.policeLight);
        } else {
          disc(context, unit.x, unit.y, 8, PALETTE.police);
        }
      }
    }

    // The player's car, or the thief on foot.
    const car = state.car;
    if (car && car.inUse) {
      drawCarBody(context, car.x, car.y, car.angle, 52, 24, PALETTE.carPlayer, '#123f33');
    } else if (state.player) {
      disc(context, state.player.x, state.player.y, 13, PALETTE.thief);
    }

    // Bullets in flight during a getaway shootout.
    if (state.combat && Array.isArray(state.combat.bullets)) {
      for (const bullet of state.combat.bullets) {
        disc(context, bullet.x, bullet.y, 3, '#fff3c4');
      }
    }
  }

  /** The crew, safe when it is null (before the first job). */
  function crewList(state) {
    return Array.isArray(state.crew) ? state.crew : [];
  }

  /**
   * Paint one frame for the current screen. Title and plan get the night
   * city backdrop; heist gets the room; getaway gets the streets; pause
   * redraws whatever was underneath it; busted and payout get the city
   * dimmed. The transform is left in world space so the effects module
   * can draw its particles in the same coordinates; hud.js resets it.
   */
  function draw(state) {
    clearBackdrop();
    const screen = state.screen;
    if (screen === SCREEN.TITLE || screen === SCREEN.PLAN) {
      drawCityBackdrop(state);
      return;
    }
    if (screen === SCREEN.HEIST) {
      drawRoom(state);
      return;
    }
    if (screen === SCREEN.GETAWAY) {
      drawCity(state);
      return;
    }
    if (screen === SCREEN.PAUSE) {
      if (state.screenBeforePause === SCREEN.GETAWAY) drawCity(state);
      else drawRoom(state);
      setViewTransform();
      context.fillStyle = 'rgba(7,8,26,0.55)';
      context.fillRect(0, 0, VIEW.width, VIEW.height);
      return;
    }
    // Busted / payout: the city, dimmed, behind the panel.
    drawCityBackdrop(state);
    setViewTransform();
    context.fillStyle = 'rgba(7,8,26,0.6)';
    context.fillRect(0, 0, VIEW.width, VIEW.height);
  }

  resize();
  window.addEventListener('resize', resize);
  return { draw, context };
}
