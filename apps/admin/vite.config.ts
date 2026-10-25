import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.FLAGSHIP_API ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@flagship/source'] },
  server: {
    proxy: { '/api': api, '/sdk': api },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
