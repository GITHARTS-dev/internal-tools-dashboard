import { Hono } from 'hono';
import { settingsUpdateSchema } from '../../shared/schema';
import { isIsoDate } from '../../shared/dates';
import type { Env } from '../context';
import { actor, db, envVars, featureDocuments, zodErrorResponse } from '../context';
import { getSettings, updateSettings } from '../repo/settings';
import { listNotifications } from '../repo/notifications';
import { listRecentAudit } from '../repo/audit';
import { recordAudit } from '../repo/audit';
import { runReminders } from '../reminders';
import { DEFAULT_CHANNELS } from '../reminders';

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.get('/settings', async (c) => {
  const settings = await getSettings(db(c));
  return c.json({
    settings,
    features: { documents: featureDocuments(c) },
    // Which channels could actually send right now, so Settings can show the
    // real state instead of implying email works when it does not.
    channels: DEFAULT_CHANNELS.map((ch) => ({
      name: ch.name,
      configured: ch.isConfigured(settings, envVars(c)),
    })),
  });
});

adminRoutes.patch('/settings', async (c) => {
  const parsed = settingsUpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const settings = await updateSettings(db(c), parsed.data);
  await recordAudit(db(c), {
    entity: 'settings',
    entity_id: 'global',
    action: 'update',
    actor: actor(c),
    summary: `Updated ${Object.keys(parsed.data).join(', ')}`,
  });
  return c.json({ settings });
});

/**
 * Preview exactly which reminders would fire, on a date you choose, without
 * sending or recording anything.
 *
 * This is the same code path the cron trigger runs -- only the dryRun flag
 * differs -- so what it shows is what would actually go out. It is how the
 * rules get checked against real data before anyone trusts them.
 */
adminRoutes.get('/reminders/dry-run', async (c) => {
  const dateParam = new URL(c.req.url).searchParams.get('date');
  const forceDigest = new URL(c.req.url).searchParams.get('digest') === 'true';

  if (dateParam && !isIsoDate(dateParam)) {
    return c.json(
      { error: 'bad_date', message: 'Use a real calendar date in YYYY-MM-DD form.' },
      400,
    );
  }

  const run = await runReminders(db(c), envVars(c), {
    dryRun: true,
    today: dateParam ?? undefined,
    forceDigest,
  });
  return c.json(run);
});

/** Run the reminder job for real, now. Used to test a freshly pasted webhook. */
adminRoutes.post('/reminders/run', async (c) => {
  const run = await runReminders(db(c), envVars(c), { dryRun: false });
  await recordAudit(db(c), {
    entity: 'reminders',
    entity_id: run.today,
    action: 'update',
    actor: actor(c),
    summary: `Ran reminders for ${run.today}`,
  });
  return c.json(run);
});

adminRoutes.get('/notifications', async (c) => {
  const notifications = await listNotifications(db(c), 200);
  return c.json({ notifications });
});

adminRoutes.get('/audit', async (c) => {
  const audit = await listRecentAudit(db(c), 200);
  return c.json({ audit });
});
