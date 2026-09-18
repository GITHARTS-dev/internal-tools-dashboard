import { Hono } from 'hono';
import type { Env } from './context';
import { toolsRoutes } from './routes/tools';
import { paymentsRoutes } from './routes/payments';
import { dashboardRoutes } from './routes/dashboard';
import { adminRoutes } from './routes/admin';
import { importExportRoutes } from './routes/importExport';
import { documentsRoutes } from './routes/documents';
import { runReminders } from './reminders';

/**
 * The Worker: API + scheduled reminder job.
 *
 * Static assets (the React app) are served by the Workers runtime itself from
 * the `assets` binding in wrangler.jsonc, so there is no asset handling here.
 */

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({ ok: true, env: c.env.APP_ENV ?? 'unknown', time: new Date().toISOString() }),
);

app.route('/api/tools', toolsRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/documents', documentsRoutes);
app.route('/api', adminRoutes);
app.route('/api', importExportRoutes);

app.notFound((c) =>
  c.req.path.startsWith('/api')
    ? c.json({ error: 'not_found', message: `No API route for ${c.req.path}` }, 404)
    : c.text('Not found', 404),
);

app.onError((error, c) => {
  // Surfaced in the wrangler console; the client gets a message it can show.
  console.error('Unhandled error:', error);
  return c.json(
    { error: 'server_error', message: error instanceof Error ? error.message : 'Something went wrong.' },
    500,
  );
});

export default {
  fetch: app.fetch,

  /**
   * The daily reminder run. Configured in wrangler.jsonc to fire at 03:00 UTC
   * (08:30 IST). While deployment is on hold this never fires on its own --
   * the same job is reachable at /api/reminders/dry-run to preview, and
   * /api/reminders/run to execute on demand.
   */
  async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    const vars: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === 'string') vars[key] = value;
    }
    ctx.waitUntil(
      runReminders(env.DB, vars)
        .then((run) => {
          console.log(`Reminder run for ${run.today}: ${run.alerts.length} alert(s)`);
        })
        .catch((error: unknown) => {
          console.error('Reminder run failed:', error);
        }),
    );
  },
};
