/**
 * The alert engine.
 *
 * `computeAlerts` is a pure function, and it is the ONLY place that decides
 * whether something needs attention. The dashboard API, the UI badges and the
 * daily reminder job all call it. That is deliberate: the dashboard can never
 * show a tool as fine while the reminder job considers it overdue, because
 * there is only one definition of "overdue" in the codebase.
 *
 * Every alert carries a `dedupe_key` identifying "this alert, at this lead
 * step". The notification log has a UNIQUE index on that key, which is what
 * stops someone being told about the same renewal every morning for 60 days.
 */

import { addDays, daysBetween, nextOccurrenceOnOrAfter, relativeDays, formatDate } from './dates';
import { formatMoney, wastedSeatCost } from './money';
import type { Alert, AlertRule, AppSettings, IsoDate, Payment, Severity, Tool } from './types';

/** Tools in these states are still live enough to warrant renewal reminders. */
const LIVE_STATUSES = new Set(['active', 'trial']);

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Pick which lead step an alert is at: the tightest configured threshold that
 * still covers `daysUntil`. With leads [7,3,1] a payment 5 days out matches
 * step 7 and stays on step 7 until it reaches 3 -- so it notifies once per
 * step crossed, not once per day.
 */
function leadStep(daysUntil: number, leads: number[]): number | null {
  const candidates = [...new Set([...leads, 0])].filter((l) => l >= daysUntil);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function severityForDays(daysUntil: number): Severity {
  if (daysUntil <= 1) return 'critical';
  if (daysUntil <= 7) return 'warning';
  return 'info';
}

function baseAlert(
  tool: Tool,
  rule: AlertRule,
  severity: Severity,
  title: string,
  detail: string,
  date: IsoDate | null,
  daysUntil: number | null,
  dedupeKey: string,
  extra: Partial<Alert> = {},
): Alert {
  return {
    rule,
    severity,
    tool_id: tool.id,
    tool_name: tool.name,
    payment_id: null,
    title,
    detail,
    date,
    days_until: daysUntil,
    amount: tool.cost_amount,
    currency: tool.currency,
    owner_name: tool.owner_name,
    owner_email: tool.owner_email,
    dedupe_key: dedupeKey,
    ...extra,
  };
}

/**
 * The renewal date a tool will actually next hit.
 *
 * A stored date that has drifted into the past is normal -- nobody updates
 * these by hand. For an auto-renewing tool the vendor has simply charged us
 * again, so we roll the date forward by whole billing periods. For a tool that
 * does NOT auto-renew, a past date means it lapsed, and that is a data problem
 * to surface rather than paper over.
 */
export function effectiveRenewalDate(tool: Tool, today: IsoDate): IsoDate | null {
  if (!tool.renewal_date) return null;
  if (daysBetween(today, tool.renewal_date) >= 0) return tool.renewal_date;
  if (!tool.auto_renew) return null;
  return nextOccurrenceOnOrAfter(tool.renewal_date, tool.billing_cycle, today);
}

export function computeAlerts(
  tools: Tool[],
  payments: Payment[],
  settings: AppSettings,
  today: IsoDate,
): Alert[] {
  const alerts: Alert[] = [];
  const toolById = new Map(tools.map((t) => [t.id, t]));

  // -- Payments -------------------------------------------------------------
  // These apply regardless of tool status: a cancelled tool can still owe a
  // final invoice, and that is exactly the bill most likely to be forgotten.
  for (const payment of payments) {
    if (payment.status !== 'due') continue;
    const tool = toolById.get(payment.tool_id);
    if (!tool) continue;

    const daysUntil = daysBetween(today, payment.due_date);
    const money = formatMoney(payment.amount, payment.currency);

    if (daysUntil < 0) {
      const daysOverdue = -daysUntil;
      // Notify on discovery, then once a week, escalating rather than nagging.
      const week = Math.floor(daysOverdue / 7);
      alerts.push(
        baseAlert(
          tool,
          'payment_overdue',
          'critical',
          `${tool.name} payment is overdue`,
          `${money} was due ${formatDate(payment.due_date)} (${relativeDays(daysUntil)}) and is still unpaid.`,
          payment.due_date,
          daysUntil,
          `payment_overdue:${payment.id}:w${week}`,
          { payment_id: payment.id, amount: payment.amount, currency: payment.currency },
        ),
      );
      continue;
    }

    const step = leadStep(daysUntil, settings.payment_lead_days);
    if (step === null) continue;
    alerts.push(
      baseAlert(
        tool,
        'payment_due_soon',
        severityForDays(daysUntil),
        `${tool.name} payment due ${relativeDays(daysUntil)}`,
        `${money} is due on ${formatDate(payment.due_date)}.`,
        payment.due_date,
        daysUntil,
        `payment_due_soon:${payment.id}:${step}`,
        { payment_id: payment.id, amount: payment.amount, currency: payment.currency },
      ),
    );
  }

  // -- Renewals, notice deadlines, data quality, seats ----------------------
  for (const tool of tools) {
    if (!LIVE_STATUSES.has(tool.status)) continue;

    const renewal = effectiveRenewalDate(tool, today);

    // A non-auto-renewing tool whose renewal date has passed: it has either
    // lapsed or somebody renewed it without updating the record. Both need a
    // human, and neither should be guessed at.
    if (tool.renewal_date && renewal === null) {
      alerts.push(
        baseAlert(
          tool,
          'missing_data',
          'warning',
          `${tool.name} renewal date has passed`,
          `The renewal date ${formatDate(tool.renewal_date)} is in the past and this tool is not set to auto-renew. Confirm whether it is still in use and update the date.`,
          tool.renewal_date,
          daysBetween(today, tool.renewal_date),
          `missing_data:${tool.id}:stale_renewal:${today.slice(0, 7)}`,
        ),
      );
    }

    if (renewal) {
      const daysUntil = daysBetween(today, renewal);
      const step = leadStep(daysUntil, settings.renewal_lead_days);
      if (step !== null) {
        const cost = tool.cost_amount === null ? 'an unrecorded amount' : formatMoney(tool.cost_amount, tool.currency);
        alerts.push(
          baseAlert(
            tool,
            'renewal_upcoming',
            severityForDays(daysUntil),
            `${tool.name} renews ${relativeDays(daysUntil)}`,
            `${tool.auto_renew ? 'Auto-renews' : 'Renewal due'} on ${formatDate(renewal)} for ${cost}.`,
            renewal,
            daysUntil,
            // The date is in the key so next year's cycle notifies again.
            `renewal_upcoming:${tool.id}:${renewal}:${step}`,
          ),
        );
      }

      // The last day to cancel without being charged for another period.
      // This is the deadline people actually miss, because it is invisible.
      if (tool.auto_renew && tool.cancellation_notice_days > 0) {
        const deadline = addDays(renewal, -tool.cancellation_notice_days);
        const daysToDeadline = daysBetween(today, deadline);

        if (daysToDeadline >= 0) {
          const noticeStep = leadStep(daysToDeadline, settings.notice_lead_days);
          if (noticeStep !== null) {
            alerts.push(
              baseAlert(
                tool,
                'notice_deadline',
                daysToDeadline <= 3 ? 'critical' : 'warning',
                `${tool.name}: last day to cancel is ${relativeDays(daysToDeadline)}`,
                `${tool.name} needs ${tool.cancellation_notice_days} days' notice. To avoid auto-renewing on ${formatDate(renewal)}, cancel by ${formatDate(deadline)}.`,
                deadline,
                daysToDeadline,
                `notice_deadline:${tool.id}:${renewal}:${noticeStep}`,
              ),
            );
          }
        } else {
          // Notice window closed but the renewal has not happened yet: it is
          // now too late to avoid the charge, and someone should know that.
          alerts.push(
            baseAlert(
              tool,
              'notice_deadline',
              'warning',
              `${tool.name} can no longer be cancelled before renewal`,
              `The ${tool.cancellation_notice_days}-day notice deadline (${formatDate(deadline)}) has passed, so this will auto-renew on ${formatDate(renewal)}. Budget for it, or cancel for the following period.`,
              deadline,
              daysToDeadline,
              `notice_deadline:${tool.id}:${renewal}:passed`,
            ),
          );
        }
      }
    }

    // -- Data quality -------------------------------------------------------
    // A record with no owner or no cost cannot prevent a missed payment, so an
    // incomplete row is itself a problem worth chasing. Re-raised monthly.
    const gaps: string[] = [];
    if (!tool.owner_name && !tool.owner_email) gaps.push('no owner');
    if (tool.cost_amount === null) gaps.push('no cost');
    if (!tool.renewal_date) gaps.push('no renewal date');
    if (gaps.length > 0) {
      alerts.push(
        baseAlert(
          tool,
          'missing_data',
          'warning',
          `${tool.name} is missing key details`,
          `This record has ${gaps.join(', ')}. Without them it cannot be tracked or chased.`,
          null,
          null,
          `missing_data:${tool.id}:${gaps.join('|')}:${today.slice(0, 7)}`,
        ),
      );
    }

    // -- Unused seats -------------------------------------------------------
    if (
      tool.seats_purchased !== null &&
      tool.seats_purchased > 0 &&
      tool.seats_used !== null &&
      tool.seats_used / tool.seats_purchased < settings.seat_underuse_ratio
    ) {
      const idle = tool.seats_purchased - tool.seats_used;
      const waste = wastedSeatCost(tool.cost_amount, tool.seats_purchased, tool.seats_used);
      const wasteText = waste ? ` That is about ${formatMoney(waste, tool.currency)} per billing period.` : '';
      alerts.push(
        baseAlert(
          tool,
          'seats_underused',
          'info',
          `${tool.name} has ${idle} unused seat${idle === 1 ? '' : 's'}`,
          `${tool.seats_used} of ${tool.seats_purchased} seats are in use.${wasteText} Worth right-sizing at the next renewal.`,
          renewal,
          renewal ? daysBetween(today, renewal) : null,
          `seats_underused:${tool.id}:${today.slice(0, 7)}`,
        ),
      );
    }
  }

  return sortAlerts(alerts);
}

/** Most urgent first: by severity, then by how soon, then by name. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    const ad = a.days_until ?? Number.MAX_SAFE_INTEGER;
    const bd = b.days_until ?? Number.MAX_SAFE_INTEGER;
    if (ad !== bd) return ad - bd;
    return a.tool_name.localeCompare(b.tool_name);
  });
}

/**
 * Which alerts are worth pushing to Teams/email, as opposed to merely showing
 * on the dashboard.
 *
 * Unused seats are real money but never urgent, so they are only pushed when a
 * renewal is close enough to act on. Everything else that reaches this
 * function is time-sensitive by construction.
 */
export function isNotifiable(alert: Alert): boolean {
  if (alert.rule === 'seats_underused') {
    return alert.days_until !== null && alert.days_until <= 60;
  }
  return true;
}

export function alertsByRule(alerts: Alert[]): Record<AlertRule, Alert[]> {
  const out = {
    payment_overdue: [],
    payment_due_soon: [],
    renewal_upcoming: [],
    notice_deadline: [],
    missing_data: [],
    seats_underused: [],
  } as Record<AlertRule, Alert[]>;
  for (const a of alerts) out[a.rule].push(a);
  return out;
}
