import type { YearMonth } from '../../shared/fx';
import { lastCompleteMonth } from '../../shared/productCosts';
import type { AppSettings, InternalProduct, IsoDate } from '../../shared/types';
import type { Db } from '../repo/db';
import { listInternalProducts } from '../repo/internalProducts';
import { findProductCost, hasImportedCosts, upsertProductCost } from '../repo/productCosts';
import { getMonthlyCosts } from './costExplorer';
import type { AwsCredentials } from './sigv4';

/**
 * Turning the AWS bill into product cost lines.
 *
 * Every product runs in one AWS account, so the bill has to be split to be
 * useful. The split is a cost-allocation tag: resources carry, say,
 * `Product=TRA`, and a tag value that matches a product's name (ignoring case)
 * is that product's spend. Anything untagged, or tagged with a name no product
 * has, goes to the default product -- which, with no tag key set at all, simply
 * receives the whole bill. That is the one-product setup, and it keeps working
 * unchanged when a second product arrives and tagging starts.
 *
 * Two rules protect the figures:
 *
 *   * A month AWS still marks as estimated is never written. Its bill is not
 *     final, and a half-month figure would read as spending falling.
 *   * A line a person typed or corrected is never overwritten. The import
 *     reports it instead, so the disagreement is visible rather than resolved
 *     silently in either direction.
 */

export const AWS_PROVIDER = 'AWS';

export interface AwsConfig {
  credentials: AwsCredentials;
  tagKey: string;
  defaultProductId: string;
}

/** The config, or what is missing from it -- the Settings panel shows the list. */
export function awsConfig(
  settings: AppSettings,
  env: Record<string, string | undefined>,
): { config: AwsConfig; missing: [] } | { config: null; missing: string[] } {
  const missing: string[] = [];
  const accessKeyId = env['AWS_ACCESS_KEY_ID']?.trim();
  const secretAccessKey = env['AWS_SECRET_ACCESS_KEY']?.trim();
  if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY');
  if (!settings.aws_default_product_id && !settings.aws_cost_tag_key) {
    missing.push('a product to record the bill against');
  }
  if (!accessKeyId || !secretAccessKey || missing.length > 0) return { config: null, missing };

  const sessionToken = env['AWS_SESSION_TOKEN']?.trim();
  return {
    config: {
      credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
      tagKey: settings.aws_cost_tag_key,
      defaultProductId: settings.aws_default_product_id,
    },
    missing: [],
  };
}

export interface AwsImportReport {
  from: YearMonth;
  to: YearMonth;
  saved: Array<{ product_id: string; product_name: string; month: YearMonth; amount: number; currency: string; created: boolean }>;
  /** Lines left alone because a person entered them. */
  kept_manual: Array<{ product_name: string; month: YearMonth }>;
  /** Spend no product could be found for: untagged or unmatched, with no default product. */
  unassigned: Array<{ month: YearMonth; tag: string; amount: number; currency: string }>;
  /** Months AWS has not finalised yet, so nothing was written for them. */
  estimated_months: YearMonth[];
}

function describeTags(tags: Set<string>): string {
  const named = [...tags].filter(Boolean).sort();
  const parts = [...(tags.has('') ? ['untagged spend'] : []), ...named.map((t) => `tag "${t}"`)];
  return parts.join(', ');
}

export async function importAwsCosts(
  db: Db,
  config: AwsConfig,
  range: { from: YearMonth; to: YearMonth },
  fetchImpl: typeof fetch = fetch,
): Promise<AwsImportReport> {
  const [rows, products] = await Promise.all([
    getMonthlyCosts(config.credentials, { ...range, tagKey: config.tagKey || undefined }, fetchImpl),
    listInternalProducts(db),
  ]);

  const byName = new Map(products.map((p) => [p.name.trim().toLowerCase(), p]));
  const fallback = products.find((p) => p.id === config.defaultProductId) ?? null;

  const report: AwsImportReport = { ...range, saved: [], kept_manual: [], unassigned: [], estimated_months: [] };
  const estimated = new Set<YearMonth>();

  // One line per product, month and currency. A product can receive several
  // groups at once -- its own tag plus the untagged remainder -- and they are
  // added together, with the note saying what was folded in.
  type Line = { product: InternalProduct; month: YearMonth; currency: string; amount: number; fallbackTags: Set<string> };
  const lines = new Map<string, Line>();

  for (const row of rows) {
    if (row.estimated) {
      estimated.add(row.month);
      continue;
    }
    const matched = row.tag ? byName.get(row.tag.trim().toLowerCase()) : undefined;
    const product = matched ?? fallback;
    if (!product) {
      report.unassigned.push({ month: row.month, tag: row.tag ?? '', amount: row.amount, currency: row.currency });
      continue;
    }

    const key = `${product.id}::${row.month}::${row.currency}`;
    const line = lines.get(key) ?? { product, month: row.month, currency: row.currency, amount: 0, fallbackTags: new Set() };
    line.amount += row.amount;
    if (!matched && row.tag !== null) line.fallbackTags.add(row.tag);
    lines.set(key, line);
  }

  for (const line of [...lines.values()].sort((a, b) => a.month.localeCompare(b.month))) {
    const existing = await findProductCost(db, line.product.id, line.month, AWS_PROVIDER);
    if (existing && existing.source === 'manual') {
      report.kept_manual.push({ product_name: line.product.name, month: line.month });
      continue;
    }

    // Credits larger than a month's usage leave a negative net; a cost line
    // cannot be negative, and nothing was paid, so it is recorded as zero.
    const amount = Math.max(0, line.amount);
    const note = [
      'Imported from AWS Cost Explorer',
      line.fallbackTags.size > 0 ? `includes ${describeTags(line.fallbackTags)}` : null,
      line.amount < 0 ? 'credits exceeded usage' : null,
    ]
      .filter(Boolean)
      .join('; ');

    const { created } = await upsertProductCost(
      db,
      line.product.id,
      { month: line.month, provider: AWS_PROVIDER, amount, currency: line.currency, note },
      'aws',
    );
    report.saved.push({
      product_id: line.product.id,
      product_name: line.product.name,
      month: line.month,
      amount,
      currency: line.currency,
      created,
    });
  }

  report.estimated_months = [...estimated].sort();
  return report;
}

/**
 * The daily job's half: fetch last month's bill once it is final, and then
 * stop asking. Every call costs a cent, so a month already imported is not
 * requested again; a month AWS still calls estimated is simply retried tomorrow.
 *
 * Returns null when there is nothing to do, including when AWS is not set up.
 */
export async function importAwsCostsIfDue(
  db: Db,
  settings: AppSettings,
  env: Record<string, string | undefined>,
  today: IsoDate,
  fetchImpl: typeof fetch = fetch,
): Promise<AwsImportReport | null> {
  const { config } = awsConfig(settings, env);
  if (!config) return null;

  const month = lastCompleteMonth(today);
  if (await hasImportedCosts(db, month, 'aws')) return null;
  // With the whole bill going to one product, a line someone already typed for
  // it means there is nothing the import could write; do not pay to find out.
  if (!config.tagKey && (await findProductCost(db, config.defaultProductId, month, AWS_PROVIDER))) return null;

  return importAwsCosts(db, config, { from: month, to: month }, fetchImpl);
}
