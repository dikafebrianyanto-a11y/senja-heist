// Senja Heist — every tuning number and colour in one place.
//
// The playfield is a fixed 1280x720 logical area; the renderer scales it to
// the window, so no rule below depends on the screen size. Kota Senja is a
// harbour city after dark: indigo streets, amber windows, teal neon. Safe
// cover reads dark blue, danger reads red or amber, loot reads gold — the
// player should be able to read a room at a glance.

export const VIEW = { width: 1280, height: 720 };

/** The simulation's fixed step, in seconds: 60 updates a second whatever the display's rate. */
export const STEP = 1 / 60;

/** The screens main.js moves between. hud.js draws the panel for each one. */
export const SCREEN = {
  TITLE: 'title',
  PLAN: 'plan',
  HEIST: 'heist',
  GETAWAY: 'getaway',
  PAUSE: 'pause',
  BUSTED: 'busted',
  PAYOUT: 'payout',
};

/** Logical size of one heist interior, and of the street map around it. */
export const ROOM = { width: 1120, height: 640 };
export const CITY = { width: 2560, height: 1600 };

export const PALETTE = {
  backdrop: '#07081a',
  panel: '#12152e',
  panelEdge: '#2a2f55',
  floor: '#191d33',
  floorAlt: '#1e2340',
  wall: '#31365e',
  wallTop: '#454b7d',
  cover: '#262b4a',
  door: '#3d3468',
  street: '#101223',
  road: '#1a1d31',
  roadLine: '#3a3f66',
  sidewalk: '#232744',
  loot: '#f5c542',
  lootGlow: 'rgba(245,197,66,0.28)',
  thief: '#7ee0c3',
  thiefDark: '#3fae8d',
  guard: '#ff5d5d',
  guardCone: 'rgba(255,93,93,0.16)',
  guardConeEdge: 'rgba(255,93,93,0.38)',
  camera: '#ffb454',
  cameraCone: 'rgba(255,180,84,0.15)',
  police: '#5aa9ff',
  policeLight: '#ff4d4d',
  text: '#eef0ff',
  muted: '#8a90b8',
  accent: '#ffb454',
  safe: '#57d977',
  danger: '#ff4d6d',
  carPlayer: '#7ee0c3',
  carTraffic: '#9aa0c4',
  carPolice: '#5aa9ff',
};

export const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Mara, the thief the player drives. Speeds are pixels per second. */
export const THIEF = {
  walk: 178,
  crouch: 96,
  sprint: 238,
  radius: 13,
  hp: 100,
  punchRange: 36,
  punchDamage: 34,
  ammoStart: 6,
  ammoMax: 12,
  /** Noise radius the thief throws while moving: crouch, walk, sprint. */
  noiseCrouch: 10,
  noiseWalk: 26,
  noiseSprint: 62,
  /** Extra weight (kg) that starts slowing the thief down. */
  weightSlowsAt: 6,
  weightSlowPerKg: 9,
};

/** Patrol guards: how fast they walk, how far they see, how fast they turn on you. */
export const GUARD = {
  patrol: 64,
  chase: 150,
  search: 92,
  sight: 255,
  /** Half of the vision cone, in radians. */
  halfCone: 0.5,
  suspicionPerSecond: 1.4,
  loseSeconds: 4,
  catchRange: 26,
  punchDamage: 20,
};

/** Wall cameras: sweeping cones that spot the thief and feed the alarm. */
export const CAMERA = {
  range: 265,
  halfCone: 0.4,
  /** How far, in radians, the cone swings from its base angle. */
  sweep: 1.05,
  sweepSpeed: 0.5,
  /** Seconds of being watched before the camera counts it as a spot. */
  spotSeconds: 1.1,
};

/** The alarm meter, 0 to 100. At 100 the room locks down and the police come. */
export const ALARM = {
  riseSeen: 30,
  riseCamera: 22,
  riseNoise: 9,
  decay: 4.5,
  suspectAt: 45,
  lockdownAt: 100,
  lockdownSeconds: 14,
};

/** The vault timing game: a needle sweeps, pins lock in the gold window. */
export const VAULT = {
  pins: 4,
  window: 0.17,
  needleSpeed: 1.7,
  missAlarm: 16,
  /** With the silent drill the needle runs slower and the window runs wider. */
  drillWindow: 0.24,
  drillNeedle: 1.25,
};

/** The getaway car: arcade top-down driving with a little drift. */
export const CAR = {
  accel: 430,
  topSpeed: 540,
  reverse: 170,
  grip: 3.4,
  turn: 2.7,
  hp: 100,
  ramDamage: 22,
};

/** Police response, driven by the heat level 0 to 5. */
export const POLICE = {
  chaseSpeed: 552,
  spawnGap: 5.5,
  maxUnits: 4,
  ramDamage: 14,
  searchSeconds: 7,
};

/** Heat: what raises it, and how fast it cools once the crew is clear. */
export const HEAT = {
  perLockdown: 1,
  perShot: 1,
  coolPerSecond: 0.05,
  max: 5,
};

/** The planning-board shop. `charges` is how many a purchase carries. */
export const TOOLS = {
  lockpick: {
    cost: 150,
    name: 'Lockpick set',
    desc: 'Doors open instantly; the vault forgives one missed pin.',
  },
  emp: {
    cost: 400,
    name: 'EMP pulse',
    desc: 'Blinds every camera for 8 seconds. 3 charges.',
    charges: 3,
  },
  disguise: {
    cost: 350,
    name: 'Crew disguise',
    desc: 'Guards read you at half range while you walk.',
  },
  drill: {
    cost: 600,
    name: 'Silent drill',
    desc: 'The vault needle runs slower and the window runs wider.',
  },
};

/** Where the campaign save lives between visits (this browser only). */
export const SAVE_KEY = 'senja-heist.save.v1';
