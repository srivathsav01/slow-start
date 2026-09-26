// Smoke test: install the packed tarball into a throwaway project outside the
// repo, then load it the way real consumers do — once with `import`, once
// with `require`. Run via `npm run test:smoke` (after a build).
//
// Outside the repo, so Node cannot resolve the package through the repo itself.
// From the tarball, so a mistake in `files` or `exports` fails here.

import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'slow-start';
const EXPECTED_EXPORTS = [
  'ManualClock',
  'Pacer',
  'QueuedLimiter',
  'RateLimitRejectedError',
  'RollingWindow',
  'SystemClock',
  'WarmupLimiter',
  'attempt',
  'guard',
];
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// The verification oracle stays in the repo; the consumer reads it by
// absolute path, so the check runs against the installed package but the
// expected values come from `verification/`.
const configPath = fileURLToPath(new URL('../verification/config.json', import.meta.url));
const vectorsPath = fileURLToPath(new URL('../verification/golden-vectors.csv', import.meta.url));

// npm sets npm_execpath to its own CLI script when running an npm script.
// Calling it through the current Node binary avoids spawning `npm.cmd`
// through a shell on Windows.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error('Run this through npm: `npm run test:smoke`');
}

function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: 'utf8' });
}

function npm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}

const workDir = mkdtempSync(join(tmpdir(), `${PACKAGE_NAME}-smoke-`));
let passed = false;

try {
  // 1. Pack exactly what `npm publish` would upload.
  const [packed] = JSON.parse(npm(['pack', '--json', '--pack-destination', workDir], repoRoot));
  const tarball = join(workDir, packed.filename);
  console.log(`packed ${packed.filename} (${packed.entryCount} files)`);

  // 2. A consumer project with no "type" field, so the .mjs / .cjs
  //    extensions alone decide how each script is loaded.
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'smoke-consumer', private: true }));
  npm(['install', tarball, '--no-audit', '--no-fund', '--no-package-lock'], workDir);

  // 3. Each consumer reports which file it resolved to and what it exports.
  writeFileSync(
    join(workDir, 'esm.mjs'),
    `const mod = await import('${PACKAGE_NAME}');
const adapters = await import('${PACKAGE_NAME}/adapters');
console.log(JSON.stringify({
  file: import.meta.resolve('${PACKAGE_NAME}'),
  exports: Object.keys(mod).sort(),
  adapters: Object.keys(adapters).sort(),
}));`,
  );
  writeFileSync(
    join(workDir, 'cjs.cjs'),
    `const mod = require('${PACKAGE_NAME}');
const adapters = require('${PACKAGE_NAME}/adapters');
console.log(JSON.stringify({
  file: require.resolve('${PACKAGE_NAME}'),
  exports: Object.keys(mod).sort(),
  adapters: Object.keys(adapters).sort(),
}));`,
  );

  const esm = JSON.parse(run(process.execPath, ['esm.mjs'], workDir));
  const cjs = JSON.parse(run(process.execPath, ['cjs.cjs'], workDir));

  // 4. Each loader must reach its own build, and both builds must agree.
  const failures = [];
  if (!esm.file.endsWith('.mjs')) failures.push(`import resolved to ${esm.file}, expected a .mjs file`);
  if (!cjs.file.endsWith('.cjs')) failures.push(`require resolved to ${cjs.file}, expected a .cjs file`);
  const missing = EXPECTED_EXPORTS.filter((name) => !esm.exports.includes(name));
  if (missing.length > 0) failures.push(`missing exports: ${missing.join(', ')}`);
  // The subpath must resolve through both loaders, and must not leak into
  // the core entry point.
  for (const [loader, result] of [['import', esm], ['require', cjs]]) {
    if (!result.adapters.includes('expressRateLimit')) {
      failures.push(`${loader} of ${PACKAGE_NAME}/adapters is missing expressRateLimit`);
    }
    if (result.exports.includes('expressRateLimit')) {
      failures.push(`${loader}: expressRateLimit leaked into the core entry point`);
    }
  }

  if (JSON.stringify(esm.exports) !== JSON.stringify(cjs.exports)) {
    failures.push(`exports differ: import ${JSON.stringify(esm.exports)}, require ${JSON.stringify(cjs.exports)}`);
  }

  // 5. Replay the golden vectors through the INSTALLED package, using only
  //    its public API. The unit tests prove src/ reproduces them; this proves
  //    the artifact users download does.
  copyFileSync(join(repoRoot, 'scripts', 'replay-vectors.mjs'), join(workDir, 'vectors.mjs'));
  const vectors = JSON.parse(
    run(process.execPath, ['vectors.mjs', configPath, vectorsPath], workDir),
  );
  if (vectors.failures.length > 0) {
    failures.push(`golden vectors differ in the packed build: ${vectors.failures.join('; ')}`);
  }

  if (failures.length > 0) {
    throw new Error(`smoke test failed:\n  ${failures.join('\n  ')}`);
  }

  console.log(`vectors -> ${vectors.replayed} golden vectors replayed, all matching`);
  console.log(`subpath -> ${PACKAGE_NAME}/adapters exports ${esm.adapters.join(', ')}`);
  console.log(`import  -> ${esm.exports.join(', ')}`);
  console.log(`require -> ${cjs.exports.join(', ')}`);
  console.log('smoke test passed');
  passed = true;
} finally {
  // Keep the directory after a failure so it can be inspected.
  if (passed) {
    rmSync(workDir, { recursive: true, force: true });
  } else {
    console.error(`smoke test directory kept for inspection: ${workDir}`);
  }
}
