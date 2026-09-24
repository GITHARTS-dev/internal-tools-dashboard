import { Hono } from 'hono';
import type { Env } from './context';
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
 */

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({ ok: true, env: c.env.APP_ENV ?? 'unknown', time: new Date().toISOString() }),
);

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
