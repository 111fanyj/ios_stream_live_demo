import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: path.resolve(process.cwd(), 'frontend'),
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/health': 'http://127.0.0.1:3000',
      '/legacy': 'http://127.0.0.1:3000'
    }
  },
  build: {
    outDir: path.resolve(process.cwd(), 'frontend', 'dist'),
    emptyOutDir: true
  }
});