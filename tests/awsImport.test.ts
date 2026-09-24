import { describe, expect, it } from 'vitest';
import { api, testDb, testEnv } from './db-helper';
import { DEFAULT_SETTINGS, type AppSettings } from '../src/shared/types';
import { awsConfig, importAwsCosts, importAwsCostsIfDue, type AwsConfig } from '../src/server/aws/import';
import { getMonthlyCosts } from '../src/server/aws/costExplorer';
import { createInternalProduct } from '../src/server/repo/internalProducts';
import { listProductCosts, upsertProductCost } from '../src/server/repo/productCosts';
import type { Db } from '../src/server/repo/db';

/**
 * The AWS import, against a real schema and a fake Cost Explorer.
 *
 * What is pinned is what protects the figures: an estimated month is never
 * written, a typed line is never overwritten, spend is split by tag with the
 * remainder going to the default product, and a month already imported is not
 * paid for again.
 */

type Result = {
  TimePeriod: { Start: string };
  Estimated?: boolean;
  Total?: Record<string, { Amount: string; Unit: string }>;
  Groups?: Array<{ Keys: string[]; Metrics: Record<string, { Amount: string; Unit: string }> }>;
};

function fakeAws(pages: Array<{ ResultsByTime: Result[]; NextPageToken?: string }>) {
  const calls: Array<{ headers: Record<string, string>; body: any }> = [];
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const page = pages[Math.min(calls.length - 1, pages.length - 1)]!;
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const total = (month: string, amount: string, estimated = false): Result => ({
  TimePeriod: { Start: `${month}-01` },
  Estimated: estimated,
  Total: { UnblendedCost: { Amount: amount, Unit: 'USD' } },
});

const cost = (amount: string) => ({ UnblendedCost: { Amount: amount, Unit: 'USD' } });

const credentials = { accessKeyId: 'AKID', secretAccessKey: 'secret' };

const settings = (overrides: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...overrides });

async function setup() {
  const { db } = testDb();
  const tra = await createInternalProduct(db, { name: 'TRA', status: 'live' } as never);
  const other = await createInternalProduct(db, { name: 'Timesheet', status: 'live' } as never);
  return { db, tra, other };
}

function config(overrides: Partial<AwsConfig> = {}): AwsConfig {
  return { credentials, tagKey: '', defaultProductId: '', ...overrides };
}

async function costsOf(db: Db, productId: string) {
  return (await listProductCosts(db, productId)).map((c) => ({
    month: c.month,
    provider: c.provider,
    amount: c.amount,
    currency: c.currency,
    source: c.source,
  }));
}

describe('Cost Explorer client', () => {
  it('asks for monthly unblended cost over whole months, signed for ce in us-east-1', async () => {
    const aws = fakeAws([{ ResultsByTime: [total('2026-08', '312.504')] }]);
    const rows = await getMonthlyCosts(credentials, { from: '2026-06', to: '2026-08' }, aws.impl);

    expect(aws.calls[0]!.body).toMatchObject({
      TimePeriod: { Start: '2026-06-01', End: '2026-09-01' },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    });
    expect(aws.calls[0]!.body.GroupBy).toBeUndefined();
    expect(aws.calls[0]!.headers['x-amz-target']).toBe('AWSInsightsIndexService.GetCostAndUsage');
    expect(aws.calls[0]!.headers['authorization']).toMatch(/\/us-east-1\/ce\/aws4_request/);
    expect(rows).toEqual([{ month: '2026-08', tag: null, amount: 31250, currency: 'USD', estimated: false }]);
  });

  it('follows NextPageToken until the results run out', async () => {
    const aws = fakeAws([
      { ResultsByTime: [{ TimePeriod: { Start: '2026-08-01' }, Groups: [{ Keys: ['Product$TRA'], Metrics: cost('10') }] }], NextPageToken: 'p2' },
      { ResultsByTime: [{ TimePeriod: { Start: '2026-08-01' }, Groups: [{ Keys: ['Product$'], Metrics: cost('5') }] }] },
    ]);
    const rows = await getMonthlyCosts(credentials, { from: '2026-08', to: '2026-08', tagKey: 'Product' }, aws.impl);

    expect(aws.calls).toHaveLength(2);
    expect(aws.calls[1]!.body.NextPageToken).toBe('p2');
    expect(rows.map((r) => r.tag)).toEqual(['TRA', '']);
  });

  it("surfaces AWS's own explanation when it refuses", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ __type: 'AccessDeniedException', Message: 'not authorized to perform ce:GetCostAndUsage' }), {
        status: 400,
      })) as unknown as typeof fetch;
    await expect(getMonthlyCosts(credentials, { from: '2026-08', to: '2026-08' }, impl)).rejects.toThrow(
      /not authorized to perform ce:GetCostAndUsage/,
    );
  });
});

describe('importing AWS costs', () => {
  it('records the whole bill against the default product when no tag is set', async () => {
    const { db, tra } = await setup();
    const aws = fakeAws([{ ResultsByTime: [total('2026-07', '280.10'), total('2026-08', '312.50')] }]);

    const report = await importAwsCosts(db, config({ defaultProductId: tra.id }), { from: '2026-07', to: '2026-08' }, aws.impl);

    expect(report.saved).toHaveLength(2);
    expect(await costsOf(db, tra.id)).toEqual([
      { month: '2026-08', provider: 'AWS', amount: 31250, currency: 'USD', source: 'aws' },
      { month: '2026-07', provider: 'AWS', amount: 28010, currency: 'USD', source: 'aws' },
    ]);
  });

  it('never writes a month AWS still marks as estimated', async () => {
    const { db, tra } = await setup();
    const aws = fakeAws([{ ResultsByTime: [total('2026-08', '312.50'), total('2026-09', '90.00', true)] }]);

    const report = await importAwsCosts(db, config({ defaultProductId: tra.id }), { from: '2026-08', to: '2026-09' }, aws.impl);

    expect(report.estimated_months).toEqual(['2026-09']);
    expect((await costsOf(db, tra.id)).map((c) => c.month)).toEqual(['2026-08']);
  });

  it('replaces an earlier import but keeps a line a person typed', async () => {
    const { db, tra } = await setup();
    await upsertProductCost(db, tra.id, { month: '2026-07', provider: 'aws', amount: 99_00, currency: 'USD', note: null });
    await upsertProductCost(db, tra.id, { month: '2026-08', provider: 'AWS', amount: 1_00, currency: 'USD', note: null }, 'aws');
    const aws = fakeAws([{ ResultsByTime: [total('2026-07', '280.10'), total('2026-08', '312.50')] }]);

    const report = await importAwsCosts(db, config({ defaultProductId: tra.id }), { from: '2026-07', to: '2026-08' }, aws.impl);

    expect(report.kept_manual).toEqual([{ product_name: 'TRA', month: '2026-07' }]);
    const rows = await costsOf(db, tra.id);
    expect(rows.find((r) => r.month === '2026-07')).toMatchObject({ amount: 99_00, source: 'manual' });
    expect(rows.find((r) => r.month === '2026-08')).toMatchObject({ amount: 312_50, source: 'aws' });
    expect(rows).toHaveLength(2);
  });

  it('splits by tag, matching product names case-insensitively, and folds the rest into the default', async () => {
    const { db, tra, other } = await setup();
    const aws = fakeAws([
      {
        ResultsByTime: [
          {
            TimePeriod: { Start: '2026-08-01' },
            Groups: [
              { Keys: ['Product$tra'], Metrics: cost('300') },
              { Keys: ['Product$Timesheet'], Metrics: cost('40') },
              { Keys: ['Product$'], Metrics: cost('12.50') },
              { Keys: ['Product$Old thing'], Metrics: cost('2') },
            ],
          },
        ],
      },
    ]);

    await importAwsCosts(
      db,
      config({ tagKey: 'Product', defaultProductId: tra.id }),
      { from: '2026-08', to: '2026-08' },
      aws.impl,
    );

    expect(aws.calls[0]!.body.GroupBy).toEqual([{ Type: 'TAG', Key: 'Product' }]);
    const traRows = await listProductCosts(db, tra.id);
    expect(traRows.map((r) => r.amount)).toEqual([314_50]);
    expect(traRows[0]!.note).toContain('untagged spend');
    expect(traRows[0]!.note).toContain('tag "Old thing"');
    expect((await costsOf(db, other.id)).map((r) => r.amount)).toEqual([40_00]);
  });

  it('reports spend it cannot place rather than inventing a home for it', async () => {
    const { db, other } = await setup();
    const aws = fakeAws([
      {
        ResultsByTime: [
          {
            TimePeriod: { Start: '2026-08-01' },
            Groups: [
              { Keys: ['Product$Timesheet'], Metrics: cost('40') },
              { Keys: ['Product$'], Metrics: cost('12.50') },
            ],
          },
        ],
      },
    ]);

    const report = await importAwsCosts(db, config({ tagKey: 'Product' }), { from: '2026-08', to: '2026-08' }, aws.impl);

    expect(report.unassigned).toEqual([{ month: '2026-08', tag: '', amount: 12_50, currency: 'USD' }]);
    expect((await costsOf(db, other.id)).map((r) => r.amount)).toEqual([40_00]);
  });

  it('records credits larger than usage as zero, and says so', async () => {
    const { db, tra } = await setup();
    const aws = fakeAws([{ ResultsByTime: [total('2026-08', '-4.20')] }]);

    await importAwsCosts(db, config({ defaultProductId: tra.id }), { from: '2026-08', to: '2026-08' }, aws.impl);

    const [row] = await listProductCosts(db, tra.id);
    expect(row!.amount).toBe(0);
    expect(row!.note).toContain('credits exceeded usage');
  });
});

describe('the daily import', () => {
  const env = { AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'secret' };

  it('does nothing, and calls nothing, until AWS is set up', async () => {
    const { db, tra } = await setup();
    const aws = fakeAws([{ ResultsByTime: [] }]);

    expect(await importAwsCostsIfDue(db, settings({ aws_default_product_id: tra.id }), {}, '2026-09-06', aws.impl)).toBeNull();
    expect(await importAwsCostsIfDue(db, settings(), env, '2026-09-06', aws.impl)).toBeNull();
    expect(aws.calls).toHaveLength(0);
  });

  it('imports last month once, then stops paying to ask', async () => {
    const { db, tra } = await setup();
    const aws = fakeAws([{ ResultsByTime: [total('2026-08', '312.50')] }]);
    const s = settings({ aws_default_product_id: tra.id });

    const first = await importAwsCostsIfDue(db, s, env, '2026-09-06', aws.impl);
    expect(first!.saved).toHaveLength(1);
    expect(aws.calls[0]!.body.TimePeriod).toEqual({ Start: '2026-08-01', End: '2026-09-01' });

    expect(await importAwsCostsIfDue(db, s, env, '2026-09-07', aws.impl)).toBeNull();
    expect(aws.calls).toHaveLength(1);
  });

  it('asks again tomorrow while the month is still estimated', async () => {
    const { db, tra } = await setup();
    const aws = fakeAws([{ ResultsByTime: [total('2026-08', '300', true)] }, { ResultsByTime: [total('2026-08', '312.50')] }]);
    const s = settings({ aws_default_product_id: tra.id });

    expect((await importAwsCostsIfDue(db, s, env, '2026-09-02', aws.impl))!.estimated_months).toEqual(['2026-08']);
    expect((await importAwsCostsIfDue(db, s, env, '2026-09-03', aws.impl))!.saved).toHaveLength(1);
    expect(aws.calls).toHaveLength(2);
  });

  it('does not call AWS when the one product already has a typed figure for the month', async () => {
    const { db, tra } = await setup();
    await upsertProductCost(db, tra.id, { month: '2026-08', provider: 'AWS', amount: 1, currency: 'USD', note: null });
    const aws = fakeAws([{ ResultsByTime: [] }]);

    expect(await importAwsCostsIfDue(db, settings({ aws_default_product_id: tra.id }), env, '2026-09-06', aws.impl)).toBeNull();
    expect(aws.calls).toHaveLength(0);
  });
});

describe('AWS config and routes', () => {
  it('lists exactly what is missing', () => {
    expect(awsConfig(settings(), {}).missing).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'a product to record the bill against',
    ]);
    expect(awsConfig(settings({ aws_cost_tag_key: 'Product' }), { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }).config).not.toBeNull();
  });

  it('reports status and refuses to import until configured', async () => {
    const env = testEnv(testDb().db);
    const status = await api(env, 'GET', '/api/aws/status');
    expect(status.json).toMatchObject({ configured: false, tag_key: '', default_product_id: '' });

    const run = await api(env, 'POST', '/api/aws/import');
    expect(run.status).toBe(400);
    expect(run.json.message).toContain('AWS_ACCESS_KEY_ID');
  });

  it('refuses a month that has not finished', async () => {
    const env = testEnv(testDb().db, { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' });
    await api(env, 'PATCH', '/api/settings', { aws_cost_tag_key: 'Product' });
    const res = await api(env, 'POST', '/api/aws/import?from=2020-01&to=2999-01');
    expect(res.status).toBe(400);
    expect(res.json.message).toContain('has not finished yet');
  });
});
