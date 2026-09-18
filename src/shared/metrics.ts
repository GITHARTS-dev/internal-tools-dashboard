/**
 * Aggregations behind the dashboard KPIs and charts.
 *
 * Kept separate from alerts.ts so each stays readable, but the counts that
 * appear in both (overdue, due soon) are derived FROM the alert list rather
 * than recalculated here -- otherwise the tile and the queue below it could
 * disagree.
 *
 * There is no FX conversion anywhere in v1: rates need a paid feed, and
 * applying today's rate to last year's invoice would make historical totals
 * change every time the page loads. Totals are therefore per-currency.
 */

import { daysBetween } from './dates';
import { annualisedCost, monthlyCost, wastedSeatCost } from './money';
import { effectiveRenewalDate } from './alerts';
import type {
  Alert,
  CategorySpend,
  IsoDate,
  KpiSummary,
  Payment,
  RenewalTimelineEntry,
  Tool,
} from './types';

const LIVE_STATUSES = new Set(['active', 'trial']);

function addTo(bucket: Record<string, number>, currency: string, amount: number | null): void {
  if (amount === null || amount === 0) return;
  const key = currency.toUpperCase();
  bucket[key] = (bucket[key] ?? 0) + amount;
}

function dominantOf(bucket: Record<string, number>): string | null {
  let best: string | null = null;
  let bestValue = -Infinity;
  for (const [cur, val] of Object.entries(bucket)) {
    if (val > bestValue) {
      bestValue = val;
      best = cur;
    }
  }
  return best;
}

export function computeKpis(
  tools: Tool[],
  payments: Payment[],
  alerts: Alert[],
  today: IsoDate,
): KpiSummary {
  const monthly: Record<string, number> = {};
  const annual: Record<string, number> = {};
  const wasted: Record<string, number> = {};
  const paidThisYear: Record<string, number> = {};

  let activeTools = 0;
  let trialTools = 0;
  let cancelledTools = 0;
  let seatsPurchased = 0;
  let seatsUsed = 0;

  for (const tool of tools) {
    if (tool.status === 'active') activeTools++;
    else if (tool.status === 'trial') trialTools++;
    else cancelledTools++;

    if (!LIVE_STATUSES.has(tool.status)) continue;

    addTo(monthly, tool.currency, monthlyCost(tool.cost_amount, tool.billing_cycle));
    addTo(annual, tool.currency, annualisedCost(tool.cost_amount, tool.billing_cycle));

    // Idle seats expressed per year, which is the number that justifies acting.
    const wastePerPeriod = wastedSeatCost(tool.cost_amount, tool.seats_purchased, tool.seats_used);
    addTo(wasted, tool.currency, annualisedCost(wastePerPeriod, tool.billing_cycle));

    seatsPurchased += tool.seats_purchased ?? 0;
    seatsUsed += tool.seats_used ?? 0;
  }

  const year = today.slice(0, 4);
  for (const payment of payments) {
    if (payment.status !== 'paid' || !payment.paid_on) continue;
    if (payment.paid_on.slice(0, 4) !== year) continue;
    addTo(paidThisYear, payment.currency, payment.amount);
  }

  return {
    active_tools: activeTools,
    trial_tools: trialTools,
    cancelled_tools: cancelledTools,
    monthly_run_rate: monthly,
    annualised_spend: annual,
    wasted_seat_cost: wasted,
    dominant_currency: dominantOf(annual) ?? dominantOf(monthly),
    seats_purchased: seatsPurchased,
    seats_used: seatsUsed,
    overdue_count: alerts.filter((a) => a.rule === 'payment_overdue').length,
    due_soon_count: alerts.filter((a) => a.rule === 'payment_due_soon').length,
    paid_this_year: paidThisYear,
  };
}

/** Spend grouped by category, biggest annual cost first. */
export function computeCategorySpend(tools: Tool[]): CategorySpend[] {
  const byKey = new Map<string, CategorySpend>();

  for (const tool of tools) {
    if (!LIVE_STATUSES.has(tool.status)) continue;
    const annual = annualisedCost(tool.cost_amount, tool.billing_cycle);
    const monthly = monthlyCost(tool.cost_amount, tool.billing_cycle);
    const category = tool.category || 'Other';
    const currency = tool.currency.toUpperCase();
    const key = `${category}::${currency}`;

    const existing = byKey.get(key) ?? {
      category,
      currency,
      monthly: 0,
      annual: 0,
      tool_count: 0,
    };
    existing.monthly += monthly ?? 0;
    existing.annual += annual ?? 0;
    existing.tool_count += 1;
    byKey.set(key, existing);
  }

  return [...byKey.values()].sort((a, b) => b.annual - a.annual || a.category.localeCompare(b.category));
}

/** Upcoming renewals inside `horizonDays`, soonest first. */
export function computeRenewalTimeline(
  tools: Tool[],
  today: IsoDate,
  horizonDays = 90,
): RenewalTimelineEntry[] {
  const out: RenewalTimelineEntry[] = [];

  for (const tool of tools) {
    if (!LIVE_STATUSES.has(tool.status)) continue;
    const date = effectiveRenewalDate(tool, today);
    if (!date) continue;
    const daysUntil = daysBetween(today, date);
    if (daysUntil < 0 || daysUntil > horizonDays) continue;

    out.push({
      tool_id: tool.id,
      tool_name: tool.name,
      date,
      days_until: daysUntil,
      amount: tool.cost_amount,
      currency: tool.currency.toUpperCase(),
      billing_cycle: tool.billing_cycle,
      auto_renew: tool.auto_renew,
    });
  }

  return out.sort((a, b) => a.days_until - b.days_until || a.tool_name.localeCompare(b.tool_name));
}

/**
 * Monthly totals of what was actually paid, for the spend-history chart.
 * Driven by the payments ledger rather than by current subscription prices,
 * so a price rise mid-year shows up honestly.
 */
export function computePaidByMonth(
  payments: Payment[],
  months = 12,
  today: IsoDate = '',
): Array<{ month: string; currency: string; amount: number }> {
  const byKey = new Map<string, number>();
  for (const payment of payments) {
    if (payment.status !== 'paid' || !payment.paid_on) continue;
    const month = payment.paid_on.slice(0, 7);
    const key = `${month}::${payment.currency.toUpperCase()}`;
    byKey.set(key, (byKey.get(key) ?? 0) + payment.amount);
  }

  const rows = [...byKey.entries()]
    .map(([key, amount]) => {
      const [month = '', currency = ''] = key.split('::');
      return { month, currency, amount };
    })
    .sort((a, b) => a.month.localeCompare(b.month));

  if (!today) return rows;
  const cutoff = today.slice(0, 7);
  return rows.filter((r) => r.month <= cutoff).slice(-months);
}
