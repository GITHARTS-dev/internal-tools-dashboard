/**
 * The Azure Functions host.
 *
 * Everything the app does lives in the Hono app in index.ts; this file only
 * bridges Azure's invocation model to it. That is deliberate -- the routes, the
 * repository layer and the reminder job have no idea which host they are
 * running under, which is what made moving off Workers a matter of writing two
 * adapters rather than rewriting the application.
 *
 * One catch-all HTTP function handles every route. Static Web Apps forwards
 * `/api/*` here, and the Functions runtime's default `api` route prefix means a
 * request for `/api/tools` arrives with that same path -- which is exactly what
 * the Hono app has registered, so the URL passes straight through.
 */

import { app as functions, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { Pool } from 'pg';
import { app as hono } from './index';
import { postgresDb } from './repo/postgres';
import type { Env } from './context';

/**
 * One pool per warm instance, created lazily.
 *
 * `max: 1` is not a typo. Each Function instance handles one request at a time,
 * and Supabase's pooler is the thing doing the real pooling; opening several
 * server-side connections per instance is how a handful of concurrent requests
 * turns into "too many connections" on the free tier.
 */
let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Add the Supabase transaction-pooler connection string (port 6543) to the Static Web App configuration.',
    );
  }

  pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase terminates non-TLS connections. `rejectUnauthorized: false` is
    // needed because the pooler presents a certificate for a different host
    // than the one dialled; the connection is still encrypted.
    ssl: { rejectUnauthorized: false },
  });

  return pool;
}

/** The bindings the Hono app expects, assembled from the process environment. */
function buildEnv(): Env {
  const env: Record<string, unknown> = { DB: postgresDb(getPool()) };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env as Env;
}

/** Azure's request object into a standard one Hono can serve. */
export async function toRequest(request: HttpRequest): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) headers.set(key, value);

  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  // Read the body eagerly: streaming it through would need duplex support that
  // the Functions host does not reliably provide.
  const body = hasBody ? await request.arrayBuffer() : undefined;

  return new Request(request.url, {
    method,
    headers,
    ...(body && body.byteLength > 0 ? { body } : {}),
  });
}

export async function toAzureResponse(response: Response): Promise<HttpResponseInit> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/**
 * The handler, separated from its registration so it can be exercised without
 * a Functions host. `envFor` is injectable for the same reason: the test suite
 * hands it a PGlite-backed database.
 */
export function createHandler(envFor: () => Env = buildEnv) {
  return async function handler(
    request: HttpRequest,
    context?: { error(...args: unknown[]): void },
  ): Promise<HttpResponseInit> {
    try {
      const response = await hono.fetch(await toRequest(request), envFor());
      return await toAzureResponse(response);
    } catch (error) {
      // Surfaced in Application Insights; the caller gets something actionable
      // rather than the platform's generic 500 page.
      context?.error('Unhandled error serving request:', error);
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        jsonBody: {
          error: 'server_error',
          message: error instanceof Error ? error.message : 'Something went wrong.',
        },
      };
    }
  };
}

functions.http('api', {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  // Static Web Apps enforces authentication in front of this, per the rules in
  // staticwebapp.config.json. The function is not separately addressable.
  authLevel: 'anonymous',
  route: '{*path}',
  handler: createHandler(),
});

/**
 * The timer that would have run the reminder job lives outside this app: Static
 * Web Apps' managed Functions are HTTP-only, so the schedule is a GitHub
 * Actions workflow calling POST /api/reminders/run with a shared secret. See
 * DEPLOYMENT.md.
 */
