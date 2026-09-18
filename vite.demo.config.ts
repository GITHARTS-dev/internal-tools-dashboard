import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Builds the app as a single self-contained HTML file.
 *
 * The only substantive change is the swap below: the real fetch-based API
 * module is replaced with an in-memory one, so the same components, the same
 * shared alert engine and the same validation run with no server behind them.
 */

const DEMO_API = fileURLToPath(new URL('./src/client/demo/demoApi.ts', import.meta.url));
const REAL_API_SUFFIX = 'src/client/lib/apiClient.ts';

/**
 * Matched on the RESOLVED file, not the import specifier: the app imports it
 * as './apiClient' from inside lib/, which no path-shaped alias would catch.
 */
function useInMemoryApi(): Plugin {
  return {
    name: 'use-in-memory-api',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.includes('apiClient')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      return resolved.id.replace(/\\/g, '/').endsWith(REAL_API_SUFFIX) ? DEMO_API : null;
    },
  };
}

/** Folds the JS and CSS back into the HTML so the result is one file. */
function inlineEverything(): Plugin {
  return {
    name: 'inline-everything',
    closeBundle() {
      const dir = resolve('dist/demo');
      let html = readFileSync(resolve(dir, 'demo.html'), 'utf8');

      html = html.replace(
        /<script type="module" crossorigin src="\/?([^"]+)"><\/script>/g,
        (_match, src: string) =>
          `<script type="module">${readFileSync(resolve(dir, src), 'utf8')}</script>`,
      );
      html = html.replace(
        /<link rel="stylesheet"[^>]*href="\/?([^"]+)"[^>]*>/g,
        (_match, href: string) => `<style>${readFileSync(resolve(dir, href), 'utf8')}</style>`,
      );

      const out = resolve(dir, 'index.html');
      writeFileSync(out, html);

      // A second output for hosts that wrap page content in their own
      // document skeleton: same page, without the <html>/<head>/<body> shell.
      const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
      const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1] ?? '';
      const keep = head
        .replace(/<meta\s+charset[^>]*>/gi, '')
        .replace(/<meta\s+name="viewport"[^>]*>/gi, '')
        .trim();
      const fragment = resolve(dir, 'fragment.html');
      writeFileSync(fragment, `${keep}\n${body.trim()}\n`);

      rmSync(resolve(dir, 'assets'), { recursive: true, force: true });
      rmSync(resolve(dir, 'demo.html'), { force: true });
      console.log(`\nSingle-file demo: ${out} (${(html.length / 1024).toFixed(0)} KB)`);
      console.log(`Embeddable fragment: ${fragment}`);
    },
  };
}

export default defineConfig({
  plugins: [useInMemoryApi(), react(), inlineEverything()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@client': fileURLToPath(new URL('./src/client', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/demo',
    emptyOutDir: true,
    rollupOptions: { input: resolve('demo.html') },
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});
