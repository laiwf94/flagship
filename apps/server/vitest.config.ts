import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@flagship/source'] },
  // Workspace packages are symlinked into node_modules; inline them so they
  // resolve to source through the condition above instead of a stale build.
  ssr: { noExternal: [/^@flagship\//], resolve: { conditions: ['@flagship/source'] } },
  test: {
    name: 'server',
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
