// npm shows whichever README the published tarball contains, and there is no
// separate field for it. So the short, npm-facing README.npm.md is swapped in
// for the duration of `npm pack` / `npm publish`, and the long one that GitHub
// shows is put straight back.
//
// Run as `prepack` (swap) and `postpack` (restore) — see package.json.
//
// Two rules this file has to respect:
//   1. Never write to stdout. `npm pack --json` output is parsed by the smoke
//      test, and anything printed here would corrupt it.
//   2. Never assume the readme's filename case. It is README.md here, but a
//      repository that tracks readme.md must not break the publish.
//   3. Neither the source nor the backup may be named README*. npm force
//      includes every file matching that, whatever `files` says, so they
//      would both end up published alongside the real one.

import console from 'node:console';
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const NPM_README = join(root, 'docs', 'npm-readme.md');
const BACKUP = join(root, '.readme-backup.md');

/** The readme as this repository actually spells it, whatever the case. */
function findReadme() {
  const match = readdirSync(root).find((name) => /^readme\.md$/i.test(name));
  return join(root, match ?? 'README.md');
}

const mode = process.argv[2];

if (mode === 'swap') {
  if (!existsSync(NPM_README)) {
    throw new Error('docs/npm-readme.md is missing; refusing to publish without the npm README');
  }

  const readme = findReadme();
  if (existsSync(BACKUP)) {
    // A previous pack died between swap and restore. The backup is the real
    // readme, so put it back before backing anything up over the top of it.
    rmSync(readme, { force: true });
    renameSync(BACKUP, readme);
  }

  renameSync(readme, BACKUP);
  copyFileSync(NPM_README, readme);
  console.error('README: swapped in the npm version for packing');
} else if (mode === 'restore') {
  if (existsSync(BACKUP)) {
    const readme = findReadme();
    rmSync(readme, { force: true });
    renameSync(BACKUP, readme);
    console.error('README: restored the full version');
  }
} else {
  throw new Error(`usage: swap-readme.mjs <swap|restore>, got ${String(mode)}`);
}
