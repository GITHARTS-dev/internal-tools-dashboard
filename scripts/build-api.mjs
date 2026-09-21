/**
 * Bundle the server into the Azure Functions app.
 *
 * Why bundle rather than let Static Web Apps build `api/` directly: the
 * function imports from src/server and src/shared, which sit outside the api
 * folder. Pointing a tsconfig at them across that boundary works but is
 * fragile, and it means the deployed API and the tested code can drift.
 * Bundling from the same source the tests import removes both problems.
 *
 * `pg` and `@azure/functions` stay external. `pg` resolves optional native
 * bindings at runtime, and the Functions host injects its own copy of the SDK;
 * bundling either breaks in ways that only show up once deployed.
 */

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const OUT = 'api/dist/index.js';

await rm('api/dist', { recursive: true, force: true });

const result = await build({
  entryPoints: ['src/server/azure.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  target: 'node20',
  // CommonJS: the Functions v4 host loads `main` with require().
  format: 'cjs',
  external: ['pg', '@azure/functions'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`\nAPI bundled -> ${OUT} (${(bytes / 1024).toFixed(0)} KB)`);
