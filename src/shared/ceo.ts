/**
 * The CEO summary: everything the company spends, in one currency.
 *
 * This is the only place in the codebase that produces a single cross-currency
 * number, and it is built to make that number defensible rather than merely
 * available:
 *
 *   * Run-rate (a forward-looking "what we pay per month") is converted at the
 *     most recent month's rate, because it describes today's commitment.
 *   * Historical paid spend is converted at the rate of the month each payment
 *     was actually made in, so a past year's total never changes.
 *   * Anything that could not be converted is reported as a gap instead of
 *     being silently dropped, and the UI shows it next to the total.
 *
 * The split the CEO actually asked for: bought SaaS versus the cost of running
 * our own products. A tool belongs to the second group when it is attributed to
 * an internal product, and to the first when it is not.
 */

import { annualisedCost, monthlyCost, wastedSeatCost } from './money';
import { addMonthsToYearMonth, monthOf, sumConverted, type RateTable, type YearMonth } from './fx';
import { computeProductUsage, costEntryDue } from './productCosts';
import { computeYearForecast } from './yearForecast';
import type {
  CeoSummary,
  IdleTool,
  InternalProduct,
  InternalProductCost,
  IsoDate,
  Payment,
  PeriodComparison,
  PriceChange,
  ProductCost,
  RankedSpend,
  RunRateItem,
  SpendItem,
  Tool,
} from './types';

const LIVE_STATUSES = new Set(['active', 'trial']);

function addTo(bucket: Record<string, number>, currency: string, amount: number | null): void {
  if (amount === null || amount === 0) return;
  const key = currency.toUpperCase();
  bucket[key] = (bucket[key] ?? 0) + amount;
}

/** Entries shaped for `sumConverted`, all at the run-rate month. */
function runRateEntries(
  bucket: Record<string, number>,
  month: YearMonth | null,
): Array<{ amount: number; currency: string; month: YearMonth | null }> {
  return Object.entries(bucket).map(([currency, amount]) => ({ amount, currency, month }));
}

/** One amount converted on its own, so a line can show what it contributed. */
function convertOne(
  amount: number,
  currency: string,
  month: YearMonth | null,
  target: string,
  tables: Record<YearMonth, RateTable>,
): { amount: number | null; rate_month: YearMonth | null } {
  const result = sumConverted([{ amount, currency, month }], target, tables);
  if (result.gaps.length > 0) return { amount: null, rate_month: null };
  return { amount: result.amount, rate_month: result.months[0] ?? null };
}

export interface CeoSummaryInput {
  tools: Tool[];
  payments: Payment[];
  products: InternalProduct[];
  /**
   * Usage-based costs recorded per product per month. Optional so callers with
   * no product costs (and the tests written before they existed) need not pass
   * an empty list.
   */
  monthlyCosts?: ProductCost[];
  /** Price changes, so the year forecast prices each bill as of its date. Optional, like `monthlyCosts`. */
  priceChanges?: PriceChange[];
  tables: Record<YearMonth, RateTable>;
  reportingCurrency: string;
  today: IsoDate;
}

export function computeCeoSummary(input: CeoSummaryInput): CeoSummary {
  const { tools, payments, products, tables, today } = input;
  const monthlyCosts = input.monthlyCosts ?? [];
  const target = input.reportingCurrency.toUpperCase();

  const available = Object.keys(tables).sort();
  const latestMonth = available[available.length - 1] ?? null;
  const fxAvailable = available.length > 0;

  // ------------------------------------------------------------ run rate
  let subsCount = 0;

  // The reported totals are the sum of the tools converted one by one, so the
  // lines in the forecast drill-down add up to exactly the figure on the
  // dashboard. A product keeps its per-currency totals as well, for display.
  type RunRateEntry = { amount: number; currency: string; month: YearMonth | null };
  const subsMonthlyEntries: RunRateEntry[] = [];
  const subsAnnualEntries: RunRateEntry[] = [];
  const runRateItems: RunRateItem[] = [];

  const perProduct = new Map<
    string,
    {
      monthly: Record<string, number>;
      annual: Record<string, number>;
      monthlyEntries: RunRateEntry[];
      annualEntries: RunRateEntry[];
      count: number;
    }
  >();
  for (const product of products) {
    perProduct.set(product.id, { monthly: {}, annual: {}, monthlyEntries: [], annualEntries: [], count: 0 });
  }

  for (const tool of tools) {
    if (!LIVE_STATUSES.has(tool.status)) continue;

    const monthly = monthlyCost(tool.cost_amount, tool.billing_cycle);
    const annual = annualisedCost(tool.cost_amount, tool.billing_cycle);
    const bucket = tool.internal_product_id ? perProduct.get(tool.internal_product_id) : undefined;

    if (bucket) {
      addTo(bucket.monthly, tool.currency, monthly);
      addTo(bucket.annual, tool.currency, annual);
      if (monthly) bucket.monthlyEntries.push({ amount: monthly, currency: tool.currency, month: latestMonth });
      if (annual) bucket.annualEntries.push({ amount: annual, currency: tool.currency, month: latestMonth });
      bucket.count += 1;
    } else {
      // A tool pointing at a product that no longer exists counts as bought
      // SaaS rather than vanishing from the totals.
      if (monthly) subsMonthlyEntries.push({ amount: monthly, currency: tool.currency, month: latestMonth });
      if (annual) subsAnnualEntries.push({ amount: annual, currency: tool.currency, month: latestMonth });
      subsCount += 1;
    }

    if (annual && tool.cost_amount !== null) {
      runRateItems.push({
        tool_id: tool.id,
        label: tool.name,
        vendor: tool.vendor,
        product_id: bucket ? tool.internal_product_id : null,
        cost_amount: tool.cost_amount,
        billing_cycle: tool.billing_cycle,
        currency: tool.currency.toUpperCase(),
        annual,
        annual_reported: convertOne(annual, tool.currency, latestMonth, target, tables).amount,
        monthly_reported:
          monthly === null ? null : convertOne(monthly, tool.currency, latestMonth, target, tables).amount,
      });
    }
  }
  runRateItems.sort((a, b) => (b.annual_reported ?? 0) - (a.annual_reported ?? 0) || a.label.localeCompare(b.label));

  const gaps = new Map<string, { currency: string; month: string | null; count: number }>();
  const monthsUsed = new Set<string>();

  function reportTotal(bucket: Record<string, number>): number | null {
    return reportEntries(runRateEntries(bucket, latestMonth));
  }

  function reportEntries(entries: RunRateEntry[]): number | null {
    if (entries.length === 0) return 0;

    const result = sumConverted(entries, target, tables);
    for (const gap of result.gaps) {
      const key = `${gap.currency}::${gap.month ?? ''}`;
      const existing = gaps.get(key);
      if (existing) existing.count += gap.count;
      else gaps.set(key, { ...gap });
    }
    for (const month of result.months) monthsUsed.add(month);

    // Every currency failed to convert: report "unknown", not a confident zero.
    return result.gaps.length > 0 && result.amount === 0 ? null : result.amount;
  }

  const costsByProduct = new Map<string, ProductCost[]>();
  for (const cost of monthlyCosts) {
    const bucket = costsByProduct.get(cost.product_id);
    if (bucket) bucket.push(cost);
    else costsByProduct.set(cost.product_id, [cost]);
  }

  const productCosts: InternalProductCost[] = products
    .map((product) => {
      const bucket = perProduct.get(product.id)!;

      // The fixed part: subscriptions attributed to the product.
      const fixedMonthly = reportEntries(bucket.monthlyEntries);
      const fixedAnnual = reportEntries(bucket.annualEntries);

      // The usage part: what was actually billed, averaged over recent complete
      // months. Null means nothing usable was entered -- unknown, not free.
      const usage = computeProductUsage(costsByProduct.get(product.id) ?? [], tables, target, today);
      for (const gap of usage.gaps) {
        const key = `${gap.currency}::${gap.month ?? ''}`;
        const existing = gaps.get(key);
        if (existing) existing.count += gap.count;
        else gaps.set(key, { ...gap });
      }
      for (const month of usage.rate_months) monthsUsed.add(month);

      const usageMonthly = usage.average_reported;
      const usageAnnual = usageMonthly === null ? null : usageMonthly * 12;

      return {
        product,
        tool_count: bucket.count,
        monthly: bucket.monthly,
        annual: bucket.annual,
        fixed_monthly_reported: fixedMonthly,
        fixed_annual_reported: fixedAnnual,
        usage_monthly_reported: usageMonthly,
        usage_annual_reported: usageAnnual,
        usage_months_counted: usage.months_counted,
        usage_window: usage.window,
        last_cost_month: usage.last_cost_month,
        // The shared definition: not retired, existed then, bills should be
        // final by now. The reminder asks the same function.
        cost_entry_due: costEntryDue(product, costsByProduct.get(product.id) ?? [], today),
        // Fixed + usage. A fixed part that could not be converted makes the
        // total unknown; a usage part that is unknown simply adds nothing.
        monthly_reported: fixedMonthly === null ? null : fixedMonthly + (usageMonthly ?? 0),
        annual_reported: fixedAnnual === null ? null : fixedAnnual + (usageAnnual ?? 0),
      };
    })
    .sort((a, b) => (b.annual_reported ?? 0) - (a.annual_reported ?? 0) || a.product.name.localeCompare(b.product.name));

  const internalMonthlyEntries: RunRateEntry[] = [];
  const internalAnnualEntries: RunRateEntry[] = [];
  for (const bucket of perProduct.values()) {
    internalMonthlyEntries.push(...bucket.monthlyEntries);
    internalAnnualEntries.push(...bucket.annualEntries);
  }
  let internalToolCount = 0;
  let usageMonthlySum = 0;
  let usageAnnualSum = 0;
  let anyUsage = false;
  for (const cost of productCosts) {
    internalToolCount += cost.tool_count;
    if (cost.usage_monthly_reported !== null) {
      anyUsage = true;
      usageMonthlySum += cost.usage_monthly_reported;
      usageAnnualSum += cost.usage_annual_reported ?? 0;
    }
  }

  const subsMonthlyReported = reportEntries(subsMonthlyEntries);
  const subsAnnualReported = reportEntries(subsAnnualEntries);
  const internalFixedMonthly = reportEntries(internalMonthlyEntries);
  const internalFixedAnnual = reportEntries(internalAnnualEntries);
  const internalMonthlyReported = internalFixedMonthly === null ? null : internalFixedMonthly + usageMonthlySum;
  const internalAnnualReported = internalFixedAnnual === null ? null : internalFixedAnnual + usageAnnualSum;

  // ------------------------------------------------- historical paid spend
  // Each payment at its own month's rate, which is what makes a past year's
  // total stable no matter when it is asked for.
  const paidByYear = new Map<string, Array<{ amount: number; currency: string; month: YearMonth | null }>>();
  for (const payment of payments) {
    if (payment.status !== 'paid' || !payment.paid_on) continue;
    const year = payment.paid_on.slice(0, 4);
    const entry = { amount: payment.amount, currency: payment.currency, month: monthOf(payment.paid_on) };
    const bucket = paidByYear.get(year);
    if (bucket) bucket.push(entry);
    else paidByYear.set(year, [entry]);
  }

  // Usage costs are money actually spent, so they belong in the history too.
  // Leaving them out would put the AWS bill in the run rate but not in "what we
  // paid", and the trend would understate what the company really spent.
  for (const cost of monthlyCosts) {
    const year = cost.month.slice(0, 4);
    const entry = { amount: cost.amount, currency: cost.currency, month: cost.month };
    const bucket = paidByYear.get(year);
    if (bucket) bucket.push(entry);
    else paidByYear.set(year, [entry]);
  }

  const paid = [...paidByYear.entries()]
    .map(([year, entries]) => {
      const result = sumConverted(entries, target, tables);
      for (const gap of result.gaps) {
        const key = `${gap.currency}::${gap.month ?? ''}`;
        const existing = gaps.get(key);
        if (existing) existing.count += gap.count;
        else gaps.set(key, { ...gap });
      }
      for (const month of result.months) monthsUsed.add(month);
      return { year, amount: result.amount };
    })
    .sort((a, b) => a.year.localeCompare(b.year));

  const totalMonthly =
    subsMonthlyReported === null || internalMonthlyReported === null
      ? null
      : subsMonthlyReported + internalMonthlyReported;
  const totalAnnual =
    subsAnnualReported === null || internalAnnualReported === null
      ? null
      : subsAnnualReported + internalAnnualReported;

  // ------------------------------------------------------- monthly trend
  // Per-month paid totals, each at its own month's rate. This is the series
  // that answers "is this going up", which no other number on the page does.
  type Entry = { amount: number; currency: string; month: YearMonth };
  const subsByMonth = new Map<YearMonth, Entry[]>();
  const usageByMonth = new Map<YearMonth, Entry[]>();
  const add = (map: Map<YearMonth, Entry[]>, month: YearMonth, entry: Entry) => {
    const bucket = map.get(month);
    if (bucket) bucket.push(entry);
    else map.set(month, [entry]);
  };

  for (const payment of payments) {
    if (payment.status !== 'paid' || !payment.paid_on) continue;
    const month = monthOf(payment.paid_on);
    add(subsByMonth, month, { amount: payment.amount, currency: payment.currency, month });
  }
  // Recorded cloud costs are money actually spent, but they are a different kind
  // of money from a subscription, so they are kept in their own series.
  for (const cost of monthlyCosts) {
    add(usageByMonth, cost.month, { amount: cost.amount, currency: cost.currency, month: cost.month });
  }

  const thisMonth = monthOf(today);
  // The current month is always partial; plotting it beside complete months
  // reads as a collapse in spending that has not happened.
  const lastComplete = addMonthsToYearMonth(thisMonth, -1);
  const windowStart = addMonthsToYearMonth(lastComplete, -23);

  /** Convert one month's entries, folding any gaps into the shared report. */
  function sumMonth(entries: Entry[] | undefined): number {
    if (!entries || entries.length === 0) return 0;
    const result = sumConverted(entries, target, tables);
    for (const month2 of result.months) monthsUsed.add(month2);
    for (const gap of result.gaps) {
      const key = `${gap.currency}::${gap.month ?? ''}`;
      const existing = gaps.get(key);
      if (existing) existing.count += gap.count;
      else gaps.set(key, { ...gap });
    }
    return result.amount;
  }

  const paidByMonth: Array<{ month: string; amount: number; subscriptions: number; usage: number }> = [];
  for (let i = 0; i < 24; i++) {
    const month = addMonthsToYearMonth(windowStart, i);
    const subscriptions = sumMonth(subsByMonth.get(month));
    const usage = sumMonth(usageByMonth.get(month));
    paidByMonth.push({ month, amount: subscriptions + usage, subscriptions, usage });
  }

  // Two 12-month windows of complete months, so the comparison is like for like.
  const trailing = paidByMonth.slice(12).reduce((sum, row) => sum + row.amount, 0);
  const previous = paidByMonth.slice(0, 12).reduce((sum, row) => sum + row.amount, 0);
  const hasHistory = paidByMonth.some((row) => row.amount > 0);

  const comparison: PeriodComparison = {
    trailing_12: hasHistory ? trailing : null,
    previous_12: hasHistory ? previous : null,
    // A change from nothing is not a percentage; it is a start.
    change_pct: previous > 0 ? ((trailing - previous) / previous) * 100 : null,
    from: addMonthsToYearMonth(lastComplete, -11),
    to: lastComplete,
  };

  // ----------------------------------------------------------- paid items
  // The lines every paid total is made of, each converted exactly as the
  // totals above convert it (at its own month's rate), so the lines in a
  // drill-down add up to the figure it was opened from.
  const toolsById = new Map(tools.map((t) => [t.id, t]));
  const productsById = new Map(products.map((p) => [p.id, p]));
  const paidItems: SpendItem[] = [];

  for (const payment of payments) {
    if (payment.status !== 'paid' || !payment.paid_on) continue;
    const tool = toolsById.get(payment.tool_id);
    const month = monthOf(payment.paid_on);
    const converted = convertOne(payment.amount, payment.currency, month, target, tables);
    paidItems.push({
      id: payment.id,
      kind: 'subscription',
      month,
      date: payment.paid_on,
      label: tool?.name ?? 'A removed tool',
      detail: tool?.vendor ?? null,
      tool_id: tool ? tool.id : null,
      product_id:
        tool?.internal_product_id && productsById.has(tool.internal_product_id) ? tool.internal_product_id : null,
      amount: payment.amount,
      currency: payment.currency.toUpperCase(),
      amount_reported: converted.amount,
      rate_month: converted.rate_month,
    });
  }

  for (const cost of monthlyCosts) {
    const product = productsById.get(cost.product_id);
    const converted = convertOne(cost.amount, cost.currency, cost.month, target, tables);
    paidItems.push({
      id: cost.id,
      kind: 'usage',
      month: cost.month,
      date: null,
      label: product?.name ?? 'A removed product',
      detail: cost.provider,
      tool_id: null,
      product_id: product ? product.id : null,
      amount: cost.amount,
      currency: cost.currency.toUpperCase(),
      amount_reported: converted.amount,
      rate_month: converted.rate_month,
    });
  }

  // Newest first; within a month, dated payments before the month's bills.
  paidItems.sort(
    (a, b) =>
      b.month.localeCompare(a.month) ||
      (b.date ?? '').localeCompare(a.date ?? '') ||
      (b.amount_reported ?? 0) - (a.amount_reported ?? 0),
  );

  // --------------------------------------------------- where it concentrates
  /** One amount converted at the latest month, or null when no rate covers it. */
  function reportOne(amount: number | null, currency: string): number | null {
    if (amount === null) return null;
    const result = sumConverted([{ amount, currency, month: latestMonth }], target, tables);
    return result.gaps.length > 0 ? null : result.amount;
  }

  const liveTools = tools.filter((t) => LIVE_STATUSES.has(t.status));

  const topTools: RankedSpend[] = liveTools
    .map((tool) => {
      const annual = annualisedCost(tool.cost_amount, tool.billing_cycle);
      return {
        id: tool.id,
        label: tool.name,
        sublabel: tool.vendor,
        annual_reported: reportOne(annual, tool.currency) ?? 0,
        amount: annual,
        currency: tool.currency.toUpperCase(),
      };
    })
    .filter((row) => row.annual_reported > 0)
    .sort((a, b) => b.annual_reported - a.annual_reported)
    .slice(0, 8);

  const categoryBuckets = new Map<string, Record<string, number>>();
  for (const tool of liveTools) {
    const annual = annualisedCost(tool.cost_amount, tool.billing_cycle);
    if (annual === null) continue;
    const key = tool.category || 'Other';
    const bucket = categoryBuckets.get(key) ?? {};
    addTo(bucket, tool.currency, annual);
    categoryBuckets.set(key, bucket);
  }

  const byCategory: RankedSpend[] = [...categoryBuckets.entries()]
    .map(([category, bucket]) => ({
      id: category,
      label: category,
      sublabel: null,
      annual_reported: reportTotal(bucket) ?? 0,
      amount: null,
      currency: target,
    }))
    .filter((row) => row.annual_reported > 0)
    .sort((a, b) => b.annual_reported - a.annual_reported);

  // ------------------------------------------------------------ idle seats
  const idleBucket: Record<string, number> = {};
  const idleTools: IdleTool[] = [];
  let idleSeats = 0;
  for (const tool of liveTools) {
    const perPeriod = wastedSeatCost(tool.cost_amount, tool.seats_purchased, tool.seats_used);
    const annualIdle = annualisedCost(perPeriod, tool.billing_cycle);
    addTo(idleBucket, tool.currency, annualIdle);
    if (tool.seats_purchased && tool.seats_used !== null) {
      idleSeats += Math.max(0, tool.seats_purchased - tool.seats_used);

      // Which tools the idle money is in is the actionable half of the figure.
      if (annualIdle && tool.seats_purchased > tool.seats_used) {
        const reported = reportOne(annualIdle, tool.currency);
        if (reported !== null && reported > 0) {
          idleTools.push({
            id: tool.id,
            label: tool.name,
            seats_purchased: tool.seats_purchased,
            seats_used: tool.seats_used,
            annual_reported: reported,
          });
        }
      }
    }
  }
  idleTools.sort((a, b) => b.annual_reported - a.annual_reported || a.label.localeCompare(b.label));

  return {
    today,
    latest_complete_month: lastComplete,
    reporting_currency: target,
    subscriptions: {
      tool_count: subsCount,
      monthly_reported: subsMonthlyReported,
      annual_reported: subsAnnualReported,
    },
    internal: {
      product_count: products.filter((p) => p.status !== 'retired').length,
      tool_count: internalToolCount,
      monthly_reported: internalMonthlyReported,
      annual_reported: internalAnnualReported,
      usage_annual_reported: anyUsage ? usageAnnualSum : null,
    },
    products: productCosts,
    total_monthly_reported: totalMonthly,
    total_annual_reported: totalAnnual,
    paid_by_year: paid,
    paid_by_month: paidByMonth,
    comparison,
    top_tools: topTools,
    by_category: byCategory,
    idle_tools: idleTools.slice(0, 5),
    idle_seat_cost: reportTotal(idleBucket),
    idle_seat_count: idleSeats,
    gaps: [...gaps.values()].sort((a, b) => b.count - a.count),
    rate_months: [...monthsUsed].sort(),
    fx_available: fxAvailable,
    paid_items: paidItems,
    run_rate_items: runRateItems,
    year_forecast: computeYearForecast({
      tools,
      payments,
      priceChanges: input.priceChanges ?? [],
      products: productCosts,
      paidItems,
      tables,
      target,
      today,
    }),
  };
}
