// Senja Heist — synthesized sound. No audio files, no network: every noise
// below is an oscillator or a burst of filtered noise built on a lazily
// created AudioContext. Browsers refuse an AudioContext before the first
// user gesture, so createAudio() only builds the bookkeeping object; the
// context itself appears in audioUnlock(), which main.js calls from the
// first pointerdown / keydown listener.
//
// The bed is adaptive: a calm low pad on the title and planning board, a
// tense pad with a heartbeat pulse in the heist that quickens as the alarm
// climbs, and a driving pulse with an engine hum and a two-tone siren in
// the getaway while the police are chasing. Everything stays quiet on
// purpose — the mixer sits well under half volume.

const MASTER_LEVEL = 0.42;
const PAD_LEVEL = 0.05;
const PULSE_LEVEL = 0.16;
const SIREN_LEVEL = 0.035;
const ENGINE_LEVEL = 0.04;

// Pulse spacing, in seconds, from a calm room to a room at full alarm.
const PULSE_CALM = 0.95;
const PULSE_HOT = 0.26;

/** The audio handle main.js keeps on state.audio. */
export function createAudio() {
  return {
    ctx: null,
    master: null,
    muted: false,
    // Bed voices, created once the context exists and kept alive across
    // screens so the music never restarts mid-phrase.
    pad: null,
    siren: null,
    engine: null,
    // Timers the bed advances in audioStep().
    pulseIn: 0,
    bedMode: 'off',
  };
}

/** Build the context and the master gain, then resume it if suspended. */
function ensureContext(audio) {
  if (audio.ctx) {
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
    return audio.ctx;
  }
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) return null;
  const ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = audio.muted ? 0 : MASTER_LEVEL;
  master.connect(ctx.destination);
  audio.ctx = ctx;
  audio.master = master;
  return ctx;
}

export function audioUnlock(audio) {
  ensureContext(audio);
}

/** A one-shot oscillator with an attack/decay envelope. */
function blip(audio, type, fromHz, toHz, seconds, level, delay = 0) {
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

/** A short burst of white noise through a band-pass filter. */
function hiss(audio, seconds, level, centreHz, sweepToHz = 0, delay = 0) {
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

/** Start a looping pad voice: two detuned triangles under a low-pass. */
function startPad(audio) {
  const ctx = audio.ctx;
  if (!ctx || audio.pad) return;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;
  const low = ctx.createOscillator();
  low.type = 'triangle';
  low.frequency.value = 55;
  const fifth = ctx.createOscillator();
  fifth.type = 'triangle';
  fifth.frequency.value = 82.4;
  low.connect(filter);
  fifth.connect(filter);
  filter.connect(gain);
  gain.connect(audio.master);
  low.start();
  fifth.start();
  audio.pad = { gain, filter, oscillators: [low, fifth] };
}

/** Start the getaway engine: a sawtooth whose pitch follows the car. */
function startEngine(audio) {
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
function startSiren(audio) {
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

function stopVoice(voice) {
  if (!voice) return;
  if (voice.gain) voice.gain.gain.setTargetAtTime(0, voice.gain.context.currentTime, 0.08);
  const oscillators = voice.oscillators ?? (voice.osc ? [voice.osc] : []);
  for (const osc of oscillators) {
    try { osc.stop(voice.gain.context.currentTime + 0.5); } catch { /* already stopped */ }
  }
}

/** One low thump: the heartbeat the heist and getaway beds run on. */
function thump(audio, level) {
  blip(audio, 'sine', 96, 42, 0.22, level);
}

/**
 * Advance the adaptive bed one frame. `state` is the shared game state;
 * the bed reads only `screen`, `alarm`, `police.siren` and `car.speed`,
 * and it does nothing at all while muted or before the first gesture.
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
      stopVoice(audio.pad);
      audio.pad = null;
      stopVoice(audio.engine);
      audio.engine = null;
      stopVoice(audio.siren);
      audio.siren = null;
    }
  }
  if (mode === 'off') return;

  // The pad runs on every live screen; it only changes colour.
  startPad(audio);
  const tension = inHeist ? Math.min(1, state.alarm / 100) : inGetaway ? 0.75 : 0;
  const padTarget = onMenu ? PAD_LEVEL * 0.7 : PAD_LEVEL * (0.8 + tension * 0.9);
  audio.pad.gain.gain.setTargetAtTime(padTarget, ctx.currentTime, 0.4);
  audio.pad.filter.frequency.setTargetAtTime(280 + tension * 900, ctx.currentTime, 0.4);

  // The heartbeat quickens with the alarm and stays brisk in the chase.
  if (inHeist || inGetaway) {
    const spacing = inGetaway ? 0.42 : PULSE_CALM + (PULSE_HOT - PULSE_CALM) * tension;
    audio.pulseIn -= dt;
    if (audio.pulseIn <= 0) {
      audio.pulseIn = spacing;
      thump(audio, PULSE_LEVEL * (0.7 + tension * 0.5));
    }
  }

  // Engine hum follows the getaway car; the siren follows the pursuit.
  if (inGetaway) {
    startEngine(audio);
    const speedRatio = state.car ? Math.min(1, Math.abs(state.car.speed) / 540) : 0;
    audio.engine.gain.gain.setTargetAtTime(ENGINE_LEVEL * (0.4 + speedRatio), ctx.currentTime, 0.2);
    audio.engine.osc.frequency.setTargetAtTime(58 + speedRatio * 96, ctx.currentTime, 0.15);
    const chasing = Boolean(state.police && state.police.siren);
    if (chasing) {
      startSiren(audio);
      audio.siren.gain.gain.setTargetAtTime(SIREN_LEVEL, ctx.currentTime, 0.3);
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
      blip(audio, 'square', 840, 660, 0.06, 0.05);
      break;
    case 'pickup':
      blip(audio, 'sine', 660, 660, 0.09, 0.09);
      blip(audio, 'sine', 990, 990, 0.12, 0.09, 0.07);
      break;
    case 'cash':
      blip(audio, 'triangle', 1174, 1174, 0.07, 0.08);
      blip(audio, 'triangle', 1568, 1568, 0.1, 0.08, 0.06);
      blip(audio, 'triangle', 2093, 2093, 0.14, 0.07, 0.12);
      break;
    case 'crack':
      hiss(audio, 0.08, 0.12, 2600);
      blip(audio, 'square', 190, 120, 0.07, 0.06);
      break;
    case 'pin':
      blip(audio, 'sine', 1320, 1320, 0.1, 0.1);
      blip(audio, 'sine', 1760, 1760, 0.16, 0.08, 0.05);
      break;
    case 'vault':
      blip(audio, 'sine', 130, 52, 0.5, 0.16);
      hiss(audio, 0.35, 0.06, 300, 90);
      blip(audio, 'triangle', 392, 392, 0.2, 0.07, 0.28);
      break;
    case 'door':
      blip(audio, 'sawtooth', 120, 210, 0.28, 0.05);
      hiss(audio, 0.2, 0.04, 500, 240);
      break;
    case 'alarm':
      blip(audio, 'square', 620, 620, 0.14, 0.07);
      blip(audio, 'square', 830, 830, 0.14, 0.07, 0.16);
      break;
    case 'lockdown':
      blip(audio, 'sawtooth', 440, 880, 0.5, 0.09);
      blip(audio, 'sawtooth', 466, 932, 0.5, 0.09, 0.12);
      hiss(audio, 0.5, 0.05, 1200, 300);
      break;
    case 'emp':
      hiss(audio, 0.55, 0.14, 3200, 140);
      blip(audio, 'sine', 880, 110, 0.5, 0.07);
      break;
    case 'hit':
      blip(audio, 'sine', 150, 60, 0.16, 0.14);
      hiss(audio, 0.1, 0.08, 400);
      break;
    case 'shot':
      hiss(audio, 0.09, 0.16, 1800, 500);
      blip(audio, 'sine', 220, 70, 0.12, 0.12);
      break;
    case 'busted':
      blip(audio, 'triangle', 392, 392, 0.22, 0.09);
      blip(audio, 'triangle', 311, 311, 0.22, 0.09, 0.2);
      blip(audio, 'triangle', 233, 220, 0.5, 0.1, 0.4);
      break;
    case 'siren':
      blip(audio, 'sine', 700, 990, 0.4, 0.06);
      blip(audio, 'sine', 990, 700, 0.4, 0.06, 0.42);
      break;
    default:
      break;
  }
}

export function setMuted(audio, muted) {
  if (!audio) return;
  audio.muted = muted;
  if (audio.master && audio.ctx) {
    audio.master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, audio.ctx.currentTime, 0.05);
  }
}
