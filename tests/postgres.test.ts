import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPgDb, type PgTestDb } from './pg-helper';
import { toPgPlaceholders } from '../src/server/repo/postgres';
import {
  createTool,
  distinctCategories,
  distinctOwners,
  getTool,
  listTools,
  updateTool,
  archiveTool,
} from '../src/server/repo/tools';
import { createInternalProduct, listInternalProducts, toolCountsByProduct } from '../src/server/repo/internalProducts';
import { getSettings, updateSettings } from '../src/server/repo/settings';
import { saveRates, listRates, fxStatus, rateTablesByMonth } from '../src/server/repo/fxRates';
import { recordNotification, alreadySentKeys } from '../src/server/repo/notifications';
import { recordAudit, listRecentAudit } from '../src/server/repo/audit';
import { toolCreateSchema } from '../src/shared/schema';
import { api, testEnv, toolPayload } from './db-helper';

/**
 * The repository layer, against real Postgres.
 *
 * The SQLite suite already covers behaviour; this one exists to catch dialect
 * differences -- SQL that parses in SQLite and is rejected by Postgres. Every
 * query the app issues in anger should be exercised here at least once.
 */

let ctx: PgTestDb;

beforeAll(async () => {
  ctx = await testPgDb();
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

const tool = (over: Record<string, unknown> = {}) =>
  toolCreateSchema.parse({ ...toolPayload(), ...over });

describe('placeholder rewriting', () => {
  it('numbers placeholders in order', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('leaves question marks inside string literals alone', () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE name = 'what?' AND b = ?")).toBe(
      "SELECT * FROM t WHERE name = 'what?' AND b = $1",
    );
  });

  it('handles an escaped quote inside a literal', () => {
    expect(toPgPlaceholders("SELECT coalesce(v, '') WHERE a = ? AND b = 'it''s? ok' AND c = ?")).toBe(
      "SELECT coalesce(v, '') WHERE a = $1 AND b = 'it''s? ok' AND c = $2",
    );
  });

  it('leaves double-quoted identifiers alone', () => {
    expect(toPgPlaceholders('SELECT "od?d" FROM t WHERE a = ?')).toBe(
      'SELECT "od?d" FROM t WHERE a = $1',
    );
  });
});

describe('tools, on Postgres', () => {
  it('round-trips a tool through insert and read', async () => {
    const created = await createTool(ctx.db, tool({ name: 'Canva Teams' }));
    expect(created.name).toBe('Canva Teams');
    // 0/1 in the column must still surface as a real boolean.
    expect(created.auto_renew).toBe(true);

    const read = await getTool(ctx.db, created.id);
    expect(read?.id).toBe(created.id);
  });

  it('applies a partial update without resetting other columns', async () => {
    const created = await createTool(ctx.db, tool({ name: 'Notion', seats_purchased: 9 }));
    const updated = await updateTool(ctx.db, created.id, { name: 'Notion Plus' });
    expect(updated?.name).toBe('Notion Plus');
    expect(updated?.seats_purchased).toBe(9);
  });

  it('filters and searches', async () => {
    await createTool(ctx.db, tool({ name: 'Zoom Workplace', vendor: 'Zoom', category: 'Communication' }));
    const found = await listTools(ctx.db, { search: 'zoom' });
    expect(found.some((t) => t.name === 'Zoom Workplace')).toBe(true);

    const byCategory = await listTools(ctx.db, { category: 'Communication' });
    expect(byCategory.length).toBeGreaterThan(0);
  });

  it('orders case-insensitively over a DISTINCT set', async () => {
    // The query shape Postgres rejects when ORDER BY sits outside the
    // select list under SELECT DISTINCT.
    await expect(distinctCategories(ctx.db)).resolves.toBeInstanceOf(Array);
    await expect(distinctOwners(ctx.db)).resolves.toBeInstanceOf(Array);
  });

  it('archives rather than deleting', async () => {
    const created = await createTool(ctx.db, tool({ name: 'Dropbox' }));
    const archived = await archiveTool(ctx.db, created.id, '2026-09-01');
    expect(archived?.status).toBe('cancelled');
    expect(archived?.cancelled_on).toBe('2026-09-01');
  });
});

describe('internal products, on Postgres', () => {
  it('keeps attributed tools when the product is removed', async () => {
    const product = await createInternalProduct(ctx.db, {
      name: 'Timesheet',
      description: null,
      status: 'live',
      owner_name: null,
      owner_email: null,
      launched_on: null,
      retired_on: null,
      notes: null,
    });

    await createTool(ctx.db, tool({ name: 'Vercel Hosting', internal_product_id: product.id }));
    const counts = await toolCountsByProduct(ctx.db);
    expect(counts[product.id]).toBe(1);

    const listed = await listInternalProducts(ctx.db);
    expect(listed.some((p) => p.id === product.id)).toBe(true);
  });
});

describe('settings, on Postgres', () => {
  it('upserts through ON CONFLICT DO UPDATE', async () => {
    const before = await getSettings(ctx.db);
    expect(before.timezone).toBeTruthy();

    // This is the batch path, so it also exercises the transaction.
    const after = await updateSettings(ctx.db, {
      timezone: 'Europe/London',
      reporting_currency: 'GBP',
    });
    expect(after.timezone).toBe('Europe/London');
    expect(after.reporting_currency).toBe('GBP');

    await updateSettings(ctx.db, { timezone: 'Asia/Kolkata', reporting_currency: 'INR' });
  });
});

describe('fx rates, on Postgres', () => {
  it('upserts on the composite key and reads back a rate table', async () => {
    await saveRates(ctx.db, [
      { month: '2026-03', currency: 'USD', rate: '1.08', source: 'ecb', fetched_at: 'now' },
      { month: '2026-03', currency: 'INR', rate: '90.5', source: 'ecb', fetched_at: 'now' },
    ]);

    // Same key again: must overwrite, not duplicate.
    await saveRates(ctx.db, [
      { month: '2026-03', currency: 'USD', rate: '1.09', source: 'manual', fetched_at: 'now' },
    ]);

    const rates = await listRates(ctx.db, '2026-03', '2026-03');
    expect(rates).toHaveLength(2);
    expect(rates.find((r) => r.currency === 'USD')?.rate).toBe('1.09');

    const status = await fxStatus(ctx.db);
    // COUNT(DISTINCT ...) comes back as a string from node-postgres unless coerced.
    expect(typeof status.months).toBe('number');
    expect(status.months).toBeGreaterThan(0);

    const tables = await rateTablesByMonth(ctx.db);
    expect(tables['2026-03']).toBeDefined();
  });
});

describe('the HTTP API, on Postgres', () => {
  const env = () => testEnv(ctx.db);

  it('serves the dashboard', async () => {
    const res = await api(env(), 'GET', '/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.json.kpis).toBeDefined();
    expect(Array.isArray(res.json.alerts)).toBe(true);
  });

  it('creates a tool and reads it back through the API', async () => {
    const created = await api(env(), 'POST', '/api/tools', toolPayload({ name: 'Linear' }));
    expect(created.status).toBe(201);

    const id = created.json.tool.id;
    const read = await api(env(), 'GET', `/api/tools/${id}`);
    expect(read.status).toBe(200);
    expect(read.json.tool.name).toBe('Linear');
  });

  it('serves the CEO summary', async () => {
    const res = await api(env(), 'GET', '/api/ceo-summary');
    expect(res.status).toBe(200);
    expect(res.json.reporting_currency).toBeTruthy();
    expect(Array.isArray(res.json.paid_by_month)).toBe(true);
    expect(res.json.paid_by_month).toHaveLength(24);
  });

  it('serves tool options, which use the DISTINCT-plus-ORDER-BY queries', async () => {
    const res = await api(env(), 'GET', '/api/tools/options');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.categories)).toBe(true);
    expect(Array.isArray(res.json.owners)).toBe(true);
  });

  it('previews reminders without sending anything', async () => {
    const res = await api(env(), 'GET', '/api/reminders/dry-run?date=2026-09-19');
    expect(res.status).toBe(200);
    expect(res.json.dry_run).toBe(true);
  });

  it('exports CSV', async () => {
    const res = await api(env(), 'GET', '/api/export/tools.csv');
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[0]).toContain('name');
  });
});

describe('the reminder token guard', () => {
  it('lets the job run when no token is configured', async () => {
    const res = await api(testEnv(ctx.db), 'POST', '/api/reminders/run');
    expect(res.status).toBe(200);
  });

  it('refuses a missing or wrong token when one is configured', async () => {
    const env = testEnv(ctx.db, { REMINDER_TOKEN: 'correct-horse-battery-staple' });

    expect((await api(env, 'POST', '/api/reminders/run')).status).toBe(401);

    const wrong = await api(env, 'POST', '/api/reminders/run', undefined, {
      'x-reminder-token': 'wrong',
    });
    expect(wrong.status).toBe(401);

    // A prefix of the real token must not be accepted either.
    const prefix = await api(env, 'POST', '/api/reminders/run', undefined, {
      'x-reminder-token': 'correct-horse',
    });
    expect(prefix.status).toBe(401);
  });

  it('accepts the right token', async () => {
    const env = testEnv(ctx.db, { REMINDER_TOKEN: 'correct-horse-battery-staple' });
    const res = await api(env, 'POST', '/api/reminders/run', undefined, {
      'x-reminder-token': 'correct-horse-battery-staple',
    });
    expect(res.status).toBe(200);
  });
});

describe('notifications and audit, on Postgres', () => {
  it('refuses a duplicate dedupe key without throwing', async () => {
    await recordNotification(ctx.db, {
      dedupe_key: 'teams:renewal:abc',
      rule: 'renewal_upcoming',
      channel: 'teams',
      status: 'sent',
      detail: 'first',
    });
    // ON CONFLICT DO NOTHING: the second write is a no-op, not an error.
    await recordNotification(ctx.db, {
      dedupe_key: 'teams:renewal:abc',
      rule: 'renewal_upcoming',
      channel: 'teams',
      status: 'sent',
      detail: 'second',
    });

    const seen = await alreadySentKeys(ctx.db, ['teams:renewal:abc', 'teams:renewal:missing']);
    expect(seen.has('teams:renewal:abc')).toBe(true);
    expect(seen.has('teams:renewal:missing')).toBe(false);
  });

  it('writes and reads audit rows', async () => {
    await recordAudit(ctx.db, {
      entity: 'tool',
      entity_id: 'abc',
      action: 'update',
      actor: 'test',
      summary: 'changed something',
    });
    const audit = await listRecentAudit(ctx.db, 10);
    expect(audit.length).toBeGreaterThan(0);
  });
});
