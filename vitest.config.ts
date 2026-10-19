import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['development'] },
  ssr: { resolve: { conditions: ['development'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts', 'apps/server/src/**/*.ts'],
      exclude: ['**/index.ts', '**/testing/**', 'apps/server/src/main.ts'],
      thresholds: {
        'packages/core/src/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  },
});
