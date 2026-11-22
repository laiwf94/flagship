import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@flagship/source'] },
  // Inline the workspace packages so they resolve to source, not a stale or missing build.
  ssr: { noExternal: [/^@flagship\//], resolve: { conditions: ['@flagship/source'] } },
  test: { name: 'cli' },
});
