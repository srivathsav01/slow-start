import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// §11 — which src/ modules each module must NOT import.
const FORBIDDEN_IMPORTS = {
  core: ['clock', 'warmup', 'pacing', 'metrics', 'adapters'],
  clock: ['warmup', 'pacing', 'metrics', 'adapters'],
  warmup: ['pacing', 'metrics', 'adapters'],
  pacing: ['warmup', 'metrics', 'adapters'],
  metrics: ['warmup', 'pacing', 'adapters'],
};

const boundaryRules = Object.entries(FORBIDDEN_IMPORTS).map(([module, forbidden]) => ({
  files: [`src/${module}/**/*.ts`],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: forbidden.map((target) => ({
        regex: `(^|/)${target}(/|$)`,
        message: `src/${module} must not depend on src/${target} (spec §11).`,
      })),
    }],
  },
}));

// §6 — time comes only from an injected Clock.
const WALL_CLOCK = [
  { object: 'Date', property: 'now', message: 'Use the injected Clock (spec §6).' },
];
const REAL_CLOCK = [
  { object: 'process', property: 'hrtime', message: 'Only SystemClock may read the real clock (spec §6).' },
  { object: 'performance', property: 'now', message: 'Only SystemClock may read the real clock (spec §6).' },
];
const NO_NEW_DATE = {
  selector: "NewExpression[callee.name='Date']",
  message: 'Use the injected Clock (spec §6).',
};

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'verification/'] },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Benchmarks and scripts run as plain Node ESM with no Node globals
  // declared, so the few web-standard globals they use are named here.
  {
    files: ['bench/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        AbortController: 'readonly',
        globalThis: 'readonly',
      },
    },
  },

  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...WALL_CLOCK, ...REAL_CLOCK],
      'no-restricted-syntax': ['error', NO_NEW_DATE],
    },
  },
  {
    files: ['src/clock/system-clock.ts'],
    rules: {
      'no-restricted-properties': ['error', ...WALL_CLOCK],
    },
  },

  ...boundaryRules,
);
