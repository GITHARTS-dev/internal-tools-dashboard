import { Hono } from 'hono';
import type { Env, Variables } from './context';
import { requireAuth } from './auth/middleware';
import { toolsRoutes } from './routes/tools';
import { paymentsRoutes } from './routes/payments';
import { dashboardRoutes } from './routes/dashboard';
import { adminRoutes } from './routes/admin';
import { importExportRoutes } from './routes/importExport';
import { documentsRoutes } from './routes/documents';
import { fxRoutes } from './routes/fx';
import { internalProductRoutes } from './routes/internalProducts';
import { awsRoutes } from './routes/aws';

/**
 * The API.
 *
 * Host-agnostic on purpose: this module knows nothing about Azure, and the two
 * adapters beside it (azure.ts for production, dev.ts for local work) know
 * nothing about the routes. Static assets are served by Static Web Apps, not
 * from here.
 *
 * There is no platform-managed sign-in gating requests before they get here
 * any more -- the SPA runs its own PKCE flow with MSAL and sends a bearer
 * token, so `requireAuth()` is what actually stands between a request and the
 * routes below. See auth/middleware.ts for exactly what it checks and the two
 * paths it deliberately leaves open.
 */

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Long enough for a cold connection to the pooler; short enough that a monitor sees a hang as down. */
const HEALTH_DB_TIMEOUT_MS = 8000;

app.use('/api/*', requireAuth());

/**
 * Is the site up -- including its database?
 *
 * Runs one trivial query, for two reasons. An outside uptime monitor calling
 * this every few minutes is what keeps the Supabase free tier from pausing the
 * project after a week without database activity; a health check that never
 * touched the database would keep the Function warm but let Supabase sleep.
 * And "up" with an unreachable database is not up, so that case answers 503
 * and the monitor raises it.
 *
 * Still open without sign-in (see auth/middleware.ts), and says nothing about
 * the data: the query reads no table.
 */
app.get('/api/health', async (c) => {
  const started = Date.now();
  let database: 'ok' | 'unreachable' = 'ok';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.env.DB.prepare('SELECT 1').first(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), HEALTH_DB_TIMEOUT_MS);
      }),
    ]);
  } catch {
    database = 'unreachable';
  } finally {
    clearTimeout(timer);
  }

  return c.json(
    {
      ok: database === 'ok',
      env: c.env.APP_ENV ?? 'unknown',
      database,
      database_ms: Date.now() - started,
      time: new Date().toISOString(),
    },
    database === 'ok' ? 200 : 503,
  );
});

app.route('/api/tools', toolsRoutes);
app.route('/api/payments', paymentsRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/documents', documentsRoutes);
app.route('/api', fxRoutes);
app.route('/api', internalProductRoutes);
app.route('/api', awsRoutes);
app.route('/api', adminRoutes);
app.route('/api', importExportRoutes);

app.notFound((c) =>
  c.req.path.startsWith('/api')
    ? c.json({ error: 'not_found', message: `No API route for ${c.req.path}` }, 404)
    : c.text('Not found', 404),
);

app.onError((error, c) => {
  // Surfaced in the host's logs; the client gets a message it can show.
  console.error('Unhandled error:', error);
  return c.json(
    { error: 'server_error', message: error instanceof Error ? error.message : 'Something went wrong.' },
    500,
  );
});

/*
 * There is no default export any more.
 *
 * On Workers, the runtime imported `{ fetch, scheduled }` from this module.
 * Azure Functions has no equivalent convention: src/server/azure.ts registers
 * the HTTP handler explicitly, and the daily job is an ordinary POST to
 * /api/reminders/run made by the scheduler -- which is why the FX refresh that
 * used to live in `scheduled()` now runs inside that route.
 */
