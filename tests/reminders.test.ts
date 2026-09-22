import { beforeEach, describe, expect, it } from 'vitest';
import { runReminders, weekKey } from '../src/server/reminders';
import { consoleChannel } from '../src/server/notify/console';
import { buildTeamsCard } from '../src/server/notify/teams';
import { listNotifications } from '../src/server/repo/notifications';
import { createTool, listTrash, trashTool } from '../src/server/repo/tools';
import { createPayment } from '../src/server/repo/payments';
import { updateSettings } from '../src/server/repo/settings';
import type { Channel, NotificationPayload } from '../src/server/notify/types';
import type { Db } from '../src/server/repo/db';
import { testDb } from './db-helper';

let db: Db;
const env: Record<string, string | undefined> = { APP_ENV: 'test' };

/** A channel that records what it was asked to send instead of sending it. */
function recordingChannel(name = 'test'): Channel & { sent: NotificationPayload[] } {
  const sent: NotificationPayload[] = [];
  return {
    name,
    sent,
    isConfigured: () => true,
    async send(payload) {
      sent.push(payload);
      return { channel: name, status: 'sent', detail: `captured ${payload.alerts.length}` };
    },
  };
}

/** A channel that always fails, like a webhook URL that has been revoked. */
function failingChannel(name = 'flaky'): Channel {
  return {
    name,
    isConfigured: () => true,
    async send() {
      return { channel: name, status: 'failed', detail: 'simulated outage' };
    },
  };
}

beforeEach(async () => {
  ({ db } = testDb());
  await updateSettings(db, { timezone: 'Asia/Kolkata' });
});

function toolInput(name = 'Some tool') {
  return {
    name,
    category: 'Other',
    status: 'active',
    billing_cycle: 'monthly',
    currency: 'INR',
    auto_renew: true,
    cancellation_notice_days: 0,
  } as never;
}

async function seedOverduePayment() {
  const tool = await createTool(db, {
    name: 'Clockify',
    category: 'Time tracking',
    status: 'active',
    owner_name: 'Ravi',
    owner_email: 'ravi@example.com',
    billing_cycle: 'monthly',
    cost_amount: 350000,
    currency: 'INR',
    renewal_date: '2027-01-01',
    auto_renew: true,
    cancellation_notice_days: 0,
  } as never);
  await createPayment(db, {
    tool_id: tool.id,
    due_date: '2026-09-01',
    amount: 350000,
    currency: 'INR',
    status: 'due',
  } as never);
  return tool;
}

describe('dry run', () => {
  it('reports what would be sent and writes nothing', async () => {
    await seedOverduePayment();
    const channel = recordingChannel();

    const run = await runReminders(db, env, {
      dryRun: true,
      today: '2026-09-18',
      channels: [channel],
    });

    expect(run.dry_run).toBe(true);
    expect(run.alerts.some((a) => a.rule === 'payment_overdue')).toBe(true);
    expect(run.alert_dispatch.channels[0]!.new_alerts).toBeGreaterThan(0);

    // Nothing sent, nothing recorded -- so previewing is always safe.
    expect(channel.sent).toHaveLength(0);
    expect(await listNotifications(db)).toHaveLength(0);
  });

  it('simulates any date without touching the clock', async () => {
    await seedOverduePayment();
    const quiet = await runReminders(db, env, {
      dryRun: true,
      today: '2026-08-01', // before the payment was due
      channels: [recordingChannel()],
    });
    expect(quiet.alerts.filter((a) => a.rule === 'payment_overdue')).toHaveLength(0);
  });

  it('leaves the trash alone: previewing must not change anything', async () => {
    const tool = await createTool(db, toolInput());
    await trashTool(db, tool.id, 'test');
    await db.prepare('UPDATE tools SET deleted_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', tool.id).run();

    await runReminders(db, env, { dryRun: true, today: '2026-09-18', channels: [recordingChannel()] });

    expect(await listTrash(db)).toHaveLength(1);
  });
});

describe('the daily run and the trash', () => {
  it('empties out anything that has sat in the trash past the retention window', async () => {
    const tool = await createTool(db, toolInput());
    await trashTool(db, tool.id, 'test');
    await db.prepare('UPDATE tools SET deleted_at = ? WHERE id = ?').bind('2020-01-01T00:00:00.000Z', tool.id).run();

    await runReminders(db, env, { today: '2026-09-18', channels: [recordingChannel()] });

    expect(await listTrash(db)).toHaveLength(0);
  });

  it('does not touch a tool still inside the retention window', async () => {
    const tool = await createTool(db, toolInput());
    await trashTool(db, tool.id, 'test');

    await runReminders(db, env, { today: '2026-09-18', channels: [recordingChannel()] });

    expect(await listTrash(db)).toHaveLength(1);
  });
});

describe('sending', () => {
  it('batches the run into one message per channel, not one per alert', async () => {
    await seedOverduePayment();
    await createTool(db, {
      name: 'Adobe CC',
      category: 'Design',
      status: 'active',
      billing_cycle: 'annual',
      cost_amount: 5000000,
      currency: 'INR',
      renewal_date: '2026-10-02',
      auto_renew: true,
      cancellation_notice_days: 0,
      owner_name: 'Meera',
    } as never);

    const channel = recordingChannel();
    await runReminders(db, env, { today: '2026-09-18', channels: [channel] });

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.alerts.length).toBeGreaterThan(1);
    expect(channel.sent[0]!.text).toContain('Overdue payments');
  });

  it('does not repeat itself when run again the same day', async () => {
    await seedOverduePayment();
    const channel = recordingChannel();

    await runReminders(db, env, { today: '2026-09-18', channels: [channel] });
    await runReminders(db, env, { today: '2026-09-18', channels: [channel] });
    await runReminders(db, env, { today: '2026-09-18', channels: [channel] });

    expect(channel.sent).toHaveLength(1);
  });

  it('does not repeat an overdue payment daily, but does chase it weekly', async () => {
    await seedOverduePayment();
    const channel = recordingChannel();

    // Counting alert messages only: 2026-09-07 is a Monday, so the weekly
    // digest also goes out that day and is not a repeat of the alert.
    const alertSends = () => channel.sent.filter((p) => p.kind === 'alerts');

    for (const day of ['2026-09-02', '2026-09-03', '2026-09-05', '2026-09-07']) {
      await runReminders(db, env, { today: day, channels: [channel] });
    }
    expect(alertSends()).toHaveLength(1); // all within the first week overdue

    await runReminders(db, env, { today: '2026-09-08', channels: [channel] });
    expect(alertSends()).toHaveLength(2); // a new week, so it chases again
  });

  it('retries after a failed send instead of marking it delivered', async () => {
    await seedOverduePayment();

    const failing = failingChannel('teams');
    const run = await runReminders(db, env, { today: '2026-09-18', channels: [failing] });
    expect(run.alert_dispatch.channels[0]!.status).toBe('failed');

    // A failed webhook must not leave a "sent" record behind, or the reminder
    // would be lost forever on the next run.
    expect(await listNotifications(db)).toHaveLength(0);

    const recovering = recordingChannel('teams');
    await runReminders(db, env, { today: '2026-09-18', channels: [recovering] });
    expect(recovering.sent).toHaveLength(1);
  });

  it('tracks each channel separately, so enabling Teams later still delivers', async () => {
    await seedOverduePayment();

    // The console channel "sends" everything while deployment is on hold...
    const console1 = recordingChannel('console');
    await runReminders(db, env, { today: '2026-09-18', channels: [console1] });
    expect(console1.sent).toHaveLength(1);

    // ...and that must not suppress the very first Teams message once a
    // webhook is finally configured.
    const teams = recordingChannel('teams');
    await runReminders(db, env, { today: '2026-09-18', channels: [teams] });
    expect(teams.sent).toHaveLength(1);
  });

  it('skips channels that are not configured, without failing the run', async () => {
    await seedOverduePayment();
    const unconfigured: Channel = {
      name: 'email',
      isConfigured: () => false,
      async send() {
        throw new Error('should never be called');
      },
    };

    const run = await runReminders(db, env, { today: '2026-09-18', channels: [unconfigured] });
    expect(run.alert_dispatch.channels[0]!.status).toBe('skipped');
    expect(run.alert_dispatch.channels[0]!.detail).toBe('not configured');
  });

  it('says nothing at all when the portfolio is clean', async () => {
    await createTool(db, {
      name: 'Notion',
      category: 'Productivity',
      status: 'active',
      owner_name: 'Sam',
      billing_cycle: 'annual',
      cost_amount: 100000,
      currency: 'INR',
      renewal_date: '2027-12-01',
      auto_renew: true,
      cancellation_notice_days: 0,
      seats_purchased: 4,
      seats_used: 4,
    } as never);

    const channel = recordingChannel();
    await runReminders(db, env, { today: '2026-09-18', channels: [channel] });
    expect(channel.sent).toHaveLength(0);
  });
});

describe('weekly digest', () => {
  it('goes out on the configured weekday and only once that week', async () => {
    await seedOverduePayment();
    const channel = recordingChannel();

    // 2026-09-21 is a Monday, the default digest day.
    const monday = await runReminders(db, env, { today: '2026-09-21', channels: [channel] });
    expect(monday.digest_dispatch).not.toBeNull();
    const digests = channel.sent.filter((p) => p.kind === 'digest');
    expect(digests).toHaveLength(1);

    await runReminders(db, env, { today: '2026-09-21', channels: [channel] });
    expect(channel.sent.filter((p) => p.kind === 'digest')).toHaveLength(1);
  });

  it('does not run on other days', async () => {
    await seedOverduePayment();
    const run = await runReminders(db, env, {
      today: '2026-09-22', // Tuesday
      channels: [recordingChannel()],
    });
    expect(run.digest_dispatch).toBeNull();
  });

  it('reaches further ahead than the daily alerts do', async () => {
    await createTool(db, {
      name: 'Figma',
      category: 'Design',
      status: 'active',
      owner_name: 'Dev',
      billing_cycle: 'annual',
      cost_amount: 2400000,
      currency: 'INR',
      renewal_date: '2026-10-25', // 34 days out: inside the 45-day digest horizon
      auto_renew: true,
      cancellation_notice_days: 0,
    } as never);

    const channel = recordingChannel();
    const run = await runReminders(db, env, { today: '2026-09-21', channels: [channel], forceDigest: true });

    // The daily pass says nothing (34 days is between the 60 and 30 steps
    // already crossed), but the digest still lists it.
    const digest = channel.sent.find((p) => p.kind === 'digest');
    expect(digest?.alerts.some((a) => a.tool_name === 'Figma')).toBe(true);
    expect(run.digest_dispatch).not.toBeNull();
  });
});

describe('weekKey', () => {
  it('is stable within a week and changes between weeks', () => {
    expect(weekKey('2026-09-21')).toBe(weekKey('2026-09-27')); // Mon-Sun
    expect(weekKey('2026-09-21')).not.toBe(weekKey('2026-09-28'));
  });

  it('handles the turn of the year', () => {
    expect(weekKey('2026-12-31')).toMatch(/^\d{4}-W\d{2}$/);
    expect(weekKey('2027-01-01')).toBe(weekKey('2026-12-31')); // same ISO week
  });
});

describe('Teams card', () => {
  it('builds an Adaptive Card grouped by urgency', async () => {
    await seedOverduePayment();
    const channel = recordingChannel();
    await runReminders(db, env, { today: '2026-09-18', channels: [channel] });

    const card = buildTeamsCard(channel.sent[0]!) as any;
    expect(card.type).toBe('message');
    expect(card.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');

    const text = JSON.stringify(card);
    expect(text).toContain('Overdue payments');
    expect(text).toContain('Clockify');
    expect(text).toContain('attention'); // critical colour
  });
});

describe('the console channel', () => {
  it('is always available, so the engine works with no credentials at all', () => {
    expect(consoleChannel.isConfigured({} as never, {})).toBe(true);
  });
});
