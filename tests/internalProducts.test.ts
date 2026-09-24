import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, testDb, testEnv, toolPayload } from './db-helper';
import { testPgDb, type PgTestDb } from './pg-helper';
import type { Db } from '../src/server/repo/db';

/**
 * Internal products, through the HTTP API, on both engines.
 *
 * The edit path is the reason this file exists. The screen used to have no way
 * to edit at all, so the PATCH route had never been exercised by anything, and
 * it carries the one bug that partial updates are prone to: Zod applies
 * `.default()` values even through `.partial()`, so a PATCH of `{name}` parsed
 * naively comes back with `status: 'live'` and quietly resets every product to
 * live the moment it is renamed.
 */

const FULL = {
  name: 'HARTS Timesheet',
  description: 'Internal time tracking',
  status: 'building',
  owner_name: 'Madhan',
  owner_email: 'madhan@example.com',
  launched_on: '2026-03-01',
  notes: 'Moving off Supabase free tier next quarter',
};

let pg: PgTestDb;

beforeAll(async () => {
  pg = await testPgDb();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

const engines: Array<[string, () => Db]> = [
  ['SQLite', () => testDb().db],
  ['Postgres', () => pg.db],
];

describe.each(engines)('internal products on %s', (_name, makeDb) => {
  const fresh = () => testEnv(makeDb());

  async function create(env: ReturnType<typeof fresh>, over: Record<string, unknown> = {}) {
    const res = await api(env, 'POST', '/api/internal-products', { ...FULL, ...over });
    expect(res.status).toBe(201);
    return res.json.product as Record<string, unknown> & { id: string };
  }

  it('stores every field it is given', async () => {
    const env = fresh();
    const product = await create(env);

    expect(product).toMatchObject({
      name: 'HARTS Timesheet',
      description: 'Internal time tracking',
      status: 'building',
      owner_name: 'Madhan',
      owner_email: 'madhan@example.com',
      launched_on: '2026-03-01',
      notes: 'Moving off Supabase free tier next quarter',
    });

    const read = await api(env, 'GET', `/api/internal-products/${product.id}`);
    expect(read.json.product.notes).toBe(FULL.notes);
  });

  it('edits one field without resetting the others', async () => {
    const env = fresh();
    const product = await create(env);

    const res = await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      name: 'HARTS Timesheet v2',
    });

    expect(res.status).toBe(200);
    expect(res.json.product.name).toBe('HARTS Timesheet v2');
    // The Zod-default trap: these must survive a rename untouched.
    expect(res.json.product.status).toBe('building');
    expect(res.json.product.owner_name).toBe('Madhan');
    expect(res.json.product.launched_on).toBe('2026-03-01');
  });

  it('clears an optional field when it is sent empty', async () => {
    const env = fresh();
    const product = await create(env);

    const res = await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      owner_name: '',
      notes: '',
    });

    expect(res.status).toBe(200);
    // Empty means "not set", stored as null -- not as an empty string.
    expect(res.json.product.owner_name).toBeNull();
    expect(res.json.product.notes).toBeNull();
    expect(res.json.product.name).toBe('HARTS Timesheet');
  });

  it('retires a product with a date', async () => {
    const env = fresh();
    const product = await create(env, { status: 'live' });

    const res = await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      status: 'retired',
      retired_on: '2026-09-01',
    });

    expect(res.json.product.status).toBe('retired');
    expect(res.json.product.retired_on).toBe('2026-09-01');
  });

  it('un-retires a product by clearing the date', async () => {
    const env = fresh();
    const product = await create(env);
    await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      status: 'retired',
      retired_on: '2026-09-01',
    });

    const res = await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      status: 'live',
      retired_on: '',
    });

    expect(res.json.product.status).toBe('live');
    expect(res.json.product.retired_on).toBeNull();
  });

  it('rejects a bad email with a message for that field', async () => {
    const env = fresh();
    const product = await create(env);

    const res = await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      owner_email: 'not-an-email',
    });

    expect(res.status).toBe(400);
    expect(res.json.fields.owner_email).toBeTruthy();
  });

  it('rejects an impossible date', async () => {
    const env = fresh();
    const product = await create(env);

    const res = await api(env, 'PATCH', `/api/internal-products/${product.id}`, {
      launched_on: '2026-02-30',
    });

    expect(res.status).toBe(400);
    expect(res.json.fields.launched_on).toBeTruthy();
  });

  it('refuses to create a product with no name', async () => {
    const res = await api(fresh(), 'POST', '/api/internal-products', { ...FULL, name: '  ' });
    expect(res.status).toBe(400);
    expect(res.json.fields.name).toBeTruthy();
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await api(fresh(), 'PATCH', '/api/internal-products/nope', { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('records edits in the audit log', async () => {
    const env = fresh();
    const product = await create(env);
    await api(env, 'PATCH', `/api/internal-products/${product.id}`, { name: 'Renamed' });

    const audit = await api(env, 'GET', '/api/audit');
    const summaries = (audit.json.audit as Array<{ summary: string }>).map((a) => a.summary);
    expect(summaries.some((s) => s.includes('Updated name'))).toBe(true);
  });

  it('keeps the tools attributed to a product when it is removed', async () => {
    const env = fresh();
    const product = await create(env);

    const tool = await api(
      env,
      'POST',
      '/api/tools',
      toolPayload({ name: 'Vercel Hosting', internal_product_id: product.id }),
    );
    expect(tool.status).toBe(201);
    const toolId = tool.json.tool.id;

    const removed = await api(env, 'DELETE', `/api/internal-products/${product.id}`);
    expect(removed.status).toBe(200);
    expect(removed.json.tools_released).toBe(1);

    // The bill survives the product it belonged to; it just stops being attributed.
    const after = await api(env, 'GET', `/api/tools/${toolId}`);
    expect(after.status).toBe(200);
    expect(after.json.tool.internal_product_id).toBeNull();
  });
});
