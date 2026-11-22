// SENJA HEIST — entrypoint: hands the game in to make.fun.
//
// Copies game/ and screenshots/ from this repository into the output
// directory and writes dossier.json there with buildDossier from
// vendor/makefun-game.ts. Node 22, standard library only. Running it
// twice over the same repository writes the same bytes both times:
// every file is a plain copy and the dossier is built from the
// copied files, so nothing here depends on clocks, randomness, or
// the order the filesystem happens to list entries in.

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDossier } from './vendor/makefun-game.ts';

// The repository root: the directory this file lives in.
const repoRoot = dirname(fileURLToPath(import.meta.url));

// The grader hands us a writable /output; anywhere else the
// MAKEFUN_OUTPUT_DIR environment variable names the target. An
// empty value is the same as unset: fall back to /output rather
// than trying to write into the current directory's root.
const handInDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

// The dossier caps this bounty grades against (see the kit's
// competition.yaml): 160 KiB of source text, at most 4 screenshots
// of at most 256 KiB each, game/ at most 993 entries / 48 MiB.
const dossierCaps = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
} as const;

// One deliverable: a directory under the repository, mirrored
// wholesale into the same relative path under the hand-in directory.
const deliverables = ['game', 'screenshots'] as const;

function clearPreviousHandIn(target: string): void {
  for (const name of deliverables) {
    rmSync(join(target, name), { recursive: true, force: true });
  }
  rmSync(join(target, 'dossier.json'), { force: true });
}

function mirrorDeliverables(target: string): void {
  mkdirSync(target, { recursive: true });
  for (const name of deliverables) {
    cpSync(join(repoRoot, name), join(target, name), { recursive: true });
  }
}

function writeDossier(target: string): void {
  const dossier = buildDossier(target, dossierCaps);
  writeFileSync(join(target, 'dossier.json'), dossier);
}

clearPreviousHandIn(handInDir);
mirrorDeliverables(handInDir);
writeDossier(handInDir);
