import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
    },
  },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    // The Worker (API) runs separately under `wrangler dev` on 8787.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
