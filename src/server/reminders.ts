import { computeAlerts } from '../shared/alerts';
import { isoWeekday, todayInTimezone } from '../shared/dates';
import type { Alert, AppSettings, IsoDate } from '../shared/types';
import type { Db } from './repo/db';
import { getSettings } from './repo/settings';
import { listAllTools, purgeOldTrash } from './repo/tools';
import { listPayments } from './repo/payments';
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
  alert_dispatch: DispatchReport;
  digest_dispatch: DispatchReport | null;
  dry_run: boolean;
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

  const tools = await listAllTools(db);
  const payments = await listPayments(db);
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
    alert_dispatch: alertDispatch,
    digest_dispatch: digestDispatch,
    dry_run: dryRun,
  };
}
