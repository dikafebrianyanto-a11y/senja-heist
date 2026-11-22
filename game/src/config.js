// Senja Heist — one home for every number the game tunes by.
// The playfield is a fixed logical canvas of 1280 by 720; the renderer
// stretches that canvas onto whatever window it gets, so none of the
// values below ever needs to know the real screen size. Kota Senja is a
// harbour city after dark, all indigo streets, amber windows and teal
// neon. Dark blue means safe cover, red and amber mean danger, gold means
// loot: a glance at a room should tell the player where to hide, what to
// fear and what to grab.

/** How many simulation ticks run each second, whatever the display does. */
const UPDATES_PER_SECOND = 60;

/** The logical canvas the renderer scales onto the window. */
export const VIEW = {
  width: 1280, // logical pixels across
  height: 720, // logical pixels down
}; // VIEW

/** One fixed simulation step, in seconds: a tick every 1/60th of a second. */
export const STEP = 1 / UPDATES_PER_SECOND;

/** The screens main.js walks between; hud.js draws the panel for each. */
export const SCREEN = { // the flow of play, screen to screen
  TITLE: "title", // opening screen, press start here
  PLAN: "plan", // planning board: pick a job, buy tools
  HEIST: "heist", // inside the building, the job itself
  GETAWAY: "getaway", // the drive out of the city
  PAUSE: "pause", // frozen mid-job
  BUSTED: "busted", // caught: the run ends here
  PAYOUT: "payout", // the split, after a clean escape
}; // SCREEN

/** One heist interior, and the street map the getaway drives across. */
export const ROOM = {
  width: 1120, // interior width in logical pixels
  height: 640, // interior height in logical pixels
}; // ROOM

export const CITY = {
  width: 2560, // street map width in logical pixels
  height: 1600, // street map height in logical pixels
}; // CITY

/** Difficulty presets: each row scales the guards, the cameras, the alarm,
// the police response and the payout. Missions read payoutMul off the
// chosen row; an unknown key falls back to normal. */
export const DIFFICULTY = {
  easy: {
    label: "Easy",
    guardMul: 0.75,
    cameraMul: 0.75,
    alarmMul: 0.7,
    policeMul: 0.75,
    payoutMul: 0.85,
  }, // easy
  normal: {
    label: "Normal",
    guardMul: 1,
    cameraMul: 1,
    alarmMul: 1,
    policeMul: 1,
    payoutMul: 1,
  }, // normal
  hard: {
    label: "Hard",
    guardMul: 1.35,
    cameraMul: 1.3,
    alarmMul: 1.45,
    policeMul: 1.3,
    payoutMul: 1.25,
  }, // hard
}; // DIFFICULTY

/** Every colour the game paints with, grouped by what it means. */
export const PALETTE = { // every colour, grouped by what it means
  // The night itself: backdrop, panels, floors and walls.
  backdrop: "#07081a",
  panel: "#12152e",
  panelEdge: "#2a2f55",
  floor: "#191d33",
  floorAlt: "#1e2340",
  wall: "#31365e",
  wallTop: "#454b7d",
  // Streets and roads for the getaway map.
  street: "#101223",
  road: "#1a1d31",
  roadLine: "#3a3f66",
  sidewalk: "#232744",
  // Cover and doors inside a room.
  cover: "#262b4a",
  door: "#3d3468",
  // Loot: gold, with a soft glow around it.
  loot: "#f5c542",
  lootGlow: "rgba(245,197,66,0.28)",
  // The crew and the opposition.
  thief: "#7ee0c3",
  thiefDark: "#3fae8d",
  guard: "#ff5d5d",
  guardCone: "rgba(255,93,93,0.16)",
  guardConeEdge: "rgba(255,93,93,0.38)",
  camera: "#ffb454",
  cameraCone: "rgba(255,180,84,0.15)",
  police: "#5aa9ff",
  policeLight: "#ff4d4d",
  // Cars on the street map.
  carPlayer: "#7ee0c3",
  carTraffic: "#9aa0c4",
  carPolice: "#5aa9ff",
  // Text and signals.
  text: "#eef0ff",
  muted: "#8a90b8",
  accent: "#ffb454",
  safe: "#57d977",
  danger: "#ff4d6d",
}; // PALETTE

/** The single typeface for every label, button and readout. */
export const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Mara, the thief under the player's control. Her speeds are in pixels per second. */
export const THIEF = { // Mara's numbers: movement, fighting, noise, weight
  // Movement: how fast she moves in each stance.
  walk: 178, // upright pace
  crouch: 96, // slow and quiet
  sprint: 238, // loud and fast
  radius: 13, // body circle, in pixels
  hp: 100, // health at the start of a job
  // Fighting up close, and the pistol she carries.
  punchRange: 36, // how close a guard must be to hit
  punchDamage: 34, // health a punch takes off a guard
  ammoStart: 6, // bullets loaded when a job begins
  ammoMax: 12, // bullets she can carry at most
  // Noise thrown while moving: the radius guards can hear, by stance.
  noiseCrouch: 10, // barely a whisper
  noiseWalk: 26, // footsteps on tile
  noiseSprint: 62, // everyone in the room hears it
  // Loot weight: past this many kilos she starts slowing down.
  weightSlowsAt: 6, // kilos before the slowdown bites
  weightSlowPerKg: 9, // pixels per second lost per extra kilo
}; // THIEF

/** Patrol guards: how fast they walk, how far they see, how fast they turn. */
export const GUARD = { // patrol numbers: pace, sight, suspicion, reach
  patrol: 64, // walking pace on a route, px per second
  chase: 150, // running pace once they have spotted Mara
  search: 92, // pace while hunting a last-seen position
  sight: 255, // how far a guard can see, in pixels
  halfCone: 0.5, // half the vision cone, in radians
  suspicionPerSecond: 1.4, // suspicion gained per second of watching Mara
  loseSeconds: 4, // seconds out of sight before they give up the chase
  catchRange: 26, // close enough to grab her
  punchDamage: 20, // health a guard punch takes off Mara
}; // GUARD

/** Wall cameras: sweeping cones that spot Mara and feed the alarm. */
export const CAMERA = { // wall-camera numbers: reach, cone, sweep, spot time
  range: 265, // how far the lens reaches, in pixels
  halfCone: 0.4, // half the cone the camera watches, in radians
  sweep: 1.05, // how far the cone swings from its base angle, in radians
  sweepSpeed: 0.5, // swing speed, in radians per second
  spotSeconds: 1.1, // seconds watched before the camera calls it a spot
}; // CAMERA

/** The alarm meter runs 0 to 100; hitting the top locks the room down and calls the police. */
export const ALARM = { // the 0-to-100 meter: rises, decay, trip points
  riseSeen: 30, // alarm gained per second while a guard watches Mara
  riseCamera: 22, // alarm gained per second while a camera watches her
  riseNoise: 9, // alarm gained from a loud noise
  decay: 4.5, // alarm lost per second while nobody sees anything
  suspectAt: 45, // guards start hunting once the meter passes this
  lockdownAt: 100, // the meter value that locks the room down
  lockdownSeconds: 14, // how long a lockdown lasts
}; // ALARM

/** The vault lock: a needle sweeps the dial and pins must land in the gold window. */
export const VAULT = { // the timing lock: pins, window, needle, misses
  pins: 4, // pins to set before the vault opens
  window: 0.17, // width of the gold window, as a share of the dial
  needleSpeed: 1.7, // how fast the needle sweeps, dials per second
  missAlarm: 16, // alarm added when a pin is missed
  drillWindow: 0.24, // gold window with the silent drill fitted
  drillNeedle: 1.25, // needle speed with the silent drill fitted
}; // VAULT

/** The planning-board shop. `charges` is how many uses a purchase carries. */
export const TOOLS = { // the planning-board shop, one entry per tool
  lockpick: { // opens doors, forgives one missed pin
    name: "Lockpick set",
    cost: 150, // coin price on the planning board
    desc: "Doors open instantly; the vault forgives one missed pin.",
  }, // lockpick
  emp: { // blinds every camera for a few seconds
    name: "EMP pulse",
    cost: 400, // coin price on the planning board
    desc: "Blinds every camera for 8 seconds. 3 charges.",
    charges: 3, // uses carried per purchase
  }, // emp
  disguise: { // walk past guards at half their usual range
    name: "Crew disguise",
    cost: 350, // coin price on the planning board
    desc: "Guards read you at half range while you walk.",
  }, // disguise
  drill: { // slower needle, wider window on the vault
    name: "Silent drill",
    cost: 600, // coin price on the planning board
    desc: "The vault needle runs slower and the window runs wider.",
  }, // drill
  smoke: {
    name: "Smoke bomb",
    cost: 300, // coin price on the planning board
    desc: "Bursts into a thick grey cloud; guards and cameras lose Mara inside it.",
    charges: 3, // uses carried per purchase
  }, // smoke
  masterpick: {
    name: "Master lockpick",
    cost: 500, // coin price on the planning board
    desc: "Doors open instantly, the vault window runs wider, one missed pin is forgiven.",
  }, // masterpick
}; // TOOLS

/** Smoke clouds: how wide one spreads and how long it hangs around. */
export const SMOKE = {
  radius: 95, // cloud radius in pixels, matching the effect's default
  duration: 6, // seconds before the cloud thins out completely
  expandSeconds: 0.4, // seconds for the cloud to bloom to full size
  fadeSeconds: 1.2, // seconds for the cloud to thin out at the end
}; // SMOKE

/** The getaway car: top-down arcade driving with a touch of drift. */
export const CAR = { // getaway handling: push, grip, steering, bodywork
  accel: 430, // forward push, pixels per second squared
  topSpeed: 540, // fastest the car goes, pixels per second
  reverse: 170, // fastest it goes backwards, pixels per second
  grip: 3.4, // how hard the tyres hold the road in a turn
  turn: 2.7, // steering speed, in radians per second
  hp: 100, // bodywork: at zero the car is done
  ramDamage: 22, // damage dealt when the car rams something
}; // CAR

/** The police response, scaled by the crew's heat level from 0 to 5. */
export const POLICE = { // pursuit numbers: pace, spawns, rams, searching
  chaseSpeed: 552, // pursuit pace, pixels per second
  spawnGap: 5.5, // seconds between new units joining the chase
  maxUnits: 4, // most patrol cars on the road at once
  ramDamage: 14, // damage a police ram deals to the getaway car
  searchSeconds: 7, // seconds a unit hunts after losing sight of Mara
}; // POLICE

/** Heat: what pushes it up, and how quickly it fades once the crew is clear. */
export const HEAT = { // the wanted level: what raises it, how it cools
  perLockdown: 1, // heat gained when a room locks down
  perShot: 1, // heat gained each time Mara fires
  coolPerSecond: 0.05, // heat bled off per second while lying low
  max: 5, // the hottest the crew's wanted level gets
}; // HEAT

/** Crew experience: what a job banks, and what each level costs. */
export const CREW_XP = {
  perJob: 120, // base experience banked for finishing a job
  ghostBonus: 60, // extra experience for a ghost run, no alarms raised
  perLevel: 100, // experience needed for each new crew level
  maxLevel: 12, // the highest level the crew can reach
}; // CREW_XP

/** The storage key for the campaign save, kept in this browser only. */
export const SAVE_KEY = "senja-heist.save.v1";
