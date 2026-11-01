import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiUrl = `http://127.0.0.1:${process.env.API_PORT || 3000}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': apiUrl } },
  preview: { proxy: { '/api': apiUrl } },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
