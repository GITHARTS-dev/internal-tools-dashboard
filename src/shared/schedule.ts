/**
 * Which payments the daily job should add to the ledger today.
 *
 * Pure, like `computeAlerts`, so the reminder run and its dry-run preview
 * decide the same way and the rule can be tested without a database.
 *
 * A tool gets its next payment once the due date comes into view: any time in
 * the current calendar month, or earlier when the bill falls inside the payment
 * reminder window (a bill due on the 2nd is added late the month before, so
 * its 7-day reminder still fires). The amount is the price in effect on the
 * due date (see prices.ts), so a change announced for next month is already
 * on next month's bill; a change recorded later reprices it while unpaid.
 */

import { effectiveRenewalDate } from './alerts';
import { advanceByCycle, daysInMonth, addDays } from './dates';
import { priceOn } from './prices';
import type { AppSettings, IsoDate, Payment, PriceChange, Tool } from './types';

/** Tools in these states are still being paid for. */
const SCHEDULED_STATUSES = new Set(['active', 'trial']);

export interface PlannedPayment {
  tool: Tool;
  due_date: IsoDate;
  period_start: IsoDate;
  period_end: IsoDate | null;
  amount: number;
  currency: string;
  /**
   * The ledger already has a payment for this bill -- one someone added by
   * hand, say. Nothing is created; the tool is only marked as handled.
   */
  already_in_ledger: boolean;
}

function lastDayOfMonth(date: IsoDate): IsoDate {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return `${date.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

/** The last due date that is "in view" today. */
export function schedulingHorizon(settings: AppSettings, today: IsoDate): IsoDate {
  const monthEnd = lastDayOfMonth(today);
  const leadEnd = addDays(today, Math.max(0, ...settings.payment_lead_days));
  return leadEnd > monthEnd ? leadEnd : monthEnd;
}

export function paymentsToSchedule(
  tools: Tool[],
  payments: Payment[],
  settings: AppSettings,
  today: IsoDate,
  priceChanges: PriceChange[] = [],
): PlannedPayment[] {
  const horizon = schedulingHorizon(settings, today);
  const byTool = new Map<string, Payment[]>();
  for (const payment of payments) {
    const list = byTool.get(payment.tool_id);
    if (list) list.push(payment);
    else byTool.set(payment.tool_id, [payment]);
  }

  const planned: PlannedPayment[] = [];
  for (const tool of tools) {
    if (tool.deleted_at || !SCHEDULED_STATUSES.has(tool.status)) continue;
    // No cost means no amount to bill; the missing_data alert already asks for one.
    if (tool.cost_amount === null) continue;

    const due = effectiveRenewalDate(tool, today);
    if (!due || due > horizon) continue;
    if (tool.payments_scheduled_through && due <= tool.payments_scheduled_through) continue;
    const price = priceOn(tool, priceChanges, due);
    if (!price) continue;

    // One bill per tool per month: a payment already due that month, however
    // it got there, is this one.
    const month = due.slice(0, 7);
    const existing = (byTool.get(tool.id) ?? []).some(
      (p) => p.due_date.slice(0, 7) === month || p.period_start === due,
    );

    planned.push({
      tool,
      due_date: due,
      period_start: due,
      period_end: advanceByCycle(due, tool.billing_cycle),
      amount: price.amount,
      currency: price.currency,
      already_in_ledger: existing,
    });
  }
  return planned;
}
