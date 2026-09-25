import { Hono } from 'hono';
import { settingsUpdateSchema } from '../../shared/schema';
import { isIsoDate, todayInTimezone } from '../../shared/dates';
import type { Alert } from '../../shared/types';
import type { AppContext, Env, Variables } from '../context';
import { actor, db, envVars, featureDocuments, zodErrorResponse } from '../context';
import { clearAllData, dataStatus, loadDemoData, removeDemoData } from '../repo/demo';
import { getSettings, updateSettings } from '../repo/settings';
import { listNotifications } from '../repo/notifications';
import { listRecentAudit } from '../repo/audit';
import { recordAudit } from '../repo/audit';
import { runReminders } from '../reminders';
import { refreshRatesIfDue } from '../fx/refresh';
import { importAwsCostsIfDue } from '../aws/import';
import { DEFAULT_CHANNELS } from '../reminders';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

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

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * A plain `===` on a secret returns as soon as it finds a differing byte, so
 * the time it takes reveals how much of the prefix was right. That is enough
 * to recover a token one character at a time given enough attempts.
 */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The reminder job is the one endpoint a machine calls.
 *
 * Everything else sits behind the host's sign-in (Static Web Apps + Entra), but
 * the scheduler has no interactive session, so this route is excluded from that
 * rule and carries its own shared secret instead. Without the guard the route
 * would be the one unauthenticated hole in the app.
 *
 * When REMINDER_TOKEN is unset -- local development -- the guard is inert, so
 * `npm run dev` needs no ceremony. It is required in production; see
 * DEPLOYMENT.md.
 */
adminRoutes.use('/reminders/run', async (c, next) => {
  const expected = envVars(c)['REMINDER_TOKEN'];
  if (!expected) return next();

  const provided = c.req.header('x-reminder-token') ?? '';
  if (!secretsMatch(provided, expected)) {
    return c.json(
      { error: 'unauthorized', message: 'A valid x-reminder-token header is required.' },
      401,
    );
  }
  return next();
});

/**
 * Run the daily job for real, now.
 *
 * This is what the scheduler calls, and what "Send reminders now" in Settings
 * calls. It is the whole daily job, not just the messaging half: rates are
 * refreshed first so a card quoting a converted total uses the same numbers
 * the dashboard will show that morning.
 *
 * A rate failure is logged into the response and stepped over. The ECB being
 * unreachable must never stop a renewal reminder going out -- that would trade
 * a cosmetic problem for the one failure this product cannot have.
 */
adminRoutes.post('/reminders/run', async (c) => {
  let fx: { refreshed: boolean; saved: number; error?: string };
  try {
    const result = await refreshRatesIfDue(db(c));
    fx = { refreshed: result.refreshed, saved: result.saved };
  } catch (error) {
    fx = {
      refreshed: false,
      saved: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // Before the reminders, so a month that has just been imported is not also
  // posted as "costs have not been entered". Stepped over on failure, like FX.
  let aws: { imported: number; estimated_months: string[]; kept_manual: number; unassigned: number } | { error: string } | null;
  try {
    const settings = await getSettings(db(c));
    const report = await importAwsCostsIfDue(db(c), settings, envVars(c), todayInTimezone(settings.timezone));
    aws = report && {
      imported: report.saved.length,
      estimated_months: report.estimated_months,
      kept_manual: report.kept_manual.length,
      unassigned: report.unassigned.length,
    };
  } catch (error) {
    aws = { error: error instanceof Error ? error.message : String(error) };
  }

  const run = await runReminders(db(c), envVars(c), { dryRun: false });
  await recordAudit(db(c), {
    entity: 'reminders',
    entity_id: run.today,
    action: 'update',
    actor: actor(c),
    summary: `Ran reminders for ${run.today}`,
  });
  return c.json({ ...run, fx, aws });
});

/**
 * Send one real message down a channel, right now.
 *
 * This is what closes the loop on pasting a webhook URL: without it the only
 * way to know the URL works is to wait for tomorrow's cron and see whether
 * anything arrives. It sends a clearly-labelled test card and records nothing
 * in the notification log, so it can never suppress a real reminder by
 * consuming its dedupe key.
 */
adminRoutes.post('/channels/:name/test', async (c) => {
  const name = c.req.param('name');
  const channel = DEFAULT_CHANNELS.find((ch) => ch.name === name);
  if (!channel) {
    return c.json(
      { error: 'not_found', message: `No channel called ${name}. Try: ${DEFAULT_CHANNELS.map((ch) => ch.name).join(', ')}.` },
      404,
    );
  }

  const settings = await getSettings(db(c));
  if (!channel.isConfigured(settings, envVars(c))) {
    return c.json(
      {
        error: 'not_configured',
        message:
          name === 'teams'
            ? 'Paste a Teams webhook URL into Settings first, then test again.'
            : `The ${name} channel has nothing to send with yet.`,
      },
      400,
    );
  }

  // A synthetic alert, so the card exercises the real rendering path rather
  // than a special "test" layout that could look fine while the real one breaks.
  const today = todayInTimezone(settings.timezone);
  const sample: Alert = {
    rule: 'renewal_upcoming',
    severity: 'info',
    tool_id: 'test',
    product_id: null,
    tool_name: 'Test message',
    payment_id: null,
    title: 'Test message from the tools dashboard',
    detail: 'If you can read this in Teams, the webhook works. Nothing was logged.',
    date: today,
    days_until: 0,
    amount: null,
    currency: null,
    owner_name: null,
    owner_email: null,
    dedupe_key: `test:${Date.now()}`,
  };

  const result = await channel.send(
    {
      title: 'Tools & subscriptions: test message',
      text: 'If you can read this, the webhook works. Nothing was recorded.',
      alerts: [sample],
      kind: 'alerts',
    },
    settings,
    envVars(c),
  );

  await recordAudit(db(c), {
    entity: 'channel',
    entity_id: name,
    action: 'update',
    actor: actor(c),
    summary: `Sent a test message to ${name}: ${result.status}`,
  });

  return c.json({ result }, result.status === 'failed' ? 502 : 200);
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
