// SENJA HEIST — hand-in program for make.fun best-heist-game-20261122-0559.
// Node 22, standard library only. It mirrors the playable game and its
// screenshots into the output directory, then writes the dossier the judge
// reads. Two runs write the same bytes twice: nothing here carries a clock,
// a random value, or an absolute path into the output.

import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The dossier caps this bounty grades against (competition.yaml / gate).
const DOSSIER_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
};

const OUTPUT_FALLBACK = '/output';
const GAME_DIR = 'game';
const SHOTS_DIR = 'screenshots';
const DOSSIER_FILE = 'dossier.json';

function repoRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function outputDir(): string {
  const fromEnv = process.env.MAKEFUN_OUTPUT_DIR;
  return resolve(fromEnv === undefined || fromEnv === '' ? OUTPUT_FALLBACK : fromEnv);
}

function requireDir(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`SENJA HEIST: ${label} is missing at ${path}`);
  }
}

function mirror(source: string, target: string): void {
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function handIn(): void {
  const root = repoRoot();
  const out = outputDir();
  const gameSrc = join(root, GAME_DIR);
  const shotsSrc = join(root, SHOTS_DIR);
  requireDir(gameSrc, GAME_DIR);
  requireDir(shotsSrc, SHOTS_DIR);
  mkdirSync(out, { recursive: true });
  mirror(gameSrc, join(out, GAME_DIR));
  mirror(shotsSrc, join(out, SHOTS_DIR));
  const dossier = buildDossier(out, DOSSIER_CAPS);
  const dossierPath = join(out, DOSSIER_FILE);
  writeFileSync(dossierPath, dossier);
  // Guard the gate's own bound: a dossier over 1.5 MiB never grades.
  const written = statSync(dossierPath);
  if (written.size === 0 || written.size > 1572864) {
    throw new Error(`SENJA HEIST: ${DOSSIER_FILE} is ${written.size} bytes, outside the gate's 1..1572864 range`);
  }
}

handIn();
