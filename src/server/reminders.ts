import { computeAlerts } from '../shared/alerts';
import { paymentsToSchedule } from '../shared/schedule';
import { isoWeekday, todayInTimezone } from '../shared/dates';
import { changesByTool } from '../shared/prices';
import type { Alert, AppSettings, IsoDate, Payment, PriceChange, Tool } from '../shared/types';
import type { Db } from './repo/db';
import { getSettings } from './repo/settings';
import { listAllTools, markPaymentsScheduledThrough, purgeOldTrash } from './repo/tools';
import { createPayment, listPayments } from './repo/payments';
import { recordAudit } from './repo/audit';
import { listPriceChanges } from './repo/priceChanges';
import { syncCurrentPrice } from './pricing';
import { listInternalProducts } from './repo/internalProducts';
import { listAllProductCosts } from './repo/productCosts';
import { consoleChannel } from './notify/console';
import { emailChannel } from './notify/email';
import { teamsChannel } from './notify/teams';
import { dispatchAlerts, dispatchDigest, type DispatchReport } from './notify/dispatcher';
import type { Channel } from './notify/types';

/**
 * The daily reminder job.
 *
 * The same function backs the cron trigger and the `/api/reminders/dry-run`
 * endpoint -- the only difference is the `dryRun` flag. That means what you
 * preview is literally what would be sent, computed by the same code path,
 * rather than a separate "preview" implementation that can drift.
 */

export const DEFAULT_CHANNELS: Channel[] = [consoleChannel, teamsChannel, emailChannel];

export interface ReminderRun {
  today: IsoDate;
  timezone: string;
  alerts: Alert[];
  /** Payments added to the ledger by this run (or that would be, in a dry run). */
  scheduled_payments: ScheduledPayment[];
  alert_dispatch: DispatchReport;
  digest_dispatch: DispatchReport | null;
  dry_run: boolean;
}

export interface ScheduledPayment {
  tool_id: string;
  tool_name: string;
  due_date: IsoDate;
  amount: number;
  currency: string;
}

export interface RunOptions {
  dryRun?: boolean;
  /** Simulate a specific day. Only used by the dry-run endpoint and tests. */
  today?: IsoDate;
  channels?: Channel[];
  /** Force the weekly digest regardless of what day it is. */
  forceDigest?: boolean;
  now?: Date;
}

/** ISO year-week, e.g. '2026-W38'. Stable identity for one digest. */
export function weekKey(today: IsoDate): string {
  const date = new Date(`${today}T00:00:00Z`);
  const dayOfWeek = (date.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - dayOfWeek + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Settings for the weekly digest: widen every lead window to the digest
 * horizon so the digest covers the whole period ahead, not just today's
 * threshold crossings.
 */
function digestSettings(settings: AppSettings): AppSettings {
  const horizon = settings.digest_horizon_days;
  return {
    ...settings,
    renewal_lead_days: [horizon],
    payment_lead_days: [horizon],
    notice_lead_days: [horizon],
  };
}

export async function runReminders(
  db: Db,
  env: Record<string, string | undefined>,
  options: RunOptions = {},
): Promise<ReminderRun> {
  const settings = await getSettings(db);
  const today = options.today ?? todayInTimezone(settings.timezone, options.now);
  const channels = options.channels ?? DEFAULT_CHANNELS;
  const dryRun = options.dryRun ?? false;

  // Piggybacks on the one thing actually scheduled to run daily, so the trash
  // empties itself without needing infrastructure of its own. A dry run
  // previews what would be sent and must not change anything, this included.
  if (!dryRun) await purgeOldTrash(db);

  const priceChanges = await listPriceChanges(db);
  // A price change dated today or earlier becomes the tool's cost, so the
  // dashboard's run-rate moves on the day the new price starts.
  if (!dryRun) {
    for (const [toolId, changes] of changesByTool(priceChanges)) {
      await syncCurrentPrice(db, toolId, changes, today, 'system');
    }
  }

  const tools = await listAllTools(db);
  const payments = await listPayments(db);
  const scheduled = await scheduleDuePayments(db, tools, payments, priceChanges, settings, today, dryRun);
  const [products, costs] = await Promise.all([listInternalProducts(db), listAllProductCosts(db)]);
  const productContext = { products, costs };

  const alerts = computeAlerts(tools, payments, settings, today, productContext);
  const alertDispatch = await dispatchAlerts(db, alerts, settings, env, channels, { dryRun });

  let digestDispatch: DispatchReport | null = null;
  const isDigestDay = isoWeekday(today) === settings.digest_weekday;
  if (options.forceDigest || isDigestDay) {
    const digestAlerts = computeAlerts(tools, payments, digestSettings(settings), today, productContext);
    digestDispatch = await dispatchDigest(
      db,
      digestAlerts,
      settings,
      env,
      channels,
      weekKey(today),
      { dryRun },
    );
  }

  return {
    today,
    timezone: settings.timezone,
    alerts,
    scheduled_payments: scheduled,
    alert_dispatch: alertDispatch,
    digest_dispatch: digestDispatch,
    dry_run: dryRun,
  };
}

/**
 * Add each tool's next payment to the ledger once it comes into view, so
 * nobody has to schedule bills by hand -- they only mark them paid.
 *
 * Runs before the alerts are computed and appends to `payments` in place, so a
 * bill added this morning gets its "due soon" reminder this morning. A dry run
 * appends the same rows in memory only, so the preview matches the real run.
 */
async function scheduleDuePayments(
  db: Db,
  tools: Tool[],
  payments: Payment[],
  priceChanges: PriceChange[],
  settings: AppSettings,
  today: IsoDate,
  dryRun: boolean,
): Promise<ScheduledPayment[]> {
  const scheduled: ScheduledPayment[] = [];

  for (const plan of paymentsToSchedule(tools, payments, settings, today, priceChanges)) {
    if (!plan.already_in_ledger) {
      const row = {
        tool_id: plan.tool.id,
        due_date: plan.due_date,
        period_start: plan.period_start,
        period_end: plan.period_end,
        amount: plan.amount,
        currency: plan.currency,
        status: 'due' as const,
      };
      const payment: Payment = dryRun
        ? {
            ...row,
            id: `dry-run-${plan.tool.id}-${plan.due_date}`,
            paid_on: null,
            paid_by: null,
            invoice_ref: null,
            invoice_url: null,
            notes: null,
            created_at: today,
            updated_at: today,
          }
        : await createPayment(db, row as never);
      payments.push(payment);
      scheduled.push({
        tool_id: plan.tool.id,
        tool_name: plan.tool.name,
        due_date: plan.due_date,
        amount: plan.amount,
        currency: plan.currency,
      });

      if (!dryRun) {
        await recordAudit(db, {
          entity: 'payment',
          entity_id: payment.id,
          action: 'create',
          actor: 'system',
          summary: `Scheduled ${plan.tool.name}'s payment due ${plan.due_date} automatically`,
        });
      }
    }
    if (!dryRun) await markPaymentsScheduledThrough(db, plan.tool.id, plan.due_date);
  }
  return scheduled;
}
