import { beforeEach, describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRows, toCsv } from '../src/shared/csv';
import { api, testDb, testEnv, toolPayload } from './db-helper';
import type { Db } from '../src/server/repo/db';

let db: Db;
let env: Record<string, unknown>;

beforeEach(() => {
  ({ db } = testDb());
  env = testEnv(db);
});

describe('CSV formatting', () => {
  it('quotes the values that would otherwise break the file', () => {
    const csv = toCsv(['name', 'notes'], [
      { name: 'Canva, Teams', notes: 'He said "use it"' },
      { name: 'Multi', notes: 'line one\nline two' },
    ]);
    const rows = parseCsvRows(csv);

    expect(rows[1]).toEqual(['Canva, Teams', 'He said "use it"']);
    expect(rows[2]).toEqual(['Multi', 'line one\nline two']);
  });

  it('round-trips empty and missing values as blanks', () => {
    const rows = parseCsv(toCsv(['name', 'a', 'b'], [{ name: 'Canva', a: '', b: null }]));
    expect(rows[0]).toEqual({ name: 'Canva', a: '', b: '' });
  });

  it('discards rows that are blank in every column', () => {
    // Spreadsheets routinely export stray empty rows in the middle of a file,
    // and importing them as nameless records would just create noise.
    const rows = parseCsv('name,vendor\nCanva,Canva Pty\n,\nNotion,Notion Labs\n');
    expect(rows.map((r) => r['name'])).toEqual(['Canva', 'Notion']);
  });

  it('normalises header names', () => {
    const rows = parseCsv('Owner Name,RENEWAL_DATE\nPriya,2026-10-01\n');
    expect(rows[0]!['owner_name']).toBe('Priya');
    expect(rows[0]!['renewal_date']).toBe('2026-10-01');
  });

  it('ignores trailing blank lines', () => {
    expect(parseCsv('name\nCanva\n\n\n')).toHaveLength(1);
  });
});

describe('export', () => {
  it('writes costs as plain decimals so the file is editable in Excel', async () => {
    await api(env, 'POST', '/api/tools', toolPayload({ cost_amount: 1499000, currency: 'INR' }));
    const res = await api(env, 'GET', '/api/export/tools.csv');

    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows[0]!['cost']).toBe('14990.00');
    expect(rows[0]!['auto_renew']).toBe('yes');
  });

  it('includes archived tools, because the ledger is the point', async () => {
    const created = await api(env, 'POST', '/api/tools', toolPayload());
    await api(env, 'POST', `/api/tools/${created.json.tool.id}/archive`, {});

    const rows = parseCsv((await api(env, 'GET', '/api/export/tools.csv')).text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['status']).toBe('cancelled');
  });

  it('offers a template with a worked example row', async () => {
    const rows = parseCsv((await api(env, 'GET', '/api/export/template.csv')).text);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['name']).toBe('Canva Teams');
    expect(rows[0]!['cancellation_notice_days']).toBe('30');
  });
});

describe('import', () => {
  const csv = [
    'name,vendor,category,billing_cycle,cost,currency,owner_name,owner_email,renewal_date,seats_purchased,seats_used,auto_renew,cancellation_notice_days',
    'Canva Teams,Canva,Design,annual,14990.00,INR,Priya Nair,priya@example.com,2027-03-14,5,4,yes,30',
    'Microsoft 365,Microsoft,Productivity,monthly,"1,250.00",INR,Ravi K,ravi@example.com,2026-10-01,25,22,yes,0',
  ].join('\n');

  it('reports what it would do and writes nothing by default', async () => {
    const res = await api(env, 'POST', '/api/import', csv);

    expect(res.status).toBe(200);
    expect(res.json.committed).toBe(false);
    expect(res.json.summary).toEqual({ total: 2, created: 2, updated: 0, rejected: 0 });
    expect(res.json.results[0].action).toBe('create');

    // Nothing was written: an import has to be confirmed explicitly.
    expect((await api(env, 'GET', '/api/tools')).json.tools).toHaveLength(0);
  });

  it('writes the rows once committed, parsing money and flags correctly', async () => {
    const res = await api(env, 'POST', '/api/import?commit=true', csv);
    expect(res.json.committed).toBe(true);

    const tools = (await api(env, 'GET', '/api/tools')).json.tools;
    expect(tools).toHaveLength(2);

    const m365 = tools.find((t: any) => t.name === 'Microsoft 365');
    expect(m365.cost_amount).toBe(125000); // "1,250.00" with a comma inside quotes
    expect(m365.billing_cycle).toBe('monthly');
    expect(m365.auto_renew).toBe(true);
    expect(m365.seats_used).toBe(22);
  });

  it('updates in place on re-import instead of creating duplicates', async () => {
    await api(env, 'POST', '/api/import?commit=true', csv);
    const changed = csv.replace('14990.00', '16990.00');

    const res = await api(env, 'POST', '/api/import?commit=true', changed);
    expect(res.json.summary.updated).toBe(2);
    expect(res.json.summary.created).toBe(0);

    const tools = (await api(env, 'GET', '/api/tools')).json.tools;
    expect(tools).toHaveLength(2);
    expect(tools.find((t: any) => t.name === 'Canva Teams').cost_amount).toBe(1699000);
  });

  it('round-trips its own export', async () => {
    await api(env, 'POST', '/api/import?commit=true', csv);
    const exported = (await api(env, 'GET', '/api/export/tools.csv')).text;

    const res = await api(env, 'POST', '/api/import', exported);
    expect(res.json.summary.rejected).toBe(0);
    expect(res.json.summary.updated).toBe(2);
  });

  it('rejects bad rows individually and says why, keeping the good ones', async () => {
    const mixed = [
      'name,billing_cycle,cost,currency,renewal_date,owner_email',
      'Good Tool,monthly,100.00,INR,2026-12-01,a@example.com',
      ',monthly,100.00,INR,2026-12-01,a@example.com',
      'Bad Date,monthly,100.00,INR,2026-02-30,a@example.com',
      'Bad Email,monthly,100.00,INR,2026-12-01,not-an-email',
    ].join('\n');

    const res = await api(env, 'POST', '/api/import?commit=true', mixed);
    expect(res.json.summary).toEqual({ total: 4, created: 1, updated: 0, rejected: 3 });

    const byName = Object.fromEntries(res.json.results.map((r: any) => [r.name || '(blank)', r]));
    expect(byName['(blank)'].message).toContain('No name');
    expect(byName['Bad Date'].message).toContain('renewal_date');
    expect(byName['Bad Email'].message).toContain('owner_email');

    // The one valid row still landed.
    expect((await api(env, 'GET', '/api/tools')).json.tools).toHaveLength(1);
  });

  it('reports the spreadsheet row number, so a rejection is findable', async () => {
    const res = await api(env, 'POST', '/api/import', 'name\n\nGood\n');
    // Row 2 is the first data row in the file as a person sees it.
    expect(res.json.results[0].row).toBe(2);
  });

  it('refuses an empty file rather than reporting a successful no-op', async () => {
    expect((await api(env, 'POST', '/api/import', '')).status).toBe(400);
    expect((await api(env, 'POST', '/api/import', 'name,vendor\n')).status).toBe(400);
  });

  it('records the import in the audit log', async () => {
    await api(env, 'POST', '/api/import?commit=true', csv);
    const audit = (await api(env, 'GET', '/api/audit')).json.audit;
    expect(audit.some((a: any) => a.entity === 'import' && a.summary.includes('2 added'))).toBe(true);
  });
});
