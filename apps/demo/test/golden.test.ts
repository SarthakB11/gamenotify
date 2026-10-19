import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../../..');

/** T-01 (end-to-end): the console demo reproduces the brief's triggers exactly (golden file). */
describe('console demo', () => {
  it('matches test/golden/demo.txt', () => {
    const out = execFileSync(process.execPath, ['--conditions=development', join(root, 'apps/demo/src/main.ts')], {
      env: { ...process.env, NO_COLOR: '1', DEMO_GROUP_WINDOW_MS: '300' },
      encoding: 'utf8',
    });
    expect(out).toBe(readFileSync(join(root, 'test/golden/demo.txt'), 'utf8'));
  }, 20_000);
});
