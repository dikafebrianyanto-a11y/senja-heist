// Keyboard and pointer input for Kota Senja. Held keys produce a move
// vector; one-shot presses (confirm, pause, interact, tools, buy, mute,
// menu steps) are queued as bit flags and taken once by the game loop, so
// a press landing between two frames is never lost and never counted
// twice. Digit keys are queued the same way for the planning board. The
// pointer is tracked in canvas pixels; the renderer owns the scale that
// turns those into world pixels. Q is shared: it raises the EMP flag and
// the smoke flag together, so code that only watches ACT_EMP sees exactly
// the behaviour it always did.

// One-shot action flags, queued by keydown and consumed once per frame.
export const ACT_CONFIRM = 1; // Space / Enter / click
export const ACT_PAUSE = 2; // P / Escape
export const ACT_INTERACT = 4; // E
export const ACT_EMP = 8; // Q
export const ACT_PUNCH = 16; // F
export const ACT_SHOOT = 32; // left click
export const ACT_MUTE = 64; // M
export const ACT_BUY = 128; // B
export const ACT_UP = 256; // Up / W
export const ACT_DOWN = 512; // Down / S
export const ACT_SMOKE = 1024; // Q — smoke bomb, fired together with the EMP

// Movement steps per key: [code, x, y]. Arrows and WASD share directions.
const MOVE_STEPS = [
  ['ArrowUp', 0, -1], ['KeyW', 0, -1],
  ['ArrowDown', 0, 1], ['KeyS', 0, 1],
  ['ArrowLeft', -1, 0], ['KeyA', -1, 0],
  ['ArrowRight', 1, 0], ['KeyD', 1, 0],
];
const MOVE_VECTORS = new Map(
  MOVE_STEPS.map(([code, x, y]) => [code, { x, y }]),
);

// One-shot key bindings: code -> action flag(s). Q raises both the EMP and
// the smoke flag so the old EMP behaviour is unchanged.
const KEY_ACTIONS = new Map([
  ['Space', ACT_CONFIRM], ['Enter', ACT_CONFIRM],
  ['KeyP', ACT_PAUSE], ['Escape', ACT_PAUSE],
  ['KeyE', ACT_INTERACT],
  ['KeyQ', ACT_EMP | ACT_SMOKE],
  ['KeyF', ACT_PUNCH],
  ['KeyM', ACT_MUTE],
  ['KeyB', ACT_BUY],
  ['ArrowUp', ACT_UP], ['KeyW', ACT_UP],
  ['ArrowDown', ACT_DOWN], ['KeyS', ACT_DOWN],
]);

const CONFIRM_CODES = new Set(['Space', 'Enter']);
const PAUSE_CODES = new Set(['KeyP', 'Escape']);
const CROUCH_CODES = new Set(['KeyC', 'ControlLeft', 'ControlRight']);
const SPRINT_CODES = new Set(['ShiftLeft', 'ShiftRight']);

// Every code the game handles, so keydown can swallow the browser default.
const HANDLED_CODES = new Set([
  ...MOVE_VECTORS.keys(),
  ...CONFIRM_CODES, ...PAUSE_CODES, ...CROUCH_CODES, ...SPRINT_CODES,
  'KeyE', 'KeyQ', 'KeyF', 'KeyM', 'KeyB',
]);

export function createInput(target) { // target: the canvas element to listen on
  const held = new Set(); // codes currently pressed
  const pointer = { x: 0, y: 0, inside: false }; // pointer in canvas pixels
  let actions = 0; // queued one-shot flags
  let digit = 0; // last digit key pressed, 1-9, or 0

  /** Queue the digit-key press (1-9) for the planning board. */
  function queueDigit(code) {
    const value = Number(code.slice('Digit'.length));
    if (value >= 1 && value <= 9) digit = value;
  }

  /** Queue the one-shot action(s) bound to a key, if any. */
  function queueAction(code) {
    if (!code) return; // defensive: a key event without a code queues nothing
    const action = KEY_ACTIONS.get(code);
    if (action !== undefined) actions |= action;
    else if (code.startsWith('Digit')) queueDigit(code); // planning-board queue
  }

  /** True while any code in the given set is held down. */
  function anyHeld(codes) {
    for (const code of held) if (codes.has(code)) return true;
    return false;
  }

  /** Update the pointer from a pointer event, in canvas pixels. */
  function trackPointer(event) {
    const bounds = target.getBoundingClientRect();
    pointer.x = event.clientX - bounds.left;
    pointer.y = event.clientY - bounds.top;
    pointer.inside = true;
  }

  function onKeyDown(event) {
    const code = event.code;
    if (HANDLED_CODES.has(code) || code.startsWith('Digit')) {
      event.preventDefault();
    }
    if (event.repeat) return; // ignore auto-repeat
    held.add(code);
    queueAction(code);
  }

  function onKeyUp(event) {
    held.delete(event.code);
  }

  // A key released while the tab is hidden never sends keyup: let go of
  // everything on blur so the crew does not keep walking on its own.
  function onBlur() {
    held.clear();
  }

  function onPointerDown(event) {
    trackPointer(event);
    actions |= ACT_CONFIRM; // a click counts as confirm
    if (event.button === 0) actions |= ACT_SHOOT; // left click fires
  }

  function onPointerLeave() {
    pointer.inside = false; // no longer over the canvas
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  target.addEventListener('pointermove', trackPointer);
  target.addEventListener('pointerleave', onPointerLeave);
  target.addEventListener('pointerdown', onPointerDown);

  return {
    /** Normalised move vector from WASD / arrows: { x, y }, length at most 1. */
    moveVector() { // normalised WASD / arrows vector
      let x = 0, y = 0; // summed direction
      for (const code of held) {
        const step = MOVE_VECTORS.get(code);
        if (step) { x += step.x; y += step.y; }
      }
      if (x === 0 && y === 0) return { x: 0, y: 0 }; // standing still
      const length = Math.hypot(x, y);
      return { x: x / length, y: y / length };
    },
    /** True while a crouch key is held. */
    crouching() { return anyHeld(CROUCH_CODES); },
    /** True while a sprint key is held. */
    sprinting() { return anyHeld(SPRINT_CODES); },
    /** The pointer in canvas pixels, plus whether it is over the canvas. */
    pointer() { return pointer; },
    /** The one-shot presses since the last call, as ACT_* flags. */
    takeActions() {
      const queued = actions;
      actions = 0;
      return queued;
    },
    /** The last digit key (1-9) pressed since the last call, or 0. */
    takeDigit() {
      const queued = digit;
      digit = 0;
      return queued;
    },
  };
}
