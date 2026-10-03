import { defineConfig } from 'vite';

// BASE is set by the GitHub Pages workflow to /<repo>/, local dev uses /
export default defineConfig({
  base: process.env.BASE ?? '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500, assetsInlineLimit: 0 },
  server: { port: 5190 },
});
