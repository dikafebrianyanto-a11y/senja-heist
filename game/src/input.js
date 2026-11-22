// Keyboard + mouse for Kota Senja. Held keys give a move vector; one-shot
// presses (confirm, pause, interact, tools, buy, mute, menu steps) are queued
// as bit flags and taken once by the loop, so a press between two frames is
// never lost and never counted twice. Digit keys are queued the same way, so
// the planning board can read them. The pointer is tracked in canvas pixels;
// the renderer owns the scale that turns them into world pixels.

export const ACT_CONFIRM = 1;
export const ACT_PAUSE = 2;
export const ACT_INTERACT = 4;
export const ACT_EMP = 8;
export const ACT_PUNCH = 16;
export const ACT_SHOOT = 32;
export const ACT_MUTE = 64;
export const ACT_BUY = 128;
export const ACT_UP = 256;
export const ACT_DOWN = 512;

const MOVE_VECTORS = {
  ArrowUp: [0, -1],
  KeyW: [0, -1],
  ArrowDown: [0, 1],
  KeyS: [0, 1],
  ArrowLeft: [-1, 0],
  KeyA: [-1, 0],
  ArrowRight: [1, 0],
  KeyD: [1, 0],
};

const CONFIRM_KEYS = new Set(['Space', 'Enter']);
const PAUSE_KEYS = new Set(['KeyP', 'Escape']);
const CROUCH_KEYS = new Set(['KeyC', 'ControlLeft', 'ControlRight']);
const SPRINT_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

export function createInput(target) {
  const held = new Set();
  const pointer = { x: 0, y: 0, inside: false };
  let actions = 0;
  let digit = 0;

  function press(code) {
    if (CONFIRM_KEYS.has(code)) actions |= ACT_CONFIRM;
    else if (PAUSE_KEYS.has(code)) actions |= ACT_PAUSE;
    else if (code === 'KeyE') actions |= ACT_INTERACT;
    else if (code === 'KeyQ') actions |= ACT_EMP;
    else if (code === 'KeyF') actions |= ACT_PUNCH;
    else if (code === 'KeyM') actions |= ACT_MUTE;
    else if (code === 'KeyB') actions |= ACT_BUY;
    else if (code === 'ArrowUp' || code === 'KeyW') actions |= ACT_UP;
    else if (code === 'ArrowDown' || code === 'KeyS') actions |= ACT_DOWN;
    else if (code.startsWith('Digit')) {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= 9) digit = n;
    }
  }

  window.addEventListener('keydown', (event) => {
    if (MOVE_VECTORS[event.code] || CONFIRM_KEYS.has(event.code) || PAUSE_KEYS.has(event.code)
      || CROUCH_KEYS.has(event.code) || SPRINT_KEYS.has(event.code)
      || ['KeyE', 'KeyQ', 'KeyF', 'KeyM', 'KeyB'].includes(event.code)
      || event.code.startsWith('Digit')) {
      event.preventDefault();
    }
    if (event.repeat) return;
    held.add(event.code);
    press(event.code);
  });
  window.addEventListener('keyup', (event) => {
    held.delete(event.code);
  });
  // A key released while the tab is hidden never sends keyup: let go of everything on blur.
  window.addEventListener('blur', () => {
    held.clear();
  });

  target.addEventListener('pointermove', (event) => {
    const rect = target.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
  });
  target.addEventListener('pointerleave', () => {
    pointer.inside = false;
  });
  target.addEventListener('pointerdown', (event) => {
    const rect = target.getBoundingClientRect();
    pointer.x = event.clientX - rect.left;
    pointer.y = event.clientY - rect.top;
    pointer.inside = true;
    actions |= ACT_CONFIRM;
    if (event.button === 0) actions |= ACT_SHOOT;
  });

  return {
    /** Normalised move vector from WASD / arrows: { x, y }, each -1, 0 or 1, length at most 1. */
    moveVector() {
      let x = 0;
      let y = 0;
      for (const code of held) {
        const v = MOVE_VECTORS[code];
        if (!v) continue;
        x += v[0];
        y += v[1];
      }
      if (x === 0 && y === 0) return { x: 0, y: 0 };
      const len = Math.hypot(x, y);
      return { x: x / len, y: y / len };
    },
    /** True while a crouch key is held. */
    crouching() {
      for (const code of held) if (CROUCH_KEYS.has(code)) return true;
      return false;
    },
    /** True while a sprint key is held. */
    sprinting() {
      for (const code of held) if (SPRINT_KEYS.has(code)) return true;
      return false;
    },
    /** The pointer in canvas pixels, plus whether it is over the canvas. */
    pointer() {
      return pointer;
    },
    /** The one-shot presses since the last call, as ACT_* flags. */
    takeActions() {
      const taken = actions;
      actions = 0;
      return taken;
    },
    /** The last digit key (1-9) pressed since the last call, or 0. */
    takeDigit() {
      const taken = digit;
      digit = 0;
      return taken;
    },
  };
}
