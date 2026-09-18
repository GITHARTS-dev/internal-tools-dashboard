import { isNotifiable } from '../../shared/alerts';
import type { Alert, AppSettings } from '../../shared/types';
import { alreadySentKeys, recordNotification } from '../repo/notifications';
import type { Db } from '../repo/db';
import { formatAlertsText, summaryLine } from './format';
import type { Channel, ChannelResult, NotificationPayload } from './types';

/**
 * Decides what to send, to whom, and only once.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 * 1. Dedupe state is tracked PER CHANNEL, by prefixing the alert's dedupe_key
 *    with the channel name. Without that prefix, the console channel logging
 *    an alert today would permanently suppress the Teams message for the same
 *    alert once a webhook is finally configured -- the reminder would be
 *    silently swallowed by its own history.
 *
 * 2. New alerts are batched into ONE message per channel per run, rather than
 *    one message per alert. Twelve separate Teams cards on a Monday morning is
 *    how a useful channel becomes a muted one.
 */

export interface DispatchOptions {
  /** Work out what would be sent, send nothing, record nothing. */
  dryRun?: boolean;
  /** Overrides the default channel set. Used by tests. */
  channels?: Channel[];
  now?: Date;
}

export interface DispatchReport {
  considered: number;
  notifiable: number;
  channels: Array<ChannelResult & { new_alerts: number; alert_titles: string[] }>;
  dry_run: boolean;
}

export function channelKey(channel: string, dedupeKey: string): string {
  return `${channel}:${dedupeKey}`;
}

function buildPayload(alerts: Alert[], kind: 'alerts' | 'digest'): NotificationPayload {
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const title =
    kind === 'digest'
      ? `Tools & subscriptions: week ahead (${alerts.length} item${alerts.length === 1 ? '' : 's'})`
      : critical > 0
        ? `Tools & subscriptions: ${critical} urgent item${critical === 1 ? '' : 's'}`
        : `Tools & subscriptions: ${alerts.length} item${alerts.length === 1 ? '' : 's'} need attention`;

  return { title, text: formatAlertsText(alerts), alerts, kind };
}

export async function dispatchAlerts(
  db: Db,
  alerts: Alert[],
  settings: AppSettings,
  env: Record<string, string | undefined>,
  channels: Channel[],
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const dryRun = options.dryRun ?? false;
  const notifiable = alerts.filter(isNotifiable);

  const report: DispatchReport = {
    considered: alerts.length,
    notifiable: notifiable.length,
    channels: [],
    dry_run: dryRun,
  };

  for (const channel of channels) {
    if (!channel.isConfigured(settings, env)) {
      report.channels.push({
        channel: channel.name,
        status: 'skipped',
        detail: 'not configured',
        new_alerts: 0,
        alert_titles: [],
      });
      continue;
    }

    const keys = notifiable.map((a) => channelKey(channel.name, a.dedupe_key));
    const sent = await alreadySentKeys(db, keys);
    const fresh = notifiable.filter((a) => !sent.has(channelKey(channel.name, a.dedupe_key)));

    if (fresh.length === 0) {
      report.channels.push({
        channel: channel.name,
        status: 'skipped',
        detail: 'nothing new since the last run',
        new_alerts: 0,
        alert_titles: [],
      });
      continue;
    }

    const payload = buildPayload(fresh, 'alerts');

    if (dryRun) {
      report.channels.push({
        channel: channel.name,
        status: 'skipped',
        detail: 'dry run: nothing sent or recorded',
        new_alerts: fresh.length,
        alert_titles: fresh.map((a) => a.title),
      });
      continue;
    }

    const result = await channel.send(payload, settings, env);

    // Only a successful send is recorded. A failed webhook must be retried on
    // the next run, not quietly marked as delivered.
    if (result.status === 'sent') {
      for (const alert of fresh) {
        await recordNotification(db, {
          dedupe_key: channelKey(channel.name, alert.dedupe_key),
          tool_id: alert.tool_id,
          payment_id: alert.payment_id,
          rule: alert.rule,
          channel: channel.name,
          target: alert.owner_email,
          severity: alert.severity,
          status: 'sent',
          detail: alert.title,
        });
      }
    }

    report.channels.push({
      ...result,
      new_alerts: fresh.length,
      alert_titles: fresh.map((a) => a.title),
    });
  }

  return report;
}

/**
 * The weekly digest: everything on the horizon, sent whether or not each item
 * has already been individually notified. Its own dedupe key is the week, so
 * it goes out once a week even if the cron runs seven times.
 */
export async function dispatchDigest(
  db: Db,
  alerts: Alert[],
  settings: AppSettings,
  env: Record<string, string | undefined>,
  channels: Channel[],
  weekKey: string,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const dryRun = options.dryRun ?? false;
  const report: DispatchReport = {
    considered: alerts.length,
    notifiable: alerts.length,
    channels: [],
    dry_run: dryRun,
  };

  for (const channel of channels) {
    if (!channel.isConfigured(settings, env)) {
      report.channels.push({
        channel: channel.name,
        status: 'skipped',
        detail: 'not configured',
        new_alerts: 0,
        alert_titles: [],
      });
      continue;
    }

    const key = channelKey(channel.name, `digest:${weekKey}`);
    const sent = await alreadySentKeys(db, [key]);
    if (sent.has(key)) {
      report.channels.push({
        channel: channel.name,
        status: 'skipped',
        detail: `digest for ${weekKey} already sent`,
        new_alerts: 0,
        alert_titles: [],
      });
      continue;
    }

    const payload = buildPayload(alerts, 'digest');
    payload.text = `${summaryLine(alerts)}\n\n${payload.text}`;

    if (dryRun) {
      report.channels.push({
        channel: channel.name,
        status: 'skipped',
        detail: 'dry run: nothing sent or recorded',
        new_alerts: alerts.length,
        alert_titles: alerts.map((a) => a.title),
      });
      continue;
    }

    const result = await channel.send(payload, settings, env);
    if (result.status === 'sent') {
      await recordNotification(db, {
        dedupe_key: key,
        rule: 'digest',
        channel: channel.name,
        status: 'sent',
        detail: payload.title,
      });
    }

    report.channels.push({
      ...result,
      new_alerts: alerts.length,
      alert_titles: alerts.map((a) => a.title),
    });
  }

  return report;
}
