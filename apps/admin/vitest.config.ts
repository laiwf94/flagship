import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  resolve: { conditions: ['@flagship/source'] },
  test: {
    name: 'admin',
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // These tests click through whole pages; give them room on a loaded machine.
    testTimeout: 20_000,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
