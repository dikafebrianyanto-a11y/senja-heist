// world.js — Kota Senja floorplans and street map for SENJA HEIST.
//
// Builds the two places the crew works in: the interior of each job's
// target (a top-down room with walls, cover, doors, loot and a vault corner)
// and the street grid the getaway drives through. Everything here is pure
// geometry over a seeded stream, so the same job + seed always stages the
// same room. Walls block both movement and sight; cover blocks movement
// only, so a crouched thief can hide behind a display case but a guard
// can still see over it. Every room is laid out with at least two open
// lanes from entry to exit, so no single door or patrol ever seals the job.

import { ROOM, CITY, CAMERA } from './config.js';

/** Outer wall thickness, in pixels. */
const SHELL = 24;

/** How far a seeded value may wander from its drafted position. */
const JITTER = 18;

/** Small drift applied to a drafted coordinate by the room's stream. */
function drift(rng, amount) {
  return (rng.next() * 2 - 1) * amount;
}

/** True when the point sits inside the rectangle (edges count as inside). */
function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

/**
 * Liang-Barsky clip test: true when the segment (ax,ay)-(bx,by) touches
 * or crosses the rectangle. Used for line-of-sight against walls only.
 */
function segmentHitsRect(ax, ay, bx, by, rect) {
  const dx = bx - ax;
  const dy = by - ay;
  let low = 0;
  let high = 1;
  const edges = [
    [-dx, ax - rect.x],
    [dx, rect.x + rect.w - ax],
    [-dy, ay - rect.y],
    [dy, rect.y + rect.h - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > high) return false;
        if (t > low) low = t;
      } else {
        if (t < low) return false;
        if (t < high) high = t;
      }
    }
  }
  return true;
}

/**
 * One interior partition, drawn as two wall segments with a gap between
 * them. `along` is 'v' (a vertical wall, gap at `gapY`) or 'h'.
 */
function splitWall(rng, along, fixed, from, to, gapAt, gapWide, thick) {
  const g = gapAt + drift(rng, JITTER);
  const half = gapWide / 2;
  if (along === 'v') {
    return [
      { x: fixed, y: from, w: thick, h: Math.max(8, g - half - from) },
      { x: fixed, y: g + half, w: thick, h: Math.max(8, to - (g + half)) },
    ];
  }
  return [
    { x: from, y: fixed, w: Math.max(8, g - half - from), h: thick },
    { x: g + half, y: fixed, w: Math.max(8, to - (g + half)), h: thick },
  ];
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Drafted floorplan per job: where the crew comes in, where they leave,
 * which rooms the interior is split into, and where the valuables sit.
 * Coordinates are drafted for the 1120x640 room and jittered at build
 * time; every partition leaves a wide gap, so each plan keeps at least
 * two lanes open between entry and exit.
 */
const FLOOR_DRAFTS = {
  pawnshop: {
    entry: { x: 78, y: 566 },
    exit: { x: 1042, y: 74 },
    partitions: [
      { along: 'v', fixed: 430, from: 60, to: 580, gapAt: 320, gapWide: 150, thick: 16 },
      { along: 'h', fixed: 420, from: 560, to: 1060, gapAt: 830, gapWide: 140, thick: 16 },
    ],
    cover: [
      { x: 150, y: 150, w: 170, h: 44 },
      { x: 170, y: 330, w: 44, h: 130 },
      { x: 620, y: 140, w: 200, h: 44 },
      { x: 760, y: 470, w: 44, h: 110 },
      { x: 900, y: 300, w: 130, h: 44 },
    ],
    lootKinds: ['cash', 'cash', 'jewels'],
    lootAt: [
      { x: 250, y: 110 },
      { x: 700, y: 110 },
      { x: 950, y: 480 },
    ],
    vaultAt: null,
    lanes: [
      [{ x: 200, y: 560 }, { x: 200, y: 110 }, { x: 700, y: 110 }, { x: 1000, y: 120 }],
      [{ x: 500, y: 560 }, { x: 520, y: 320 }, { x: 950, y: 250 }, { x: 1020, y: 180 }],
    ],
    camAt: [{ x: 1068, y: 56, angle: Math.PI * 0.82 }],
  },
  jewellers: {
    entry: { x: 78, y: 74 },
    exit: { x: 1042, y: 566 },
    partitions: [
      { along: 'v', fixed: 620, from: 60, to: 580, gapAt: 200, gapWide: 140, thick: 16 },
      { along: 'h', fixed: 230, from: 60, to: 560, gapAt: 300, gapWide: 150, thick: 16 },
    ],
    cover: [
      { x: 240, y: 300, w: 220, h: 46 },
      { x: 330, y: 420, w: 46, h: 130 },
      { x: 760, y: 150, w: 46, h: 150 },
      { x: 820, y: 400, w: 170, h: 46 },
      { x: 180, y: 480, w: 130, h: 44 },
    ],
    lootKinds: ['jewels', 'jewels', 'cash', 'jewels'],
    lootAt: [
      { x: 350, y: 280 },
      { x: 950, y: 140 },
      { x: 150, y: 460 },
      { x: 900, y: 520 },
    ],
    vaultAt: null,
    lanes: [
      [{ x: 150, y: 200 }, { x: 500, y: 200 }, { x: 620, y: 460 }, { x: 980, y: 520 }],
      [{ x: 350, y: 90 }, { x: 700, y: 90 }, { x: 900, y: 300 }, { x: 1000, y: 520 }],
    ],
    camAt: [
      { x: 56, y: 56, angle: Math.PI * 0.2 },
      { x: 1068, y: 584, angle: -Math.PI * 0.8 },
    ],
  },
  gallery: {
    entry: { x: 78, y: 320 },
    exit: { x: 1042, y: 320 },
    partitions: [
      { along: 'v', fixed: 380, from: 60, to: 580, gapAt: 470, gapWide: 150, thick: 16 },
      { along: 'v', fixed: 760, from: 60, to: 580, gapAt: 170, gapWide: 150, thick: 16 },
      { along: 'h', fixed: 470, from: 820, to: 1060, gapAt: 950, gapWide: 120, thick: 16 },
    ],
    cover: [
      { x: 150, y: 130, w: 120, h: 46 },
      { x: 500, y: 120, w: 46, h: 120 },
      { x: 470, y: 420, w: 140, h: 46 },
      { x: 880, y: 130, w: 120, h: 46 },
      { x: 880, y: 480, w: 140, h: 46 },
    ],
    lootKinds: ['art', 'art', 'cash', 'jewels'],
    lootAt: [
      { x: 210, y: 110 },
      { x: 560, y: 320 },
      { x: 940, y: 110 },
      { x: 720, y: 550 },
    ],
    vaultAt: { x: 1000, y: 560 },
    lanes: [
      [{ x: 200, y: 320 }, { x: 380, y: 500 }, { x: 700, y: 500 }, { x: 1000, y: 320 }],
      [{ x: 200, y: 320 }, { x: 380, y: 140 }, { x: 700, y: 140 }, { x: 1000, y: 320 }],
    ],
    camAt: [
      { x: 56, y: 56, angle: Math.PI * 0.25 },
      { x: 1068, y: 56, angle: Math.PI * 0.75 },
      { x: 560, y: 584, angle: -Math.PI * 0.5 },
    ],
  },
  bank: {
    entry: { x: 78, y: 566 },
    exit: { x: 1042, y: 74 },
    partitions: [
      { along: 'v', fixed: 480, from: 60, to: 580, gapAt: 300, gapWide: 140, thick: 18 },
      { along: 'v', fixed: 800, from: 60, to: 580, gapAt: 480, gapWide: 140, thick: 18 },
      { along: 'h', fixed: 200, from: 830, to: 1060, gapAt: 950, gapWide: 130, thick: 18 },
      { along: 'h', fixed: 470, from: 60, to: 420, gapAt: 240, gapWide: 140, thick: 18 },
    ],
    cover: [
      { x: 160, y: 130, w: 180, h: 46 },
      { x: 560, y: 120, w: 46, h: 150 },
      { x: 560, y: 400, w: 180, h: 46 },
      { x: 880, y: 300, w: 46, h: 140 },
      { x: 180, y: 330, w: 46, h: 130 },
    ],
    lootKinds: ['cash', 'gold', 'cash', 'data', 'gold'],
    lootAt: [
      { x: 250, y: 110 },
      { x: 640, y: 320 },
      { x: 940, y: 480 },
      { x: 940, y: 140 },
      { x: 250, y: 520 },
    ],
    vaultAt: { x: 1010, y: 120 },
    lanes: [
      [{ x: 200, y: 560 }, { x: 300, y: 300 }, { x: 640, y: 300 }, { x: 900, y: 140 }, { x: 1010, y: 90 }],
      [{ x: 420, y: 560 }, { x: 480, y: 480 }, { x: 800, y: 480 }, { x: 950, y: 320 }, { x: 1010, y: 140 }],
    ],
    camAt: [
      { x: 56, y: 56, angle: Math.PI * 0.2 },
      { x: 1068, y: 56, angle: Math.PI * 0.8 },
      { x: 56, y: 584, angle: -Math.PI * 0.25 },
      { x: 1068, y: 584, angle: -Math.PI * 0.75 },
    ],
  },
  museum: {
    entry: { x: 560, y: 586 },
    exit: { x: 560, y: 54 },
    partitions: [
      { along: 'v', fixed: 360, from: 60, to: 580, gapAt: 180, gapWide: 140, thick: 18 },
      { along: 'v', fixed: 760, from: 60, to: 580, gapAt: 460, gapWide: 140, thick: 18 },
      { along: 'h', fixed: 320, from: 60, to: 340, gapAt: 200, gapWide: 130, thick: 18 },
      { along: 'h', fixed: 320, from: 780, to: 1060, gapAt: 920, gapWide: 130, thick: 18 },
    ],
    cover: [
      { x: 120, y: 120, w: 140, h: 46 },
      { x: 200, y: 420, w: 46, h: 130 },
      { x: 500, y: 240, w: 120, h: 46 },
      { x: 850, y: 120, w: 140, h: 46 },
      { x: 880, y: 420, w: 46, h: 130 },
      { x: 500, y: 470, w: 120, h: 46 },
    ],
    lootKinds: ['art', 'gold', 'art', 'jewels', 'data', 'art'],
    lootAt: [
      { x: 190, y: 100 },
      { x: 560, y: 220 },
      { x: 920, y: 100 },
      { x: 1010, y: 520 },
      { x: 130, y: 540 },
      { x: 560, y: 420 },
    ],
    vaultAt: { x: 1040, y: 90 },
    lanes: [
      [{ x: 560, y: 540 }, { x: 360, y: 460 }, { x: 360, y: 180 }, { x: 560, y: 120 }],
      [{ x: 560, y: 540 }, { x: 760, y: 460 }, { x: 760, y: 180 }, { x: 560, y: 120 }],
      [{ x: 560, y: 540 }, { x: 560, y: 320 }, { x: 560, y: 120 }],
    ],
    camAt: [
      { x: 56, y: 56, angle: Math.PI * 0.25 },
      { x: 1068, y: 56, angle: Math.PI * 0.75 },
      { x: 56, y: 584, angle: -Math.PI * 0.2 },
      { x: 1068, y: 584, angle: -Math.PI * 0.8 },
      { x: 560, y: 56, angle: Math.PI * 0.5 },
    ],
  },
};

/** Fallback draft for a job id the table does not know yet. */
const GENERIC_DRAFT = {
  entry: { x: 78, y: 566 },
  exit: { x: 1042, y: 74 },
  partitions: [
    { along: 'v', fixed: 560, from: 60, to: 580, gapAt: 320, gapWide: 160, thick: 16 },
  ],
  cover: [
    { x: 200, y: 150, w: 160, h: 44 },
    { x: 700, y: 400, w: 160, h: 44 },
  ],
  lootKinds: ['cash', 'jewels'],
  lootAt: [
    { x: 300, y: 130 },
    { x: 900, y: 500 },
  ],
  vaultAt: null,
  lanes: [
    [{ x: 200, y: 560 }, { x: 200, y: 200 }, { x: 900, y: 150 }],
    [{ x: 500, y: 560 }, { x: 560, y: 320 }, { x: 1000, y: 200 }],
  ],
  camAt: [{ x: 1068, y: 56, angle: Math.PI * 0.75 }],
};

/** The four outer walls that close the room. */
function shellWalls() {
  return [
    { x: 0, y: 0, w: ROOM.width, h: SHELL },
    { x: 0, y: ROOM.height - SHELL, w: ROOM.width, h: SHELL },
    { x: 0, y: 0, w: SHELL, h: ROOM.height },
    { x: ROOM.width - SHELL, y: 0, w: SHELL, h: ROOM.height },
  ];
}

/**
 * Build one job's interior. Guard posts walk the drafted lanes (each
 * guard gets its own lane, wrapping when the lanes run out); camera posts
 * sit on the drafted mounts. Counts come from the job, so a bigger job
 * simply staffs more of the same floor.
 */
export function buildRoom(rng, job) {
  const draft = FLOOR_DRAFTS[job?.id] ?? GENERIC_DRAFT;
  const walls = shellWalls();
  for (const part of draft.partitions) {
    walls.push(...splitWall(rng, part.along, part.fixed, part.from, part.to, part.gapAt, part.gapWide, part.thick));
  }
  const cover = draft.cover.map((c) => ({
    x: c.x + drift(rng, JITTER),
    y: c.y + drift(rng, JITTER),
    w: c.w,
    h: c.h,
  }));
  const doors = draft.partitions.map((part) => {
    if (part.along === 'v') {
      return { x: part.fixed - 8, y: part.gapAt - part.gapWide / 2, w: 32, h: part.gapWide, open: true };
    }
    return { x: part.gapAt - part.gapWide / 2, y: part.fixed - 8, w: part.gapWide, h: 32, open: true };
  });
  const lootSpots = draft.lootKinds.map((kind, i) => {
    const at = draft.lootAt[i % draft.lootAt.length];
    return { x: at.x + drift(rng, JITTER), y: at.y + drift(rng, JITTER), kind };
  });
  const guardCount = Math.max(0, job?.guards ?? 0);
  const guardPosts = [];
  for (let i = 0; i < guardCount; i += 1) {
    const lane = draft.lanes[i % draft.lanes.length];
    const route = lane.map((p) => ({ x: p.x + drift(rng, JITTER), y: p.y + drift(rng, JITTER) }));
    guardPosts.push({ x: route[0].x, y: route[0].y, route });
  }
  const camCount = Math.max(0, job?.cameras ?? 0);
  const camPosts = [];
  for (let i = 0; i < camCount; i += 1) {
    const mount = draft.camAt[i % draft.camAt.length];
    camPosts.push({
      x: mount.x + drift(rng, 6),
      y: mount.y + drift(rng, 6),
      angle: mount.angle + drift(rng, 0.12),
      sweep: CAMERA.sweep,
    });
  }
  const vaultSpot = draft.vaultAt && job?.vault
    ? { x: draft.vaultAt.x + drift(rng, 8), y: draft.vaultAt.y + drift(rng, 8) }
    : null;
  const room = {
    name: job?.target ?? 'Kota Senja',
    w: ROOM.width,
    h: ROOM.height,
    entry: { x: draft.entry.x, y: draft.entry.y },
    exit: { x: draft.exit.x, y: draft.exit.y },
    walls,
    cover,
    doors,
    lootSpots,
    vaultSpot,
    guardPosts,
    camPosts,
  };
  // Seeded jitter can push a loot spot into a case or a wall. Nudge any
  // spot that landed on solid ground out to the nearest open floor, so
  // every valuable is always standing on walkable tiles.
  const nudges = [
    [0, -44], [44, 0], [0, 44], [-44, 0],
    [0, -88], [88, 0], [0, 88], [-88, 0],
    [64, -64], [-64, -64], [64, 64], [-64, 64],
  ];
  for (const spot of room.lootSpots) {
    if (!roomSolidAt(room, spot.x, spot.y)) continue;
    for (const [dx, dy] of nudges) {
      if (!roomSolidAt(room, spot.x + dx, spot.y + dy)) {
        spot.x += dx;
        spot.y += dy;
        break;
      }
    }
  }
  return room;
}

/** True when the point is inside a wall, a piece of cover, or a shut door, or outside the room. */
export function roomSolidAt(room, x, y) {
  if (!room) return true;
  if (x < 0 || y < 0 || x > room.w || y > room.h) return true;
  for (const wall of room.walls) if (pointInRect(x, y, wall)) return true;
  for (const piece of room.cover) if (pointInRect(x, y, piece)) return true;
  for (const door of room.doors ?? []) {
    if (!door.open && pointInRect(x, y, door)) return true;
  }
  return false;
}

/** True when the sight line between two points crosses any wall. Cover never blocks sight. */
export function losBlocked(room, ax, ay, bx, by) {
  if (!room) return true;
  for (const wall of room.walls) {
    if (segmentHitsRect(ax, ay, bx, by, wall)) return true;
  }
  return false;
}

/** The room's exit, as a fresh point. */
export function roomExit(room) {
  return { x: room.exit.x, y: room.exit.y };
}

// ---------------------------------------------------------------------------
// City
// ---------------------------------------------------------------------------

/** Horizontal road bands and vertical road bands across the 2560x1600 map. */
const ROAD_BANDS_H = [
  { from: 240, to: 350 },
  { from: 745, to: 855 },
  { from: 1250, to: 1360 },
];
const ROAD_BANDS_V = [
  { from: 430, to: 540 },
  { from: 1225, to: 1335 },
  { from: 1980, to: 2090 },
];

/**
 * Build the getaway grid: three avenues each way, building blocks filling
 * the cells between them, lamps along the kerbs, the crew's start on the
 * west end of the middle avenue and the safehouse on the far south-east
 * road — a long drive across the whole map.
 */
export function buildCity(rng) {
  const roads = [];
  for (const band of ROAD_BANDS_H) {
    roads.push({ x: 0, y: band.from, w: CITY.width, h: band.to - band.from, dir: 'h' });
  }
  for (const band of ROAD_BANDS_V) {
    roads.push({ x: band.from, y: 0, w: band.to - band.from, h: CITY.height, dir: 'v' });
  }
  const cellXs = [
    { from: 60, to: ROAD_BANDS_V[0].from - 30 },
    { from: ROAD_BANDS_V[0].to + 30, to: ROAD_BANDS_V[1].from - 30 },
    { from: ROAD_BANDS_V[1].to + 30, to: ROAD_BANDS_V[2].from - 30 },
    { from: ROAD_BANDS_V[2].to + 30, to: CITY.width - 60 },
  ];
  const cellYs = [
    { from: 60, to: ROAD_BANDS_H[0].from - 30 },
    { from: ROAD_BANDS_H[0].to + 30, to: ROAD_BANDS_H[1].from - 30 },
    { from: ROAD_BANDS_H[1].to + 30, to: ROAD_BANDS_H[2].from - 30 },
    { from: ROAD_BANDS_H[2].to + 30, to: CITY.height - 60 },
  ];
  const blocks = [];
  for (const cx of cellXs) {
    for (const cy of cellYs) {
      // Leave an occasional open plaza so the grid is not a solid wall of roofs.
      if (rng.chance(0.12)) continue;
      const inset = 14 + rng.next() * 18;
      blocks.push({
        x: cx.from + inset,
        y: cy.from + inset,
        w: cx.to - cx.from - inset * 2,
        h: cy.to - cy.from - inset * 2,
      });
    }
  }
  const lamps = [];
  for (const band of ROAD_BANDS_H) {
    for (let x = 180; x < CITY.width; x += 260) {
      lamps.push({ x: x + drift(rng, 20), y: band.from - 14 });
      lamps.push({ x: x + 130 + drift(rng, 20), y: band.to + 14 });
    }
  }
  for (const band of ROAD_BANDS_V) {
    for (let y = 180; y < CITY.height; y += 300) {
      lamps.push({ x: band.from - 14, y: y + drift(rng, 20) });
    }
  }
  return {
    w: CITY.width,
    h: CITY.height,
    roads,
    blocks,
    lamps,
    spawn: { x: 300, y: 800 },
    carSpawn: { x: 380, y: 800 },
    safehouse: { x: 2280, y: 1305 },
  };
}

/** True when the point is inside a building block or outside the city. */
export function citySolidAt(city, x, y) {
  if (!city) return true;
  if (x < 0 || y < 0 || x > city.w || y > city.h) return true;
  for (const block of city.blocks) if (pointInRect(x, y, block)) return true;
  return false;
}

/** The safehouse, as a fresh point. */
export function citySafehouse(city) {
  return { x: city.safehouse.x, y: city.safehouse.y };
}
