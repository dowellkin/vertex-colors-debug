import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  cacheDir: resolve(__dirname, 'node_modules/.vite'),
  base: '/',
  publicDir: resolve(__dirname, 'public'),
  resolve: {
    alias: {
      '@utils': resolve(__dirname, 'src/utils'),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    strictPort: false,
  },
});
