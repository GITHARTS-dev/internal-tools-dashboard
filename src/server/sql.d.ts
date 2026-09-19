/** `.sql` files are bundled as plain text (wrangler's default rule; see vitest.config.ts for tests). */
declare module '*.sql' {
  const contents: string;
  export default contents;
}
