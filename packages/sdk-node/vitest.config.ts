import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@flagship/source'] },
  ssr: { noExternal: [/^@flagship\//], resolve: { conditions: ['@flagship/source'] } },
  test: { name: 'sdk-node', testTimeout: 20_000 },
});
