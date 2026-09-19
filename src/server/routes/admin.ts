import { Hono } from 'hono';
import { settingsUpdateSchema } from '../../shared/schema';
import { isIsoDate } from '../../shared/dates';
import type { AppContext, Env } from '../context';
import { actor, db, envVars, featureDocuments, zodErrorResponse } from '../context';
import { clearAllData, dataStatus, loadDemoData, removeDemoData } from '../repo/demo';
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

/**
 * Demo data controls, so anyone can start from a clean slate or bring the worked
 * example back. Refused in production: these endpoints delete data.
 */
function refuseInProduction(c: AppContext) {
  if (c.env.APP_ENV !== 'production') return null;
  return c.json(
    { error: 'forbidden', message: 'Demo data controls are disabled in production.' },
    403,
  );
}

adminRoutes.get('/data', async (c) => {
  return c.json({ status: await dataStatus(db(c)), enabled: c.env.APP_ENV !== 'production' });
});

adminRoutes.post('/data/demo', async (c) => {
  const refused = refuseInProduction(c);
  if (refused) return refused;

  await loadDemoData(db(c));
  await recordAudit(db(c), {
    entity: 'data',
    entity_id: 'demo',
    action: 'create',
    actor: actor(c),
    summary: 'Loaded the demo data',
  });
  return c.json({ status: await dataStatus(db(c)) });
});

adminRoutes.delete('/data/demo', async (c) => {
  const refused = refuseInProduction(c);
  if (refused) return refused;

  await removeDemoData(db(c));
  await recordAudit(db(c), {
    entity: 'data',
    entity_id: 'demo',
    action: 'delete',
    actor: actor(c),
    summary: 'Removed the demo data',
  });
  return c.json({ status: await dataStatus(db(c)) });
});

/** Deletes every tool, payment and log entry. Needs `?confirm=true` so a stray request cannot do it. */
adminRoutes.delete('/data', async (c) => {
  const refused = refuseInProduction(c);
  if (refused) return refused;

  if (new URL(c.req.url).searchParams.get('confirm') !== 'true') {
    return c.json(
      { error: 'confirmation_required', message: 'Add ?confirm=true to delete all data.' },
      400,
    );
  }

  await clearAllData(db(c));
  await recordAudit(db(c), {
    entity: 'data',
    entity_id: 'all',
    action: 'delete',
    actor: actor(c),
    summary: 'Deleted all tools and payments',
  });
  return c.json({ status: await dataStatus(db(c)) });
});

adminRoutes.get('/notifications', async (c) => {
  const notifications = await listNotifications(db(c), 200);
  return c.json({ notifications });
});

adminRoutes.get('/audit', async (c) => {
  const audit = await listRecentAudit(db(c), 200);
  return c.json({ audit });
});
