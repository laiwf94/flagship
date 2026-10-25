import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/test/**',
        '**/*.d.ts',
        'apps/server/src/main.ts',
      ],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 90 },
    },
  },
});
