// A small seeded generator (xorshift32): the same seed stages the same room,
// which is what makes the screenshot scenes repeatable. The handle carries
// its own state, so several streams (city, room, traffic) can run apart
// without stepping on each other's sequence.

export function createSeeded(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;

  /** Next value in [0, 1). */
  function next() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  }

  return {
    next,
    /** A float in [min, max). */
    range(min, max) {
      return min + next() * (max - min);
    },
    /** An integer in [min, max], both ends included. */
    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },
    /** One element of a list, uniformly. */
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    /** True with probability `p` (0 to 1). */
    chance(p) {
      return next() < p;
    },
    /** A shuffled copy of a list, in place on the copy. */
    shuffle(list) {
      const copy = list.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
      }
      return copy;
    },
  };
}

/** FNV-1a over a string, so a job id plus a seed makes a stable stream seed. */
export function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
