import { addMonthsToYearMonth, type YearMonth } from '../../shared/fx';
import { parseMoneyInput } from '../../shared/money';
import { signRequest, type AwsCredentials } from './sigv4';

/**
 * AWS Cost Explorer, GetCostAndUsage, monthly.
 *
 * This is the same figure the billing console shows, not a scrape of the
 * invoice email: the email only says an invoice exists, and reading a shared
 * mailbox would need tenant-wide mail access for one number a month.
 *
 * `UnblendedCost` with no filter is what the invoice adds up to: usage, tax and
 * credits together. Each call costs USD 0.01, which is why the daily job asks
 * once a month rather than every morning.
 *
 * Cost Explorer only has a global endpoint, in us-east-1, whatever region the
 * account's resources run in.
 */

const ENDPOINT = 'https://ce.us-east-1.amazonaws.com/';

export interface AwsMonthCost {
  month: YearMonth;
  /**
   * The cost-allocation tag value this amount belongs to. `null` when the query
   * was not grouped by a tag; `''` for spend with no tag on it.
   */
  tag: string | null;
  /** Minor units. */
  amount: number;
  currency: string;
  /** AWS marks a month estimated until its bill is final. */
  estimated: boolean;
}

export class AwsError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'AwsError';
  }
}

interface MetricValue {
  Amount?: string;
  Unit?: string;
}

interface CeResponse {
  ResultsByTime?: Array<{
    TimePeriod?: { Start?: string };
    Total?: Record<string, MetricValue>;
    Groups?: Array<{ Keys?: string[]; Metrics?: Record<string, MetricValue> }>;
    Estimated?: boolean;
  }>;
  NextPageToken?: string;
}

/** 'Product$TRA' -> 'TRA'; 'Product$' (untagged) -> ''. */
function tagValue(key: string | undefined): string {
  if (!key) return '';
  const at = key.indexOf('$');
  return at === -1 ? key : key.slice(at + 1);
}

function toMinor(value: MetricValue | undefined): { amount: number; currency: string } | null {
  if (!value?.Amount || !value.Unit) return null;
  const amount = parseMoneyInput(value.Amount, value.Unit);
  return amount === null ? null : { amount, currency: value.Unit.toUpperCase() };
}

export async function getMonthlyCosts(
  credentials: AwsCredentials,
  query: { from: YearMonth; to: YearMonth; tagKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AwsMonthCost[]> {
  const out: AwsMonthCost[] = [];
  let nextPageToken: string | undefined;

  do {
    const body = JSON.stringify({
      TimePeriod: { Start: `${query.from}-01`, End: `${addMonthsToYearMonth(query.to, 1)}-01` },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      ...(query.tagKey ? { GroupBy: [{ Type: 'TAG', Key: query.tagKey }] } : {}),
      ...(nextPageToken ? { NextPageToken: nextPageToken } : {}),
    });

    const headers = await signRequest(
      {
        method: 'POST',
        url: ENDPOINT,
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage',
        },
        body,
        region: 'us-east-1',
        service: 'ce',
      },
      credentials,
    );

    const response = await fetchImpl(ENDPOINT, { method: 'POST', headers, body });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { message?: string; Message?: string; __type?: string };
        message = parsed.Message ?? parsed.message ?? parsed.__type ?? message;
      } catch {
        // Not JSON; the raw text is the best explanation there is.
      }
      throw new AwsError(`AWS Cost Explorer refused the request (${response.status}): ${message}`, response.status);
    }

    const data = JSON.parse(text) as CeResponse;
    for (const result of data.ResultsByTime ?? []) {
      const month = result.TimePeriod?.Start?.slice(0, 7);
      if (!month) continue;
      const estimated = Boolean(result.Estimated);

      if (query.tagKey) {
        for (const group of result.Groups ?? []) {
          const money = toMinor(group.Metrics?.['UnblendedCost']);
          if (money) out.push({ month, tag: tagValue(group.Keys?.[0]), estimated, ...money });
        }
      } else {
        const money = toMinor(result.Total?.['UnblendedCost']);
        if (money) out.push({ month, tag: null, estimated, ...money });
      }
    }
    nextPageToken = data.NextPageToken || undefined;
  } while (nextPageToken);

  return out;
}
