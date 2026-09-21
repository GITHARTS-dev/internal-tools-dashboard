import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './db-helper';
import { testPgDb, type PgTestDb } from './pg-helper';
import { runReminders } from '../src/server/reminders';
import { createInternalProduct } from '../src/server/repo/internalProducts';
import { upsertProductCost } from '../src/server/repo/productCosts';
import type { Db } from '../src/server/repo/db';
import type { Channel, NotificationPayload } from '../src/server/notify/types';

/**
 * The missing-costs reminder, end to end through the real reminder job.
 *
 * The pure alert logic is covered elsewhere. What this file proves is the part
 * that only shows up when it is actually sent and recorded: the notification log
 * has a foreign key from tool_id to tools, and a product alert has no tool, so
 * if it were written with a made-up tool_id the insert would fail and the
 * reminder would be re-sent every morning because it was never marked as sent.
 */

let pg: PgTestDb;

beforeAll(async () => {
  pg = await testPgDb();
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

/**
 * SQLite hands back a fresh database each time. PGlite is one instance for the
 * whole file, so it is emptied first: without that, products and log rows from
 * an earlier test leak into the next one and a count that should be one is four.
 */
async function freshPostgres(): Promise<Db> {
  for (const table of ['notification_log', 'product_costs', 'internal_products', 'audit_log']) {
    await pg.db.prepare(`DELETE FROM ${table}`).run();
  }
  return pg.db;
}

const engines: Array<[string, () => Promise<Db>]> = [
  ['SQLite', async () => testDb().db],
  ['Postgres', freshPostgres],
];

/** A channel that just remembers what it was asked to send. */
function spyChannel(): Channel & { sent: NotificationPayload[] } {
  const sent: NotificationPayload[] = [];
  return {
    name: 'spy',
    sent,
    isConfigured: () => true,
    async send(payload) {
      sent.push(payload);
      return { channel: 'spy', status: 'sent', detail: `sent ${payload.alerts.length}` };
    },
  };
}

const PRODUCT = {
  name: 'TRA',
  description: null,
  status: 'live' as const,
  owner_name: 'Madhan',
  owner_email: 'madhan@example.com',
  // Launched long ago, so last month's bill certainly existed.
  launched_on: '2024-01-01',
  retired_on: null,
  notes: null,
};

const costAlerts = (payload: NotificationPayload) =>
  payload.alerts.filter((a) => a.rule === 'costs_missing');

describe.each(engines)('missing-costs reminders on %s', (_name, makeDb) => {
  it('sends the reminder, and records it without a tool', async () => {
    const db = await makeDb();
    const product = await createInternalProduct(db, PRODUCT);
    const spy = spyChannel();

    const run = await runReminders(db, {}, { today: '2026-09-19', channels: [spy] });

    expect(spy.sent).toHaveLength(1);
    const [alert] = costAlerts(spy.sent[0]!);
    expect(alert!.product_id).toBe(product.id);
    expect(run.alerts.some((a) => a.rule === 'costs_missing')).toBe(true);

    // The reminder was recorded. If tool_id had been written as anything but
    // NULL the foreign key would have rejected it and this would be empty.
    const { results } = await db
      .prepare(`SELECT tool_id, rule, status FROM notification_log WHERE rule = 'costs_missing'`)
      .all<{ tool_id: string | null; rule: string; status: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_id).toBeNull();
    expect(results[0]!.status).toBe('sent');
  });

  it('does not resend it the next morning', async () => {
    const db = await makeDb();
    await createInternalProduct(db, PRODUCT);
    const spy = spyChannel();

    await runReminders(db, {}, { today: '2026-09-19', channels: [spy] });
    await runReminders(db, {}, { today: '2026-09-20', channels: [spy] });

    // Same week, same missing month: told once, not daily.
    expect(spy.sent.flatMap(costAlerts)).toHaveLength(1);
  });

  it('chases it again a week later if it is still missing', async () => {
    const db = await makeDb();
    await createInternalProduct(db, PRODUCT);
    const spy = spyChannel();

    await runReminders(db, {}, { today: '2026-09-19', channels: [spy] });
    await runReminders(db, {}, { today: '2026-09-26', channels: [spy] });

    expect(spy.sent.flatMap(costAlerts)).toHaveLength(2);
  });

  it('stops once the month is entered', async () => {
    const db = await makeDb();
    const product = await createInternalProduct(db, PRODUCT);
    await upsertProductCost(db, product.id, {
      month: '2026-08',
      provider: 'AWS',
      amount: 31250,
      currency: 'USD',
      note: null,
    });
    const spy = spyChannel();

    await runReminders(db, {}, { today: '2026-09-19', channels: [spy] });

    expect(spy.sent.flatMap(costAlerts)).toHaveLength(0);
  });

  it('does not nag before the bills are final', async () => {
    const db = await makeDb();
    await createInternalProduct(db, PRODUCT);
    const spy = spyChannel();

    await runReminders(db, {}, { today: '2026-09-02', channels: [spy] });

    expect(spy.sent.flatMap(costAlerts)).toHaveLength(0);
  });

  it('shows in the dry run without sending or recording anything', async () => {
    const db = await makeDb();
    await createInternalProduct(db, PRODUCT);
    const spy = spyChannel();

    const run = await runReminders(db, {}, { today: '2026-09-19', dryRun: true, channels: [spy] });

    expect(run.alerts.some((a) => a.rule === 'costs_missing')).toBe(true);
    expect(spy.sent).toHaveLength(0);
    const { results } = await db.prepare('SELECT COUNT(*) AS n FROM notification_log').all<{ n: number }>();
    expect(Number(results[0]!.n)).toBe(0);
  });
});
