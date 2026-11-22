// world.js — floorplans for the Senja Heist jobs and the getaway street grid.
//
// Two kinds of place get built here. First, the inside of whatever building
// the crew is hitting: a rectangular floor, ringed by thick outer walls, cut
// up by a few interior dividers that always leave a wide doorway, and
// furnished with low cover the crew can crouch behind. Second, the city the
// getaway drives across: avenues crossing both ways, solid building blocks
// filling the gaps between them, lamps along the kerbs, a start point on the
// west side and a safehouse waiting in the far south-east.
//
// Nothing here keeps state. A seeded stream goes in, the same plan comes
// out every time for the same job and seed, so a screenshot run can replay
// a room exactly. Walls stop both feet and eyes; cover stops feet only, so
// a guard standing behind a display case can still be seen over it. Doors
// are the gaps in the dividers: while open they are just floor, and if one
// ever shuts it becomes solid like a wall.

import { CAMERA, CITY, ROOM } from './config.js';

/** Thickness of the outer shell that rings every room, in pixels. */
const EDGE = 24;

/** How far a drafted point is allowed to wander from its sketched spot. */
const WOBBLE = 18;

/** A rectangle, the shared shape for walls, cover, doors and blocks. */
function box(x, y, w, h) {
  return { x: x, y: y, w: w, h: h };
}

/** A small random nudge, symmetric around zero, from the room's stream. */
function wobble(stream, span) {
  return (stream.next() * 2 - 1) * span;
}

/** True when the point lies inside the box, edges included. */
function inside(px, py, rect) {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/**
 * Liang-Barsky clip: true when the straight run from (x1, y1) to (x2, y2)
 * touches or crosses the box. Sight checks use this against walls alone,
 * never against cover, so furniture never blocks a guard's view.
 */
function rayHitsBox(x1, y1, x2, y2, rect) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let near = 0;
  let far = 1;
  const sides = [
    [-dx, x1 - rect.x],
    [dx, rect.x + rect.w - x1],
    [-dy, y1 - rect.y],
    [dy, rect.y + rect.h - y1],
  ];
  for (const pair of sides) {
    const p = pair[0];
    const q = pair[1];
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const hit = q / p;
      if (p < 0) {
        if (hit > far) return false;
        if (hit > near) near = hit;
      } else {
        if (hit < near) return false;
        if (hit < far) far = hit;
      }
    }
  }
  return true;
}

/**
 * A vertical divider spec: a wall running down `x` from `top` to `bottom`,
 * broken by a doorway centred on `gap` and `wide` pixels across.
 */
function uprightDivider(x, top, bottom, gap, wide, thick) {
  return { along: 'v', fixed: x, from: top, to: bottom, gapAt: gap, gapWide: wide, thick: thick };
}

/**
 * A horizontal divider spec: a wall running across `y` from `left` to
 * `right`, broken by a doorway centred on `gap` and `wide` pixels across.
 */
function flatDivider(y, left, right, gap, wide, thick) {
  return { along: 'h', fixed: y, from: left, to: right, gapAt: gap, gapWide: wide, thick: thick };
}

/**
 * Turn a divider spec into the two solid wall pieces either side of its
 * doorway, jittering the doorway a little so no two runs feel identical.
 */
function splitDivider(stream, spec) {
  const centre = spec.gapAt + wobble(stream, WOBBLE);
  const half = spec.gapWide / 2;
  if (spec.along === 'v') {
    return [
      box(spec.fixed, spec.from, spec.thick, Math.max(8, centre - half - spec.from)),
      box(spec.fixed, centre + half, spec.thick, Math.max(8, spec.to - (centre + half))),
    ];
  }
  return [
    box(spec.from, spec.fixed, Math.max(8, centre - half - spec.from), spec.thick),
    box(centre + half, spec.fixed, Math.max(8, spec.to - (centre + half)), spec.thick),
  ];
}

// ---------------------------------------------------------------------------
// Job floorplans
// ---------------------------------------------------------------------------
//
// Every plan is a sketch for the 1120x640 floor: where the crew slips in,
// where they slip out, which dividers split the floor, what low furniture
// gives cover, where the takings sit, where the vault hides when the job
// has one, which lanes the guards patrol, and where the cameras mount.
// The sketches are drafted generously — every doorway is wide and every
// plan keeps at least two open lanes from entry to exit — so the jitter
// applied at build time can never seal a room shut.

/** The pawnshop: a small shop, split once each way, cases along the walls. */
function planPawnshop() {
  return {
    enter: { x: 78, y: 566 },
    leave: { x: 1042, y: 74 },
    dividers: [
      uprightDivider(430, 60, 580, 320, 150, 16),
      flatDivider(420, 560, 1060, 830, 140, 16),
    ],
    furniture: [
      box(150, 150, 170, 44),
      box(170, 330, 44, 130),
      box(620, 140, 200, 44),
      box(760, 470, 44, 110),
      box(900, 300, 130, 44),
    ],
    kinds: ['cash', 'cash', 'jewels'],
    stash: [
      { x: 250, y: 110 },
      { x: 700, y: 110 },
      { x: 950, y: 480 },
    ],
    vault: null,
    patrols: [
      [{ x: 200, y: 560 }, { x: 200, y: 110 }, { x: 700, y: 110 }, { x: 1000, y: 120 }],
      [{ x: 500, y: 560 }, { x: 520, y: 320 }, { x: 950, y: 250 }, { x: 1020, y: 180 }],
    ],
    mounts: [{ x: 1068, y: 56, angle: Math.PI * 0.82 }],
  };
}

/** The jewellers: long display counters down the middle, gems everywhere. */
function planJewellers() {
  return {
    enter: { x: 78, y: 74 },
    leave: { x: 1042, y: 566 },
    dividers: [
      uprightDivider(620, 60, 580, 200, 140, 16),
      flatDivider(230, 60, 560, 300, 150, 16),
    ],
    furniture: [
      box(240, 300, 220, 46),
      box(330, 420, 46, 130),
      box(760, 150, 46, 150),
      box(820, 400, 170, 46),
      box(180, 480, 130, 44),
    ],
    kinds: ['jewels', 'jewels', 'cash', 'jewels'],
    stash: [
      { x: 350, y: 280 },
      { x: 950, y: 140 },
      { x: 150, y: 460 },
      { x: 900, y: 520 },
    ],
    vault: null,
    patrols: [
      [{ x: 150, y: 200 }, { x: 500, y: 200 }, { x: 620, y: 460 }, { x: 980, y: 520 }],
      [{ x: 350, y: 90 }, { x: 700, y: 90 }, { x: 900, y: 300 }, { x: 1000, y: 520 }],
    ],
    mounts: [
      { x: 56, y: 56, angle: Math.PI * 0.2 },
      { x: 1068, y: 584, angle: -Math.PI * 0.8 },
    ],
  };
}

/** The gallery: three open halls in a row, art on the walls, vault at back. */
function planGallery() {
  return {
    enter: { x: 78, y: 320 },
    leave: { x: 1042, y: 320 },
    dividers: [
      uprightDivider(380, 60, 580, 470, 150, 16),
      uprightDivider(760, 60, 580, 170, 150, 16),
      flatDivider(470, 820, 1060, 950, 120, 16),
    ],
    furniture: [
      box(150, 130, 120, 46),
      box(500, 120, 46, 120),
      box(470, 420, 140, 46),
      box(880, 130, 120, 46),
      box(880, 480, 140, 46),
    ],
    kinds: ['art', 'art', 'cash', 'jewels'],
    stash: [
      { x: 210, y: 110 },
      { x: 560, y: 320 },
      { x: 940, y: 110 },
      { x: 720, y: 550 },
    ],
    vault: { x: 1000, y: 560 },
    patrols: [
      [{ x: 200, y: 320 }, { x: 380, y: 500 }, { x: 700, y: 500 }, { x: 1000, y: 320 }],
      [{ x: 200, y: 320 }, { x: 380, y: 140 }, { x: 700, y: 140 }, { x: 1000, y: 320 }],
    ],
    mounts: [
      { x: 56, y: 56, angle: Math.PI * 0.25 },
      { x: 1068, y: 56, angle: Math.PI * 0.75 },
      { x: 560, y: 584, angle: -Math.PI * 0.5 },
    ],
  };
}

/** The bank: a teller hall, a back office, and the vault cage up top. */
function planBank() {
  return {
    enter: { x: 78, y: 566 },
    leave: { x: 1042, y: 74 },
    dividers: [
      uprightDivider(480, 60, 580, 300, 140, 18),
      uprightDivider(800, 60, 580, 480, 140, 18),
      flatDivider(200, 830, 1060, 950, 130, 18),
      flatDivider(470, 60, 420, 240, 140, 18),
    ],
    furniture: [
      box(160, 130, 180, 46),
      box(560, 120, 46, 150),
      box(560, 400, 180, 46),
      box(880, 300, 46, 140),
      box(180, 330, 46, 130),
    ],
    kinds: ['cash', 'gold', 'cash', 'data', 'gold'],
    stash: [
      { x: 250, y: 110 },
      { x: 640, y: 320 },
      { x: 940, y: 480 },
      { x: 940, y: 140 },
      { x: 250, y: 520 },
    ],
    vault: { x: 1010, y: 120 },
    patrols: [
      [{ x: 200, y: 560 }, { x: 300, y: 300 }, { x: 640, y: 300 }, { x: 900, y: 140 }, { x: 1010, y: 90 }],
      [{ x: 420, y: 560 }, { x: 480, y: 480 }, { x: 800, y: 480 }, { x: 950, y: 320 }, { x: 1010, y: 140 }],
    ],
    mounts: [
      { x: 56, y: 56, angle: Math.PI * 0.2 },
      { x: 1068, y: 56, angle: Math.PI * 0.8 },
      { x: 56, y: 584, angle: -Math.PI * 0.25 },
      { x: 1068, y: 584, angle: -Math.PI * 0.75 },
    ],
  };
}

/** The museum: a grand hall down the middle, wings on both sides. */
function planMuseum() {
  return {
    enter: { x: 560, y: 586 },
    leave: { x: 560, y: 54 },
    dividers: [
      uprightDivider(360, 60, 580, 180, 140, 18),
      uprightDivider(760, 60, 580, 460, 140, 18),
      flatDivider(320, 60, 340, 200, 130, 18),
      flatDivider(320, 780, 1060, 920, 130, 18),
    ],
    furniture: [
      box(120, 120, 140, 46),
      box(200, 420, 46, 130),
      box(500, 240, 120, 46),
      box(850, 120, 140, 46),
      box(880, 420, 46, 130),
      box(500, 470, 120, 46),
    ],
    kinds: ['art', 'gold', 'art', 'jewels', 'data', 'art'],
    stash: [
      { x: 190, y: 100 },
      { x: 560, y: 220 },
      { x: 920, y: 100 },
      { x: 1010, y: 520 },
      { x: 130, y: 540 },
      { x: 560, y: 420 },
    ],
    vault: { x: 1040, y: 90 },
    patrols: [
      [{ x: 560, y: 540 }, { x: 360, y: 460 }, { x: 360, y: 180 }, { x: 560, y: 120 }],
      [{ x: 560, y: 540 }, { x: 760, y: 460 }, { x: 760, y: 180 }, { x: 560, y: 120 }],
      [{ x: 560, y: 540 }, { x: 560, y: 320 }, { x: 560, y: 120 }],
    ],
    mounts: [
      { x: 56, y: 56, angle: Math.PI * 0.25 },
      { x: 1068, y: 56, angle: Math.PI * 0.75 },
      { x: 56, y: 584, angle: -Math.PI * 0.2 },
      { x: 1068, y: 584, angle: -Math.PI * 0.8 },
      { x: 560, y: 56, angle: Math.PI * 0.5 },
    ],
  };
}

/**
 * The casino: one big gaming floor. Three rows of slot machines run across
 * the room with open lanes between them, a long bar sits in the middle, and
 * the cashier cage — two dividers closing off the top-right corner — hides
 * the vault behind it. The crew comes in at the bottom-left doors and slips
 * out through the service door at the top-right, right past the cage. Both
 * cage dividers leave a wide doorway, so the vault is never locked behind a
 * single choke point, and one taking sits inside the cage itself for the
 * crew willing to go in after the vault.
 */
function planCasino() {
  return {
    enter: { x: 78, y: 566 },
    leave: { x: 1042, y: 74 },
    dividers: [
      uprightDivider(880, 60, 300, 240, 130, 16),
      flatDivider(300, 880, 1060, 980, 130, 16),
    ],
    furniture: [
      box(150, 140, 170, 44),
      box(400, 140, 170, 44),
      box(650, 140, 170, 44),
      box(470, 270, 180, 46),
      box(150, 330, 170, 44),
      box(400, 330, 170, 44),
      box(650, 330, 170, 44),
      box(150, 480, 170, 44),
      box(400, 480, 170, 44),
      box(650, 480, 170, 44),
      box(900, 330, 140, 44),
    ],
    kinds: ['cash', 'cash', 'gold', 'cash', 'jewels'],
    stash: [
      { x: 250, y: 110 },
      { x: 600, y: 110 },
      { x: 250, y: 420 },
      { x: 600, y: 560 },
      { x: 960, y: 230 },
    ],
    vault: { x: 990, y: 190 },
    patrols: [
      [{ x: 120, y: 560 }, { x: 120, y: 120 }, { x: 560, y: 120 }, { x: 1000, y: 120 }],
      [{ x: 500, y: 560 }, { x: 520, y: 420 }, { x: 950, y: 420 }, { x: 1020, y: 200 }],
      [{ x: 900, y: 560 }, { x: 900, y: 420 }, { x: 700, y: 250 }, { x: 300, y: 120 }],
    ],
    mounts: [
      { x: 56, y: 56, angle: Math.PI * 0.2 },
      { x: 1068, y: 584, angle: -Math.PI * 0.8 },
      { x: 560, y: 56, angle: Math.PI * 0.5 },
      { x: 1068, y: 320, angle: Math.PI },
    ],
  };
}

/**
 * The penthouse: a luxury flat on the top floor. The lounge stays wide open
 * — long sofas, a grand piano, planters — so sightlines run the whole room,
 * while a divider splits off the bedroom wing on the right and a second one
 * closes the study in the top-right corner, where the vault sits. The exit
 * is the balcony door at the top-right, past the study. Because the lounge
 * has only two dividers, a guard standing at one end can watch the other;
 * the piano and sofas are the only honest cover, so the crew crosses the
 * open floor between patrols rather than hugging walls.
 */
function planPenthouse() {
  return {
    enter: { x: 78, y: 566 },
    leave: { x: 1042, y: 74 },
    dividers: [
      uprightDivider(700, 60, 580, 320, 150, 16),
      flatDivider(360, 700, 1060, 880, 140, 16),
    ],
    furniture: [
      box(170, 140, 230, 50),
      box(170, 430, 230, 50),
      box(450, 270, 190, 70),
      box(640, 110, 44, 44),
      box(640, 500, 44, 44),
      box(470, 130, 130, 44),
      box(850, 430, 170, 50),
    ],
    kinds: ['jewels', 'art', 'cash', 'gold', 'jewels'],
    stash: [
      { x: 300, y: 110 },
      { x: 560, y: 210 },
      { x: 950, y: 150 },
      { x: 900, y: 540 },
      { x: 250, y: 540 },
    ],
    vault: { x: 1000, y: 140 },
    patrols: [
      [{ x: 120, y: 560 }, { x: 120, y: 120 }, { x: 600, y: 120 }, { x: 1000, y: 120 }],
      [{ x: 560, y: 560 }, { x: 660, y: 320 }, { x: 950, y: 320 }, { x: 1000, y: 200 }],
      [{ x: 900, y: 560 }, { x: 660, y: 500 }, { x: 300, y: 320 }, { x: 300, y: 120 }],
    ],
    mounts: [
      { x: 56, y: 584, angle: -Math.PI * 0.2 },
      { x: 1068, y: 56, angle: Math.PI * 0.8 },
      { x: 560, y: 56, angle: Math.PI * 0.5 },
    ],
  };
}

/** A plain two-lane room for any job id with no sketch of its own yet. */
function planGeneric() {
  return {
    enter: { x: 78, y: 566 },
    leave: { x: 1042, y: 74 },
    dividers: [
      uprightDivider(560, 60, 580, 320, 160, 16),
    ],
    furniture: [
      box(200, 150, 160, 44),
      box(700, 400, 160, 44),
    ],
    kinds: ['cash', 'jewels'],
    stash: [
      { x: 300, y: 130 },
      { x: 900, y: 500 },
    ],
    vault: null,
    patrols: [
      [{ x: 200, y: 560 }, { x: 200, y: 200 }, { x: 900, y: 150 }],
      [{ x: 500, y: 560 }, { x: 560, y: 320 }, { x: 1000, y: 200 }],
    ],
    mounts: [{ x: 1068, y: 56, angle: Math.PI * 0.75 }],
  };
}

/** Job id to sketch function. Unknown ids fall back to the generic room. */
const PLANS = {
  pawnshop: planPawnshop,
  jewellers: planJewellers,
  gallery: planGallery,
  bank: planBank,
  museum: planMuseum,
  casino: planCasino,
  penthouse: planPenthouse,
};

/** The four thick walls that close a room off from the outside. */
function perimeterWalls() {
  return [
    box(0, 0, ROOM.width, EDGE),
    box(0, ROOM.height - EDGE, ROOM.width, EDGE),
    box(0, 0, EDGE, ROOM.height),
    box(ROOM.width - EDGE, 0, EDGE, ROOM.height),
  ];
}

/**
 * Steps a spot must try, in order, when it lands on solid ground: the four
 * compass directions close by, then further out, then the diagonals. The
 * first open tile wins.
 */
const ESCAPE_STEPS = [
  [0, -44], [44, 0], [0, 44], [-44, 0],
  [0, -88], [88, 0], [0, 88], [-88, 0],
  [64, -64], [-64, -64], [64, 64], [-64, 64],
];

/**
 * Stage one job's interior from its sketch. Guards walk the sketched lanes
 * — each guard takes the next lane, wrapping round when the lanes run out —
 * and cameras sit on the sketched mounts, again wrapping if a big job
 * staffs more cameras than there are mounts. Counts come from the job, so a
 * bigger crew simply fills more of the same floor.
 */
export function buildRoom(stream, job) {
  const sketch = (PLANS[job?.id] ?? planGeneric)();
  const walls = perimeterWalls();
  for (const spec of sketch.dividers) {
    walls.push(...splitDivider(stream, spec));
  }
  const cover = sketch.furniture.map((piece) => ({
    x: piece.x + wobble(stream, WOBBLE),
    y: piece.y + wobble(stream, WOBBLE),
    w: piece.w,
    h: piece.h,
  }));
  const doors = sketch.dividers.map((spec) => {
    if (spec.along === 'v') {
      return { x: spec.fixed - 8, y: spec.gapAt - spec.gapWide / 2, w: 32, h: spec.gapWide, open: true };
    }
    return { x: spec.gapAt - spec.gapWide / 2, y: spec.fixed - 8, w: spec.gapWide, h: 32, open: true };
  });
  const lootSpots = sketch.kinds.map((kind, i) => {
    const at = sketch.stash[i % sketch.stash.length];
    return { x: at.x + wobble(stream, WOBBLE), y: at.y + wobble(stream, WOBBLE), kind: kind };
  });
  const guardTotal = Math.max(0, job?.guards ?? 0);
  const guardPosts = [];
  // Hand the lanes out round-robin: guard zero takes lane zero, guard one
  // takes lane one, and once the lanes run out they start again from the
  // top, so a seven-guard casino still patrols the same three lanes.
  for (let i = 0; i < guardTotal; i += 1) {
    const lane = sketch.patrols[i % sketch.patrols.length];
    const route = lane.map((p) => ({ x: p.x + wobble(stream, WOBBLE), y: p.y + wobble(stream, WOBBLE) }));
    guardPosts.push({ x: route[0].x, y: route[0].y, route: route });
  }
  const camTotal = Math.max(0, job?.cameras ?? 0);
  const camPosts = [];
  for (let i = 0; i < camTotal; i += 1) {
    const mount = sketch.mounts[i % sketch.mounts.length];
    camPosts.push({
      x: mount.x + wobble(stream, 6),
      y: mount.y + wobble(stream, 6),
      angle: mount.angle + wobble(stream, 0.12),
      sweep: CAMERA.sweep,
    });
  }
  const vaultSpot = sketch.vault && job?.vault
    ? { x: sketch.vault.x + wobble(stream, 8), y: sketch.vault.y + wobble(stream, 8) }
    : null;
  const room = {
    name: job?.target ?? 'Kota Senja',
    w: ROOM.width,
    h: ROOM.height,
    entry: { x: sketch.enter.x, y: sketch.enter.y },
    exit: { x: sketch.leave.x, y: sketch.leave.y },
    walls: walls,
    cover: cover,
    doors: doors,
    lootSpots: lootSpots,
    vaultSpot: vaultSpot,
    guardPosts: guardPosts,
    camPosts: camPosts,
  };
  // Jitter can shove a taking onto a case or into a wall. Walk each spot
  // that landed on solid ground out to the nearest open tile, so every
  // valuable in the room is always standing somewhere reachable. Entry,
  // exit and vault spots are sketched clear of walls and cover on purpose,
  // so they never need this rescue — only the jittered loot does.
  for (const spot of room.lootSpots) {
    if (!roomSolidAt(room, spot.x, spot.y)) continue;
    for (const step of ESCAPE_STEPS) {
      if (!roomSolidAt(room, spot.x + step[0], spot.y + step[1])) {
        spot.x += step[0];
        spot.y += step[1];
        break;
      }
    }
  }
  return room;
}

/**
 * True when the point cannot be stood on: outside the room, inside a wall,
 * inside a piece of cover, or inside a door that has shut. Open doors are
 * just floor.
 */
export function roomSolidAt(room, px, py) {
  if (room == null) return true;
  if (px < 0 || py < 0 || px > room.w || py > room.h) return true;
  for (const slab of room.walls) {
    if (inside(px, py, slab)) return true;
  }
  for (const piece of room.cover) {
    if (inside(px, py, piece)) return true;
  }
  for (const door of room.doors ?? []) {
    if (!door.open && inside(px, py, door)) return true;
  }
  return false;
}

/** True when a straight sight line between two points crosses any wall. */
export function losBlocked(room, x1, y1, x2, y2) {
  if (room == null) return true;
  for (const slab of room.walls) {
    if (rayHitsBox(x1, y1, x2, y2, slab)) return true;
  }
  return false;
}

/** The room's exit, as a fresh point. */
export function roomExit(room) { return { x: room.exit.x, y: room.exit.y }; }

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------

/** East-west road bands and north-south road bands across the 2560x1600 map. */
const AVENUES_EW = [
  { from: 240, to: 350 },
  { from: 745, to: 855 },
  { from: 1250, to: 1360 },
];
const AVENUES_NS = [
  { from: 430, to: 540 },
  { from: 1225, to: 1335 },
  { from: 1980, to: 2090 },
];

/**
 * The stretches of open ground between road bands: from the map's edge to
 * the first band, between each pair of bands, and from the last band to the
 * far edge. Buildings sit inside these stretches, never on a road.
 */
function gapsBetween(bands, total, edge, clearance) {
  const spans = [];
  let start = edge;
  for (const band of bands) {
    spans.push({ from: start, to: band.from - clearance });
    start = band.to + clearance;
  }
  spans.push({ from: start, to: total - edge });
  return spans;
}

/**
 * Lay out the getaway grid: three avenues each way, building blocks filling
 * the cells between them, lamps along the kerbs, the crew starting on the
 * west end of the middle avenue and the safehouse waiting on the far
 * south-east road — a long drive across the whole map.
 */
export function buildCity(stream) {
  const roads = [];
  for (const band of AVENUES_EW) {
    roads.push({ x: 0, y: band.from, w: CITY.width, h: band.to - band.from, dir: 'h' });
  }
  for (const band of AVENUES_NS) {
    roads.push({ x: band.from, y: 0, w: band.to - band.from, h: CITY.height, dir: 'v' });
  }
  const columns = gapsBetween(AVENUES_NS, CITY.width, 60, 30);
  const rows = gapsBetween(AVENUES_EW, CITY.height, 60, 30);
  const blocks = [];
  for (const column of columns) {
    for (const row of rows) {
      // Now and then leave a cell open as a plaza, so the grid is not one
      // unbroken wall of rooftops.
      if (stream.chance(0.12)) continue;
      const inset = 14 + stream.next() * 18;
      blocks.push({
        x: column.from + inset,
        y: row.from + inset,
        w: column.to - column.from - inset * 2,
        h: row.to - row.from - inset * 2,
      });
    }
  }
  const lamps = [];
  // One lamp pair per stretch of kerb on every avenue, both sides of the
  // road, so the getaway drive is lit end to end and no avenue goes dark.
  for (const band of AVENUES_EW) {
    for (let x = 180; x < CITY.width; x += 260) {
      lamps.push({ x: x + wobble(stream, 20), y: band.from - 14 });
      lamps.push({ x: x + 130 + wobble(stream, 20), y: band.to + 14 });
    }
  }
  for (const band of AVENUES_NS) {
    for (let y = 180; y < CITY.height; y += 300) {
      lamps.push({ x: band.from - 14, y: y + wobble(stream, 20) });
    }
  }
  return {
    w: CITY.width,
    h: CITY.height,
    roads: roads,
    blocks: blocks,
    lamps: lamps,
    spawn: { x: 300, y: 800 },
    carSpawn: { x: 380, y: 800 },
    safehouse: { x: 2280, y: 1305 },
  };
}

/** True when the point is inside a building block or outside the city. */
export function citySolidAt(city, px, py) {
  if (city == null) return true;
  if (px < 0 || py < 0 || px > city.w || py > city.h) return true;
  for (const block of city.blocks) {
    if (inside(px, py, block)) return true;
  }
  return false;
}

/** The safehouse, as a fresh point. */
export function citySafehouse(city) { return { x: city.safehouse.x, y: city.safehouse.y }; }
