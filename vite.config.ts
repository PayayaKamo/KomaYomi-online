import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Static build for GitHub Pages. The repository is published under
 * https://<user>.github.io/KomaYomi-online/, so every asset URL needs that prefix.
 */
export default defineConfig({
  base: '/KomaYomi-online/',
  plugins: [react()],
  build: {
    // Source maps make the deployed bundle easier to debug from the browser.
    sourcemap: true,
  },
});
