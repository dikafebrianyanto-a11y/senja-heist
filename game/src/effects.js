// Senja Heist — sparks, drifting smoke, floating labels, camera jolts and
// the red alarm wash. Sparks and labels live in fixed-size pools that are
// allocated once by createEffects() and recycled, so a frantic room full
// of vault sparks never churns the garbage collector. Smoke is different:
// a cloud is a short-lived list entry on the shared state, not a pooled
// slot, because clouds are rare and each one carries its own radius.
//
// main.js keeps the object returned by createEffects() on state.fx and
// passes the whole state into every helper here. drawEffects() paints in
// world coordinates (render.js already moved the camera) apart from the
// alarm wash, which is painted in screen coordinates at the very end.

// How many reusable slots each pool holds, and how a label behaves.
const SPARK_CAPACITY = 240;
const LABEL_CAPACITY = 24;
const LABEL_LIFT = 36;
const LABEL_SPAN = 1.1;

// A smoke cloud lives this long, in seconds, from the moment it spawns.
// Clouds are rare, but a careless loop could still spam them, so the list
// is capped — the oldest cloud is dropped when the cap is reached.
const SMOKE_SPAN = 6;
const SMOKE_CAP = 12;

// One blank spark slot; `live` false means the slot is waiting to be used.
function blankSpark() {
  return {
    live: false,
    x: 0, y: 0,
    vx: 0, vy: 0,
    age: 0, span: 1,
    size: 2, color: '#ffffff',
    gravity: 0, drag: 0,
  };
}

// One blank floating-label slot.
function blankLabel() {
  return { live: false, x: 0, y: 0, text: '', color: '#ffffff', age: 0 };
}

export function createEffects() {
  const sparks = [];
  for (let i = 0; i < SPARK_CAPACITY; i += 1) sparks.push(blankSpark());
  const labels = [];
  for (let i = 0; i < LABEL_CAPACITY; i += 1) labels.push(blankLabel());
  return { particles: sparks, floats: labels, shakeT: 0, shakeMag: 0, flash: 0 };
}

// First unused slot in a pool, or null when every slot is busy.
function unusedSlot(pool) {
  for (let i = 0; i < pool.length; i += 1) {
    if (!pool[i].live) return pool[i];
  }
  return null;
}

/**
 * Throw `n` sparks out of (x, y) in every direction — vault clicks,
 * punches, muzzle flashes, the dust a sprinting thief kicks up. Sparks
 * past the pool's capacity are quietly dropped; the caller never waits.
 */
export function burst(state, x, y, color, n) {
  const fx = state.fx;
  if (!fx) return;
  const count = Math.max(0, Math.min(n, 40));
  for (let i = 0; i < count; i += 1) {
    const slot = unusedSlot(fx.particles);
    if (!slot) return;
    const heading = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 190;
    slot.live = true;
    slot.x = x;
    slot.y = y;
    slot.vx = Math.cos(heading) * speed;
    slot.vy = Math.sin(heading) * speed;
    slot.span = 0.3 + Math.random() * 0.45;
    slot.age = slot.span;
    slot.size = 1.5 + Math.random() * 2.5;
    slot.color = color;
    slot.gravity = 160;
    slot.drag = 2.2;
  }
}

/**
 * Drop a smoke cloud at (x, y). The cloud is a plain entry on
 * state.smoke — { x, y, r: 95, t: 6 } — created lazily the first time
 * anything smokes, so states that never smoke carry no smoke list.
 */
export function smokeCloud(state, x, y) {
  if (!state.smoke) state.smoke = [];
  if (state.smoke.length >= SMOKE_CAP) state.smoke.shift();
  state.smoke.push({ x, y, r: 95, t: SMOKE_SPAN });
}

/** A number that rises and fades away, like "+$1,600" above grabbed loot. */
export function floatText(state, x, y, text, color) {
  const fx = state.fx;
  if (!fx) return;
  const slot = unusedSlot(fx.floats) ?? fx.floats[0];
  slot.live = true;
  slot.x = x;
  slot.y = y;
  slot.text = text;
  slot.color = color;
  slot.age = LABEL_SPAN;
}

/** Jolt the camera. A bigger jolt wins over a smaller one; jolts never stack. */
export function shake(state, mag, time) {
  const fx = state.fx;
  if (!fx) return;
  if (mag >= fx.shakeMag || fx.shakeT <= 0) {
    fx.shakeMag = mag;
    fx.shakeT = Math.max(fx.shakeT, time);
  }
}

/**
 * Age everything by dt: sparks fly and die, labels drift upward, smoke
 * clouds thin out, the shake winds down and the red flash fades — except
 * during a lockdown, when the flash throbs instead of fading.
 */
export function stepEffects(state, dt) {
  const fx = state.fx;
  if (!fx) return;
  for (let i = 0; i < fx.particles.length; i += 1) {
    const spark = fx.particles[i];
    if (!spark.live) continue;
    spark.age -= dt;
    if (spark.age <= 0) {
      spark.live = false;
      continue;
    }
    const drag = Math.max(0, 1 - spark.drag * dt);
    spark.vx *= drag;
    spark.vy = spark.vy * drag + spark.gravity * dt;
    spark.x += spark.vx * dt;
    spark.y += spark.vy * dt;
  }
  for (let i = 0; i < fx.floats.length; i += 1) {
    const label = fx.floats[i];
    if (!label.live) continue;
    label.age -= dt;
    if (label.age <= 0) {
      label.live = false;
      continue;
    }
    label.y -= LABEL_LIFT * dt;
  }
  if (state.smoke) {
    for (let i = state.smoke.length - 1; i >= 0; i -= 1) {
      state.smoke[i].t -= dt;
      if (state.smoke[i].t <= 0) state.smoke.splice(i, 1);
    }
  }
  if (fx.shakeT > 0) {
    fx.shakeT -= dt;
    if (fx.shakeT <= 0) {
      fx.shakeT = 0;
      fx.shakeMag = 0;
    }
  }
  if (state.lockdown) {
    fx.flash = Math.max(fx.flash, 0.22 + 0.12 * Math.sin(state.time * 7));
  } else if (fx.flash > 0) {
    fx.flash = Math.max(0, fx.flash - dt * 1.6);
  }
}

/**
 * The offset render.js adds to the camera while a shake is alive: random
 * jitter scaled by the remaining shake, so a punch and an alarm shake
 * with different sizes but the same feel. Pure — no state is touched.
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

/** Paint smoke, sparks and labels in world space, then the alarm wash. */
export function drawEffects(ctx, state) {
  const fx = state.fx;
  if (!fx) return;

  if (state.smoke) {
    for (let i = 0; i < state.smoke.length; i += 1) {
      const cloud = state.smoke[i];
      const fade = Math.max(0, Math.min(1, cloud.t / SMOKE_SPAN));
      if (fade <= 0.01) continue;
      // A few overlapping puffs make one soft blob instead of a hard disc.
      const puffs = [
        { dx: 0, dy: 0, k: 1.0 },
        { dx: -0.42, dy: 0.18, k: 0.62 },
        { dx: 0.45, dy: -0.12, k: 0.58 },
        { dx: 0.1, dy: 0.38, k: 0.5 },
        { dx: -0.2, dy: -0.36, k: 0.48 },
      ];
      for (let j = 0; j < puffs.length; j += 1) {
        const puff = puffs[j];
        ctx.globalAlpha = 0.14 * fade * puff.k;
        ctx.fillStyle = '#8d86a8';
        ctx.beginPath();
        ctx.arc(
          cloud.x + puff.dx * cloud.r,
          cloud.y + puff.dy * cloud.r,
          cloud.r * 0.55 * puff.k,
          0, Math.PI * 2,
        );
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  for (let i = 0; i < fx.particles.length; i += 1) {
    const spark = fx.particles[i];
    if (!spark.live) continue;
    ctx.globalAlpha = Math.max(0, spark.age / spark.span);
    ctx.fillStyle = spark.color;
    ctx.beginPath();
    ctx.arc(spark.x, spark.y, spark.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (fx.floats.some((label) => label.live)) {
    ctx.font = 'bold 17px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < fx.floats.length; i += 1) {
      const label = fx.floats[i];
      if (!label.live) continue;
      ctx.globalAlpha = Math.min(1, (label.age / LABEL_SPAN) * 1.6);
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, label.x, label.y);
    }
    ctx.globalAlpha = 1;
  }

  // Alarm wash: red seeps in from the frame as the meter climbs past 45,
  // and the flash field (lockdown, explosions) pushes it harder still.
  const alarmGlow = Math.max(0, (state.alarm - 45) / 55) * 0.3;
  const strength = Math.min(0.55, Math.max(fx.flash, alarmGlow));
  if (strength > 0.01) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const wash = ctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.36,
      w / 2, h / 2, Math.max(w, h) * 0.72,
    );
    wash.addColorStop(0, 'rgba(255,45,70,0)');
    wash.addColorStop(1, `rgba(255,45,70,${strength.toFixed(3)})`);
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
