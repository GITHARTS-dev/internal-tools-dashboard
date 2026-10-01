import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@server': fileURLToPath(new URL('./src/server', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Not the 5 s default. The first test in a file also pays for building its
    // database, and on a busy machine or CI runner that alone has run past 5 s
    // -- failing a correct test, and with it the deploy the tests gate.
    testTimeout: 20_000,
  },
});
