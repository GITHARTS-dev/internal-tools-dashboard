/**
 * Types the `.sql` import in src/server/repo/demo.ts.
 *
 * The `*.sql` ambient declaration in src/server/sql.d.ts does not cover a
 * relative import that resolves outside `src`, so this sidecar does it the way
 * TypeScript supports directly: `<name>.d.<ext>.ts` alongside the file, enabled
 * by `allowArbitraryExtensions`. Wrangler still bundles the .sql as text.
 */
declare const contents: string;
export default contents;
