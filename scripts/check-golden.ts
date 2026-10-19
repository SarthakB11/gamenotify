/**
 * Acceptance gate: runs the console demo and diffs it against test/golden/demo.txt.
 *   node scripts/check-golden.ts            (compare; exit 1 on drift)
 *   node scripts/check-golden.ts --update   (rewrite the golden file)
 * Uses the built demo when present, otherwise runs the TypeScript sources directly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const golden = join(root, 'test/golden/demo.txt');
const built = join(root, 'apps/demo/dist/main.js');
const args = existsSync(built) ? [built] : ['--conditions=development', join(root, 'apps/demo/src/main.ts')];

const output = execFileSync(process.execPath, args, {
  env: { ...process.env, NO_COLOR: '1', DEMO_GROUP_WINDOW_MS: '300' },
  encoding: 'utf8',
});

if (process.argv.includes('--update')) {
  writeFileSync(golden, output);
  console.log(`updated ${golden}`);
} else if (output !== readFileSync(golden, 'utf8')) {
  console.error('Demo output drifted from test/golden/demo.txt:\n');
  console.error(output);
  process.exit(1);
} else {
  console.log('demo output matches golden file ✔');
}
