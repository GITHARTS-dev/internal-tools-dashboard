import { Hono } from 'hono';
import { computeAlerts } from '../../shared/alerts';
import {
  computeCategorySpend,
  computeKpis,
  computePaidByMonth,
  computeRenewalTimeline,
} from '../../shared/metrics';
import { todayInTimezone } from '../../shared/dates';
import { isIsoDate } from '../../shared/dates';
import type { Env } from '../context';
import { db } from '../context';
import { listAllTools } from '../repo/tools';
import { listPayments, paidTotalsByTool } from '../repo/payments';
import { getSettings } from '../repo/settings';
import { listRecentAudit } from '../repo/audit';

export const dashboardRoutes = new Hono<{ Bindings: Env }>();

/**
 * Everything the dashboard renders, in one request.
 *
 * The alert list here comes from the same computeAlerts() the reminder job
 * calls, so the queue on screen and the message in Teams can never disagree.
 */
dashboardRoutes.get('/', async (c) => {
  const settings = await getSettings(db(c));
  const override = new URL(c.req.url).searchParams.get('date');
  const today = override && isIsoDate(override) ? override : todayInTimezone(settings.timezone);

  const [tools, payments] = await Promise.all([listAllTools(db(c)), listPayments(db(c))]);
  const alerts = computeAlerts(tools, payments, settings, today);

  return c.json({
    today,
    timezone: settings.timezone,
    kpis: computeKpis(tools, payments, alerts, today),
    alerts,
    category_spend: computeCategorySpend(tools),
    renewal_timeline: computeRenewalTimeline(tools, today, 90),
    paid_by_month: computePaidByMonth(payments, 12, today),
    recent_activity: await listRecentAudit(db(c), 12),
  });
});

/** Cancelled and expired tools, with what each one cost over its lifetime. */
dashboardRoutes.get('/history', async (c) => {
  const tools = await listAllTools(db(c));
  const totals = await paidTotalsByTool(db(c));

  const archived = tools
    .filter((t) => t.status === 'cancelled' || t.status === 'expired')
    .map((tool) => ({
      tool,
      lifetime_paid: totals.get(tool.id) ?? null,
    }));

  return c.json({ archived });
});
