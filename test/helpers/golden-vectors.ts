import { readFileSync } from 'node:fs';

const CONFIG_URL = new URL('../../verification/config.json', import.meta.url);
const VECTORS_URL = new URL('../../verification/golden-vectors.csv', import.meta.url);

const CONFIG_SHAPE = {
  input: ['stableRatePermitsPerSecond', 'coldFactor', 'warmupPeriodMicros'],
  derived: [
    'stableIntervalMicros',
    'coldIntervalMicros',
    'thresholdPermits',
    'maxPermits',
    'slopeMicrosPerPermit',
    'coolDownIntervalMicros',
  ],
  initialState: ['storedPermits', 'nextFreeTicketMicros'],
  tolerance: ['timeMicros', 'permits'],
} as const;

type ConfigShape = typeof CONFIG_SHAPE;

export type GoldenConfig = {
  [Section in keyof ConfigShape]: Record<ConfigShape[Section][number], number>;
};

export interface GoldenVector {
  step: number;
  nowMicros: number;
  permits: number;
  expectGrantMicros: number;
  expectStoredAfter: number;
  expectNextFreeMicros: number;
  exercises: string;
}

const COLUMNS = [
  'step',
  'now_micros',
  'permits',
  'expect_grant_micros',
  'expect_stored_after',
  'expect_next_free_micros',
  'exercises',
] as const;

export function loadGoldenConfig(): GoldenConfig {
  const raw: unknown = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
  if (!isRecord(raw)) {
    throw new Error('config.json: expected a JSON object at the top level');
  }

  for (const [section, keys] of Object.entries(CONFIG_SHAPE)) {
    const values = raw[section];
    if (!isRecord(values)) {
      throw new Error(`config.json: missing section "${section}"`);
    }
    for (const key of keys) {
      const value = values[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `config.json: ${section}.${key} must be a finite number, got ${JSON.stringify(value)}`,
        );
      }
    }
  }

  return raw as GoldenConfig;
}

export function loadGoldenVectors(): GoldenVector[] {
  const lines = readFileSync(VECTORS_URL, 'utf8')
    .split(/\r?\n/)
    .map((text, index) => ({ text, lineNumber: index + 1 }))
    .filter((line) => line.text.trim() !== '');

  const [header, ...rows] = lines;
  const expectedHeader = COLUMNS.join(',');
  if (header?.text !== expectedHeader) {
    throw new Error(
      `golden-vectors.csv: header is ${JSON.stringify(header?.text)}, expected ${JSON.stringify(expectedHeader)}`,
    );
  }

  return rows.map((row) => parseRow(row.text, row.lineNumber));
}

function parseRow(text: string, lineNumber: number): GoldenVector {
  const fields = text.split(',');
  if (fields.length < COLUMNS.length) {
    throw new Error(
      `golden-vectors.csv line ${lineNumber}: expected ${COLUMNS.length} fields, got ${fields.length}`,
    );
  }

  const numberAt = (index: 0 | 1 | 2 | 3 | 4 | 5): number => {
    const field = fields[index];
    if (field === undefined || field.trim() === '' || !Number.isFinite(Number(field))) {
      throw new Error(
        `golden-vectors.csv line ${lineNumber}: ${COLUMNS[index]} must be a finite number, got ${JSON.stringify(field)}`,
      );
    }
    return Number(field);
  };

  return {
    step: numberAt(0),
    nowMicros: numberAt(1),
    permits: numberAt(2),
    expectGrantMicros: numberAt(3),
    expectStoredAfter: numberAt(4),
    expectNextFreeMicros: numberAt(5),
    exercises: fields.slice(COLUMNS.length - 1).join(','),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
