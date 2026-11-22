// Senja Heist — particles, floating text, screen shake and the alarm
// vignette. All of it is pooled: the particle and float slots are allocated
// once in createEffects() and reused, so the hot path (a burst every time
// the vault sparks or a guard is punched) never allocates. The object this
// returns lives on state.fx; every helper below takes the shared state and
// reads state.fx from it, matching how main.js calls them.
//
// drawEffects() draws in world space — render.js has already applied the
// camera transform when main.js calls it — except for the alarm vignette,
// which is painted in screen space at the end.

// Pool sizes: plenty for a room full of sparks and a street full of dust.
const MAX_PARTICLES = 240;
const MAX_FLOATS = 24;
const FLOAT_RISE = 36;
const FLOAT_LIFE = 1.1;

/** One reusable particle slot. `alive` false means the slot is free. */
function emptyParticle() {
  return {
    alive: false, x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 1, size: 2, color: '#ffffff',
    gravity: 0, drag: 0,
  };
}

/** One reusable floating-text slot. */
function emptyFloat() {
  return { alive: false, x: 0, y: 0, text: '', color: '#ffffff', life: 0 };
}

export function createEffects() {
  const particles = [];
  for (let i = 0; i < MAX_PARTICLES; i += 1) particles.push(emptyParticle());
  const floats = [];
  for (let i = 0; i < MAX_FLOATS; i += 1) floats.push(emptyFloat());
  return { particles, floats, shakeT: 0, shakeMag: 0, flash: 0 };
}

/** First free slot in a pool, or null when the pool is full. */
function freeSlot(pool) {
  for (let i = 0; i < pool.length; i += 1) {
    if (!pool[i].alive) return pool[i];
  }
  return null;
}

/**
 * Spray `n` sparks from (x, y). Used for vault clicks, punches, muzzle
 * flashes and the puff of dust a sprinting thief kicks up. When the pool
 * is full the oldest-looking extra sparks are simply dropped.
 */
export function burst(state, x, y, color, n) {
  const fx = state.fx;
  if (!fx) return;
  const count = Math.max(0, Math.min(n, 40));
  for (let i = 0; i < count; i += 1) {
    const slot = freeSlot(fx.particles);
    if (!slot) return;
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 190;
    slot.alive = true;
    slot.x = x;
    slot.y = y;
    slot.vx = Math.cos(angle) * speed;
    slot.vy = Math.sin(angle) * speed;
    slot.maxLife = 0.3 + Math.random() * 0.45;
    slot.life = slot.maxLife;
    slot.size = 1.5 + Math.random() * 2.5;
    slot.color = color;
    slot.gravity = 160;
    slot.drag = 2.2;
  }
}

/** A value that floats up and fades, e.g. "+$1,600" over grabbed loot. */
export function floatText(state, x, y, text, color) {
  const fx = state.fx;
  if (!fx) return;
  const slot = freeSlot(fx.floats) ?? fx.floats[0];
  slot.alive = true;
  slot.x = x;
  slot.y = y;
  slot.text = text;
  slot.color = color;
  slot.life = FLOAT_LIFE;
}

/** Kick the camera. A stronger shake replaces a weaker one, never adds. */
export function shake(state, mag, time) {
  const fx = state.fx;
  if (!fx) return;
  if (mag >= fx.shakeMag || fx.shakeT <= 0) {
    fx.shakeMag = mag;
    fx.shakeT = Math.max(fx.shakeT, time);
  }
}

/** Age particles and floats, decay shake and the red flash. */
export function stepEffects(state, dt) {
  const fx = state.fx;
  if (!fx) return;
  for (let i = 0; i < fx.particles.length; i += 1) {
    const p = fx.particles[i];
    if (!p.alive) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.alive = false;
      continue;
    }
    const drag = Math.max(0, 1 - p.drag * dt);
    p.vx *= drag;
    p.vy = p.vy * drag + p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  for (let i = 0; i < fx.floats.length; i += 1) {
    const f = fx.floats[i];
    if (!f.alive) continue;
    f.life -= dt;
    if (f.life <= 0) {
      f.alive = false;
      continue;
    }
    f.y -= FLOAT_RISE * dt;
  }
  if (fx.shakeT > 0) {
    fx.shakeT -= dt;
    if (fx.shakeT <= 0) {
      fx.shakeT = 0;
      fx.shakeMag = 0;
    }
  }
  // During a lockdown the red flash throbs instead of fading out.
  if (state.lockdown) {
    fx.flash = Math.max(fx.flash, 0.22 + 0.12 * Math.sin(state.time * 7));
  } else if (fx.flash > 0) {
    fx.flash = Math.max(0, fx.flash - dt * 1.6);
  }
}

/**
 * The shake offset render.js adds to the camera while shakeT is alive:
 * a damped random jitter, so a punch and an alarm feel different in size
 * but the same in kind. Kept pure so the renderer and this module agree.
 */
export function shakeOffset(state) {
  const fx = state.fx;
  if (!fx || fx.shakeT <= 0) return { x: 0, y: 0 };
  const strength = fx.shakeMag * Math.min(1, fx.shakeT / 0.25);
  return {
    x: (Math.random() * 2 - 1) * strength,
    y: (Math.random() * 2 - 1) * strength,
  };
}

/** Paint particles and floats (world space), then the alarm vignette. */
export function drawEffects(ctx, state) {
  const fx = state.fx;
  if (!fx) return;

  for (let i = 0; i < fx.particles.length; i += 1) {
    const p = fx.particles[i];
    if (!p.alive) continue;
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (fx.floats.some((f) => f.alive)) {
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < fx.floats.length; i += 1) {
      const f = fx.floats[i];
      if (!f.alive) continue;
      ctx.globalAlpha = Math.min(1, (f.life / FLOAT_LIFE) * 1.6);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  // Alarm vignette: red creeps in from the edges as the meter warms up,
  // and the flash field (lockdown, explosions) punches it harder.
  const alarmGlow = Math.max(0, (state.alarm - 45) / 55) * 0.3;
  const strength = Math.min(0.55, Math.max(fx.flash, alarmGlow));
  if (strength > 0.01) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const gradient = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.36,
      w / 2, h / 2, Math.max(w, h) * 0.72,
    );
    gradient.addColorStop(0, 'rgba(255,45,70,0)');
    gradient.addColorStop(1, `rgba(255,45,70,${strength.toFixed(3)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
