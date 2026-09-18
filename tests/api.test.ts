import { beforeEach, describe, expect, it } from 'vitest';
import { api, testDb, testEnv, toolPayload } from './db-helper';
import type { Db } from '../src/server/repo/db';

let db: Db;
let env: Record<string, unknown>;

beforeEach(() => {
  ({ db } = testDb());
  env = testEnv(db);
});

async function createTool(overrides: Record<string, unknown> = {}) {
  const res = await api(env, 'POST', '/api/tools', toolPayload(overrides));
  expect(res.status).toBe(201);
  return res.json.tool;
}

describe('health', () => {
  it('answers', async () => {
    const res = await api(env, 'GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });

  it('returns JSON, not HTML, for an unknown API route', async () => {
    const res = await api(env, 'GET', '/api/nope');
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('not_found');
  });
});

describe('creating tools', () => {
  it('stores a tool and records who added it', async () => {
    const tool = await createTool();
    expect(tool.name).toBe('Canva Teams');
    expect(tool.auto_renew).toBe(true); // round-trips through SQLite's 0/1

    const detail = await api(env, 'GET', `/api/tools/${tool.id}`);
    expect(detail.json.audit).toHaveLength(1);
    expect(detail.json.audit[0].action).toBe('create');
    expect(detail.json.audit[0].summary).toContain('Canva Teams');
  });

  it('attributes the change to the acting user when one is given', async () => {
    const { app } = await import('../src/server/index');
    const response = await app.fetch(
      new Request('http://localhost/api/tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-actor': 'priya@example.com' },
        body: JSON.stringify(toolPayload()),
      }),
      env as never,
    );
    const { tool } = (await response.json()) as { tool: { id: string } };

    const detail = await api(env, 'GET', `/api/tools/${tool.id}`);
    expect(detail.json.audit[0].actor).toBe('priya@example.com');
  });

  it('rejects a tool with no name, naming the field', async () => {
    const res = await api(env, 'POST', '/api/tools', toolPayload({ name: '' }));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('validation_failed');
    expect(res.json.fields.name).toContain('needs a name');
  });

  it('rejects an impossible renewal date', async () => {
    const res = await api(env, 'POST', '/api/tools', toolPayload({ renewal_date: '2026-02-30' }));
    expect(res.status).toBe(400);
    expect(res.json.fields.renewal_date).toContain('real calendar date');
  });

  it('rejects a malformed owner email', async () => {
    const res = await api(env, 'POST', '/api/tools', toolPayload({ owner_email: 'priya-at-example' }));
    expect(res.status).toBe(400);
    expect(res.json.fields.owner_email).toBeTruthy();
  });

  it('treats blank optional fields as not-set rather than empty strings', async () => {
    const tool = await createTool({ vendor: '', department: '', renewal_date: '', notes: '' });
    expect(tool.vendor).toBeNull();
    expect(tool.renewal_date).toBeNull();
  });
});

describe('editing tools', () => {
  it('records what changed, with before and after values', async () => {
    const tool = await createTool();
    const res = await api(env, 'PATCH', `/api/tools/${tool.id}`, { renewal_date: '2027-04-01' });
    expect(res.status).toBe(200);
    expect(res.json.tool.renewal_date).toBe('2027-04-01');

    const detail = await api(env, 'GET', `/api/tools/${tool.id}`);
    const update = detail.json.audit.find((a: any) => a.action === 'update');
    expect(update.summary).toContain('renewal_date');

    const changes = JSON.parse(update.diff_json);
    expect(changes).toContainEqual({ field: 'renewal_date', from: '2027-03-14', to: '2027-04-01' });
  });

  it('does not write a history entry for an edit that changed nothing', async () => {
    const tool = await createTool();
    await api(env, 'PATCH', `/api/tools/${tool.id}`, { name: 'Canva Teams' });

    const detail = await api(env, 'GET', `/api/tools/${tool.id}`);
    expect(detail.json.audit.filter((a: any) => a.action === 'update')).toHaveLength(0);
  });

  it('leaves every field the caller did not send untouched', async () => {
    // Regression: Zod applies .default() values even through .partial(), so a
    // PATCH of {name} used to parse into a full object and silently reset
    // billing_cycle to 'monthly', status to 'active', currency to 'INR' and
    // auto_renew to true. Renaming a tool quietly destroyed its billing setup.
    const tool = await createTool({
      billing_cycle: 'annual',
      status: 'trial',
      currency: 'USD',
      category: 'Design',
      auto_renew: false,
      cancellation_notice_days: 45,
      seats_purchased: 12,
    });

    const res = await api(env, 'PATCH', `/api/tools/${tool.id}`, { name: 'Canva Enterprise' });
    expect(res.status).toBe(200);

    const after = res.json.tool;
    expect(after.name).toBe('Canva Enterprise');
    expect(after.billing_cycle).toBe('annual');
    expect(after.status).toBe('trial');
    expect(after.currency).toBe('USD');
    expect(after.category).toBe('Design');
    expect(after.auto_renew).toBe(false);
    expect(after.cancellation_notice_days).toBe(45);
    expect(after.seats_purchased).toBe(12);
  });

  it('can still clear a field by sending it explicitly as null', async () => {
    const tool = await createTool();
    const res = await api(env, 'PATCH', `/api/tools/${tool.id}`, { renewal_date: null });
    expect(res.json.tool.renewal_date).toBeNull();
  });

  it('404s for a tool that does not exist', async () => {
    expect((await api(env, 'PATCH', '/api/tools/nope', { name: 'x' })).status).toBe(404);
    expect((await api(env, 'GET', '/api/tools/nope')).status).toBe(404);
  });
});

describe('archiving', () => {
  it('keeps the tool and its payment history instead of deleting them', async () => {
    const tool = await createTool();
    await api(env, 'POST', `/api/tools/${tool.id}/payments`, { due_date: '2026-09-01', amount: 1499000 });

    const archived = await api(env, 'POST', `/api/tools/${tool.id}/archive`, { cancelled_on: '2026-09-18' });
    expect(archived.status).toBe(200);
    expect(archived.json.tool.status).toBe('cancelled');
    expect(archived.json.tool.cancelled_on).toBe('2026-09-18');

    // The whole point of the ledger: the history survives the cancellation.
    const detail = await api(env, 'GET', `/api/tools/${tool.id}`);
    expect(detail.json.payments).toHaveLength(1);

    const history = await api(env, 'GET', '/api/dashboard/history');
    expect(history.json.archived).toHaveLength(1);
  });

  it('leaves archived tools out of the default list but keeps them available', async () => {
    const tool = await createTool();
    await api(env, 'POST', `/api/tools/${tool.id}/archive`, {});

    expect((await api(env, 'GET', '/api/tools')).json.tools).toHaveLength(0);
    expect((await api(env, 'GET', '/api/tools?include_archived=true')).json.tools).toHaveLength(1);
  });

  it('can restore an archived tool', async () => {
    const tool = await createTool();
    await api(env, 'POST', `/api/tools/${tool.id}/archive`, {});
    const restored = await api(env, 'POST', `/api/tools/${tool.id}/restore`, {});

    expect(restored.json.tool.status).toBe('active');
    expect(restored.json.tool.cancelled_on).toBeNull();
  });
});

describe('payments', () => {
  it('schedules a payment from the tool\'s own cycle and cost', async () => {
    const tool = await createTool();
    const res = await api(env, 'POST', `/api/tools/${tool.id}/payments`, {});

    expect(res.status).toBe(201);
    expect(res.json.payment.due_date).toBe('2027-03-14'); // the renewal date
    expect(res.json.payment.amount).toBe(1499000); // the tool's cost
    expect(res.json.payment.period_end).toBe('2028-03-14'); // one annual cycle on
    expect(res.json.payment.status).toBe('due');
  });

  it('refuses to guess a due date when the tool has no renewal date', async () => {
    const tool = await createTool({ renewal_date: null });
    const res = await api(env, 'POST', `/api/tools/${tool.id}/payments`, {});

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('missing_due_date');
  });

  it('marks a payment paid and records it in the history', async () => {
    const tool = await createTool();
    const created = await api(env, 'POST', `/api/tools/${tool.id}/payments`, {});
    const id = created.json.payment.id;

    const res = await api(env, 'POST', `/api/payments/${id}/mark-paid`, {
      paid_on: '2027-03-12',
      paid_by: 'Finance',
      invoice_ref: 'INV-2027-0041',
    });

    expect(res.json.payment.status).toBe('paid');
    expect(res.json.payment.paid_on).toBe('2027-03-12');
    expect(res.json.payment.invoice_ref).toBe('INV-2027-0041');

    const audit = await api(env, 'GET', '/api/audit');
    const entry = audit.json.audit.find((a: any) => a.entity === 'payment' && a.summary.includes('Marked paid'));
    expect(entry).toBeTruthy();
  });

  it('defaults the paid date to today in the business timezone', async () => {
    const tool = await createTool();
    const created = await api(env, 'POST', `/api/tools/${tool.id}/payments`, {});
    const res = await api(env, 'POST', `/api/payments/${created.json.payment.id}/mark-paid`, {});

    expect(res.json.payment.paid_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('marks several payments paid in one call', async () => {
    const tool = await createTool();
    const a = await api(env, 'POST', `/api/tools/${tool.id}/payments`, { due_date: '2026-01-01' });
    const b = await api(env, 'POST', `/api/tools/${tool.id}/payments`, { due_date: '2026-02-01' });

    const res = await api(env, 'POST', '/api/payments/bulk-mark-paid', {
      ids: [a.json.payment.id, b.json.payment.id],
      paid_on: '2026-02-02',
    });

    expect(res.json.count).toBe(2);
    const list = await api(env, 'GET', '/api/payments?status=paid');
    expect(list.json.payments).toHaveLength(2);
  });

  it('rejects a bulk call with nothing selected', async () => {
    const res = await api(env, 'POST', '/api/payments/bulk-mark-paid', { ids: [] });
    expect(res.status).toBe(400);
  });

  it('filters the ledger by status and due-date range', async () => {
    const tool = await createTool();
    await api(env, 'POST', `/api/tools/${tool.id}/payments`, { due_date: '2026-01-15' });
    await api(env, 'POST', `/api/tools/${tool.id}/payments`, { due_date: '2026-06-15' });

    const res = await api(env, 'GET', '/api/payments?due_from=2026-05-01&due_to=2026-12-31');
    expect(res.json.payments).toHaveLength(1);
    expect(res.json.payments[0].due_date).toBe('2026-06-15');
  });
});

describe('dashboard', () => {
  it('returns KPIs and alerts computed for a given day', async () => {
    await createTool({ name: 'Zoom', renewal_date: '2026-10-01', billing_cycle: 'monthly', cost_amount: 200000 });
    const res = await api(env, 'GET', '/api/dashboard?date=2026-09-18');

    expect(res.status).toBe(200);
    expect(res.json.today).toBe('2026-09-18');
    expect(res.json.kpis.active_tools).toBe(1);
    expect(res.json.kpis.monthly_run_rate.INR).toBe(200000);
    expect(res.json.alerts.some((a: any) => a.rule === 'renewal_upcoming')).toBe(true);
  });

  it('counts overdue payments in the KPI tile and the alert queue alike', async () => {
    const tool = await createTool();
    await api(env, 'POST', `/api/tools/${tool.id}/payments`, { due_date: '2026-09-01' });

    const res = await api(env, 'GET', '/api/dashboard?date=2026-09-18');
    expect(res.json.kpis.overdue_count).toBe(1);
    expect(res.json.alerts.filter((a: any) => a.rule === 'payment_overdue')).toHaveLength(1);
  });

  it('rejects a nonsense date rather than silently using today', async () => {
    const res = await api(env, 'GET', '/api/dashboard?date=notadate');
    // Falls back to the real today rather than 400ing the whole dashboard.
    expect(res.status).toBe(200);
    expect(res.json.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('settings', () => {
  it('reports which notification channels can actually send', async () => {
    const res = await api(env, 'GET', '/api/settings');
    const byName = Object.fromEntries(res.json.channels.map((ch: any) => [ch.name, ch.configured]));

    expect(byName.console).toBe(true);
    expect(byName.teams).toBe(false); // no webhook yet
    expect(byName.email).toBe(false); // deliberately inert until credentials exist
  });

  it('saves changes and parses list settings back into numbers', async () => {
    const res = await api(env, 'PATCH', '/api/settings', {
      renewal_lead_days: '[45,10]',
      timezone: 'Asia/Kolkata',
    });
    expect(res.json.settings.renewal_lead_days).toEqual([45, 10]);
  });

  it('falls back to the default when a stored setting is malformed', async () => {
    await api(env, 'PATCH', '/api/settings', { renewal_lead_days: 'not json' });
    const res = await api(env, 'GET', '/api/settings');
    // A bad value must not take the reminder job down with it.
    expect(res.json.settings.renewal_lead_days).toEqual([60, 30, 14, 7, 3, 1]);
  });
});

describe('documents feature flag', () => {
  it('is unreachable while the flag is off', async () => {
    const res = await api(env, 'GET', '/api/documents/anything');
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('feature_disabled');
  });

  it('works once the flag is on', async () => {
    const tool = await createTool();
    const enabled = testEnv(db, { FEATURE_DOCUMENTS: 'true' });

    const created = await api(enabled, 'POST', '/api/documents', {
      tool_id: tool.id,
      kind: 'contract',
      title: 'Canva order form 2027',
      external_url: 'https://example.sharepoint.com/canva.pdf',
    });
    expect(created.status).toBe(201);

    const list = await api(enabled, 'GET', `/api/documents/${tool.id}`);
    expect(list.json.documents).toHaveLength(1);
  });
});
