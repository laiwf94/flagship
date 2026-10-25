import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['@flagship/source'] },
  test: { name: 'sdk-browser', environment: 'jsdom' },
});
