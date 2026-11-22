// Senja Heist — everything you hear is synthesized live. No audio files
// and no network: each sound is an oscillator or a burst of filtered
// noise built on an AudioContext that only exists after the first user
// gesture. createAudio() just builds the bookkeeping object; the context
// itself is made in audioUnlock(), which main.js calls from the first
// pointerdown / keydown listener, because browsers block audio before
// that first gesture.
//
// The bed adapts to the screen: a quiet low pad on the title and planning
// board, a tense pad with a heartbeat that quickens as the alarm climbs
// during the heist, and a driving pulse with an engine hum and a two-tone
// siren in the getaway while the police are chasing. The mixer is kept
// deliberately low — well under half volume.

// Mix levels.
const MIX_MASTER = 0.42;
const MIX_PAD = 0.05;
const MIX_PULSE = 0.16;
const MIX_SIREN = 0.035;
const MIX_ENGINE = 0.04;

// Heartbeat spacing in seconds, from a calm room to one at full alarm.
const BEAT_CALM = 0.95;
const BEAT_HOT = 0.26;

/** The audio handle main.js keeps on state.audio. */
export function createAudio() {
  return {
    ctx: null,
    master: null,
    muted: false,
    // Bed voices, built once the context exists and kept alive across
    // screens so the music never restarts mid-phrase.
    pad: null,
    siren: null,
    engine: null,
    // Bookkeeping the bed advances in audioStep().
    pulseIn: 0,
    bedMode: 'off',
  };
}

/**
 * Build the context and master gain on first use; on later calls just
 * wake a suspended context. Returns the context, or null when the
 * browser has no WebAudio at all.
 */
function openContext(audio) {
  if (audio.ctx) {
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    return audio.ctx;
  }
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = audio.muted ? 0 : MIX_MASTER;
  master.connect(ctx.destination);
  audio.ctx = ctx;
  audio.master = master;
  return ctx;
}

export function audioUnlock(audio) {
  openContext(audio);
}

/**
 * One oscillator note with a fast attack and an exponential tail. A
 * falling `toHz` makes a pitch drop; pass the same pitch twice for a
 * steady tone. `delay` schedules the note in the future.
 */
function tone(audio, type, fromHz, toHz, seconds, level, delay = 0) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, fromHz), start);
  if (toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), start + seconds);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  osc.connect(gain);
  gain.connect(audio.master);
  osc.start(start);
  osc.stop(start + seconds + 0.05);
}

/**
 * A short wash of white noise through a band-pass filter, optionally
 * sweeping its centre frequency down (or up) over its lifetime.
 */
function noise(audio, seconds, level, centreHz, sweepToHz = 0, delay = 0) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  const start = ctx.currentTime + delay;
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(centreHz, start);
  if (sweepToHz > 0) filter.frequency.exponentialRampToValueAtTime(sweepToHz, start + seconds);
  filter.Q.value = 0.9;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audio.master);
  source.start(start);
  source.stop(start + seconds + 0.05);
}

/** Start the looping pad: two detuned triangles under a low-pass filter. */
function beginPad(audio) {
  const ctx = audio.ctx;
  if (!ctx || audio.pad) return;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;
  const root = ctx.createOscillator();
  root.type = 'triangle';
  root.frequency.value = 55;
  const fifth = ctx.createOscillator();
  fifth.type = 'triangle';
  fifth.frequency.value = 82.4;
  root.connect(filter);
  fifth.connect(filter);
  filter.connect(gain);
  gain.connect(audio.master);
  root.start();
  fifth.start();
  audio.pad = { gain, filter, oscillators: [root, fifth] };
}

/** Start the getaway engine: a sawtooth whose pitch follows the car. */
function beginEngine(audio) {
  const ctx = audio.ctx;
  if (!ctx || audio.engine) return;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 420;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 62;
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(audio.master);
  osc.start();
  audio.engine = { gain, osc };
}

/** Start the police wail: a sine whose pitch rocks on a slow LFO. */
function beginSiren(audio) {
  const ctx = audio.ctx;
  if (!ctx || audio.siren) return;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 720;
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.55;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 260;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  osc.connect(gain);
  gain.connect(audio.master);
  osc.start();
  lfo.start();
  audio.siren = { gain, oscillators: [osc, lfo] };
}

/** Fade a bed voice out and stop its oscillators shortly afterwards. */
function silenceVoice(voice) {
  if (!voice) return;
  if (voice.gain) voice.gain.gain.setTargetAtTime(0, voice.gain.context.currentTime, 0.08);
  const oscillators = voice.oscillators ?? (voice.osc ? [voice.osc] : []);
  for (const osc of oscillators) {
    try { osc.stop(voice.gain.context.currentTime + 0.5); } catch { /* already stopped */ }
  }
}

/** One low thump: the heartbeat the heist and getaway beds run on. */
function heartbeat(audio, level) {
  tone(audio, 'sine', 96, 42, 0.22, level);
}

/**
 * A soft whoosh for a smoke canister venting: low-passed noise that swells
 * in over a tenth of a second and sighs out over the rest — no sharp
 * attack, so it sits underneath the action instead of cutting through it.
 */
function ventWhoosh(audio) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  const start = ctx.currentTime;
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.7));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(500, start);
  filter.frequency.exponentialRampToValueAtTime(180, start + 0.7);
  filter.Q.value = 0.6;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.1, start + 0.12);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.7);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(audio.master);
  source.start(start);
  source.stop(start + 0.75);
}

/**
 * Advance the adaptive bed one frame. `state` is the shared game state;
 * the bed reads only `screen`, `alarm`, `police.siren` and `car.speed`,
 * and it stays silent while muted or before the first gesture.
 */
export function audioStep(audio, state, dt) {
  if (!audio.ctx || audio.muted) return;
  const ctx = audio.ctx;
  const screen = state.screen;
  const inHeist = screen === 'heist';
  const inGetaway = screen === 'getaway';
  const onMenu = screen === 'title' || screen === 'plan';

  const mode = inGetaway ? 'chase' : inHeist ? 'tense' : onMenu ? 'calm' : 'off';
  if (mode !== audio.bedMode) {
    audio.bedMode = mode;
    if (mode === 'off') {
      silenceVoice(audio.pad);
      audio.pad = null;
      silenceVoice(audio.engine);
      audio.engine = null;
      silenceVoice(audio.siren);
      audio.siren = null;
    }
  }
  if (mode === 'off') return;

  // The pad runs on every live screen; only its colour changes.
  beginPad(audio);
  const tension = inHeist ? Math.min(1, state.alarm / 100) : inGetaway ? 0.75 : 0;
  const padTarget = onMenu ? MIX_PAD * 0.7 : MIX_PAD * (0.8 + tension * 0.9);
  audio.pad.gain.gain.setTargetAtTime(padTarget, ctx.currentTime, 0.4);
  audio.pad.filter.frequency.setTargetAtTime(280 + tension * 900, ctx.currentTime, 0.4);

  // The heartbeat quickens with the alarm and stays brisk in the chase.
  if (inHeist || inGetaway) {
    const spacing = inGetaway ? 0.42 : BEAT_CALM + (BEAT_HOT - BEAT_CALM) * tension;
    audio.pulseIn -= dt;
    if (audio.pulseIn <= 0) {
      audio.pulseIn = spacing;
      heartbeat(audio, MIX_PULSE * (0.7 + tension * 0.5));
    }
  }

  // Engine hum follows the getaway car; the siren follows the pursuit.
  if (inGetaway) {
    beginEngine(audio);
    const speedRatio = state.car ? Math.min(1, Math.abs(state.car.speed) / 540) : 0;
    audio.engine.gain.gain.setTargetAtTime(MIX_ENGINE * (0.4 + speedRatio), ctx.currentTime, 0.2);
    audio.engine.osc.frequency.setTargetAtTime(58 + speedRatio * 96, ctx.currentTime, 0.15);
    const chasing = Boolean(state.police && state.police.siren);
    if (chasing) {
      beginSiren(audio);
      audio.siren.gain.gain.setTargetAtTime(MIX_SIREN, ctx.currentTime, 0.3);
    } else if (audio.siren) {
      audio.siren.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    }
  } else {
    if (audio.engine) {
      audio.engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    }
    if (audio.siren) {
      audio.siren.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
    }
  }
}

/** Play one named effect. Silent before unlock, silent while muted. */
export function sfx(audio, name) {
  if (!audio || !audio.ctx || audio.muted || !audio.master) return;
  switch (name) {
    case 'click':
      tone(audio, 'square', 840, 660, 0.06, 0.05);
      break;
    case 'pickup':
      tone(audio, 'sine', 660, 660, 0.09, 0.09);
      tone(audio, 'sine', 990, 990, 0.12, 0.09, 0.07);
      break;
    case 'cash':
      tone(audio, 'triangle', 1174, 1174, 0.07, 0.08);
      tone(audio, 'triangle', 1568, 1568, 0.1, 0.08, 0.06);
      tone(audio, 'triangle', 2093, 2093, 0.14, 0.07, 0.12);
      break;
    case 'crack':
      noise(audio, 0.08, 0.12, 2600);
      tone(audio, 'square', 190, 120, 0.07, 0.06);
      break;
    case 'pin':
      tone(audio, 'sine', 1320, 1320, 0.1, 0.1);
      tone(audio, 'sine', 1760, 1760, 0.16, 0.08, 0.05);
      break;
    case 'vault':
      tone(audio, 'sine', 130, 52, 0.5, 0.16);
      noise(audio, 0.35, 0.06, 300, 90);
      tone(audio, 'triangle', 392, 392, 0.2, 0.07, 0.28);
      break;
    case 'door':
      tone(audio, 'sawtooth', 120, 210, 0.28, 0.05);
      noise(audio, 0.2, 0.04, 500, 240);
      break;
    case 'alarm':
      tone(audio, 'square', 620, 620, 0.14, 0.07);
      tone(audio, 'square', 830, 830, 0.14, 0.07, 0.16);
      break;
    case 'lockdown':
      tone(audio, 'sawtooth', 440, 880, 0.5, 0.09);
      tone(audio, 'sawtooth', 466, 932, 0.5, 0.09, 0.12);
      noise(audio, 0.5, 0.05, 1200, 300);
      break;
    case 'emp':
      noise(audio, 0.55, 0.14, 3200, 140);
      tone(audio, 'sine', 880, 110, 0.5, 0.07);
      break;
    case 'smoke':
      ventWhoosh(audio);
      break;
    case 'levelup':
      // A short rising arpeggio: four bright notes climbing an octave.
      tone(audio, 'triangle', 523, 523, 0.1, 0.09);
      tone(audio, 'triangle', 659, 659, 0.1, 0.09, 0.09);
      tone(audio, 'triangle', 784, 784, 0.1, 0.09, 0.18);
      tone(audio, 'triangle', 1047, 1047, 0.22, 0.1, 0.27);
      break;
    case 'hit':
      tone(audio, 'sine', 150, 60, 0.16, 0.14);
      noise(audio, 0.1, 0.08, 400);
      break;
    case 'shot':
      noise(audio, 0.09, 0.16, 1800, 500);
      tone(audio, 'sine', 220, 70, 0.12, 0.12);
      break;
    case 'busted':
      tone(audio, 'triangle', 392, 392, 0.22, 0.09);
      tone(audio, 'triangle', 311, 311, 0.22, 0.09, 0.2);
      tone(audio, 'triangle', 233, 220, 0.5, 0.1, 0.4);
      break;
    case 'siren':
      tone(audio, 'sine', 700, 990, 0.4, 0.06);
      tone(audio, 'sine', 990, 700, 0.4, 0.06, 0.42);
      break;
    default:
      break;
  }
}

export function setMuted(audio, muted) {
  if (!audio) return;
  audio.muted = muted;
  if (audio.master && audio.ctx) {
    audio.master.gain.setTargetAtTime(muted ? 0 : MIX_MASTER, audio.ctx.currentTime, 0.05);
  }
}
