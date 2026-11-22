// Senja Heist — the hand-in program (Node 22, standard library only).
// The game itself is the plain static site under game/ (game/index.html
// plus its ES modules, no library, no network request), and this program
// hands it in: it copies game/ and screenshots/ from beside this file
// into /output (or $MAKEFUN_OUTPUT_DIR outside the grader's container)
// and writes /output/dossier.json, the summary the judge reads, using the
// vendored make.fun library.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

/** The directory this file lives in — the entry root. */
function entryRoot() {
  return fileURLToPath(new URL('.', import.meta.url));
}

/** Where the handed-in entry goes. */
function outputRoot() {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

/** Copy one directory tree, creating the destination first. */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

/**
 * The scorer's own caps, from the kit's reference/gate.json. Only
 * text_max_bytes shapes the bytes; the rest refuse an entry the scorer
 * would refuse outright: more than 4 screenshots or one over 256 KiB,
 * more than 993 files or 48 MiB under game/, or a game/ path over 1000
 * bytes (game/ counts beside /output's own 1000-entry cap, its
 * screenshots/ and dossier.json).
 */
const DOSSIER_LIMITS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

/** Write the judge's summary for the entry now sitting in `outDir`. */
function emitDossier(outDir) {
  writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, DOSSIER_LIMITS));
}

const root = entryRoot();
const outDir = outputRoot();

mkdirSync(outDir, { recursive: true });
copyTree(join(root, 'game'), join(outDir, 'game'));
mkdirSync(join(outDir, 'screenshots'), { recursive: true });
if (existsSync(join(root, 'screenshots'))) {
  copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));
}
emitDossier(outDir);
