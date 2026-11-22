// A small seeded generator built on xorshift32: the same seed always stages
// the same room, which is what keeps the screenshot scenes repeatable. Each
// handle keeps its own state, so separate streams — city, room, traffic —
// can run side by side without ever stepping on each other's sequence.
// Nothing here touches Math.random, so a run can be replayed exactly.
// The two standalone helpers at the bottom take a stream as their first
// argument, for code that holds the stream outside the handle.

/** Build a seeded stream. `seed` may be any integer; zero falls back to a fixed nonzero start. */
export function createSeeded(seed) { // one stream per seed, replayable forever
  let state = (seed >>> 0) || 0x9e3779b9;

  /** The next value in [0, 1): one xorshift32 step, kept unsigned. */
  function draw() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  } // draw

  /** A float in [low, high). */
  function inRange(low, high) {
    return low + draw() * (high - low);
  } // inRange

  /** A whole number in [low, high], both ends included. */
  function wholeIn(low, high) {
    return Math.floor(low + draw() * (high - low + 1));
  } // wholeIn

  /** One element of a list, each equally likely. */
  function oneOf(list) {
    return list[Math.floor(draw() * list.length)];
  } // oneOf

  /** True with probability `p`, where p runs from 0 to 1. */
  function maybe(p) {
    return draw() < p;
  } // maybe

  /** A shuffled copy of a list; the list handed in is left untouched. */
  function shuffled(list) {
    const deck = [...list];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(draw() * (i + 1));
      const held = deck[i];
      deck[i] = deck[j];
      deck[j] = held;
    } // walk the deck backwards, swapping each card with a random earlier one
    return deck;
  } // shuffled

  const stream = {
    next: draw,
    range: inRange,
    int: wholeIn,
    pick: oneOf,
    chance: maybe,
    shuffle: shuffled,
  }; // stream
  return stream;
} // createSeeded

/** FNV-1a hash of a string, turning a job id plus a seed into one stable stream seed. */
export function hashSeed(label) {
  let acc = 0x811c9dc5;
  for (const ch of label) {
    acc ^= ch.charCodeAt(0);
    acc = Math.imul(acc, 0x01000193);
  } // fold every character into the hash
  return acc >>> 0;
} // hashSeed

/** Pick one element of `array` using the seeded stream `rng`, each equally likely. */
export function pickSeeded(rng, array) {
  if (array.length === 0) return undefined; // nothing to pick from
  const index = Math.floor(rng.next() * array.length);
  return array[index];
} // pickSeeded

/** A shuffled copy of `array` drawn from the seeded stream `rng`; the input is left alone. */
export function shuffleSeeded(rng, array) {
  const deck = [...array];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const held = deck[i];
    deck[i] = deck[j];
    deck[j] = held;
  } // walk the deck backwards, swapping each card with a random earlier one
  return deck;
} // shuffleSeeded
