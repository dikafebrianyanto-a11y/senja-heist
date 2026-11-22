// Senja Heist — the painter.
//
// One responsibility: turn a game state into pixels on a fixed 1280x720
// logical stage, letterboxed into whatever window the player happens to
// have. The renderer owns the canvas and the camera; the simulation
// modules own the numbers. Nothing in here steps the game forward — it
// only reads state and draws it.
//
// Paint order inside a room, bottom to top: floor tiles, entry and exit
// pads, loot, the vault, doors, cover, walls, smoke, vision cones,
// cameras, guards, crew, the thief, bullets. The effects pass runs after
// draw() (main.js calls it while the camera transform is still live, so
// its particles land in world space), and hud.js resets the transform
// before it paints its panels.
//
// Newer state fields are read defensively throughout: state.smoke,
// state.difficulty, guard.alertMode and cam.disabledBy may be absent
// on older saves or before their systems land, and every one of those
// reads falls back to the pre-existing look.
//
// Readability rules the palette: safe cover is dark blue, danger is a
// red or amber cone, loot is gold, the thief is teal. A player should be
// able to read a room at a glance, mid-sprint, in the dark.

import { VIEW, SCREEN, PALETTE, FONT, GUARD, CAMERA } from './config.js';

/** How much of the gap to the camera target closes each frame. */
const EASE = 0.14;
/** Edge of one square of the chequered room floor, in world pixels. */
const TILE = 80;
/** How far the loot glow swells and shrinks as it pulses. */
const GLINT_SWING = 0.25;
/** A full turn, for arcs. */
const TAU = Math.PI * 2;

/** Guard cone fill, keyed by the guard's current mode. */
const CONE_BY_MODE = {
  patrol: PALETTE.guardCone,
  suspicious: 'rgba(255,180,84,0.22)',
  chase: 'rgba(255,77,109,0.30)',
  search: 'rgba(255,180,84,0.18)',
};
/** Cone fill for a guard whose alert flag is raised — far angrier. */
const CONE_ALERT = 'rgba(255,45,85,0.40)';
/** Cone rim for a guard whose alert flag is raised. */
const CONE_ALERT_RIM = 'rgba(255,45,85,0.75)';
/** Rim colour for a calm guard's cone. */
const CONE_CALM_RIM = 'rgba(255,93,93,0.35)';
/** Rim colour for a chasing guard's cone. */
const CONE_CHASE_RIM = 'rgba(255,77,109,0.55)';
/** Rim colour for a live camera's cone. */
const CONE_CAMERA_RIM = 'rgba(255,180,84,0.35)';

/** One-letter glyphs stamped on the crew followers. */
const CREW_GLYPH = { hacker: 'H', driver: 'D', lookout: 'L', leader: 'M' };

/** Smoke fades out over its last few seconds of life. */
const SMOKE_FADE_SECONDS = 2.5;

const typeCache = {};

/** Cached canvas font string for a size, optionally bold. */
function typeface(px, heavy) {
  const tag = `${heavy ? 'b' : 'r'}${px}`;
  if (!typeCache[tag]) typeCache[tag] = `${heavy ? '700 ' : ''}${px}px ${FONT}`;
  return typeCache[tag];
}

/** Clamp a number into a range. */
function pinch(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A filled circle. */
function dot(ctx, x, y, r, colour) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

/** A filled rectangle from a { x, y, w, h } box. */
function slab(ctx, r, colour) {
  ctx.fillStyle = colour;
  ctx.fillRect(r.x, r.y, r.w, r.h);
}

/**
 * A translucent vision sector: a wedge of `reach` around `bearing`,
 * open `half` radians either side. The rim is stroked a little
 * stronger than the fill so the edge of danger stays visible over a
 * busy floor.
 */
function sector(ctx, x, y, bearing, reach, half, fill, rim) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, reach, bearing - half, bearing + half);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = rim;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(bearing - half) * reach, y + Math.sin(bearing - half) * reach);
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(bearing + half) * reach, y + Math.sin(bearing + half) * reach);
  ctx.stroke();
}

/** A small diamond, for loot glints and marked guards. */
function gem(ctx, x, y, s, colour) {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * A top-down car: a rounded body turned to `heading`, a darker cabin,
 * headlights at the front. Length and width come from the car kind,
 * supplied by the caller.
 */
function autoBody(ctx, x, y, heading, len, wid, paint, glass) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  ctx.fillStyle = paint;
  ctx.beginPath();
  ctx.roundRect(-len / 2, -wid / 2, len, wid, 7);
  ctx.fill();
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.roundRect(-len / 6, -wid / 2 + 4, len / 3, wid - 8, 4);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,244,190,0.9)';
  ctx.fillRect(len / 2 - 3, -wid / 2 + 4, 3, 5);
  ctx.fillRect(len / 2 - 3, wid / 2 - 9, 3, 5);
  ctx.restore();
}

/** A tiny lightning bolt, stamped next to an EMP-killed camera. */
function drawBolt(ctx, x, y) {
  ctx.fillStyle = '#ffe9a8';
  ctx.beginPath();
  ctx.moveTo(x + 2, y - 7);
  ctx.lineTo(x - 3, y + 1);
  ctx.lineTo(x, y + 1);
  ctx.lineTo(x - 2, y + 7);
  ctx.lineTo(x + 3, y - 1);
  ctx.lineTo(x, y - 1);
  ctx.closePath();
  ctx.fill();
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const frame = { scale: 1, ox: 0, oy: 0 };

  /**
   * Back the canvas at the device pixel ratio and fit the 1280x720
   * logical stage inside the window, centred, with the backdrop
   * colour filling the margins.
   */
  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    frame.scale = Math.min(w / VIEW.width, h / VIEW.height);
    frame.ox = (w - VIEW.width * frame.scale) / 2;
    frame.oy = (h - VIEW.height * frame.scale) / 2;
  }

  /** Flood the whole backing store with the backdrop colour. */
  function paintBackdrop() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PALETTE.backdrop;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /** Switch to the letterboxed logical view, camera not applied. */
  function useViewTransform() {
    ctx.setTransform(frame.scale, 0, 0, frame.scale, frame.ox, frame.oy);
  }

  /**
   * Ease `state.camera` (the centre of the view, in world pixels)
   * toward a target, then keep it inside the map. When the map is
   * smaller than the view, the camera rests on the map's centre.
   */
  function trackTarget(state, tx, ty, mapW, mapH) {
    const cam = state.camera;
    cam.x += (tx - cam.x) * EASE;
    cam.y += (ty - cam.y) * EASE;
    const hw = VIEW.width / 2;
    const hh = VIEW.height / 2;
    cam.x = mapW <= VIEW.width ? mapW / 2 : pinch(cam.x, hw, mapW - hw);
    cam.y = mapH <= VIEW.height ? mapH / 2 : pinch(cam.y, hh, mapH - hh);
  }

  /** Apply the camera transform, plus the shake while it is running. */
  function useCameraTransform(state) {
    let jx = 0;
    let jy = 0;
    if (state.fx && state.fx.shakeT > 0) {
      const mag = state.fx.shakeMag || 0;
      jx = (Math.random() * 2 - 1) * mag;
      jy = (Math.random() * 2 - 1) * mag;
    }
    const cx = state.camera.x + jx;
    const cy = state.camera.y + jy;
    ctx.setTransform(
      frame.scale, 0, 0, frame.scale,
      frame.ox - (cx - VIEW.width / 2) * frame.scale,
      frame.oy - (cy - VIEW.height / 2) * frame.scale,
    );
  }

  // ------------------------------------------------------------------
  // Night-city backdrop: title screen and planning board.
  // ------------------------------------------------------------------

  /** A fixed star field: the same index always lands in the same spot. */
  function starField(seed) {
    for (let i = 0; i < 90; i += 1) {
      const sx = ((i * 389 + seed * 101) % 1280 + 1280) % 1280;
      const sy = ((i * 173 + seed * 59) % 300 + 300) % 300;
      const glow = 0.35 + 0.3 * Math.sin(i * 1.7 + (seed % 10));
      ctx.fillStyle = `rgba(238,240,255,${glow.toFixed(2)})`;
      ctx.fillRect(sx, sy, 2, 2);
    }
  }

  /** Rooftop silhouettes with lit windows, and a street at the bottom. */
  function skyline() {
    const horizon = 560;
    // Sky.
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#07081a');
    sky.addColorStop(1, '#141736');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW.width, horizon);
    starField(7);
    // Moon.
    dot(ctx, 1120, 110, 34, '#f5efc9');
    dot(ctx, 1108, 102, 7, '#e3d9a8');
    dot(ctx, 1132, 122, 5, '#e3d9a8');
    // Two rows of buildings, back row taller and darker.
    const rows = [
      { shade: '#0d0f24', heights: [180, 260, 210, 300, 240, 190, 280, 220] },
      { shade: '#12152e', heights: [120, 170, 140, 200, 160, 130, 180, 150] },
    ];
    for (const row of rows) {
      let bx = 0;
      for (let i = 0; i < row.heights.length; i += 1) {
        const bw = VIEW.width / row.heights.length;
        const bh = row.heights[i];
        ctx.fillStyle = row.shade;
        ctx.fillRect(bx, horizon - bh, bw - 6, bh);
        // Lit windows, scattered by a cheap hash so they never move.
        for (let wy = horizon - bh + 16; wy < horizon - 18; wy += 26) {
          for (let wx = bx + 12; wx < bx + bw - 18; wx += 24) {
            if ((wx * 7 + wy * 13 + i * 31) % 5 < 2) {
              ctx.fillStyle = 'rgba(245,197,66,0.75)';
              ctx.fillRect(wx, wy, 9, 12);
            }
          }
        }
        bx += bw;
      }
    }
    // Street.
    ctx.fillStyle = PALETTE.street;
    ctx.fillRect(0, horizon, VIEW.width, VIEW.height - horizon);
    ctx.fillStyle = PALETTE.roadLine;
    for (let lx = 0; lx < VIEW.width; lx += 90) {
      ctx.fillRect(lx, 648, 46, 4);
    }
  }

  /** The city backdrop for title / plan, with traffic rolling past. */
  function titleCity(state) {
    useViewTransform();
    skyline();
    const traffic = state.traffic;
    if (traffic && Array.isArray(traffic.cars)) {
      for (const car of traffic.cars.slice(0, 14)) {
        const tx = ((car.x * 0.4 + state.time * car.speed * 0.4) % 1400) - 60;
        const ty = 596 + ((car.y * 0.13) % 96);
        autoBody(ctx, tx, ty, 0, 44, 20, car.color || PALETTE.carTraffic, '#1a1d31');
      }
    }
    // Harbour glow creeping up from the bottom edge.
    const glow = ctx.createLinearGradient(0, 660, 0, VIEW.height);
    glow.addColorStop(0, 'rgba(87,217,119,0)');
    glow.addColorStop(1, 'rgba(87,217,119,0.10)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 660, VIEW.width, VIEW.height - 660);
  }

  // ------------------------------------------------------------------
  // The heist room — one small helper per drawn thing.
  // ------------------------------------------------------------------

  /** Chequered tiles, alternating shades so the room reads as a floor. */
  function paintFloor(room) {
    for (let ty = 0; ty < room.h; ty += TILE) {
      for (let tx = 0; tx < room.w; tx += TILE) {
        const light = ((tx + ty) / TILE) % 2 === 0;
        ctx.fillStyle = light ? PALETTE.floor : PALETTE.floorAlt;
        ctx.fillRect(tx, ty, TILE, TILE);
      }
    }
  }

  /** Entry pad (teal outline) and exit pad (pulsing green, labelled). */
  function paintPads(state, room) {
    if (room.entry) {
      ctx.fillStyle = 'rgba(126,224,195,0.18)';
      ctx.fillRect(room.entry.x - 34, room.entry.y - 34, 68, 68);
      ctx.strokeStyle = PALETTE.thief;
      ctx.lineWidth = 2;
      ctx.strokeRect(room.entry.x - 34, room.entry.y - 34, 68, 68);
    }
    if (room.exit) {
      const pulse = 0.5 + 0.3 * Math.sin(state.time * 3);
      ctx.fillStyle = `rgba(87,217,119,${pulse.toFixed(2)})`;
      ctx.fillRect(room.exit.x - 30, room.exit.y - 30, 60, 60);
      ctx.fillStyle = PALETTE.safe;
      ctx.font = typeface(15, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('EXIT', room.exit.x, room.exit.y);
    }
  }

  /** Loot: a gold diamond inside a breathing glow, so the target pops. */
  function paintLoot(state) {
    const glint = 0.55 + GLINT_SWING * Math.sin(state.time * 4);
    for (const item of state.loot || []) {
      if (item.taken) continue;
      ctx.fillStyle = `rgba(245,197,66,${(glint * 0.35).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(item.x, item.y, 26, 0, TAU);
      ctx.fill();
      gem(ctx, item.x, item.y, 11, PALETTE.loot);
      gem(ctx, item.x, item.y, 5, '#fff3c4');
    }
  }

  /** The vault door: a heavy slab, gold-ringed once it stands open. */
  function paintVault(state, room) {
    if (!room.vaultSpot || !state.vault) return;
    const vault = state.vault;
    const vx = room.vaultSpot.x;
    const vy = room.vaultSpot.y;
    ctx.fillStyle = '#2c3049';
    ctx.fillRect(vx - 34, vy - 34, 68, 68);
    ctx.strokeStyle = vault.state === 'open' ? PALETTE.loot : '#565d8a';
    ctx.lineWidth = 4;
    ctx.strokeRect(vx - 34, vy - 34, 68, 68);
    dot(ctx, vx, vy, 14, vault.state === 'open' ? PALETTE.loot : '#565d8a');
    if (vault.state === 'cracking') {
      ctx.fillStyle = PALETTE.loot;
      ctx.font = typeface(13, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('CRACKING', vx, vy - 44);
    }
  }

  /** Doors: open ones read as holes, shut ones as slabs. */
  function paintDoors(room) {
    for (const door of room.doors || []) {
      slab(ctx, door, door.open ? '#1a1d31' : PALETTE.door);
    }
  }

  /** Cover: low dark-blue blocks, with a pale lip along the top. */
  function paintCover(room) {
    for (const spot of room.cover || []) {
      slab(ctx, spot, PALETTE.cover);
      ctx.fillStyle = '#33395f';
      ctx.fillRect(spot.x, spot.y, spot.w, 5);
    }
  }

  /** Walls: solid blocks with a lighter top edge. */
  function paintWalls(room) {
    for (const wall of room.walls || []) {
      slab(ctx, wall, PALETTE.wall);
      ctx.fillStyle = PALETTE.wallTop;
      ctx.fillRect(wall.x, wall.y, wall.w, 5);
    }
  }

  /**
   * Smoke clouds from state.smoke ({ x, y, r, t } each, t counting down
   * in seconds). Three nested grey-violet puffs per cloud, denser toward
   * the middle, fading out over the last seconds of life. Painted above
   * the floor and walls but below every figure, so someone standing in
   * smoke reads as hidden.
   */
  function paintSmoke(state) {
    const clouds = state.smoke;
    if (!Array.isArray(clouds)) return;
    for (const cloud of clouds) {
      const fade = pinch((cloud.t ?? 0) / SMOKE_FADE_SECONDS, 0, 1);
      if (fade <= 0) continue;
      const r = cloud.r || 60;
      const wobble = Math.sin(state.time * 1.5 + cloud.x * 0.05) * r * 0.05;
      dot(ctx, cloud.x + wobble, cloud.y, r, `rgba(148,140,178,${(0.20 * fade).toFixed(2)})`);
      dot(ctx, cloud.x - r * 0.25, cloud.y + r * 0.12, r * 0.66, `rgba(160,152,196,${(0.26 * fade).toFixed(2)})`);
      dot(ctx, cloud.x + r * 0.2, cloud.y - r * 0.18, r * 0.45, `rgba(178,170,214,${(0.30 * fade).toFixed(2)})`);
    }
  }

  /**
   * Guard vision cones. Alert guards (alertMode) get a sharper, hotter
   * cone than their mode would normally earn; chasing guards are drawn
   * in a second pass so their cones sit on top of the calm ones.
   */
  function paintGuardCones(state) {
    const guards = state.guards || [];
    for (const g of guards) {
      if (g.mode === 'chase') continue;
      const fill = g.alertMode ? CONE_ALERT : (CONE_BY_MODE[g.mode] || CONE_BY_MODE.patrol);
      const rim = g.alertMode ? CONE_ALERT_RIM : CONE_CALM_RIM;
      sector(ctx, g.x, g.y, g.angle, GUARD.sight, GUARD.halfCone, fill, rim);
    }
    for (const g of guards) {
      if (g.mode !== 'chase') continue;
      sector(ctx, g.x, g.y, g.angle, GUARD.sight, GUARD.halfCone, CONE_BY_MODE.chase, CONE_CHASE_RIM);
    }
  }

  /**
   * Camera vision cones. Live cameras sweep amber; a disabled camera
   * gets no live cone at all — only a faint dotted ghost of the sweep
   * it used to make.
   */
  function paintCameraCones(state) {
    for (const cam of state.cameras || []) {
      if (!cam.disabled) {
        sector(ctx, cam.x, cam.y, cam.angle, CAMERA.range, CAMERA.halfCone, PALETTE.cameraCone, CONE_CAMERA_RIM);
        continue;
      }
      ctx.strokeStyle = 'rgba(255,180,84,0.14)';
      ctx.setLineDash([2, 7]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cam.x, cam.y);
      ctx.arc(cam.x, cam.y, CAMERA.range, cam.angle - CAMERA.halfCone, cam.angle + CAMERA.halfCone);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,180,84,0.03)';
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * Cameras: amber wall units while live; greyed out, crossed, and
   * tagged OFF once disabled. The kill method gets its own tick — a
   * lightning bolt for an EMP, a code glyph for a hack.
   */
  function paintCameras(state) {
    for (const cam of state.cameras || []) {
      dot(ctx, cam.x, cam.y, 9, cam.disabled ? PALETTE.muted : PALETTE.camera);
      dot(ctx, cam.x, cam.y, 4, '#1a1d31');
      if (!cam.disabled) continue;
      ctx.strokeStyle = PALETTE.muted;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cam.x - 6, cam.y - 6);
      ctx.lineTo(cam.x + 6, cam.y + 6);
      ctx.stroke();
      ctx.fillStyle = PALETTE.muted;
      ctx.font = typeface(10, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('OFF', cam.x, cam.y - 13);
      if (cam.disabledBy === 'emp') drawBolt(ctx, cam.x + 14, cam.y - 4);
      else if (cam.disabledBy === 'hack') {
        ctx.fillStyle = PALETTE.thief;
        ctx.font = typeface(10, true);
        ctx.fillText('</>', cam.x + 17, cam.y + 4);
      }
    }
  }

  /**
   * Guards: red discs with a facing tick, a white ring while chasing,
   * a gold diamond above the one the lookout has marked, and a bold
   * exclamation above an alert guard. A knocked-out guard reads darker.
   * The mark diamond rides higher when an exclamation is present so
   * the two glyphs never collide.
   */
  function paintGuards(state) {
    for (const g of state.guards || []) {
      const knocked = g.mode === 'search' && g.suspicion <= 0 && g.alertTimer > 0;
      dot(ctx, g.x, g.y, 13, knocked ? '#7a3a3a' : PALETTE.guard);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x + Math.cos(g.angle) * 18, g.y + Math.sin(g.angle) * 18);
      ctx.stroke();
      if (g.mode === 'chase') {
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(g.x, g.y, 18, 0, TAU);
        ctx.stroke();
      }
      if (g.marked) gem(ctx, g.x, g.y - (g.alertMode ? 38 : 26), 7, PALETTE.loot);
      if (g.alertMode) {
        // Dark halo first so the mark stays legible over a bright cone.
        dot(ctx, g.x, g.y - 28, 10, 'rgba(7,8,26,0.65)');
        ctx.fillStyle = '#ffffff';
        ctx.font = typeface(16, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('!', g.x, g.y - 20);
      }
    }
  }

  /** The crew, safe when the array is missing (before the first job). */
  function crewMembers(state) {
    return Array.isArray(state.crew) ? state.crew : [];
  }

  /** Crew followers: coloured discs stamped with a role letter. */
  function paintCrew(state) {
    for (const member of crewMembers(state)) {
      if (member.role === 'leader') continue;
      if (member.status === 'down') continue;
      dot(ctx, member.x, member.y, 10, member.color || PALETTE.thief);
      ctx.fillStyle = '#0a0c20';
      ctx.font = typeface(11, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(CREW_GLYPH[member.role] || '?', member.x, member.y + 0.5);
    }
  }

  /**
   * The thief: teal, with a facing tick. Crouched she is smaller and
   * darker; hidden she wears a dashed ring; disguised she shimmers
   * violet; moving loud she throws a faint noise ring.
   */
  function paintThief(state) {
    const player = state.player;
    if (!player) return;
    const radius = player.crouched ? 10 : 13;
    const body = player.crouched ? PALETTE.thiefDark : PALETTE.thief;
    if (player.hidden) {
      ctx.strokeStyle = 'rgba(126,224,195,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 4, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    dot(ctx, player.x, player.y, radius, body);
    ctx.strokeStyle = '#0a0c20';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(player.x + Math.cos(player.facing) * (radius + 7), player.y + Math.sin(player.facing) * (radius + 7));
    ctx.stroke();
    if (player.noise > 0 && player.moving) {
      ctx.strokeStyle = 'rgba(238,240,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.noise, 0, TAU);
      ctx.stroke();
    }
    if (player.disguised) {
      ctx.strokeStyle = 'rgba(180,140,255,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(player.x, player.y, radius + 5, 0, TAU);
      ctx.stroke();
    }
  }

  /** Bullets in flight, if combat has any. */
  function paintBullets(state) {
    if (!state.combat || !Array.isArray(state.combat.bullets)) return;
    for (const bullet of state.combat.bullets) {
      dot(ctx, bullet.x, bullet.y, 3, '#fff3c4');
    }
  }

  /** One room frame: camera, then every layer in order. */
  function paintRoom(state) {
    const room = state.room;
    if (!room) {
      useViewTransform();
      ctx.fillStyle = PALETTE.floor;
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);
      return;
    }
    const focus = state.player || { x: room.w / 2, y: room.h / 2 };
    trackTarget(state, focus.x, focus.y, room.w, room.h);
    useCameraTransform(state);
    paintFloor(room);
    paintPads(state, room);
    paintLoot(state);
    paintVault(state, room);
    paintDoors(room);
    paintCover(room);
    paintWalls(room);
    paintSmoke(state);
    paintGuardCones(state);
    paintCameraCones(state);
    paintCameras(state);
    paintGuards(state);
    paintCrew(state);
    paintThief(state);
    paintBullets(state);
  }

  // ------------------------------------------------------------------
  // The getaway: Kota Senja's streets.
  // ------------------------------------------------------------------

  /** Street ground, then each block with a few lit rooftop windows. */
  function paintStreetGround(state, city) {
    ctx.fillStyle = PALETTE.street;
    ctx.fillRect(0, 0, city.w, city.h);
    for (const block of city.blocks || []) {
      slab(ctx, block, PALETTE.sidewalk);
      for (let wy = block.y + 12; wy < block.y + block.h - 12; wy += 30) {
        for (let wx = block.x + 12; wx < block.x + block.w - 12; wx += 30) {
          if ((wx * 5 + wy * 11) % 7 < 2) {
            ctx.fillStyle = 'rgba(245,197,66,0.55)';
            ctx.fillRect(wx, wy, 7, 9);
          }
        }
      }
    }
  }

  /** Roads with dashed centre lines, horizontal or vertical. */
  function paintRoads(city) {
    for (const road of city.roads || []) {
      slab(ctx, road, PALETTE.road);
      ctx.fillStyle = PALETTE.roadLine;
      if (road.dir === 'h') {
        const midY = road.y + road.h / 2 - 2;
        for (let lx = road.x + 8; lx < road.x + road.w - 20; lx += 44) {
          ctx.fillRect(lx, midY, 24, 4);
        }
      } else {
        const midX = road.x + road.w / 2 - 2;
        for (let ly = road.y + 8; ly < road.y + road.h - 20; ly += 44) {
          ctx.fillRect(midX, ly, 4, 24);
        }
      }
    }
  }

  /** Street lamps: small amber glows along the roads. */
  function paintLamps(city) {
    for (const lamp of city.lamps || []) {
      dot(ctx, lamp.x, lamp.y, 10, 'rgba(255,180,84,0.16)');
      dot(ctx, lamp.x, lamp.y, 3, PALETTE.camera);
    }
  }

  /** Safehouse: a green house marker inside a pulsing ring, labelled. */
  function paintSafehouse(state, city) {
    const safe = city.safehouse;
    if (!safe) return;
    const pulse = 0.4 + 0.25 * Math.sin(state.time * 3);
    ctx.strokeStyle = `rgba(87,217,119,${pulse.toFixed(2)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(safe.x, safe.y, 34 + 6 * Math.sin(state.time * 3), 0, TAU);
    ctx.stroke();
    ctx.fillStyle = PALETTE.safe;
    ctx.fillRect(safe.x - 16, safe.y - 8, 32, 22);
    ctx.beginPath();
    ctx.moveTo(safe.x - 20, safe.y - 8);
    ctx.lineTo(safe.x, safe.y - 24);
    ctx.lineTo(safe.x + 20, safe.y - 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = PALETTE.safe;
    ctx.font = typeface(13, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('SAFEHOUSE', safe.x, safe.y - 34);
  }

  /** Walkers: small dots wandering the sidewalks. */
  function paintWalkers(state) {
    if (!state.traffic || !Array.isArray(state.traffic.walkers)) return;
    for (const walker of state.traffic.walkers) {
      dot(ctx, walker.x, walker.y, 4, walker.color || '#c9cde8');
    }
  }

  /** Traffic cars rolling the roads. */
  function paintTrafficCars(state) {
    if (!state.traffic || !Array.isArray(state.traffic.cars)) return;
    for (const car of state.traffic.cars) {
      autoBody(ctx, car.x, car.y, car.angle, 46, 22, car.color || PALETTE.carTraffic, '#1a1d31');
    }
  }

  /**
   * Police units: blue cars with a flashing light bar, foot units as
   * dots. The bar alternates red and blue twice a second.
   */
  function paintPoliceUnits(state) {
    const police = state.police;
    if (!police || !Array.isArray(police.units)) return;
    const flash = Math.floor(state.time * 6) % 2 === 0;
    for (const unit of police.units) {
      if (unit.kind === 'car') {
        autoBody(ctx, unit.x, unit.y, unit.angle, 48, 22, PALETTE.carPolice, '#16224a');
        dot(ctx, unit.x, unit.y - 4, 4, flash ? PALETTE.policeLight : '#5aa9ff');
        dot(ctx, unit.x, unit.y + 4, 4, flash ? '#5aa9ff' : PALETTE.policeLight);
      } else {
        dot(ctx, unit.x, unit.y, 8, PALETTE.police);
      }
    }
  }

  /** The player's car while driving, or the thief on foot. */
  function paintPlayerCarOrThief(state) {
    const car = state.car;
    if (car && car.inUse) {
      autoBody(ctx, car.x, car.y, car.angle, 52, 24, PALETTE.carPlayer, '#123f33');
    } else if (state.player) {
      dot(ctx, state.player.x, state.player.y, 13, PALETTE.thief);
    }
  }

  /** One street frame: camera, then every layer in order. */
  function paintCity(state) {
    const city = state.city;
    if (!city) {
      useViewTransform();
      ctx.fillStyle = PALETTE.street;
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);
      return;
    }
    const focus = state.car && state.car.inUse
      ? state.car
      : state.player || { x: city.w / 2, y: city.h / 2 };
    trackTarget(state, focus.x, focus.y, city.w, city.h);
    useCameraTransform(state);
    paintStreetGround(state, city);
    paintRoads(city);
    paintLamps(city);
    paintSafehouse(state, city);
    paintWalkers(state);
    paintTrafficCars(state);
    paintPoliceUnits(state);
    paintPlayerCarOrThief(state);
    paintBullets(state);
  }

  /**
   * Paint one frame for the current screen. Title and plan get the
   * night-city backdrop; heist gets the room; getaway gets the streets;
   * pause redraws whatever was underneath it and dims it; busted and
   * payout get the city dimmed behind the panel. The transform is left
   * in world space so the effects module can draw its particles in the
   * same coordinates; hud.js resets it for itself.
   */
  function draw(state) {
    paintBackdrop();
    const screen = state.screen;
    if (screen === SCREEN.TITLE || screen === SCREEN.PLAN) {
      titleCity(state);
      return;
    }
    if (screen === SCREEN.HEIST) {
      paintRoom(state);
      return;
    }
    if (screen === SCREEN.GETAWAY) {
      paintCity(state);
      return;
    }
    if (screen === SCREEN.PAUSE) {
      if (state.screenBeforePause === SCREEN.GETAWAY) paintCity(state);
      else paintRoom(state);
      useViewTransform();
      ctx.fillStyle = 'rgba(7,8,26,0.55)';
      ctx.fillRect(0, 0, VIEW.width, VIEW.height);
      return;
    }
    // Busted / payout: the city, dimmed, behind the panel.
    titleCity(state);
    useViewTransform();
    ctx.fillStyle = 'rgba(7,8,26,0.6)';
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);
  }

  fitCanvas();
  window.addEventListener('resize', fitCanvas);
  return { draw, context: ctx };
}
