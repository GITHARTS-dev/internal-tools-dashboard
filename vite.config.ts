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
  // By default Vite crawls every .html file under the root to find dependencies,
  // which would walk into the reference copy of the company dashboard sitting
  // inside this folder. Point it at the one real entry.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    port: 5173,
    // Never watch the reference copy. It carries its own node_modules and .git,
    // and a file in it being locked or rewritten (OneDrive, an editor, a git
    // operation) throws EBUSY inside Vite's watcher and takes the whole dev
    // server down with it -- which is exactly what happened.
    watch: { ignored: ['**/HARTS-internal-tools-dashboard/**'] },
    // The Worker (API) runs separately under `wrangler dev` on 8787.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
