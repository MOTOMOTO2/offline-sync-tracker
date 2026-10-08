import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The API runs on the Python server; in dev we proxy to it so the frontend is
// same-origin, which is what a service worker needs in order to take control.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
