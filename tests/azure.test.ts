import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler, toAzureResponse } from '../src/server/azure';
import { testPgDb, type PgTestDb } from './pg-helper';
import { testEnv } from './db-helper';
import type { HttpRequest } from '@azure/functions';

/**
 * The Azure Functions adapter.
 *
 * The conversion between Azure's invocation model and a standard
 * Request/Response is the one piece of the migration with no equivalent in the
 * old host, so it gets its own tests rather than being discovered in
 * production. The Hono app underneath is the same one the other suites cover.
 */

let ctx: PgTestDb;

beforeAll(async () => {
  ctx = await testPgDb();
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

/** The parts of Azure's HttpRequest the adapter actually touches. */
function fakeRequest(
  method: string,
  url: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): HttpRequest {
  const headers = new Headers(options.headers ?? {});
  const encoded = options.body ? new TextEncoder().encode(options.body) : new Uint8Array(0);

  return {
    method,
    url,
    headers,
    async arrayBuffer() {
      return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    },
  } as unknown as HttpRequest;
}

const handler = () => createHandler(() => testEnv(ctx.db) as never);

function bodyText(result: { body?: unknown; jsonBody?: unknown }): string {
  if (result.jsonBody !== undefined) return JSON.stringify(result.jsonBody);
  const body = result.body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body ?? '');
}

describe('the Azure handler', () => {
  it('serves a GET through to the Hono app', async () => {
    const result = await handler()(fakeRequest('GET', 'http://localhost/api/health'));
    expect(result.status).toBe(200);
    expect(JSON.parse(bodyText(result)).ok).toBe(true);
  });

  it('preserves the query string', async () => {
    const result = await handler()(
      fakeRequest('GET', 'http://localhost/api/reminders/dry-run?date=2026-09-19'),
    );
    expect(result.status).toBe(200);
    expect(JSON.parse(bodyText(result)).today).toBe('2026-09-19');
  });

  it('passes a JSON body through on POST', async () => {
    const payload = {
      name: 'Adapter Test Tool',
      billing_cycle: 'monthly',
      cost_amount: 50000,
      currency: 'INR',
      cancellation_notice_days: 0,
    };

    const result = await handler()(
      fakeRequest('POST', 'http://localhost/api/tools', {
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(result.status).toBe(201);
    expect(JSON.parse(bodyText(result)).tool.name).toBe('Adapter Test Tool');
  });

  it('forwards request headers, so the token guard sees them', async () => {
    const withToken = createHandler(
      () => testEnv(ctx.db, { REMINDER_TOKEN: 'shared-secret-value' }) as never,
    );

    const refused = await withToken(fakeRequest('POST', 'http://localhost/api/reminders/run'));
    expect(refused.status).toBe(401);

    const allowed = await withToken(
      fakeRequest('POST', 'http://localhost/api/reminders/run', {
        headers: { 'x-reminder-token': 'shared-secret-value' },
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it('returns the response headers Azure needs to send', async () => {
    const result = await handler()(fakeRequest('GET', 'http://localhost/api/health'));
    const headers = result.headers as Record<string, string>;
    expect(headers['content-type']).toContain('application/json');
  });

  it('returns a 404 as a 404, not an exception', async () => {
    const result = await handler()(fakeRequest('GET', 'http://localhost/api/nope'));
    expect(result.status).toBe(404);
  });

  it('turns a thrown error into a 500 with a readable message', async () => {
    const broken = createHandler(() => {
      throw new Error('DATABASE_URL is not set.');
    });
    const result = await broken(fakeRequest('GET', 'http://localhost/api/health'));
    expect(result.status).toBe(500);
    expect(bodyText(result)).toContain('DATABASE_URL is not set.');
  });

  it('carries a non-JSON body through unmangled', async () => {
    const response = new Response('a,b,c\n1,2,3', {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });
    const result = await toAzureResponse(response);
    expect(bodyText(result)).toBe('a,b,c\n1,2,3');
    expect((result.headers as Record<string, string>)['content-type']).toContain('text/csv');
  });
});
