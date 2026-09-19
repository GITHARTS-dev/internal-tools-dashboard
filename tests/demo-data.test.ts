import { describe, expect, it } from 'vitest';
import { api, testDb, testEnv, toolPayload } from './db-helper';

async function status(env: Record<string, unknown>) {
  const { json } = await api(env, 'GET', '/api/data');
  return json.status as { tools: number; payments: number; demo_tools: number; own_tools: number };
}

describe('demo data controls', () => {
  it('loads the demo data into an empty database', async () => {
    const env = testEnv(testDb().db);
    expect((await status(env)).tools).toBe(0);

    const res = await api(env, 'POST', '/api/data/demo');
    expect(res.status).toBe(200);
    expect(res.json.status.demo_tools).toBeGreaterThanOrEqual(15);
    expect(res.json.status.payments).toBeGreaterThan(0);
  });

  it('does not duplicate anything when loaded twice', async () => {
    const env = testEnv(testDb().db);
    await api(env, 'POST', '/api/data/demo');
    const first = await status(env);
    await api(env, 'POST', '/api/data/demo');
    expect(await status(env)).toEqual(first);
  });

  it('removes only the demo rows and keeps what a person added', async () => {
    const env = testEnv(testDb().db);
    await api(env, 'POST', '/api/data/demo');
    const created = await api(env, 'POST', '/api/tools', toolPayload({ name: 'My Own Tool' }));
    expect(created.status).toBe(201);

    const res = await api(env, 'DELETE', '/api/data/demo');
    expect(res.json.status).toMatchObject({ demo_tools: 0, own_tools: 1, tools: 1 });

    const { json } = await api(env, 'GET', '/api/tools');
    expect(json.tools.map((t: any) => t.name)).toEqual(['My Own Tool']);
  });

  it('deletes everything only when confirmed', async () => {
    const env = testEnv(testDb().db);
    await api(env, 'POST', '/api/data/demo');

    const refused = await api(env, 'DELETE', '/api/data');
    expect(refused.status).toBe(400);
    expect((await status(env)).tools).toBeGreaterThan(0);

    const done = await api(env, 'DELETE', '/api/data?confirm=true');
    expect(done.json.status).toMatchObject({ tools: 0, payments: 0 });
  });

  it('leaves the app working on an empty database', async () => {
    const env = testEnv(testDb().db);
    await api(env, 'POST', '/api/data/demo');
    await api(env, 'DELETE', '/api/data?confirm=true');

    const { status: code, json } = await api(env, 'GET', '/api/dashboard');
    expect(code).toBe(200);
    expect(json.alerts).toEqual([]);
  });

  it('is switched off in production', async () => {
    const env = testEnv(testDb().db, { APP_ENV: 'production' });
    expect((await api(env, 'POST', '/api/data/demo')).status).toBe(403);
    expect((await api(env, 'DELETE', '/api/data/demo')).status).toBe(403);
    expect((await api(env, 'DELETE', '/api/data?confirm=true')).status).toBe(403);
    expect((await api(env, 'GET', '/api/data')).json.enabled).toBe(false);
  });
});
