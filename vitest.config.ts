import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/** Wrangler bundles `.sql` imports as text; give the test runner the same behaviour. */
const sqlAsText = {
  name: 'sql-as-text',
  enforce: 'pre' as const,
  load(id: string) {
    const path = id.split('?')[0]!;
    if (!path.endsWith('.sql')) return null;
    return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`;
  },
};

export default defineConfig({
  plugins: [sqlAsText],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
    },
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
